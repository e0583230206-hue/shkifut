package main

// Account-scoped saved messages. Store IDs only; resolve current content under the
// requesting user's permissions so deletion/holding never leaks cached snippets.
import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const maxSaved = 300

func personalKey(s Session, kind string) string {
	identity := "id:" + s.ID
	if s.ID == "" {
		identity = "email:" + strings.ToLower(strings.TrimSpace(s.Email))
	}
	return fmt.Sprintf("personal:%x:%s", sha256.Sum256([]byte(identity)), kind)
}

type savedMessage struct {
	ID      int    `json:"id"`
	Time    string `json:"time"`
	Snippet string `json:"snippet"`
	At      int64  `json:"at"`
}

func visibleSaved(h map[string]string, reviewer bool) bool {
	return len(h) > 0 && h["deleted"] != "1" && h["deleted"] != "true" && (h[heldField] != "1" || reviewer)
}

func getSaved(w http.ResponseWriter, r *http.Request) {
	s, ok := myUser(r)
	if !ok {
		http.Error(w, "login required", 401)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	entries, err := rdb.ZRevRangeWithScores(ctx, personalKey(s, "saved"), 0, maxSaved-1).Result()
	if err != nil {
		http.Error(w, "could not load saved messages", 500)
		return
	}
	pipe := rdb.Pipeline()
	commands := make([]*redis.MapStringStringCmd, len(entries))
	for i, e := range entries {
		commands[i] = pipe.HGetAll(ctx, "messages:"+fmt.Sprint(e.Member))
	}
	if len(entries) > 0 {
		if _, err = pipe.Exec(ctx); err != nil {
			http.Error(w, "could not load messages", 500)
			return
		}
	}
	out := []savedMessage{}
	reviewer := canReviewFigures(r)
	for i, e := range entries {
		h := commands[i].Val()
		if !visibleSaved(h, reviewer) {
			continue
		}
		id, err := strconv.Atoi(fmt.Sprint(e.Member))
		if err != nil {
			continue
		}
		snippet := truncate(plainText(h["text"]), 140)
		if strings.TrimSpace(snippet) == "" {
			snippet = "הודעת מדיה"
		}
		out = append(out, savedMessage{ID: id, Time: h["timestamp"], Snippet: snippet, At: int64(e.Score)})
	}
	writeJSON(w, out)
}

// One atomic operation per request: different devices do not overwrite a whole list.
var addSavedScript = redis.NewScript(`
for i=2,#ARGV do redis.call('ZADD',KEYS[1],'NX',ARGV[1],ARGV[i]) end
local n=redis.call('ZCARD',KEYS[1])
if n>300 then redis.call('ZREMRANGEBYRANK',KEYS[1],0,n-301) end
return 1`)

func updateSaved(w http.ResponseWriter, r *http.Request) {
	s, ok := myUser(r)
	if !ok {
		http.Error(w, "login required", 401)
		return
	}
	var req struct {
		Action string `json:"action"`
		IDs    []int  `json:"ids"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if json.NewDecoder(r.Body).Decode(&req) != nil || len(req.IDs) > maxSaved {
		http.Error(w, "invalid request", 400)
		return
	}
	if req.Action != "add" && req.Action != "remove" && req.Action != "clear" {
		http.Error(w, "invalid action", 400)
		return
	}
	for _, id := range req.IDs {
		if id <= 0 {
			http.Error(w, "invalid id", 400)
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	key := personalKey(s, "saved")
	var err error
	switch req.Action {
	case "clear":
		err = rdb.Del(ctx, key).Err()
	case "remove":
		ids := make([]any, len(req.IDs))
		for i, id := range req.IDs {
			ids[i] = strconv.Itoa(id)
		}
		if len(ids) > 0 {
			err = rdb.ZRem(ctx, key, ids...).Err()
		}
	case "add":
		args := []any{time.Now().UnixMilli()}
		reviewer := canReviewFigures(r)
		for _, id := range req.IDs {
			h, e := rdb.HGetAll(ctx, fmt.Sprintf("messages:%d", id)).Result()
			if e != nil {
				http.Error(w, "could not read message", 500)
				return
			}
			if visibleSaved(h, reviewer) {
				args = append(args, strconv.Itoa(id))
			}
		}
		if len(args) > 1 {
			err = addSavedScript.Run(ctx, rdb, []string{key}, args...).Err()
		}
	}
	if err != nil {
		http.Error(w, "could not save", 500)
		return
	}
	writeJSON(w, Response{Success: true})
}

type personalPreferences struct {
	ReplyToast     bool `json:"replyToast"`
	ChatToast      bool `json:"chatToast"`
	InboxToast     bool `json:"inboxToast"`
	MediaToast     bool `json:"mediaToast"`
	BroadcastToast bool `json:"broadcastToast"`
}

func getPersonalPreferences(w http.ResponseWriter, r *http.Request) {
	s, ok := myUser(r)
	if !ok {
		http.Error(w, "login required", 401)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	p := personalPreferences{ReplyToast: true, ChatToast: true, InboxToast: true, MediaToast: true, BroadcastToast: true}
	raw, err := rdb.Get(r.Context(), personalKey(s, "preferences")).Result()
	if err != nil && err != redis.Nil {
		http.Error(w, "could not load preferences", 500)
		return
	}
	if raw != "" {
		if json.Unmarshal([]byte(raw), &p) != nil {
			http.Error(w, "invalid stored preferences", 500)
			return
		}
	}
	writeJSON(w, p)
}
func setPersonalPreferences(w http.ResponseWriter, r *http.Request) {
	s, ok := myUser(r)
	if !ok {
		http.Error(w, "login required", 401)
		return
	}
	p := personalPreferences{ReplyToast: true, ChatToast: true, InboxToast: true, MediaToast: true, BroadcastToast: true}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(&p) != nil {
		http.Error(w, "invalid preferences", 400)
		return
	}
	raw, _ := json.Marshal(p)
	if rdb.Set(r.Context(), personalKey(s, "preferences"), raw, 0).Err() != nil {
		http.Error(w, "could not save preferences", 500)
		return
	}
	writeJSON(w, p)
}

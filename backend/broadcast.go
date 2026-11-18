package main

// General messages from the owner to every user ("הודעות מהערוץ"). A message is stored once; every user sees all of them.
// Each user only has a counter of the last general message he has opened (hash "notif:<email>", field bcSeen).
// So a user who logged in at any time sees all of them, and the counter shows how many are new to him.

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	broadcastTitleMax = 100
	broadcastTextMax  = 2000
	broadcastsShown   = 100 // the newest ones
)

type broadcast struct {
	ID    int64  `json:"id"`
	Title string `json:"title"`
	Text  string `json:"text"`
	At    string `json:"at"`
}

// notifKey: the per-user counters (the email is lower-cased, like the presence records).
func notifKey(s Session) string { return "notif:" + presenceKey(s.Email) }

// unreadBroadcasts: general messages with a number above the one this user last opened.
func unreadBroadcasts(ctx context.Context, s Session) int {
	seen, _ := rdb.HGet(ctx, notifKey(s), "bcSeen").Int64()
	n, err := rdb.ZCount(ctx, "broadcasts:list", strconv.FormatInt(seen+1, 10), "+inf").Result()
	if err != nil {
		return 0
	}
	return int(n)
}

// createBroadcast (owner only): {"title":"...","text":"..."}
func createBroadcast(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var req struct {
		Title string `json:"title"`
		Text  string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	title, ok := cleanText(req.Title, broadcastTitleMax)
	if !ok {
		http.Error(w, "title must be 1-"+strconv.Itoa(broadcastTitleMax)+" characters", http.StatusBadRequest)
		return
	}
	text, ok := cleanText(req.Text, broadcastTextMax)
	if !ok {
		http.Error(w, "text must be 1-"+strconv.Itoa(broadcastTextMax)+" characters", http.StatusBadRequest)
		return
	}
	by := ""
	if s, ok := myUser(r); ok {
		by = s.Email
	}
	id, err := rdb.Incr(ctx, "broadcast:next_id").Result()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	key := "broadcast:" + strconv.FormatInt(id, 10)
	at := nowText()
	if err := rdb.HSet(ctx, key, "id", id, "title", title, "text", text, "at", at, "by", by).Err(); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	rdb.ZAdd(ctx, "broadcasts:list", redis.Z{Score: float64(id), Member: key})
	writeJSON(w, Response{Success: true})
}

// getMyBroadcasts: the newest general messages (no name of who wrote them is sent).
func getMyBroadcasts(w http.ResponseWriter, r *http.Request) {
	if _, ok := myUser(r); !ok {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	ids, err := rdb.ZRevRange(ctx, "broadcasts:list", 0, broadcastsShown-1).Result()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	out := make([]broadcast, 0, len(ids))
	for _, k := range ids {
		h, err := rdb.HGetAll(ctx, k).Result()
		if err != nil || len(h) == 0 {
			continue
		}
		id, _ := strconv.ParseInt(h["id"], 10, 64)
		out = append(out, broadcast{ID: id, Title: h["title"], Text: h["text"], At: h["at"]})
	}
	writeJSON(w, out)
}

// markBroadcastsSeen: {"upTo": 7} - the user has seen every general message up to this number.
func markBroadcastsSeen(w http.ResponseWriter, r *http.Request) {
	s, ok := myUser(r)
	if !ok {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	var req struct {
		UpTo int64 `json:"upTo"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UpTo < 0 {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	cur, _ := rdb.HGet(ctx, notifKey(s), "bcSeen").Int64()
	if req.UpTo > cur {
		rdb.HSet(ctx, notifKey(s), "bcSeen", req.UpTo)
	}
	writeJSON(w, Response{Success: true})
}

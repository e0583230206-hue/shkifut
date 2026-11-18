package main

// The personal area ("הפניות שלי"): a logged-in user sees ONLY his own reports and contact messages, and the conversation about them.
// Nothing about the moderators is shown to him (who closed, who handled, who wrote a reply) - those stay in the admin hashes.
// Each item has a thread (list "thread:<kind>:<id>"): the sender's messages and the moderators' replies, oldest first.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/redis/go-redis/v9"
)

const (
	replyMax  = 2000 // characters of one message in a thread
	threadMax = 300  // entries of one thread that are returned (the newest ones)
)

// threadEntry: one message of a conversation. By (the moderator's email) is for the admin only.
type threadEntry struct {
	From string `json:"from"` // "admin" or "user"
	Text string `json:"text"`
	At   string `json:"at"`
	By   string `json:"by,omitempty"`
}

// myThreadEntry: what the sender sees - never the moderator's name.
type myThreadEntry struct {
	From string `json:"from"`
	Text string `json:"text"`
	At   string `json:"at"`
}

// myUser: the logged-in user from the cookie (ok=false when nobody is logged in).
func myUser(r *http.Request) (Session, bool) {
	session, _ := store.Get(r, cookieName)
	s, ok := session.Values["user"].(Session)
	return s, ok && (s.ID != "" || s.Email != "")
}

// nowText: times are kept as RFC3339 text, the same way the admin hashes already keep them.
func nowText() string { return time.Now().UTC().Format(time.RFC3339) }

func parseStamp(s string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, s)
	return t, err == nil
}

// cleanText: trimmed, 1..max characters.
func cleanText(s string, max int) (string, bool) {
	s = strings.TrimSpace(s)
	n := utf8.RuneCountInString(s)
	return s, n >= 1 && n <= max
}

// itemKeys: the hash of a report / contact message and its thread.
func itemKeys(kind string, id int64) (item, thread string, ok bool) {
	switch kind {
	case "report":
		return fmt.Sprintf("report:%d", id), fmt.Sprintf("thread:report:%d", id), true
	case "contact":
		return fmt.Sprintf("contact:%d", id), fmt.Sprintf("thread:contact:%d", id), true
	}
	return "", "", false
}

// readThread: the whole conversation, oldest first. A reply written before threads existed is the first entry.
func readThread(ctx context.Context, kind string, id int64, h map[string]string) []threadEntry {
	_, tk, _ := itemKeys(kind, id)
	vals, _ := rdb.LRange(ctx, tk, 0, -1).Result()
	out := make([]threadEntry, 0, len(vals)+1)
	for _, v := range vals {
		var e threadEntry
		if json.Unmarshal([]byte(v), &e) == nil {
			out = append(out, e)
		}
	}
	if len(out) == 0 && h["reply"] != "" {
		out = append(out, threadEntry{From: "admin", Text: h["reply"], At: h["repliedAt"], By: h["replyBy"]})
	}
	return out
}

// appendThread: adds one message. A reply written before threads existed is copied into the thread first, so nothing is lost.
func appendThread(ctx context.Context, kind string, id int64, e threadEntry) error {
	item, tk, _ := itemKeys(kind, id)
	if n, err := rdb.LLen(ctx, tk).Result(); err == nil && n == 0 {
		if legacy, _ := rdb.HGet(ctx, item, "reply").Result(); legacy != "" {
			at, _ := rdb.HGet(ctx, item, "repliedAt").Result()
			by, _ := rdb.HGet(ctx, item, "replyBy").Result()
			if b, err := json.Marshal(threadEntry{From: "admin", Text: legacy, At: at, By: by}); err == nil {
				rdb.RPush(ctx, tk, b)
			}
		}
	}
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, tk, b).Err()
}

// unreadFor: how many messages from the other side came after the time this side last opened the item.
func unreadFor(entries []threadEntry, from string, seen time.Time) int {
	n := 0
	for _, e := range entries {
		if e.From != from {
			continue
		}
		if at, ok := parseStamp(e.At); !ok || at.After(seen) {
			n++
		}
	}
	return n
}

// loadOwned: the item and whether it belongs to this user (not his -> ok=false, the same answer as a missing one).
func loadOwned(ctx context.Context, s Session, kind string, id int64) (string, map[string]string, bool) {
	item, _, ok := itemKeys(kind, id)
	if !ok {
		return "", nil, false
	}
	h, err := rdb.HGetAll(ctx, item).Result()
	if err != nil || len(h) == 0 {
		return "", nil, false
	}
	mine := (kind == "report" && s.ID != "" && h["reporterId"] == s.ID) ||
		(kind == "contact" && s.Email != "" && strings.EqualFold(h["userEmail"], s.Email))
	return item, h, mine
}

// status of an item as the sender sees it
func senderStatus(kind string, h map[string]string) string {
	if kind == "contact" && h["handled"] == "1" {
		return "handled"
	}
	if kind == "report" && h["closed"] == "1" {
		return "closed"
	}
	return "open"
}

type myItem struct {
	Kind      string          `json:"kind"`
	ID        int64           `json:"id"`
	CreatedAt string          `json:"createdAt"`
	Subject   string          `json:"subject,omitempty"`
	Text      string          `json:"text"`
	Status    string          `json:"status"`
	Unread    int             `json:"unread"`
	Thread    []myThreadEntry `json:"thread"`
}

// myItems: the user's own reports and contact messages, newest first, each with its conversation.
func myItems(ctx context.Context, s Session) []myItem {
	items := []myItem{}
	add := func(kind string, key string, h map[string]string, mine bool) {
		if !mine {
			return
		}
		id, _ := strconv.ParseInt(h["id"], 10, 64)
		if id == 0 {
			id, _ = strconv.ParseInt(strings.TrimPrefix(key, kind+":"), 10, 64)
		}
		entries := readThread(ctx, kind, id, h)
		seen, _ := parseStamp(h["seenReplyAt"])
		it := myItem{Kind: kind, ID: id, CreatedAt: h["createdAt"], Status: senderStatus(kind, h), Unread: unreadFor(entries, "admin", seen)}
		if kind == "report" {
			it.Text = h["reason"]
		} else {
			it.Subject = h["subject"]
			it.Text = h["message"]
		}
		if len(entries) > threadMax {
			entries = entries[len(entries)-threadMax:]
		}
		for _, e := range entries {
			it.Thread = append(it.Thread, myThreadEntry{From: e.From, Text: e.Text, At: e.At})
		}
		items = append(items, it)
	}
	// The newest 500 of each list, read in ONE pipeline instead of one round trip per item (the old loop made ~1000 round trips per call).
	var keys, kinds []string
	if reportKeys, err := rdb.ZRevRange(ctx, "reports:list", 0, 499).Result(); err == nil {
		for _, k := range reportKeys {
			keys, kinds = append(keys, k), append(kinds, "report")
		}
	}
	if contactKeys, err := rdb.ZRevRange(ctx, "contact:list", 0, 499).Result(); err == nil {
		for _, k := range contactKeys {
			keys, kinds = append(keys, k), append(kinds, "contact")
		}
	}
	if len(keys) > 0 {
		pipe := rdb.Pipeline()
		cmds := make([]*redis.MapStringStringCmd, len(keys))
		for i, k := range keys {
			cmds[i] = pipe.HGetAll(ctx, k)
		}
		pipe.Exec(ctx) // each command's own error is checked below, as before
		for i, k := range keys {
			h, err := cmds[i].Result()
			if err != nil || len(h) == 0 {
				continue
			}
			if kinds[i] == "report" {
				add("report", k, h, s.ID != "" && h["reporterId"] == s.ID)
			} else {
				add("contact", k, h, s.Email != "" && strings.EqualFold(h["userEmail"], s.Email))
			}
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		a, _ := parseStamp(items[i].CreatedAt)
		b, _ := parseStamp(items[j].CreatedAt)
		if a.Equal(b) {
			return items[i].ID > items[j].ID
		}
		return a.After(b)
	})
	return items
}

func getMyMessages(w http.ResponseWriter, r *http.Request) {
	s, ok := myUser(r)
	if !ok {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	writeJSON(w, myItems(ctx, s))
}

// markMyReplySeen: {"kind":"report"|"contact","id":5} - the user opened the item, its replies count as read.
func markMyReplySeen(w http.ResponseWriter, r *http.Request) {
	s, ok := myUser(r)
	if !ok {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	var req struct {
		Kind string `json:"kind"`
		ID   int64  `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID <= 0 {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	item, _, mine := loadOwned(ctx, s, req.Kind, req.ID)
	if !mine {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	rdb.HSet(ctx, item, "seenReplyAt", nowText())
	writeJSON(w, Response{Success: true})
}

// postMyReply: {"kind":"report"|"contact","id":5,"text":"..."} - the user answers in his thread.
// Answering an item that was closed or handled opens it again.
func postMyReply(w http.ResponseWriter, r *http.Request) {
	s, ok := myUser(r)
	if !ok {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	var req struct {
		Kind string `json:"kind"`
		ID   int64  `json:"id"`
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID <= 0 {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	text, ok := cleanText(req.Text, replyMax)
	if !ok {
		http.Error(w, "message must be 1-"+strconv.Itoa(replyMax)+" characters", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	item, h, mine := loadOwned(ctx, s, req.Kind, req.ID)
	if !mine {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	now := nowText()
	if err := appendThread(ctx, req.Kind, req.ID, threadEntry{From: "user", Text: text, At: now}); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	rdb.HSet(ctx, item, "seenReplyAt", now) // his own message is read by him
	if req.Kind == "contact" && h["handled"] == "1" {
		rdb.HSet(ctx, item, "handled", false)
		if created, err := rdb.ZScore(ctx, "contact:list", item).Result(); err == nil {
			rdb.ZAdd(ctx, "contact:open", redis.Z{Score: created, Member: item})
		}
	}
	if req.Kind == "report" && h["closed"] == "1" {
		rdb.HSet(ctx, item, "closed", false)
		rdb.ZRem(ctx, "reports:closed", item)
		if created, err := rdb.ZScore(ctx, "reports:list", item).Result(); err == nil {
			rdb.ZAdd(ctx, "reports:open", redis.Z{Score: created, Member: item})
		}
	}
	writeJSON(w, Response{Success: true})
}

// getMySummary: the counter in the header - unread replies on his items plus unread general messages.
func getMySummary(w http.ResponseWriter, r *http.Request) {
	s, ok := myUser(r)
	if !ok {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	replies := 0
	for _, it := range myItems(ctx, s) {
		replies += it.Unread
	}
	broadcasts := unreadBroadcasts(ctx, s)
	writeJSON(w, map[string]int{"replies": replies, "broadcasts": broadcasts, "total": replies + broadcasts})
}

// --- moderators ---

// writeReply (moderators): {"id": 5, "reply": "..."} - appended to the thread; the sender sees it in his area.
func writeReply(w http.ResponseWriter, r *http.Request, kind string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var req struct {
		ID    int64  `json:"id"`
		Reply string `json:"reply"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID <= 0 {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	text, ok := cleanText(req.Reply, replyMax)
	if !ok {
		http.Error(w, "reply must be 1-"+strconv.Itoa(replyMax)+" characters", http.StatusBadRequest)
		return
	}
	item, _, known := itemKeys(kind, req.ID)
	if !known {
		http.Error(w, "invalid kind", http.StatusBadRequest)
		return
	}
	if n, _ := rdb.Exists(ctx, item).Result(); n == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	by := ""
	if s, ok := myUser(r); ok {
		by = s.Email
	}
	now := nowText()
	if err := appendThread(ctx, kind, req.ID, threadEntry{From: "admin", Text: text, At: now, By: by}); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	// the latest reply is also kept on the item itself (the admin lists show it)
	rdb.HSet(ctx, item, "reply", text, "repliedAt", now, "replyBy", by)
	rdb.RPush(ctx, item+":log", "reply|"+by+"|"+now)
	writeJSON(w, Response{Success: true})
}

func setReportReply(w http.ResponseWriter, r *http.Request)  { writeReply(w, r, "report") }
func setContactReply(w http.ResponseWriter, r *http.Request) { writeReply(w, r, "contact") }

// getAdminThread: GET /api/admin/thread?kind=contact&id=5 - the whole conversation, with who wrote each reply.
// Opening it marks what the sender wrote as read by the moderators.
func getAdminThread(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	kind := r.URL.Query().Get("kind")
	id, _ := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	item, _, known := itemKeys(kind, id)
	if !known || id <= 0 {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	h, err := rdb.HGetAll(ctx, item).Result()
	if err != nil || len(h) == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	rdb.HSet(ctx, item, "adminSeenAt", nowText())
	thread := readThread(ctx, kind, id, h)
	for i := range thread {
		if thread[i].By != "" {
			thread[i].By = staffName(thread[i].By)
		}
	}
	writeJSON(w, map[string]any{"thread": thread})
}

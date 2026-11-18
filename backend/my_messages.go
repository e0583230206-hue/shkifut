package main

// The personal area ("הפניות שלי"): a logged-in user sees ONLY his own reports and contact messages, and the replies written to them.
// Nothing about the moderators is shown to him (who closed, who handled, who wrote the reply) - those stay in the admin hashes.

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

)

const replyMax = 2000 // characters of one reply

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

// cleanReply: trimmed, 1..replyMax characters.
func cleanReply(s string) (string, bool) {
	s = strings.TrimSpace(s)
	n := utf8.RuneCountInString(s)
	return s, n >= 1 && n <= replyMax
}

// unreadReply: a reply the user has not opened since it was written.
func unreadReply(h map[string]string) bool {
	if h["reply"] == "" {
		return false
	}
	at, ok := parseStamp(h["repliedAt"])
	if !ok {
		return false
	}
	seen, ok := parseStamp(h["seenReplyAt"])
	return !ok || seen.Before(at)
}

type myItem struct {
	Kind      string `json:"kind"` // "report" | "contact"
	ID        int64  `json:"id"`
	CreatedAt string `json:"createdAt"`
	Subject   string `json:"subject,omitempty"`
	Text      string `json:"text"`
	Reply     string `json:"reply,omitempty"`
	RepliedAt string `json:"repliedAt,omitempty"`
	Unread    bool   `json:"unread"`
}

func getMyMessages(w http.ResponseWriter, r *http.Request) {
	s, ok := myUser(r)
	if !ok {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	items := []myItem{}
	reportKeys, _ := rdb.ZRevRange(ctx, "reports:list", 0, 499).Result()
	for _, k := range reportKeys {
		h, err := rdb.HGetAll(ctx, k).Result()
		if err != nil || s.ID == "" || h["reporterId"] != s.ID {
			continue
		}
		id, _ := strconv.ParseInt(h["id"], 10, 64)
		items = append(items, myItem{Kind: "report", ID: id, CreatedAt: h["createdAt"], Text: h["reason"],
			Reply: h["reply"], RepliedAt: h["repliedAt"], Unread: unreadReply(h)})
	}
	contactKeys, _ := rdb.ZRevRange(ctx, "contact:list", 0, 499).Result()
	for _, k := range contactKeys {
		h, err := rdb.HGetAll(ctx, k).Result()
		if err != nil || s.Email == "" || !strings.EqualFold(h["userEmail"], s.Email) {
			continue
		}
		id, _ := strconv.ParseInt(h["id"], 10, 64)
		items = append(items, myItem{Kind: "contact", ID: id, CreatedAt: h["createdAt"], Subject: h["subject"], Text: h["message"],
			Reply: h["reply"], RepliedAt: h["repliedAt"], Unread: unreadReply(h)})
	}
	sort.SliceStable(items, func(i, j int) bool {
		a, _ := parseStamp(items[i].CreatedAt)
		b, _ := parseStamp(items[j].CreatedAt)
		return a.After(b)
	})
	writeJSON(w, items)
}

// markMyReplySeen: {"kind":"report"|"contact","id":5} - the user opened the reply.
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

	var k string
	switch req.Kind {
	case "report":
		k = fmt.Sprintf("report:%d", req.ID)
	case "contact":
		k = fmt.Sprintf("contact:%d", req.ID)
	default:
		http.Error(w, "invalid kind", http.StatusBadRequest)
		return
	}
	h, err := rdb.HGetAll(ctx, k).Result()
	if err != nil || len(h) == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	mine := (req.Kind == "report" && s.ID != "" && h["reporterId"] == s.ID) ||
		(req.Kind == "contact" && s.Email != "" && strings.EqualFold(h["userEmail"], s.Email))
	if !mine {
		http.Error(w, "not found", http.StatusNotFound) // not his: the same answer as for a missing item
		return
	}
	rdb.HSet(ctx, k, "seenReplyAt", nowText())
	writeJSON(w, Response{Success: true})
}

// setReportReply / setContactReply (moderators): {"id": 5, "reply": "..."} - the reply is shown in the sender's personal area.
func setReportReply(w http.ResponseWriter, r *http.Request) {
	writeReply(w, r, "report")
}

func setContactReply(w http.ResponseWriter, r *http.Request) {
	writeReply(w, r, "contact")
}

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
	text, ok := cleanReply(req.Reply)
	if !ok {
		http.Error(w, "reply must be 1-"+strconv.Itoa(replyMax)+" characters", http.StatusBadRequest)
		return
	}
	k := fmt.Sprintf("%s:%d", kind, req.ID)
	if n, _ := rdb.Exists(ctx, k).Result(); n == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	by := ""
	if s, ok := myUser(r); ok {
		by = s.Email
	}
	// the admin keeps who wrote it (replyBy is never returned to the sender); a new reply makes the sender's copy unread again
	rdb.HSet(ctx, k, "reply", text, "repliedAt", nowText(), "replyBy", by)
	rdb.HDel(ctx, k, "seenReplyAt")
	rdb.RPush(ctx, k+":log", "reply|"+by+"|"+nowText())
	writeJSON(w, Response{Success: true})
}


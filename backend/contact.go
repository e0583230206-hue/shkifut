package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/redis/go-redis/v9"
)

// Contact form ("צור קשר"): public submit with spam protection, inbox for moderators.

type ContactMessage struct {
	ID        int64     `json:"id" redis:"id"`
	Name      string    `json:"name" redis:"name"`
	Email     string    `json:"email" redis:"email"`
	Phone     string    `json:"phone" redis:"phone"`
	Subject   string    `json:"subject" redis:"subject"`
	Message   string    `json:"message" redis:"message"`
	CreatedAt time.Time `json:"createdAt" redis:"createdAt"`
	Handled   bool      `json:"handled" redis:"handled"`
	UserEmail string    `json:"userEmail,omitempty" redis:"userEmail"` // logged-in sender, if any
}

const (
	contactPerIPPerHour = 5
	contactMinFillMs    = 3000 // humans need a few seconds to fill the form
)

var (
	contactEmailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	contactURLRe   = regexp.MustCompile(`(?i)https?://|www\.`)
)

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr) // set from X-Real-IP by middleware.RealIP behind nginx
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func submitContact(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)

	var req struct {
		Name      string `json:"name"`
		Email     string `json:"email"`
		Phone     string `json:"phone"`
		Subject   string `json:"subject"`
		Message   string `json:"message"`
		Website   string `json:"website"`   // honeypot: hidden field, must stay empty
		ElapsedMs int64  `json:"elapsedMs"` // time the form was open
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	trim := strings.TrimSpace
	req.Name, req.Email, req.Phone, req.Subject, req.Message = trim(req.Name), trim(req.Email), trim(req.Phone), trim(req.Subject), trim(req.Message)

	// Bots: answer as if accepted so they learn nothing.
	if req.Website != "" || req.ElapsedMs < contactMinFillMs {
		writeJSON(w, Response{Success: true})
		return
	}
	switch {
	case utf8.RuneCountInString(req.Message) < 5 || utf8.RuneCountInString(req.Message) > 5000:
		http.Error(w, "message length", http.StatusBadRequest)
		return
	case utf8.RuneCountInString(req.Name) > 100 || utf8.RuneCountInString(req.Subject) > 200 || len(req.Phone) > 30:
		http.Error(w, "field too long", http.StatusBadRequest)
		return
	case req.Email != "" && (len(req.Email) > 200 || !contactEmailRe.MatchString(req.Email)):
		http.Error(w, "invalid email", http.StatusBadRequest)
		return
	case req.Email == "" && req.Phone == "":
		http.Error(w, "email or phone required", http.StatusBadRequest)
		return
	case len(contactURLRe.FindAllString(req.Message, -1)) > 3:
		http.Error(w, "too many links", http.StatusBadRequest)
		return
	}

	// Rate limit per IP.
	key := "contact:rate:" + clientIP(r)
	n, err := rdb.Incr(ctx, key).Result()
	if err == nil && n == 1 {
		rdb.Expire(ctx, key, time.Hour)
	}
	if n > contactPerIPPerHour {
		http.Error(w, "too many messages, try again later", http.StatusTooManyRequests)
		return
	}

	id, err := rdb.Incr(ctx, "contact:next_id").Result()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	msg := ContactMessage{ID: id, Name: req.Name, Email: req.Email, Phone: req.Phone, Subject: req.Subject,
		Message: req.Message, CreatedAt: time.Now()}
	session, _ := store.Get(r, cookieName)
	if s, ok := session.Values["user"].(Session); ok {
		msg.UserEmail = s.Email
	}
	k := fmt.Sprintf("contact:%d", id)
	if err := rdb.HSet(ctx, k, msg).Err(); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	rdb.ZAdd(ctx, "contact:list", redis.Z{Score: float64(msg.CreatedAt.Unix()), Member: k})
	rdb.ZAdd(ctx, "contact:open", redis.Z{Score: float64(msg.CreatedAt.Unix()), Member: k})
	writeJSON(w, Response{Success: true})
}

// getContactMessages lists messages newest first: ?status=open|all
func getContactMessages(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	list := "contact:list"
	if r.URL.Query().Get("status") != "all" {
		list = "contact:open"
	}
	keys, err := rdb.ZRevRange(ctx, list, 0, 499).Result()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	out := make([]ContactMessage, 0, len(keys))
	for _, k := range keys {
		var m ContactMessage
		if err := rdb.HGetAll(ctx, k).Scan(&m); err == nil && m.ID != 0 {
			out = append(out, m)
		}
	}
	writeJSON(w, out)
}

// setContactHandled marks a message handled / open again: {"id": 1, "handled": true}
func setContactHandled(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var req struct {
		ID      int64 `json:"id"`
		Handled bool  `json:"handled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID <= 0 {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	k := fmt.Sprintf("contact:%d", req.ID)
	if n, _ := rdb.Exists(ctx, k).Result(); n == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	rdb.HSet(ctx, k, "handled", req.Handled)
	if req.Handled {
		rdb.ZRem(ctx, "contact:open", k)
	} else {
		created, _ := rdb.ZScore(ctx, "contact:list", k).Result()
		rdb.ZAdd(ctx, "contact:open", redis.Z{Score: created, Member: k})
	}
	writeJSON(w, Response{Success: true})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

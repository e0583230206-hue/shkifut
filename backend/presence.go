package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Who is online (for admins only). Only logged-in readers are recorded: when they open the site (user-info, messages) and while a
// live-update connection (SSE) is open. "Last seen" is kept for presenceRetention and then deleted automatically.
//
//	presence:seen   ZSET  email -> last seen (unix seconds)
//	presence:names  HASH  email -> display name
const (
	presenceSeenKey      = "presence:seen"
	presenceNamesKey     = "presence:names"
	presenceOnlineWindow = 5 * time.Minute     // seen within this time = online
	presenceRetention    = 30 * 24 * time.Hour // "last seen" older than this is deleted
	presenceTouchEvery   = time.Minute         // at most one database write per user per minute
	presenceMaxUsers     = 500
)

var presence = struct {
	mu      sync.Mutex
	conns   map[string]int       // open live-update connections per user
	touched map[string]time.Time // last database write per user
}{conns: map[string]int{}, touched: map[string]time.Time{}}

func presenceKey(email string) string { return strings.ToLower(strings.TrimSpace(email)) }

func sessionUser(r *http.Request) (Session, bool) {
	session, _ := store.Get(r, cookieName)
	s, ok := session.Values["user"].(Session)
	return s, ok && presenceKey(s.Email) != ""
}

// touchPresence records "seen now" (at most once per minute per user unless forced).
func touchPresence(s Session, force bool) {
	email := presenceKey(s.Email)
	if email == "" {
		return
	}
	now := time.Now()
	presence.mu.Lock()
	if !force && now.Sub(presence.touched[email]) < presenceTouchEvery {
		presence.mu.Unlock()
		return
	}
	presence.touched[email] = now
	presence.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := rdb.ZAdd(ctx, presenceSeenKey, redis.Z{Score: float64(now.Unix()), Member: email}).Err(); err != nil {
		log.Printf("presence: %v", err)
		return
	}
	if name := strings.TrimSpace(s.PublicName); name != "" {
		rdb.HSet(ctx, presenceNamesKey, email, name)
	}
}

// withPresence wraps a page-load style handler: the visit counts as "seen now".
func withPresence(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s, ok := sessionUser(r); ok {
			go touchPresence(s, false)
		}
		h(w, r)
	}
}

// presenceConnOpened / presenceConnClosed count the open live-update connections of a user (an open connection = online).
func presenceConnOpened(s Session) {
	presence.mu.Lock()
	presence.conns[presenceKey(s.Email)]++
	presence.mu.Unlock()
	touchPresence(s, true)
}

func presenceConnClosed(s Session) {
	email := presenceKey(s.Email)
	presence.mu.Lock()
	if presence.conns[email] > 1 {
		presence.conns[email]--
	} else {
		delete(presence.conns, email)
	}
	presence.mu.Unlock()
	touchPresence(s, true) // the last moment they were here
}

type PresenceUser struct {
	Email       string   `json:"email"`
	Name        string   `json:"name,omitempty"`
	Roles       []string `json:"roles,omitempty"`
	Online      bool     `json:"online"`
	Connections int      `json:"connections"`
	LastSeen    string   `json:"lastSeen"`
}

// getPresence: GET /api/admin/presence (admin)
func getPresence(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	seen, err := rdb.ZRevRangeWithScores(ctx, presenceSeenKey, 0, presenceMaxUsers-1).Result()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	names, _ := rdb.HGetAll(ctx, presenceNamesKey).Result()
	now := time.Now()

	presence.mu.Lock()
	conns := make(map[string]int, len(presence.conns))
	for k, v := range presence.conns {
		conns[k] = v
	}
	presence.mu.Unlock()

	users := []PresenceUser{}
	listed := map[string]bool{}
	add := func(email string, at time.Time) {
		u := PresenceUser{Email: email, Name: names[email], Connections: conns[email], LastSeen: at.UTC().Format(time.RFC3339)}
		u.Online = u.Connections > 0 || now.Sub(at) <= presenceOnlineWindow
		if v, ok := privilegesUsers.Load(email); ok {
			for _, role := range []Privilege{Admin, Moderator, Reviewer, Writer} {
				if v.(User).Privileges[role] {
					u.Roles = append(u.Roles, string(role))
				}
			}
		}
		listed[email] = true
		users = append(users, u)
	}
	for _, z := range seen {
		email, _ := z.Member.(string)
		if email != "" {
			add(email, time.Unix(int64(z.Score), 0))
		}
	}
	for email := range conns { // connected, but the first write has not landed yet
		if !listed[email] {
			add(email, now)
		}
	}
	sort.SliceStable(users, func(i, j int) bool {
		if users[i].Online != users[j].Online {
			return users[i].Online
		}
		return users[i].LastSeen > users[j].LastSeen
	})

	online := 0
	for _, u := range users {
		if u.Online {
			online++
		}
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"users": users, "online": online, "onlineWindowSec": int(presenceOnlineWindow.Seconds()),
		"retentionDays": int(presenceRetention.Hours() / 24), "now": now.UTC().Format(time.RFC3339),
	})
}

// cleanupPresence deletes "last seen" records older than presenceRetention.
func cleanupPresence() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cutoff := strconv.FormatInt(time.Now().Add(-presenceRetention).Unix(), 10)
	old, err := rdb.ZRangeByScore(ctx, presenceSeenKey, &redis.ZRangeBy{Min: "-inf", Max: cutoff}).Result()
	if err != nil || len(old) == 0 {
		return
	}
	members := make([]any, len(old))
	for i, e := range old {
		members[i] = e
	}
	rdb.ZRem(ctx, presenceSeenKey, members...)
	rdb.HDel(ctx, presenceNamesKey, old...)
	presence.mu.Lock()
	for _, e := range old {
		delete(presence.touched, e)
	}
	presence.mu.Unlock()
	log.Printf("presence: deleted %d records older than %d days", len(old), int(presenceRetention.Hours()/24))
}

func startPresenceCleanup() {
	go func() {
		for {
			cleanupPresence()
			time.Sleep(6 * time.Hour)
		}
	}()
}

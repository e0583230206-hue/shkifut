package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/redis/go-redis/v9"
)

// Topics split the channel into subjects. The list lives in "topics:list"; each message stores its topic id,
// and every topic has its own time index ("m_times:topic:<id>") so filtering is a direct range read.

const (
	topicsKey = "topics:list"
	maxTopics = 20
)

type Topic struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

var (
	topicColorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	topicIDRe    = regexp.MustCompile(`^[0-9a-f]{8}$`)
)

func topicIndexKey(id string) string { return "m_times:topic:" + id }

func dbGetTopics(ctx context.Context) ([]Topic, error) {
	raw, err := rdb.Get(ctx, topicsKey).Result()
	if err == redis.Nil {
		return []Topic{}, nil
	}
	if err != nil {
		return nil, err
	}
	var list []Topic
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, err
	}
	return list, nil
}

// resolveTopic accepts a topic id or a name (case-insensitive, for the bridge); unknown -> "".
func resolveTopic(ctx context.Context, v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	list, err := dbGetTopics(ctx)
	if err != nil {
		return ""
	}
	for _, t := range list {
		if t.ID == v || strings.EqualFold(t.Name, v) {
			return t.ID
		}
	}
	return ""
}

func getTopics(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	list, err := dbGetTopics(ctx)
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

// setTopics replaces the topic list (moderators). New topics get an id; removed topics lose their index
// (their messages stay in the channel, just without a topic chip).
func setTopics(w http.ResponseWriter, r *http.Request) {
	var list []Topic
	if err := json.NewDecoder(r.Body).Decode(&list); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if len(list) > maxTopics {
		http.Error(w, fmt.Sprintf("at most %d topics", maxTopics), http.StatusBadRequest)
		return
	}
	seen := map[string]bool{}
	for i := range list {
		t := &list[i]
		t.Name = strings.TrimSpace(t.Name)
		if n := utf8.RuneCountInString(t.Name); n < 1 || n > 30 {
			http.Error(w, "topic name must be 1-30 characters", http.StatusBadRequest)
			return
		}
		if seen[strings.ToLower(t.Name)] {
			http.Error(w, "duplicate topic name", http.StatusBadRequest)
			return
		}
		seen[strings.ToLower(t.Name)] = true
		if !topicColorRe.MatchString(t.Color) {
			t.Color = "#3366ff"
		}
		if !topicIDRe.MatchString(t.ID) {
			b := make([]byte, 4)
			rand.Read(b)
			t.ID = hex.EncodeToString(b)
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	old, err := dbGetTopics(ctx)
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	data, _ := json.Marshal(list)
	if err := rdb.Set(ctx, topicsKey, data, 0).Err(); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	keep := map[string]bool{}
	for _, t := range list {
		keep[t.ID] = true
	}
	for _, t := range old {
		if !keep[t.ID] {
			rdb.Del(ctx, topicIndexKey(t.ID))
		}
	}
	msg, _ := json.Marshal(map[string]string{"type": "topics"})
	rdb.Publish(ctx, "events", msg)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

// indexMessageTopic keeps the per-topic time index in step with a message's topic.
func indexMessageTopic(ctx context.Context, m *Message, oldTopic string) {
	key := fmt.Sprintf("messages:%d", m.ID)
	if oldTopic != "" && oldTopic != m.Topic {
		rdb.ZRem(ctx, topicIndexKey(oldTopic), key)
	}
	if m.Topic != "" {
		score, err := rdb.ZScore(ctx, "m_times:1", key).Result()
		if err != nil {
			score = float64(m.Timestamp.Unix())
		}
		rdb.ZAdd(ctx, topicIndexKey(m.Topic), redis.Z{Score: score, Member: key})
	}
}

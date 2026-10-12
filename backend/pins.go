package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Pinned messages: a sorted set of message ids scored by pin time (newest pin first in the bar).
// Kept outside the message hash so that editing a message never changes its pin state.

const (
	pinnedKey  = "pinned:1"
	maxPinned  = 10
	pinSnippet = 160
)

type PinnedMessage struct {
	ID        int       `json:"id"`
	Timestamp time.Time `json:"timestamp"`
	Snippet   string    `json:"snippet"`
	PinnedAt  time.Time `json:"pinnedAt"`
}

func getPinnedMessages(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	list, err := dbGetPinned(ctx)
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

func dbGetPinned(ctx context.Context) ([]PinnedMessage, error) {
	pins, err := rdb.ZRevRangeWithScores(ctx, pinnedKey, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	out := []PinnedMessage{}
	for _, p := range pins {
		id, _ := strconv.Atoi(fmt.Sprint(p.Member))
		v, err := rdb.HMGet(ctx, fmt.Sprintf("messages:%d", id), "text", "deleted", "timestamp").Result()
		if err != nil {
			return nil, err
		}
		if v[0] == nil || asString(v[1]) == "1" {
			rdb.ZRem(ctx, pinnedKey, p.Member) // message gone or deleted: drop the stale pin
			continue
		}
		text := []rune(plainText(asString(v[0])))
		if len(text) > pinSnippet {
			text = append(text[:pinSnippet], '…')
		}
		ts, _ := time.Parse(time.RFC3339Nano, asString(v[2]))
		out = append(out, PinnedMessage{ID: id, Timestamp: ts, Snippet: string(text), PinnedAt: time.Unix(int64(p.Score), 0).UTC()})
	}
	return out, nil
}

var errTooManyPins = errors.New("too many pinned messages")

func dbSetPinned(ctx context.Context, id int, pinned bool) error {
	if !pinned {
		return rdb.ZRem(ctx, pinnedKey, strconv.Itoa(id)).Err()
	}
	exists, err := rdb.Exists(ctx, fmt.Sprintf("messages:%d", id)).Result()
	if err != nil {
		return err
	}
	if exists == 0 {
		return redis.Nil
	}
	if deleted, _ := rdb.HGet(ctx, fmt.Sprintf("messages:%d", id), "deleted").Result(); deleted == "1" {
		return redis.Nil
	}
	if _, err := rdb.ZScore(ctx, pinnedKey, strconv.Itoa(id)).Result(); err == nil {
		return nil // already pinned
	}
	if n, _ := rdb.ZCard(ctx, pinnedKey).Result(); n >= maxPinned {
		return errTooManyPins
	}
	return rdb.ZAdd(ctx, pinnedKey, redis.Z{Score: float64(time.Now().Unix()), Member: strconv.Itoa(id)}).Err()
}

// setPinned pins or unpins a message (writers).
func setPinned(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     int  `json:"id"`
		Pinned bool `json:"pinned"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID <= 0 {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	switch err := dbSetPinned(ctx, req.ID, req.Pinned); {
	case errors.Is(err, redis.Nil):
		http.Error(w, "Message not found", http.StatusNotFound)
		return
	case errors.Is(err, errTooManyPins):
		http.Error(w, fmt.Sprintf("at most %d pinned messages", maxPinned), http.StatusConflict)
		return
	case err != nil:
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	publishPinsChanged(ctx)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{Success: true})
}

func publishPinsChanged(ctx context.Context) {
	data, _ := json.Marshal(map[string]string{"type": "pins"})
	rdb.Publish(ctx, "events", data)
}

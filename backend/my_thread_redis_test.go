package main

import (
	"context"
	"testing"
	"time"
)

// The thread against a real store: a moderator's reply and the sender's answer, and the old single reply is kept.
func TestThreadRoundTripOnStore(t *testing.T) {
	ctx := context.Background()
	const id int64 = 987654321
	item, tk, _ := itemKeys("contact", id)
	defer rdb.Del(ctx, item, tk)
	rdb.HSet(ctx, item, "id", id, "userEmail", "sender@example.com", "message", "שאלה", "reply", "תשובה ישנה", "repliedAt", "2026-11-01T10:00:00Z", "replyBy", "mod@example.com")

	if err := appendThread(ctx, "contact", id, threadEntry{From: "admin", Text: "תשובה חדשה", At: "2026-11-18T10:00:00Z", By: "mod@example.com"}); err != nil {
		t.Fatal(err)
	}
	if err := appendThread(ctx, "contact", id, threadEntry{From: "user", Text: "תודה", At: "2026-11-18T10:05:00Z"}); err != nil {
		t.Fatal(err)
	}
	h, _ := rdb.HGetAll(ctx, item).Result()
	entries := readThread(ctx, "contact", id, h)
	if len(entries) != 3 {
		t.Fatalf("legacy reply + new admin reply + user answer: got %d entries", len(entries))
	}
	if entries[0].Text != "תשובה ישנה" || entries[1].Text != "תשובה חדשה" || entries[2].From != "user" {
		t.Fatalf("order or content wrong: %+v", entries)
	}
	if n := unreadFor(entries, "admin", time.Time{}); n != 2 {
		t.Fatalf("never opened: two admin messages unread, got %d", n)
	}
}

package main

import (
	"testing"
	"time"
)

func TestCleanText(t *testing.T) {
	if s, ok := cleanText("   שלום  ", 10); !ok || s != "שלום" {
		t.Fatalf("trim: got %q %v", s, ok)
	}
	if _, ok := cleanText("   ", 10); ok {
		t.Fatal("empty text must be refused")
	}
	long := make([]rune, 11)
	for i := range long {
		long[i] = 'א'
	}
	if _, ok := cleanText(string(long), 10); ok {
		t.Fatal("too long text must be refused")
	}
}

func TestUnreadFor(t *testing.T) {
	seen := time.Date(2026, 11, 18, 10, 5, 0, 0, time.UTC)
	entries := []threadEntry{
		{From: "user", Text: "שאלה", At: "2026-11-18T10:00:00Z"},
		{From: "admin", Text: "תשובה ישנה", At: "2026-11-18T10:01:00Z"},
		{From: "admin", Text: "תשובה חדשה", At: "2026-11-18T10:30:00Z"},
	}
	if n := unreadFor(entries, "admin", seen); n != 1 {
		t.Fatalf("one admin message after the last opening: got %d", n)
	}
	if n := unreadFor(entries, "admin", time.Time{}); n != 2 {
		t.Fatalf("never opened: every admin message is unread, got %d", n)
	}
	if n := unreadFor(entries, "user", time.Time{}); n != 1 {
		t.Fatalf("the sender's own messages are counted on the other side only, got %d", n)
	}
}

func TestSenderStatus(t *testing.T) {
	if got := senderStatus("contact", map[string]string{"handled": "1"}); got != "handled" {
		t.Fatalf("contact handled: got %q", got)
	}
	if got := senderStatus("report", map[string]string{"closed": "1"}); got != "closed" {
		t.Fatalf("report closed: got %q", got)
	}
	if got := senderStatus("report", map[string]string{"closed": "0"}); got != "open" {
		t.Fatalf("report open: got %q", got)
	}
}

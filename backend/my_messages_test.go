package main

import "testing"

func TestCleanReply(t *testing.T) {
	if s, ok := cleanReply("   שלום  "); !ok || s != "שלום" {
		t.Fatalf("trim: got %q %v", s, ok)
	}
	if _, ok := cleanReply("   "); ok {
		t.Fatal("empty reply must be refused")
	}
	long := make([]rune, replyMax+1)
	for i := range long {
		long[i] = 'א'
	}
	if _, ok := cleanReply(string(long)); ok {
		t.Fatal("too long reply must be refused")
	}
}

func TestUnreadReply(t *testing.T) {
	if unreadReply(map[string]string{}) {
		t.Fatal("no reply: not unread")
	}
	h := map[string]string{"reply": "תשובה", "repliedAt": "2026-11-18T10:00:00Z"}
	if !unreadReply(h) {
		t.Fatal("a reply never opened is unread")
	}
	h["seenReplyAt"] = "2026-11-18T10:05:00Z"
	if unreadReply(h) {
		t.Fatal("a reply opened after it was written is read")
	}
	h["repliedAt"] = "2026-11-18T11:00:00Z" // a new reply, written after the last time it was opened
	if !unreadReply(h) {
		t.Fatal("a new reply is unread again")
	}
}

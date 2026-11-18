package main

import "testing"

func TestPersonalIdentity(t *testing.T) {
	a := Session{ID: "account-a", Email: "same@example.test"}
	b := Session{ID: "account-b", Email: "same@example.test"}
	if personalKey(a, "saved") == personalKey(b, "saved") {
		t.Fatal("different accounts share saved data")
	}
	if personalKey(a, "saved") == personalKey(a, "preferences") {
		t.Fatal("different collections share keys")
	}
	a.Email = "changed@example.test"
	if personalKey(a, "saved") != personalKey(Session{ID: "account-a"}, "saved") {
		t.Fatal("stable ID must survive email change")
	}
}
func TestPersonalVisibility(t *testing.T) {
	for _, h := range []map[string]string{nil, {"deleted": "1"}, {"deleted": "true"}} {
		if visibleSaved(h, true) {
			t.Fatal("deleted/missing content must not be returned")
		}
	}
	if visibleSaved(map[string]string{heldField: "1", "text": "private"}, false) {
		t.Fatal("held content leaked to reader")
	}
	if !visibleSaved(map[string]string{heldField: "1", "text": "private"}, true) {
		t.Fatal("approver should see held content")
	}
	if !visibleSaved(map[string]string{"text": "public"}, false) {
		t.Fatal("public message hidden")
	}
}

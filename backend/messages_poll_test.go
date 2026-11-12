package main

import (
	"net/http/httptest"
	"testing"
)

// The extension's background check (?poll=1) must not count as a view or as a visit; every other request still does.
func TestIsBackgroundPoll(t *testing.T) {
	cases := map[string]bool{
		"/api/messages":                 false,
		"/api/messages?limit=30":        false,
		"/api/messages?limit=50&poll=1": true,
		"/api/messages?poll=1":          true,
		"/api/messages?poll=0":          false,
		"/api/messages?poll=true":       false, // only the exact value "1" is the extension's mark
		"/api/messages?poll=":           false,
	}
	for url, want := range cases {
		if got := isBackgroundPoll(httptest.NewRequest("GET", url, nil)); got != want {
			t.Errorf("isBackgroundPoll(%q) = %v, want %v", url, got, want)
		}
	}
}

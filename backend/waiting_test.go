package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Tests of what waits for an approver (waiting.go). They need a Redis only because the package connects to one when it starts.
//   go test -run Waiting .

func writeWaitingFile(t *testing.T, id string, meta map[string]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(metadataPath(id)), 0755); err != nil {
		t.Fatal(err)
	}
	if err := writeMetadata(id, meta); err != nil {
		t.Fatal(err)
	}
}

func TestWaitingKind(t *testing.T) {
	oldHold, oldStrict := holdVideos, strictUntilReviewed
	t.Cleanup(func() { holdVideos, strictUntilReviewed = oldHold, oldStrict })

	people := map[string]any{"autoDecision": "blurred", "autoReasons": []any{"person"}}
	merge := func(base map[string]any, extra map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range base {
			out[k] = v
		}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	cases := []struct {
		name         string
		hold, strict bool
		meta         map[string]any
		want         string
	}{
		{"held video", true, false, map[string]any{"type": "video", "holdRequired": true}, waitingVideo},
		{"approved video", true, false, map[string]any{"type": "video", "holdRequired": true, "approvedAt": "2026-10-28T10:00:00Z"}, ""},
		{"video from before the flag", true, false, map[string]any{"type": "video"}, ""},
		{"hold flag off", false, false, map[string]any{"type": "video", "holdRequired": true}, ""},
		{"crowd video, strict", false, true, map[string]any{"type": "video", "autoNeedsReview": true}, waitingVideo},
		{"crowd video reviewed", false, true, map[string]any{"type": "video", "autoNeedsReview": true, "figuresReviewedAt": "2026-10-28T10:00:00Z"}, ""},
		{"image with people, strict", false, true, merge(people, map[string]any{"type": "image"}), waitingImage},
		{"image with people, not strict", false, false, merge(people, map[string]any{"type": "image"}), ""},
		{"image with people, reviewed", false, true, merge(people, map[string]any{"type": "image", "figuresReviewedAt": "2026-10-28T10:00:00Z"}), ""},
		{"image decided by hand", false, true, merge(people, map[string]any{"type": "image", "reviewedBy": "a@example.com"}), ""},
		{"image without people", false, true, map[string]any{"type": "image", "autoDecision": "open", "autoReasons": []any{"no_people"}}, ""},
		{"image not checked yet", false, true, map[string]any{"type": "image"}, ""},
		{"a document", true, true, map[string]any{"type": "document", "holdRequired": true}, ""},
	}
	for _, c := range cases {
		holdVideos, strictUntilReviewed = c.hold, c.strict
		if got := waitingKind(c.meta); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestWaitingSummaryCountsAndInvalidates(t *testing.T) {
	oldRoot, oldHold, oldStrict := rootUploadPath, holdVideos, strictUntilReviewed
	t.Cleanup(func() {
		rootUploadPath, holdVideos, strictUntilReviewed = oldRoot, oldHold, oldStrict
		waitingInvalidate()
	})
	rootUploadPath, holdVideos, strictUntilReviewed = t.TempDir(), true, true
	waitingInvalidate()

	v1 := "1111111111111111111111111111111111111111"
	v2 := "2222222222222222222222222222222222222222"
	i1 := "3333333333333333333333333333333333333333"
	done := "4444444444444444444444444444444444444444"
	writeWaitingFile(t, v1, map[string]any{"type": "video", "holdRequired": true, "uploadedAt": "2026-10-28T12:00:00Z", "filename": "late.mp4"})
	writeWaitingFile(t, v2, map[string]any{"type": "video", "holdRequired": true, "uploadedAt": "2026-10-28T08:00:00Z", "filename": "early.mp4"})
	writeWaitingFile(t, i1, map[string]any{"type": "image", "autoDecision": "blurred", "autoReasons": []any{"person"}, "uploadedAt": "2026-10-28T10:00:00Z"})
	writeWaitingFile(t, done, map[string]any{"type": "video", "holdRequired": true, "approvedAt": "2026-10-28T09:00:00Z"})

	s := currentWaiting()
	if s.Videos != 2 || s.Images != 1 || len(s.Items) != 3 {
		t.Fatalf("counts: %+v", s)
	}
	if s.Items[0].ID != v2 || s.Items[2].ID != v1 {
		t.Errorf("the oldest should come first: %+v", s.Items)
	}

	// approve one: the cached answer is old until a change is announced
	writeWaitingFile(t, v2, map[string]any{"type": "video", "holdRequired": true, "approvedAt": "2026-10-28T13:00:00Z"})
	if got := currentWaiting(); got.Videos != 2 {
		t.Errorf("within the cache time the answer is the same, got %d videos", got.Videos)
	}
	waitingInvalidate()
	if got := currentWaiting(); got.Videos != 1 || got.Images != 1 {
		t.Errorf("after a change: %+v", got)
	}
}

func TestWaitingEndpoint(t *testing.T) {
	oldRoot, oldHold, oldStrict := rootUploadPath, holdVideos, strictUntilReviewed
	t.Cleanup(func() {
		rootUploadPath, holdVideos, strictUntilReviewed = oldRoot, oldHold, oldStrict
		waitingInvalidate()
	})
	rootUploadPath, holdVideos, strictUntilReviewed = t.TempDir(), true, true
	waitingInvalidate()
	writeWaitingFile(t, "5555555555555555555555555555555555555555", map[string]any{"type": "video", "holdRequired": true, "filename": "a.mp4"})

	// the handler itself. Its guard is protectedWithApprover, the one of the review grid (the roles are tested in privileges_roles_test.go);
	// "a reader who is not signed in gets 401" needs the session store and is checked against the running stack.
	rec := httptest.NewRecorder()
	getWaiting(rec, httptest.NewRequest(http.MethodGet, "/api/admin/hold/waiting", nil))
	var got waitingSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("%v: %q", err, rec.Body.String())
	}
	if got.Videos != 1 || got.Images != 0 || len(got.Items) != 1 || got.Items[0].Filename != "a.mp4" {
		t.Errorf("answer: %+v", got)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("the answer must not be cached by the browser")
	}
}

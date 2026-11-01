package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
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

func TestWaitingSince(t *testing.T) {
	oldRoot, oldHold, oldStrict, oldSince := rootUploadPath, holdVideos, strictUntilReviewed, waitingSince
	t.Cleanup(func() {
		rootUploadPath, holdVideos, strictUntilReviewed, waitingSince = oldRoot, oldHold, oldStrict, oldSince
		waitingInvalidate()
	})
	rootUploadPath, holdVideos, strictUntilReviewed = t.TempDir(), true, true

	old := "6666666666666666666666666666666666666666"
	noDate := "7777777777777777777777777777777777777777"
	today := "8888888888888888888888888888888888888888"
	writeWaitingFile(t, old, map[string]any{"type": "video", "holdRequired": true, "uploadedAt": "2026-10-30T20:00:00Z"})
	writeWaitingFile(t, noDate, map[string]any{"type": "video", "holdRequired": true})
	writeWaitingFile(t, today, map[string]any{"type": "video", "holdRequired": true, "uploadedAt": "2026-10-30T22:30:00Z"})

	waitingSince = time.Time{}
	waitingInvalidate()
	if got := currentWaiting(); got.Videos != 3 {
		t.Errorf("without a date everything waits: %+v", got)
	}

	waitingSince = parseWaitingSince("2026-10-31") // the start of the day in Israel: 22:00 UTC the evening before (winter time)
	waitingInvalidate()
	got := currentWaiting()
	if got.Videos != 1 || got.Items[0].ID != today {
		t.Errorf("from 2026-10-31 only the new one is counted: %+v", got)
	}

	for in, want := range map[string]string{
		"2026-10-31T10:00:00Z": "2026-10-31T10:00:00Z",
		"":                     "0001-01-01T00:00:00Z",
		"not a date":           "0001-01-01T00:00:00Z",
	} {
		if got := parseWaitingSince(in).UTC().Format(time.RFC3339); got != want {
			t.Errorf("parseWaitingSince(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestWaitingIgnoresDeletedMessages(t *testing.T) {
	oldRoot, oldHold, oldStrict := rootUploadPath, holdVideos, strictUntilReviewed
	ctx := context.Background()
	keys := []string{"messages:990001", "messages:990002", "messages:990003"}
	t.Cleanup(func() {
		rootUploadPath, holdVideos, strictUntilReviewed = oldRoot, oldHold, oldStrict
		for _, k := range keys {
			rdb.Del(ctx, k)
			rdb.ZRem(ctx, "m_times:1", k)
		}
		waitingInvalidate()
	})
	rootUploadPath, holdVideos, strictUntilReviewed = t.TempDir(), true, true

	gone := "9999999999999999999999999999999999999991"
	kept := "9999999999999999999999999999999999999992"
	loose := "9999999999999999999999999999999999999993"
	for _, id := range []string{gone, kept, loose} {
		writeWaitingFile(t, id, map[string]any{"type": "video", "holdRequired": true})
	}
	rdb.HSet(ctx, keys[0], "text", "/api/files/"+gone, "deleted", true)
	rdb.HSet(ctx, keys[1], "text", "/api/files/"+kept, "deleted", false)
	rdb.HSet(ctx, keys[2], "text", "*ההודעה נמחקה*", "deleted", true)
	for i, k := range keys {
		rdb.ZAdd(ctx, "m_times:1", redis.Z{Score: float64(990001 + i), Member: k})
	}

	waitingInvalidate()
	got := currentWaiting()
	if got.Videos != 2 {
		t.Fatalf("want the live message's file and the file no message uses: %+v", got)
	}
	for _, it := range got.Items {
		if it.ID == gone {
			t.Errorf("a file of a deleted message must not be counted")
		}
	}
}

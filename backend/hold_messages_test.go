package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// Tests of the hidden message of a held video (hold_messages.go). They need any Redis/kvrocks (see moderation/README.md):
//   REDIS_PROTOCOL=tcp REDIS_ADDR=127.0.0.1:16666 go test -run HeldMessage .

const (
	heldVidA = "8888888888888888888888888888888888888881"
	heldVidB = "8888888888888888888888888888888888888882"
)

type heldEnv struct {
	ctx      context.Context
	webhooks *atomic.Int32
	ids      []int
	// announced: how many webhook goroutines the test has started (one per announced message). Cleanup waits until the
	// server has received that many, so no goroutine still reads settingConfig.WebhookURL when the next test changes it.
	announced int
}

func newHeldEnv(t *testing.T) *heldEnv {
	t.Helper()
	oldRoot, oldHold, oldHook := rootUploadPath, holdVideos, settingConfig.WebhookURL
	e := &heldEnv{ctx: context.Background(), webhooks: &atomic.Int32{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { e.webhooks.Add(1) }))
	heldMu.Lock()
	rootUploadPath, holdVideos, settingConfig.WebhookURL = t.TempDir(), true, srv.URL
	heldMu.Unlock()
	t.Cleanup(func() {
		deadline := time.Now().Add(5 * time.Second)
		for e.webhooks.Load() < int32(e.announced) && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if got := e.webhooks.Load(); got < int32(e.announced) {
			t.Errorf("only %d of %d webhook goroutines finished before cleanup", got, e.announced)
		}
		srv.Close()
		// The release goroutines (holdNewMessage) read rootUploadPath under heldMu: restore under the same lock,
		// so every read by them is ordered before this write (or after it, with the lock as the ordering).
		heldMu.Lock()
		rootUploadPath, holdVideos, settingConfig.WebhookURL = oldRoot, oldHold, oldHook
		heldMu.Unlock()
		for _, id := range e.ids {
			k := fmt.Sprintf("messages:%d", id)
			rdb.Del(e.ctx, k)
			rdb.ZRem(e.ctx, "m_times:1", k)
			rdb.ZRem(e.ctx, pinnedKey, fmt.Sprint(id))
			rdb.SRem(e.ctx, heldMessagesSet, fmt.Sprint(id))
		}
		rdb.Del(e.ctx, heldByFileKey(heldVidA), heldByFileKey(heldVidB))
	})
	return e
}

func (e *heldEnv) video(t *testing.T, id string, held bool) {
	t.Helper()
	meta := map[string]any{"type": "video"}
	if held {
		meta["holdRequired"] = true
	}
	writeWaitingFile(t, id, meta)
}

func (e *heldEnv) approve(t *testing.T, id string) {
	t.Helper()
	writeWaitingFile(t, id, map[string]any{"type": "video", "holdRequired": true, "approvedAt": "2026-11-11T10:00:00Z"})
	e.countReleases(func() { releaseHeldFor(id) })
}

// countReleases runs a release (approval, sweep) and counts the messages of this test it released and did not delete:
// each of them started one webhook goroutine (see releaseHeldMessage).
func (e *heldEnv) countReleases(run func()) {
	wasHeld := map[int]bool{}
	for _, mid := range e.ids {
		if v, _ := rdb.HGet(e.ctx, fmt.Sprintf("messages:%d", mid), heldField).Result(); v == "1" {
			wasHeld[mid] = true
		}
	}
	run()
	for mid := range wasHeld {
		h, _ := rdb.HGetAll(e.ctx, fmt.Sprintf("messages:%d", mid)).Result()
		if h[heldField] != "1" && h["deleted"] != "1" && h["deleted"] != "true" {
			e.announced++
		}
	}
}

// post stores a message the way the import API does (setMessage + the follow-up) and returns it.
func (e *heldEnv) post(t *testing.T, id int, text string, ts time.Time) *Message {
	t.Helper()
	e.ids = append(e.ids, id)
	m := &Message{ID: id, Type: "md", Text: text, Timestamp: ts}
	if err := setMessage(e.ctx, m, false); err != nil {
		t.Fatal(err)
	}
	if !m.Held {
		e.announced++ // afterMessageCreated starts one webhook goroutine for a message that is not held
	}
	afterMessageCreated(m)
	return m
}

func (e *heldEnv) listIDs(t *testing.T, admin bool) []int {
	t.Helper()
	msgs, err := funcGetMessageRange(e.ctx, 0, 50, admin, false, "desc", "", admin)
	if err != nil {
		t.Fatal(err)
	}
	var out []int
	for _, m := range msgs {
		if m.ID >= 880000 && m.ID < 881000 {
			out = append(out, m.ID)
		}
	}
	return out
}

func contains(ids []int, id int) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for i := 0; i < 50; i++ {
		if ok() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

func TestHeldMessageHiddenFromReadersUntilApproved(t *testing.T) {
	e := newHeldEnv(t)
	e.video(t, heldVidA, true)
	old := time.Now().Add(-2 * time.Hour)

	plain := e.post(t, 880001, "הודעה רגילה", old)
	held := e.post(t, 880002, "טקסט עם סרטון /api/files/"+heldVidA, old.Add(time.Minute))
	if plain.Held || !held.Held {
		t.Fatalf("held flags: plain=%v held=%v", plain.Held, held.Held)
	}

	if ids := e.listIDs(t, false); contains(ids, 880002) || !contains(ids, 880001) {
		t.Fatalf("readers must get the plain message only: %v", ids)
	}
	adminIDs := e.listIDs(t, true)
	if !contains(adminIDs, 880002) {
		t.Fatalf("managers must see the held message: %v", adminIDs)
	}
	msgs, _ := funcGetMessageRange(e.ctx, 0, 50, true, false, "desc", "", true)
	for _, m := range msgs {
		if m.ID == 880002 && !m.Held {
			t.Errorf("a manager's copy must say it is held")
		}
	}

	// the same everywhere else
	if res, _ := dbSearchMessages(e.ctx, []string{"סרטון"}, "", 10, false); len(res) != 0 {
		t.Errorf("search shows a held message to readers: %+v", res)
	}
	if res, _ := dbSearchMessages(e.ctx, []string{"סרטון"}, "", 10, true); len(res) != 1 {
		t.Errorf("search hides a held message from managers: %+v", res)
	}
	if err := dbSetPinned(e.ctx, 880002, true); err != nil {
		t.Fatal(err)
	}
	if list, _ := dbGetPinned(e.ctx, false); len(list) != 0 {
		t.Errorf("the pins show a held message to readers: %+v", list)
	}
	if list, _ := dbGetPinned(e.ctx, true); len(list) != 1 {
		t.Errorf("the pins hide a held message from managers: %+v", list)
	}
	if !messageIsHeld(e.ctx, 880002) || messageIsHeld(e.ctx, 880001) {
		t.Errorf("messageIsHeld is wrong")
	}

	// the push and the webhook did not go out for the held one (the plain one sent its webhook)
	waitFor(t, "the webhook of the plain message", func() bool { return e.webhooks.Load() == 1 })
	time.Sleep(200 * time.Millisecond)
	if n := e.webhooks.Load(); n != 1 {
		t.Fatalf("webhooks before the approval: %d, want 1 (the plain message only)", n)
	}
}

func TestHeldMessageReleasedOnceOnTop(t *testing.T) {
	e := newHeldEnv(t)
	e.video(t, heldVidA, true)
	sub := rdb.Subscribe(e.ctx, "events")
	defer sub.Close()
	if _, err := sub.Receive(e.ctx); err != nil {
		t.Fatal(err)
	}
	var newEvents atomic.Int32
	go func() {
		for msg := range sub.Channel() {
			if strings.Contains(msg.Payload, `"approversOnly":true`) {
				continue // the approvers' copy of a held message: not an announcement to the readers
			}
			if strings.Contains(msg.Payload, `"new-message"`) && strings.Contains(msg.Payload, "released one") {
				newEvents.Add(1)
			}
		}
	}()

	old := time.Now().Add(-3 * time.Hour)
	e.post(t, 880011, "released one /api/files/"+heldVidA, old)
	newer := e.post(t, 880012, "a newer plain message", old.Add(time.Hour))
	_ = newer
	if ids := e.listIDs(t, false); contains(ids, 880011) {
		t.Fatalf("held message visible: %v", ids)
	}
	time.Sleep(200 * time.Millisecond)
	if newEvents.Load() != 0 || e.webhooks.Load() != 1 {
		t.Fatalf("a held message was announced: events=%d webhooks=%d", newEvents.Load(), e.webhooks.Load())
	}

	e.approve(t, heldVidA)
	waitFor(t, "the release", func() bool { return contains(e.listIDs(t, false), 880011) })
	ids := e.listIDs(t, false)
	if len(ids) < 2 || ids[0] != 880011 {
		t.Errorf("the released message must be on top (the time of the approval): %v", ids)
	}
	waitFor(t, "the live event", func() bool { return newEvents.Load() == 1 })
	waitFor(t, "the webhook", func() bool { return e.webhooks.Load() == 2 })

	// a second approval / sweep / release must not announce again
	releaseHeldFor(heldVidA)
	sweepHeldMessages()
	if releaseHeldMessage(880011) {
		t.Errorf("a released message was released again")
	}
	time.Sleep(300 * time.Millisecond)
	if newEvents.Load() != 1 || e.webhooks.Load() != 2 {
		t.Errorf("announced more than once: events=%d webhooks=%d", newEvents.Load(), e.webhooks.Load())
	}
}

func TestHeldMessageWaitsForEveryVideo(t *testing.T) {
	e := newHeldEnv(t)
	e.video(t, heldVidA, true)
	e.video(t, heldVidB, true)
	e.post(t, 880021, "two videos /api/files/"+heldVidA+" /api/files/"+heldVidB, time.Now().Add(-time.Hour))

	e.approve(t, heldVidA)
	time.Sleep(200 * time.Millisecond)
	if contains(e.listIDs(t, false), 880021) {
		t.Fatalf("released after one of two videos")
	}
	e.approve(t, heldVidB)
	waitFor(t, "release after the second video", func() bool { return contains(e.listIDs(t, false), 880021) })
}

func TestHeldMessageOnlyForNewMessagesAndHeldVideos(t *testing.T) {
	e := newHeldEnv(t)
	e.video(t, heldVidA, false) // uploaded before the flag: no holdRequired
	m := e.post(t, 880031, "old video /api/files/"+heldVidA, time.Now())
	if m.Held || messageIsHeld(e.ctx, 880031) {
		t.Fatalf("a video that is not held must not hold its message")
	}

	// flag off: nothing is held, even for a video that has the mark
	e.video(t, heldVidB, true)
	holdVideos = false
	m = e.post(t, 880032, "flag off /api/files/"+heldVidB, time.Now())
	if m.Held {
		t.Fatalf("held while the flag is off")
	}
	holdVideos = true

	// an image-only or a text-only message is never held
	if m = e.post(t, 880033, "text only", time.Now()); m.Held {
		t.Fatalf("text-only message held")
	}
}

func TestHeldMessageEditStaysHiddenAndSweepReleases(t *testing.T) {
	e := newHeldEnv(t)
	e.video(t, heldVidA, true)
	sub := rdb.Subscribe(e.ctx, "events")
	defer sub.Close()
	if _, err := sub.Receive(e.ctx); err != nil {
		t.Fatal(err)
	}
	var seen atomic.Int32
	go func() {
		for msg := range sub.Channel() {
			if strings.Contains(msg.Payload, "edited held") && !strings.Contains(msg.Payload, `"approversOnly":true`) {
				seen.Add(1) // an event the readers would get
			}
		}
	}()

	m := e.post(t, 880041, "first /api/files/"+heldVidA, time.Now().Add(-time.Hour))
	edit := &Message{ID: 880041, Type: "md", Text: "edited held /api/files/" + heldVidA, Timestamp: m.Timestamp}
	if err := setMessage(e.ctx, edit, true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if seen.Load() != 0 || !messageIsHeld(e.ctx, 880041) {
		t.Fatalf("an edit of a held message reached the readers or lifted the hold (events=%d)", seen.Load())
	}

	// the approval was written but the release never ran (a restart): the sweep at start finds it
	writeWaitingFile(t, heldVidA, map[string]any{"type": "video", "holdRequired": true, "approvedAt": "2026-11-11T10:00:00Z"})
	e.countReleases(sweepHeldMessages)
	if messageIsHeld(e.ctx, 880041) {
		t.Fatalf("the sweep did not release the message")
	}
	if _, err := rdb.SIsMember(e.ctx, heldMessagesSet, "880041").Result(); err != nil && err != redis.Nil {
		t.Fatal(err)
	}
}

// A Writer who may not approve (isAdmin: the author is shown) still does not get a held message: the two questions are separate.
func TestHeldMessageNeedsTheApprovalRightNotWriter(t *testing.T) {
	e := newHeldEnv(t)
	e.video(t, heldVidA, true)
	e.post(t, 880051, "held for the writer test /api/files/"+heldVidA, time.Now())
	msgs, err := funcGetMessageRange(e.ctx, 0, 50, true, false, "desc", "", false) // isAdmin (Writer), seeHeld false
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range msgs {
		if m.ID == 880051 {
			t.Fatalf("a Writer without the right to approve got the held message")
		}
	}
	msgs, _ = funcGetMessageRange(e.ctx, 0, 50, false, false, "desc", "", true) // an approver who is not a Writer
	found := false
	for _, m := range msgs {
		found = found || (m.ID == 880051 && m.Held && m.Author == "Anonymous")
	}
	if !found {
		t.Fatalf("an approver without Writer must get the held message (the author stays hidden)")
	}
}

// The live stream: a held message is published marked for approvers only; its release goes out to everyone.
func TestHeldMessageEventsAreMarkedForApprovers(t *testing.T) {
	e := newHeldEnv(t)
	e.video(t, heldVidA, true)
	sub := rdb.Subscribe(e.ctx, "events")
	defer sub.Close()
	if _, err := sub.Receive(e.ctx); err != nil {
		t.Fatal(err)
	}
	var held, open atomic.Int32
	go func() {
		for msg := range sub.Channel() {
			if !strings.Contains(msg.Payload, "events marker") {
				continue
			}
			if strings.Contains(msg.Payload, `"approversOnly":true`) {
				held.Add(1)
			} else if strings.Contains(msg.Payload, `"new-message"`) {
				open.Add(1)
			}
		}
	}()
	e.post(t, 880061, "events marker /api/files/"+heldVidA, time.Now())
	waitFor(t, "the approvers-only event", func() bool { return held.Load() == 1 })
	if open.Load() != 0 {
		t.Fatalf("the held message went out as an open event")
	}
	e.approve(t, heldVidA)
	waitFor(t, "the open release event", func() bool { return open.Load() == 1 })
	if held.Load() != 1 {
		t.Errorf("held events: %d", held.Load())
	}
}

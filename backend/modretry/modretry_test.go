package modretry

import (
	"errors"
	"testing"
	"time"
)

type memStore struct {
	n    map[string]int
	fail bool
}

func (m *memStore) Incr(id string) (int, error) {
	if m.fail {
		return 0, errors.New("redis down")
	}
	m.n[id]++
	return m.n[id], nil
}
func (m *memStore) Clear(id string) { delete(m.n, id) }

func newTracker(max int) (*Tracker, *memStore, *time.Time) {
	st := &memStore{n: map[string]int{}}
	tr := New(max, 3*time.Minute, st)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	tr.now = func() time.Time { return now }
	return tr, st, &now
}

func TestGivesUpAfterMaxAttempts(t *testing.T) {
	tr, _, _ := newTracker(3)
	for i := 1; i <= 2; i++ {
		if n, giveUp := tr.Failed("a"); n != i || giveUp {
			t.Fatalf("attempt %d: got n=%d giveUp=%v", i, n, giveUp)
		}
	}
	if n, giveUp := tr.Failed("a"); n != 3 || !giveUp {
		t.Fatalf("third failure must give up, got n=%d giveUp=%v", n, giveUp)
	}
}

func TestPauseGrowsWithAttempts(t *testing.T) {
	tr, _, now := newTracker(5)
	tr.Failed("a")
	if tr.Ready("a") {
		t.Fatal("a failed file must be paused")
	}
	*now = now.Add(3*time.Minute + time.Second)
	if !tr.Ready("a") {
		t.Fatal("first pause is 1 x delay")
	}
	tr.Failed("a") // second failure: 2 x delay
	*now = now.Add(5 * time.Minute)
	if tr.Ready("a") {
		t.Fatal("second pause is 2 x delay (6 min), 5 min is too early")
	}
	*now = now.Add(2 * time.Minute)
	if !tr.Ready("a") {
		t.Fatal("6+ minutes later it is ready again")
	}
}

func TestOtherFilesAreNotPaused(t *testing.T) {
	tr, _, _ := newTracker(3)
	tr.Failed("bad")
	if !tr.Ready("good") || !tr.TryQueue("good") {
		t.Fatal("one bad file must not hold back the others")
	}
}

func TestSweepDoesNotQueueDuplicates(t *testing.T) {
	tr, _, _ := newTracker(3)
	if !tr.TryQueue("a") {
		t.Fatal("first sweep queues the file")
	}
	if tr.TryQueue("a") {
		t.Fatal("second sweep must not queue it again while it waits")
	}
	if tr.Started("a") {
		t.Fatal("not paused")
	}
	if tr.TryQueue("a") {
		t.Fatal("must not queue a file that is being checked")
	}
	tr.Finished("a")
	if !tr.TryQueue("a") {
		t.Fatal("after the check it may be queued again")
	}
}

func TestWorkerSkipsPausedFile(t *testing.T) {
	tr, _, _ := newTracker(3)
	tr.Failed("a")
	if !tr.Started("a") {
		t.Fatal("a paused file must be skipped by the worker")
	}
	if tr.TryQueue("a") {
		t.Fatal("and the sweep must not queue it before the pause is over")
	}
}

func TestResetForgetsEverything(t *testing.T) {
	tr, st, _ := newTracker(3)
	tr.Failed("a")
	tr.Failed("a")
	tr.Reset("a")
	if st.n["a"] != 0 || !tr.Ready("a") {
		t.Fatal("Reset clears the count and the pause")
	}
	if n, _ := tr.Failed("a"); n != 1 {
		t.Fatalf("counting starts again, got %d", n)
	}
}

func TestCountsInMemoryWhenStoreFails(t *testing.T) {
	tr, st, _ := newTracker(2)
	st.fail = true
	if _, giveUp := tr.Failed("a"); giveUp {
		t.Fatal("first failure")
	}
	if n, giveUp := tr.Failed("a"); n != 2 || !giveUp {
		t.Fatalf("must still give up with Redis down, got n=%d giveUp=%v", n, giveUp)
	}
}

func TestMaxZeroNeverGivesUp(t *testing.T) {
	tr, _, _ := newTracker(0)
	for i := 0; i < 20; i++ {
		if _, giveUp := tr.Failed("a"); giveUp {
			t.Fatal("max 0 = no limit")
		}
	}
}

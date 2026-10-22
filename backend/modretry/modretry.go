// Package modretry keeps the books of the automatic media check: how often a file's check failed, when it may be tried again, and
// which files are already waiting in a queue. It has no Redis or HTTP of its own (the count is kept in a Store), so it can be tested
// anywhere.
//
// Why: a file that the service cannot check (it crashes or runs out of memory on it, or it hangs) used to be retried for ever. The
// 2-minute sweep put every pending file back into the queue, each try could hold the single video worker for up to 45 minutes, and
// the queue filled with duplicates, so one bad video blocked all the others.
package modretry

import (
	"sync"
	"time"
)

// Store keeps the number of failed attempts per file (Redis in production; it survives a restart of the backend).
type Store interface {
	// Incr adds one failed attempt and returns the new total.
	Incr(id string) (int, error)
	Clear(id string)
}

type Tracker struct {
	max   int           // failed attempts after which the file is given up (0 or less = never)
	delay time.Duration // wait before the next try: delay * attempts so far
	store Store
	now   func() time.Time

	mu       sync.Mutex
	local    map[string]int // fallback when the Store fails
	retryAt  map[string]time.Time
	queued   map[string]bool
	inflight map[string]bool
}

func New(max int, delay time.Duration, store Store) *Tracker {
	return &Tracker{max: max, delay: delay, store: store, now: time.Now, local: map[string]int{},
		retryAt: map[string]time.Time{}, queued: map[string]bool{}, inflight: map[string]bool{}}
}

// Failed records one failed attempt. giveUp is true once the file has failed `max` times; otherwise the file may be tried
// again only after a growing pause.
func (t *Tracker) Failed(id string) (attempts int, giveUp bool) {
	n, err := t.store.Incr(id)
	t.mu.Lock()
	defer t.mu.Unlock()
	if err != nil { // Redis is not answering: count in memory, a restart forgets it (the next failures count again)
		t.local[id]++
		n = t.local[id]
	}
	if t.max > 0 && n >= t.max {
		return n, true
	}
	t.retryAt[id] = t.now().Add(t.delay * time.Duration(n))
	return n, false
}

// Reset forgets everything about the file (it succeeded, was given up, or a moderator asked for a new check).
func (t *Tracker) Reset(id string) {
	t.store.Clear(id)
	t.mu.Lock()
	delete(t.local, id)
	delete(t.retryAt, id)
	t.mu.Unlock()
}

// Ready: the file is not in its pause after a failure.
func (t *Tracker) Ready(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return !t.now().Before(t.retryAt[id])
}

// TryQueue is for the periodic sweep: true (and the file is marked as waiting) only if it is not paused, not waiting in a queue and
// not being checked right now.
func (t *Tracker) TryQueue(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.queued[id] || t.inflight[id] || t.now().Before(t.retryAt[id]) {
		return false
	}
	t.queued[id] = true
	return true
}

// Started / Finished bracket one check of the file by a worker. Started clears the "waiting" mark and reports whether the file is
// still paused (the worker then skips it; the sweep brings it back later).
func (t *Tracker) Started(id string) (paused bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.queued, id)
	if t.now().Before(t.retryAt[id]) {
		return true
	}
	t.inflight[id] = true
	return false
}

func (t *Tracker) Finished(id string) {
	t.mu.Lock()
	delete(t.inflight, id)
	t.mu.Unlock()
}

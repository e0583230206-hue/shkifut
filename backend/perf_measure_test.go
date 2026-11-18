package main

// Performance measurement for the personal-area summary (M1) and the waiting count (M2).
// Skipped unless PERF_MEASURE=1. It only runs against a throwaway store: REDIS_ADDR must be 127.0.0.1:16666
// (a fresh kvrocks container), and the test FLUSHDBs that store before it seeds data.
//
//	PERF_MEASURE=1 REDIS_PROTOCOL=tcp REDIS_ADDR=127.0.0.1:16666 go test -run TestPerfMeasure -v -count=1 .

import (
	"context"
	"fmt"
	"os"
	"sort"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// cmdCounter counts Redis commands (a pipeline counts each command).
type cmdCounter struct{ n *int64 }

func (c cmdCounter) DialHook(next redis.DialHook) redis.DialHook { return next }
func (c cmdCounter) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		atomic.AddInt64(c.n, 1)
		return next(ctx, cmd)
	}
}
func (c cmdCounter) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		atomic.AddInt64(c.n, int64(len(cmds)))
		return next(ctx, cmds)
	}
}

func perfGuard(t *testing.T) {
	if os.Getenv("PERF_MEASURE") != "1" {
		t.Skip("set PERF_MEASURE=1 to run the performance measurement")
	}
	if redisAddr != "127.0.0.1:16666" {
		t.Fatalf("refused: the measurement only runs on the throwaway store 127.0.0.1:16666, got %q", redisAddr)
	}
	// the measurement backfills the global file index: leave the throwaway store empty afterwards
	t.Cleanup(func() { rdb.FlushDB(context.Background()) })
}

// medianMs runs f n times and returns the median duration in milliseconds.
func medianMs(n int, f func()) float64 {
	d := make([]float64, n)
	for i := 0; i < n; i++ {
		s := time.Now()
		f()
		d[i] = float64(time.Since(s).Microseconds()) / 1000
	}
	sort.Float64s(d)
	return d[n/2]
}

// seedItems: n reports and n contact messages, each by a different sender; the reader owns none of them
// except one report (so the reader's own item is in the list too).
func seedItems(t *testing.T, ctx context.Context, n int) Session {
	reader := Session{ID: "reader-perf", Email: "reader-perf@example.test"}
	pipe := rdb.Pipeline()
	for i := 1; i <= n; i++ {
		key := fmt.Sprintf("report:%d", i)
		owner := fmt.Sprintf("other-%d", i)
		if i == 1 {
			owner = reader.ID
		}
		pipe.HSet(ctx, key, "id", i, "reporterId", owner, "reason", "perf report", "createdAt", "2026-11-18T10:00:00Z", "closed", "0")
		pipe.ZAdd(ctx, "reports:list", redis.Z{Score: float64(1000 + i), Member: key})
		ck := fmt.Sprintf("contact:%d", i)
		cowner := fmt.Sprintf("sender-%d@example.test", i)
		if i == 2 {
			cowner = reader.Email
		}
		pipe.HSet(ctx, ck, "id", i, "userEmail", cowner, "subject", "perf", "message", "perf message", "createdAt", "2026-11-18T10:00:00Z", "handled", "0")
		pipe.ZAdd(ctx, "contact:list", redis.Z{Score: float64(1000 + i), Member: ck})
	}
	if _, err := pipe.Exec(ctx); err != nil {
		t.Fatal(err)
	}
	return reader
}

func TestPerfMeasureM1PersonalSummary(t *testing.T) {
	perfGuard(t)
	ctx := context.Background()
	var cmds int64
	rdb.AddHook(cmdCounter{&cmds})
	for _, n := range []int{0, 50, 200, 500, 1000} {
		rdb.FlushDB(ctx)
		reader := seedItems(t, ctx, n)
		atomic.StoreInt64(&cmds, 0)
		myItems(ctx, reader) // one call to count commands
		c := atomic.LoadInt64(&cmds)
		ms := medianMs(15, func() { myItems(ctx, reader) })
		t.Logf("M1 myItems (summary) with %4d reports + %4d contacts: median %.2f ms, Redis commands per call: %d", n, n, ms, c)
	}
}

// seedMessages: m messages in the time index; every 10th one references a file. Half the referencing
// messages are deleted, and the file IDs in the first 5 of them are "only deleted" for the question asked.
func seedMessages(t *testing.T, ctx context.Context, m int) (map[string]bool, []string) {
	pipe := rdb.Pipeline()
	ids := map[string]bool{}
	var query []string
	for i := 1; i <= m; i++ {
		key := fmt.Sprintf("messages:%d", i)
		text := fmt.Sprintf("message %d", i)
		deleted := "0"
		if i%10 == 0 {
			fid := fmt.Sprintf("%040x", i)
			text = "video /api/files/" + fid
			if (i/10)%2 == 0 {
				deleted = "1"
			}
			if len(query) < 20 {
				ids[fid] = true
				query = append(query, fid)
			}
		}
		pipe.HSet(ctx, key, "text", text, "deleted", deleted)
		pipe.ZAdd(ctx, "m_times:1", redis.Z{Score: float64(i), Member: key})
	}
	if _, err := pipe.Exec(ctx); err != nil {
		t.Fatal(err)
	}
	return ids, query
}

func TestPerfMeasureM2WaitingCount(t *testing.T) {
	perfGuard(t)
	ctx := context.Background()
	var cmds int64
	rdb.AddHook(cmdCounter{&cmds})
	for _, m := range []int{1000, 10000, 50000} {
		rdb.FlushDB(ctx)
		ids, _ := seedMessages(t, ctx, m)
		// BEFORE: the original full scan (the index flag is absent after FlushDB, so deletedOnlyAmong would scan too)
		atomic.StoreInt64(&cmds, 0)
		deletedOnlyAmongScan(ids)
		cBefore := atomic.LoadInt64(&cmds)
		msBefore := medianMs(7, func() { deletedOnlyAmongScan(ids) })
		t.Logf("M2 BEFORE (full scan), 20 files, %6d messages: median %.2f ms, Redis commands per call: %d", m, msBefore, cBefore)
		// backfill (one-time): timed
		start := time.Now()
		if _, _, err := backfillFileIndex(ctx); err != nil {
			t.Fatal(err)
		}
		t.Logf("M2 backfill of %6d messages: %.2f ms (one-time)", m, float64(time.Since(start).Microseconds())/1000)
		// AFTER: the indexed answer, must equal the scan's
		if !sameSet(scanReference(ids), indexedAnswer(ctx, ids)) {
			t.Fatal("indexed answer differs from the scan")
		}
		atomic.StoreInt64(&cmds, 0)
		deletedOnlyAmong(ids)
		cAfter := atomic.LoadInt64(&cmds)
		msAfter := medianMs(7, func() { deletedOnlyAmong(ids) })
		t.Logf("M2 AFTER (index),       20 files, %6d messages: median %.2f ms, Redis commands per call: %d", m, msAfter, cAfter)
	}
}

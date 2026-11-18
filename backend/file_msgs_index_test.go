package main

// Tests for the M2 file index. They FLUSH the store, so they run only with FILE_INDEX_TEST=1 on the throwaway store
// 127.0.0.1:16666 (the same guard as perf_measure_test.go). Normal `go test` skips them.
//
//	FILE_INDEX_TEST=1 REDIS_PROTOCOL=tcp REDIS_ADDR=127.0.0.1:16666 go test -run TestFileIndex -v -count=1 .

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func fileIndexGuard(t *testing.T) context.Context {
	t.Helper()
	if os.Getenv("FILE_INDEX_TEST") != "1" {
		t.Skip("set FILE_INDEX_TEST=1 (throwaway store only) to run the file index tests")
	}
	// the throwaway store: on the host 127.0.0.1:16666, inside the test container the same port as host.docker.internal:16666
	if redisAddr != "127.0.0.1:16666" && redisAddr != "host.docker.internal:16666" {
		t.Fatalf("refused: only the throwaway store (port 16666 on this machine), got %q", redisAddr)
	}
	ctx := context.Background()
	rdb.FlushDB(ctx)
	// The index flag is global: leave the throwaway store empty, so the other tests that seed messages directly are not affected.
	t.Cleanup(func() { rdb.FlushDB(context.Background()) })
	return ctx
}

func fidOf(i int) string { return fmt.Sprintf("%040x", i+1) }

// scanReference: the old answer for a set of files, computed by the original full scan.
func scanReference(ids map[string]bool) []string {
	out := []string{}
	for k := range deletedOnlyAmongScan(ids) {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func indexedAnswer(ctx context.Context, ids map[string]bool) []string {
	out := []string{}
	for k := range deletedOnlyAmongIndexed(ctx, ids) {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func randomSubset(r *rand.Rand, files []string, n int) map[string]bool {
	s := map[string]bool{}
	for i := 0; i < n; i++ {
		s[files[r.Intn(len(files))]] = true
	}
	return s
}

// TestFileIndexMatchesScanAfterWrites: messages written through setMessage (create, edit, soft delete), random,
// then the old and the new answers must be identical for many random sets of files.
func TestFileIndexMatchesScanAfterWrites(t *testing.T) {
	ctx := fileIndexGuard(t)
	r := rand.New(rand.NewSource(7))
	const nFiles, nMsgs = 40, 400
	files := make([]string, nFiles)
	for i := range files {
		files[i] = fidOf(i)
	}
	texts := map[int]string{}
	deleted := map[int]bool{}
	for id := 1; id <= nMsgs; id++ {
		var parts []string
		parts = append(parts, fmt.Sprintf("message %d", id))
		for k := r.Intn(3); k > 0; k-- {
			parts = append(parts, "/api/files/"+files[r.Intn(nFiles)])
		}
		texts[id] = strings.Join(parts, " ")
		if err := setMessage(ctx, &Message{ID: id, Text: texts[id], Timestamp: time.Now()}, false); err != nil {
			t.Fatal(err)
		}
	}
	// edits (text changes that add and remove references) and soft deletes
	for step := 0; step < 300; step++ {
		id := 1 + r.Intn(nMsgs)
		if deleted[id] {
			continue
		}
		if r.Intn(3) == 0 {
			deleted[id] = true
			rdb.HSet(ctx, fmt.Sprintf("messages:%d", id), "deleted", "true")
			continue
		}
		text := fmt.Sprintf("edited %d", id)
		for k := r.Intn(3); k > 0; k-- {
			text += " /api/files/" + files[r.Intn(nFiles)]
		}
		texts[id] = text
		if err := setMessage(ctx, &Message{ID: id, Text: text, Timestamp: time.Now()}, true); err != nil {
			t.Fatal(err)
		}
	}
	// Rare files: each one is referenced by a single message, which is then deleted, so some files are deleted-only.
	// Without them the random data never has a deleted-only file and the comparison would prove nothing.
	for k := 0; k < 10; k++ {
		id := nMsgs + 1 + k
		rare := fidOf(nFiles + k)
		files = append(files, rare)
		if err := setMessage(ctx, &Message{ID: id, Text: "rare /api/files/" + rare, Timestamp: time.Now()}, false); err != nil {
			t.Fatal(err)
		}
		rdb.HSet(ctx, fmt.Sprintf("messages:%d", id), "deleted", "true")
	}
	if !fileIndexReady(ctx) {
		// The flag is only set by the backfill; the writes above did not set it. Run the backfill now, as an operator would.
		if _, _, err := backfillFileIndex(ctx); err != nil {
			t.Fatal(err)
		}
	}
	mismatches := 0
	nonEmpty := 0
	for iter := 0; iter < 200; iter++ {
		ids := randomSubset(r, files, 1+r.Intn(8))
		want, got := scanReference(ids), indexedAnswer(ctx, ids)
		if len(want) > 0 {
			nonEmpty++
		}
		if !sameSet(want, got) {
			mismatches++
			if mismatches <= 3 {
				t.Errorf("mismatch for %v: scan %v, index %v", ids, want, got)
			}
		}
	}
	t.Logf("200 random sets, %d with at least one deleted-only file, mismatches: %d", nonEmpty, mismatches)
	if nonEmpty == 0 {
		t.Fatal("the data never produced a deleted-only file; the test would prove nothing")
	}
	if mismatches > 0 {
		t.Fatalf("%d mismatches", mismatches)
	}
}

// TestFileIndexBackfillOfLegacyData: messages written directly (as the old code did, no index), then the backfill.
// Before the backfill the index is not trusted (the scan answers); after it, the index answers the same.
func TestFileIndexBackfillOfLegacyData(t *testing.T) {
	ctx := fileIndexGuard(t)
	files := []string{fidOf(0), fidOf(1), fidOf(2)}
	// legacy: time index + text + deleted, no file_msgs keys at all
	add := func(id int, text, del string, inTime bool) {
		key := fmt.Sprintf("messages:%d", id)
		rdb.HSet(ctx, key, "text", text, "deleted", del)
		if inTime {
			rdb.ZAdd(ctx, "m_times:1", redis.Z{Score: float64(id), Member: key})
		}
	}
	add(1, "a /api/files/"+files[0], "true", true)  // deleted only -> file 0 is deleted-only
	add(2, "b /api/files/"+files[1], "false", true) // live -> file 1 is NOT deleted-only
	add(3, "c /api/files/"+files[1], "true", true)  // deleted, but file 1 also has a live message
	add(4, "d /api/files/"+files[2], "true", false) // not in the time index: the scan ignores it, so file 2 is NOT deleted-only

	ids := map[string]bool{files[0]: true, files[1]: true, files[2]: true}
	if fileIndexReady(ctx) {
		t.Fatal("the flag must be absent before the backfill")
	}
	if got := deletedOnlyAmong(ids); len(got) != len(scanReference(ids)) {
		t.Fatalf("before backfill the scan must answer: got %v", got)
	}
	m, refs, err := backfillFileIndex(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// message 4 is not in the time index, so the backfill (like the scan) does not read it: 3 messages, 3 references
	if m != 3 || refs != 3 {
		t.Fatalf("backfill counted %d messages and %d references, want 3 and 3", m, refs)
	}
	want := scanReference(ids)
	got := indexedAnswer(ctx, ids)
	if !sameSet(want, got) {
		t.Fatalf("after backfill: scan %v, index %v", want, got)
	}
	if len(want) != 1 || want[0] != files[0] {
		t.Fatalf("expected only file 0 to be deleted-only, got %v", want)
	}
	// running the backfill again changes nothing
	if _, _, err := backfillFileIndex(ctx); err != nil {
		t.Fatal(err)
	}
	if got2 := indexedAnswer(ctx, ids); !sameSet(want, got2) {
		t.Fatalf("second backfill changed the answer: %v", got2)
	}
}

// TestFileIndexStaleEntryNeverMakesFileDeleted: an edit removes the reference of a deleted message. The index keeps the old
// entry (superset rule), and the answer must not count the file as deleted-only because of it.
func TestFileIndexStaleEntryNeverMakesFileDeleted(t *testing.T) {
	ctx := fileIndexGuard(t)
	f := fidOf(9)
	setMessage(ctx, &Message{ID: 1, Text: "old /api/files/" + f, Timestamp: time.Now()}, false)
	rdb.HSet(ctx, "messages:1", "deleted", "true")
	if _, _, err := backfillFileIndex(ctx); err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{f: true}
	if got := indexedAnswer(ctx, ids); len(got) != 1 {
		t.Fatalf("deleted message with the reference: the file is deleted-only, got %v", got)
	}
	// the same deleted message is edited to a text without the file (it stays deleted); the index entry remains
	setMessage(ctx, &Message{ID: 1, Text: "no file any more", Timestamp: time.Now()}, true)
	rdb.HSet(ctx, "messages:1", "deleted", "true")
	if members, _ := rdb.SMembers(ctx, fileMsgsKey(f)).Result(); len(members) != 1 {
		t.Fatalf("the index must keep the stale entry (superset rule), members: %v", members)
	}
	if got := indexedAnswer(ctx, ids); len(got) != 0 {
		t.Fatalf("a stale entry must not decide: got %v", got)
	}
	if got := scanReference(ids); len(got) != 0 {
		t.Fatalf("the scan agrees: got %v", got)
	}
}

// TestFileIndexFallbackWithoutFlag: without the built flag, deletedOnlyAmong uses the scan (never the index).
func TestFileIndexFallbackWithoutFlag(t *testing.T) {
	ctx := fileIndexGuard(t)
	f := fidOf(5)
	setMessage(ctx, &Message{ID: 2, Text: "x /api/files/" + f, Timestamp: time.Now()}, false)
	rdb.HSet(ctx, "messages:2", "deleted", "true")
	// the index is complete for this message but the flag is absent: the answer is the scan's, which is also "deleted-only"
	rdb.Del(ctx, fileMsgsBuiltKey)
	ids := map[string]bool{f: true}
	if got := deletedOnlyAmong(ids); len(got) != 1 {
		t.Fatalf("fallback answer: %v", got)
	}
	// a file the index does not know about, flag absent: still answered by the scan, and not deleted-only (no message refers to it)
	if got := deletedOnlyAmong(map[string]bool{fidOf(77): true}); len(got) != 0 {
		t.Fatalf("unknown file must not be deleted-only: %v", got)
	}
}

// TestFileIndexRejectsMessagesOutsideTheTimeIndex: the index lists a message that is not in m_times:1 -> ignored, as the scan does.
func TestFileIndexIgnoresMessagesOutsideTimeIndex(t *testing.T) {
	ctx := fileIndexGuard(t)
	f := fidOf(11)
	rdb.HSet(ctx, "messages:3", "text", "y /api/files/"+f, "deleted", "true")
	rdb.SAdd(ctx, fileMsgsKey(f), "messages:3")
	if _, _, err := backfillFileIndex(ctx); err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{f: true}
	if got := indexedAnswer(ctx, ids); len(got) != 0 {
		t.Fatalf("not in the time index: must not count: %v", got)
	}
	if got := scanReference(ids); len(got) != 0 {
		t.Fatalf("scan: %v", got)
	}
}

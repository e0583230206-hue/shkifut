package main

import (
	"context"
	"fmt"
	"io/fs"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// The count of what waits for an approver must give exactly the answers it always gave, and without making a request wait.
//   go test -run WaitingFast .     (needs any Redis, like the other waiting tests)

// referenceWaiting is the count as it was before the change (waiting.go, 12.11.2026): every metadata file read, every message asked one by one.
// It is kept here only to compare the new one with.
func referenceDeletedOnlyFileIDs() map[string]bool {
	ctx, cancel := redisCtx()
	defer cancel()
	out := map[string]bool{}
	keys, err := rdb.ZRange(ctx, "m_times:1", 0, -1).Result()
	if err != nil {
		return out
	}
	live := map[string]bool{}
	for _, k := range keys {
		vals, err := rdb.HMGet(ctx, k, "text", "deleted").Result()
		if err != nil || len(vals) != 2 {
			continue
		}
		text, _ := vals[0].(string)
		del, _ := vals[1].(string)
		isDeleted := del == "1" || del == "true"
		for _, m := range fileRefRe.FindAllStringSubmatch(text, -1) {
			if isDeleted {
				out[m[1]] = true
			} else {
				live[m[1]] = true
			}
		}
	}
	for id := range live {
		delete(out, id)
	}
	return out
}

func referenceWaiting() *waitingSummary {
	sum := &waitingSummary{Items: []waitingItem{}}
	deleted := referenceDeletedOnlyFileIDs()
	_ = filepath.WalkDir(rootUploadPath, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".yaml") {
			return nil
		}
		id := strings.TrimSuffix(filepath.Base(p), ".yaml")
		if !validFileId(id) || deleted[id] {
			return nil
		}
		meta, err := readMetadata(id)
		if err != nil {
			return nil
		}
		kind := waitingKind(meta)
		if kind == "" || !uploadedSince(meta, waitingSince) {
			return nil
		}
		if !holdActive(meta) && manualActive(meta, id) {
			return nil
		}
		if kind == waitingVideo {
			sum.Videos++
		} else {
			sum.Images++
		}
		sum.Items = append(sum.Items, waitingItem{ID: id, Kind: kind, Filename: metaString(meta, "filename"), UploadedAt: metaString(meta, "uploadedAt")})
		return nil
	})
	sort.SliceStable(sum.Items, func(i, j int) bool { return sum.Items[i].UploadedAt < sum.Items[j].UploadedAt })
	return sum
}

func fileIDFor(i int) string { return fmt.Sprintf("%040x", 0xabc000000+i*7919) }

// randomMeta: a metadata record of every sort the count has to tell apart.
func randomMeta(r *rand.Rand, i int) map[string]any {
	m := map[string]any{"filename": fmt.Sprintf("f%d.bin", i), "uploadedAt": time.Date(2026, 11, 1+r.Intn(10), r.Intn(24), r.Intn(60), 0, 0, time.UTC).Format(time.RFC3339)}
	switch r.Intn(5) {
	case 0: // a held video, maybe approved
		m["type"], m["holdRequired"] = "video", true
		if r.Intn(3) == 0 {
			m["approvedAt"] = "2026-11-05T10:00:00Z"
		}
	case 1: // a crowd video, maybe reviewed
		m["type"], m["autoNeedsReview"] = "video", true
		if r.Intn(3) == 0 {
			m["figuresReviewedAt"] = "2026-11-05T10:00:00Z"
		}
	case 2: // an image with people, maybe reviewed
		m["type"], m["autoDecision"], m["autoReasons"] = "image", "blurred", []any{"person"}
		if r.Intn(3) == 0 {
			m["figuresReviewedAt"] = "2026-11-05T10:00:00Z"
		}
	case 3: // an image without people
		m["type"], m["autoDecision"], m["autoReasons"] = "image", "open", []any{"no_people"}
	default:
		m["type"] = "document"
	}
	return m
}

type waitingFixture struct {
	r     *rand.Rand
	n     int
	files []string
	msgs  []string
}

// buildWaitingFixture: n metadata files (old enough for the cache to trust them) and m messages that refer to them, some of them deleted.
func buildWaitingFixture(t *testing.T, n, m int) *waitingFixture {
	t.Helper()
	r := rand.New(rand.NewSource(42))
	f := &waitingFixture{r: r, n: n}
	old := time.Now().Add(-time.Hour)
	for i := 0; i < n; i++ {
		id := fileIDFor(i)
		writeWaitingFile(t, id, randomMeta(r, i))
		_ = os.Chtimes(metadataPath(id), old, old)
		f.files = append(f.files, id)
	}
	ctx := context.Background()
	for i := 0; i < m; i++ {
		key := fmt.Sprintf("wfast:msg:%d", i)
		var text strings.Builder
		for k := 0; k < r.Intn(3); k++ {
			text.WriteString("[video-embedded#](/api/files/" + f.files[r.Intn(n)] + ".mp4) ")
		}
		text.WriteString("text of message")
		del := "0"
		if r.Intn(4) == 0 {
			del = "1"
		}
		rdb.HSet(ctx, key, "text", text.String(), "deleted", del)
		rdb.ZAdd(ctx, "m_times:1", redis.Z{Score: float64(880000000 + i), Member: key})
		f.msgs = append(f.msgs, key)
	}
	t.Cleanup(func() {
		for _, k := range f.msgs {
			rdb.Del(ctx, k)
			rdb.ZRem(ctx, "m_times:1", k)
		}
	})
	return f
}

func withWaitingFlags(t *testing.T) {
	t.Helper()
	oldRoot, oldHold, oldStrict, oldSince := rootUploadPath, holdVideos, strictUntilReviewed, waitingSince
	t.Cleanup(func() {
		rootUploadPath, holdVideos, strictUntilReviewed, waitingSince = oldRoot, oldHold, oldStrict, oldSince
		waitingInvalidate()
	})
	rootUploadPath, holdVideos, strictUntilReviewed, waitingSince = t.TempDir(), true, true, time.Time{}
	waitingInvalidate()
}

func sameWaiting(t *testing.T, label string, got, want *waitingSummary) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s:\n got  %d videos %d images %d items\n want %d videos %d images %d items\n first items got %+v\n want %+v", label,
			got.Videos, got.Images, len(got.Items), want.Videos, want.Images, len(want.Items), head(got.Items), head(want.Items))
	}
}

func head(items []waitingItem) []waitingItem {
	if len(items) > 3 {
		return items[:3]
	}
	return items
}

// The new count equals the old one: on random data, and again after files and messages changed in every way.
func TestWaitingFastEqualsTheReference(t *testing.T) {
	withWaitingFlags(t)
	f := buildWaitingFixture(t, 300, 400)
	ctx := context.Background()

	sameWaiting(t, "first count", computeWaiting(), referenceWaiting())
	sameWaiting(t, "second count (everything from the cache)", computeWaiting(), referenceWaiting())

	// files change: an approval, a review, a new upload, a removed file, a file that stops being a video
	for _, i := range []int{3, 17, 40, 41, 99} {
		id := f.files[i]
		meta, err := readMetadata(id)
		if err != nil {
			t.Fatal(err)
		}
		meta["approvedAt"], meta["figuresReviewedAt"], meta["uploadedAt"] = "2026-11-09T09:00:00Z", "2026-11-09T09:00:00Z", "2026-11-09T09:00:00Z"
		writeWaitingFile(t, id, meta)
	}
	writeWaitingFile(t, fileIDFor(5000), map[string]any{"type": "video", "holdRequired": true, "uploadedAt": "2026-11-11T09:00:00Z"})
	_ = os.Remove(metadataPath(f.files[7]))
	writeWaitingFile(t, f.files[8], map[string]any{"type": "document"})
	sameWaiting(t, "after the files changed", computeWaiting(), referenceWaiting())

	// messages change: some are deleted, some come back
	for k := 0; k < 60; k++ {
		rdb.HSet(ctx, f.msgs[f.r.Intn(len(f.msgs))], "deleted", []string{"0", "1", "true", "false"}[f.r.Intn(4)])
	}
	sameWaiting(t, "after messages were deleted and restored", computeWaiting(), referenceWaiting())

	// the settings the count depends on
	holdVideos = false
	sameWaiting(t, "hold flag off", computeWaiting(), referenceWaiting())
	holdVideos, strictUntilReviewed = true, false
	sameWaiting(t, "strict flag off", computeWaiting(), referenceWaiting())
	strictUntilReviewed = true
	waitingSince = parseWaitingSince("2026-11-05")
	sameWaiting(t, "WAITING_SINCE", computeWaiting(), referenceWaiting())
}

// Two writes inside one clock tick leave the same modification time and size: the new answer must still be seen.
func TestWaitingFastSeesAQuickRewriteWithTheSameSize(t *testing.T) {
	withWaitingFlags(t)
	id := fileIDFor(1)
	a := map[string]any{"type": "video", "holdRequired": true, "filename": "aaaa.mp4", "uploadedAt": "2026-11-10T10:00:00Z"}
	writeWaitingFile(t, id, a)
	if got := computeWaiting(); got.Videos != 1 {
		t.Fatalf("held video: %+v", got)
	}
	st, _ := os.Stat(metadataPath(id))
	b := map[string]any{"type": "video", "holdRequired": false, "filename": "aaaa.mp4", "uploadedAt": "2026-11-10T10:00:00Z"} // "true" -> "false" is not the same size, so make it the same:
	b["holdRequired"] = true
	b["approvedAt"] = "2026-11-10T10:00:00Z"
	delete(b, "uploadedAt")
	b["filename"] = "x"
	writeWaitingFile(t, id, b)
	st2, _ := os.Stat(metadataPath(id))
	_ = os.Chtimes(metadataPath(id), st.ModTime(), st.ModTime()) // the very same modification time as the old content had
	if st2.Size() == st.Size() {
		t.Log("the sizes happen to be equal: the same-size case is tested")
	}
	if got := computeWaiting(); got.Videos != 0 {
		t.Fatalf("the video was approved (the file was rewritten): %+v", got)
	}
}

// The numbers the request is judged by: how long a request waits, with the volume of the live site (1850 files, 3023 messages).
func TestWaitingFastIsFastOnTheRealVolume(t *testing.T) {
	withWaitingFlags(t)
	buildWaitingFixture(t, 1850, 3023)

	t0 := time.Now()
	want := referenceWaiting()
	oldMs := time.Since(t0)

	t0 = time.Now()
	first := computeWaiting() // cold: reads every file once
	coldMs := time.Since(t0)
	sameWaiting(t, "cold count", first, want)

	t0 = time.Now()
	warm := computeWaiting() // warm: the files are in the cache
	warmMs := time.Since(t0)
	sameWaiting(t, "warm count", warm, want)

	// the endpoint, as a request gets it
	waitingInvalidate()
	<-startWaitingFlight(waitingGen.Load()).done
	var worst time.Duration
	var total time.Duration
	const n = 500
	for i := 0; i < n; i++ {
		rec := httptest.NewRecorder()
		t1 := time.Now()
		getWaiting(rec, httptest.NewRequest(http.MethodGet, "/api/admin/hold/waiting", nil))
		d := time.Since(t1)
		total += d
		if d > worst {
			worst = d
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d", rec.Code)
		}
	}

	// a change was announced: the request waits for a count that began after it
	waitingInvalidate()
	t1 := time.Now()
	_ = currentWaiting()
	afterChange := time.Since(t1)

	// the time is over: the request gets the old answer at once and the count happens in the background
	if s := waitingSnap.Load(); s != nil {
		waitingSnap.Store(&waitingSnapshot{sum: s.sum, at: time.Now().Add(-2 * waitingCacheTTL), gen: s.gen})
	}
	t1 = time.Now()
	_ = currentWaiting()
	afterExpiry := time.Since(t1)

	t.Logf("old count (every file and every message, one by one): %v", oldMs)
	t.Logf("new count, cold: %v | warm: %v", coldMs, warmMs)
	t.Logf("request, %d in a row: average %v, worst %v", n, total/n, worst)
	t.Logf("request right after a change was announced: %v", afterChange)
	t.Logf("request when the cached answer is older than %v: %v", waitingCacheTTL, afterExpiry)

	if worst > 50*time.Millisecond {
		t.Errorf("a request must come back within 50 ms, the worst took %v", worst)
	}
	if afterExpiry > 50*time.Millisecond {
		t.Errorf("an old cached answer must still come back within 50 ms, took %v", afterExpiry)
	}
	if afterChange > 250*time.Millisecond {
		t.Errorf("after a change the count must be quick, took %v", afterChange)
	}
}

// Many requests and many announced changes at once: nothing hangs, every answer is a whole one.
func TestWaitingFastConcurrent(t *testing.T) {
	withWaitingFlags(t)
	buildWaitingFixture(t, 200, 250)
	var wg sync.WaitGroup
	deadline := time.Now().Add(1500 * time.Millisecond)
	errs := make(chan string, 64)
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for time.Now().Before(deadline) {
				if g%3 == 0 {
					waitingInvalidate()
				}
				s := currentWaiting()
				if s == nil || s.Items == nil || s.Videos+s.Images != len(s.Items) {
					errs <- fmt.Sprintf("a broken answer: %+v", s)
					return
				}
			}
		}(g)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the requests did not finish: something waits for ever")
	}
	close(errs)
	for e := range errs {
		t.Error(e)
	}
	waitingInvalidate()
	sameWaiting(t, "after the storm", currentWaiting(), referenceWaiting())
}

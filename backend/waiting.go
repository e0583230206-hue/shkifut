package main

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	_ "time/tzdata" // the date of WAITING_SINCE is in Israel time, also in an image without the system zones

	"github.com/redis/go-redis/v9"
)

// What waits for an approver (the banner at the top for approvers and owners):
//   - a video the readers do not get yet: held until approved (HOLD_VIDEOS_UNTIL_APPROVED) or flagged "needs review" (STRICT_UNTIL_REVIEWED);
//   - an image in which people were found and no moderator has reviewed yet (STRICT_UNTIL_REVIEWED): readers get it fully blurred.
// It is computed from the metadata of the files, not kept in a second place that every decision would have to update.

// WAITING_SINCE (empty by default = everything that waits): "2026-10-31" (from the start of that day, Israel time) or a full RFC 3339 time. The bar then
// counts only files uploaded from then on; older ones, and files from before "uploadedAt" existed, are left out (they still wait for a decision as always).
var waitingSince = parseWaitingSince(os.Getenv("WAITING_SINCE"))

func parseWaitingSince(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t
	}
	loc, err := time.LoadLocation("Asia/Jerusalem")
	if err != nil {
		loc = time.UTC
	}
	if t, err := time.ParseInLocation("2006-01-02", s, loc); err == nil {
		return t
	}
	return time.Time{} // not understood: count everything rather than nothing
}

// uploadedSince: counts for the bar (always true without WAITING_SINCE).
func uploadedSince(meta map[string]any, since time.Time) bool {
	if since.IsZero() {
		return true
	}
	t, err := time.Parse(time.RFC3339, metaString(meta, "uploadedAt"))
	return err == nil && !t.Before(since)
}

const (
	waitingVideo = "video"
	waitingImage = "image"
)

// waitingKind: "video", "image", or "" when nothing waits for a decision.
func waitingKind(meta map[string]any) string {
	switch metaString(meta, "type") {
	case "video":
		if holdActive(meta) || strictHidden(meta) {
			return waitingVideo
		}
	case "image":
		if strictUnreviewed(meta) {
			return waitingImage
		}
	}
	return ""
}

type waitingItem struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Filename   string `json:"filename,omitempty"`
	UploadedAt string `json:"uploadedAt,omitempty"`
}

type waitingSummary struct {
	Videos int           `json:"videos"`
	Images int           `json:"images"`
	Items  []waitingItem `json:"items"` // the oldest first
}

const waitingCacheTTL = 20 * time.Second

// waitingRacyWindow: a file that changed less than this long before it was read is read again on the next count. Two writes inside one
// clock tick of the file system can leave the same modification time and size, and the cached answer would then be wrong for good.
const waitingRacyWindow = 2 * time.Second

// How the answer is kept, so that a request never waits for the counting (it used to scan every metadata file and ask Redis for every
// message, one round trip each, while all the other requests queued behind a lock: 1.4 s on average, up to 22 s):
//   - the last finished count is a snapshot that is read without a lock;
//   - when it is older than waitingCacheTTL it is counted again in the background and the request gets the snapshot it has;
//   - when a change was announced (waitingInvalidate) the request waits for a count that began after the change - as before, so an approver
//     sees the result of his own click - but the count itself is now cheap (see computeWaiting);
//   - one count at a time, and every request that needs one shares it.
type waitingSnapshot struct {
	sum *waitingSummary
	at  time.Time
	gen uint64 // the generation (see waitingGen) the count began at
}

type waitingCall struct {
	gen  uint64
	done chan struct{}
}

var (
	waitingSnap     atomic.Pointer[waitingSnapshot]
	waitingGen      atomic.Uint64 // grows with every announced change
	waitingFlightMu sync.Mutex
	waitingFlight   *waitingCall
)

// waitingInvalidate: a file changed state, the next question counts again.
func waitingInvalidate() {
	waitingGen.Add(1)
}

// warmWaiting counts once at start, so the first approver's page does not wait for it.
func warmWaiting() {
	startWaitingFlight(waitingGen.Load())
}

func storeWaitingSnapshot(s *waitingSnapshot) {
	for {
		old := waitingSnap.Load()
		if old != nil && old.gen > s.gen {
			return // a count that began after a later change is already there
		}
		if waitingSnap.CompareAndSwap(old, s) {
			return
		}
	}
}

// startWaitingFlight: the count that began at generation gen or later (the running one, or a new one).
func startWaitingFlight(gen uint64) *waitingCall {
	waitingFlightMu.Lock()
	defer waitingFlightMu.Unlock()
	if f := waitingFlight; f != nil && f.gen >= gen {
		return f
	}
	f := &waitingCall{gen: gen, done: make(chan struct{})}
	waitingFlight = f
	go func() {
		defer close(f.done)
		defer func() {
			waitingFlightMu.Lock()
			if waitingFlight == f {
				waitingFlight = nil
			}
			waitingFlightMu.Unlock()
		}()
		defer func() {
			if r := recover(); r != nil {
				log.Printf("waiting: the count failed: %v", r) // the old snapshot stays; the next question tries again
			}
		}()
		storeWaitingSnapshot(&waitingSnapshot{sum: computeWaiting(), at: time.Now(), gen: gen})
	}()
	return f
}

// waitingFileEval: what the metadata of one file says, for the things that only the YAML decides. A file is read again only when its
// modification time or size changed. Whether a manual blur is valid depends on other files, so that is asked again at every count.
type waitingFileEval struct {
	modTime time.Time
	size    int64
	readAt  time.Time
	kind    string         // "" = this file does not wait for a decision at all
	meta    map[string]any // kept only for the few files that wait
}

var (
	waitingComputeMu sync.Mutex // computeWaiting runs one at a time (and its cache with it)
	waitingFileCache = map[string]*waitingFileEval{}
	waitingCacheKey  string
)

// deletedOnlyAmong: of the given files, those whose only messages were deleted. Deleting a message keeps its upload (the message can be
// restored, and the cleanup removes it after MEDIA_CLEANUP_DAYS), so without this the bar would go on counting a video nobody can see any more.
// A file that no message uses yet (just uploaded, being written) is not in the set and still counts. On a Redis error: empty set.
// The messages are asked in a few batches, not one round trip each.
// deletedOnlyAmongScan is the original full scan (kept as the fallback until the file index is complete; see file_msgs_index.go).
func deletedOnlyAmongScan(ids map[string]bool) map[string]bool {
	out := map[string]bool{}
	if len(ids) == 0 {
		return out
	}
	ctx, cancel := redisCtx()
	defer cancel()
	keys, err := rdb.ZRange(ctx, "m_times:1", 0, -1).Result()
	if err != nil {
		return out
	}
	live := map[string]bool{}
	const batch = 500
	for start := 0; start < len(keys); start += batch {
		end := start + batch
		if end > len(keys) {
			end = len(keys)
		}
		pipe := rdb.Pipeline()
		cmds := make([]*redis.SliceCmd, 0, end-start)
		for _, k := range keys[start:end] {
			cmds = append(cmds, pipe.HMGet(ctx, k, "text", "deleted"))
		}
		_, _ = pipe.Exec(ctx) // the result of every command is looked at below
		for _, c := range cmds {
			vals, err := c.Result()
			if err != nil || len(vals) != 2 {
				continue
			}
			text, _ := vals[0].(string)
			del, _ := vals[1].(string)
			if !strings.Contains(text, "/api/files/") {
				continue
			}
			isDeleted := del == "1" || del == "true"
			for _, m := range fileRefRe.FindAllStringSubmatch(text, -1) {
				if !ids[m[1]] {
					continue
				}
				if isDeleted {
					out[m[1]] = true
				} else {
					live[m[1]] = true
				}
			}
		}
	}
	for id := range live {
		delete(out, id)
	}
	return out
}

// computeWaiting: the count and the list. It goes through the metadata files (only the ones that changed are read), and asks about the
// messages only when something waits.
func computeWaiting() *waitingSummary {
	waitingComputeMu.Lock()
	defer waitingComputeMu.Unlock()
	key := fmt.Sprintf("%s|%t|%t", rootUploadPath, holdVideos, strictUntilReviewed) // what decides "kind" besides the file itself
	if key != waitingCacheKey {
		waitingFileCache, waitingCacheKey = map[string]*waitingFileEval{}, key
	}

	type candidate struct {
		id string
		ev *waitingFileEval
	}
	var cands []candidate
	seen := make(map[string]struct{}, len(waitingFileCache))
	_ = filepath.WalkDir(rootUploadPath, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".yaml") {
			return nil
		}
		id := strings.TrimSuffix(filepath.Base(p), ".yaml")
		if !validFileId(id) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		seen[id] = struct{}{}
		ev := waitingFileCache[id]
		if ev == nil || !ev.modTime.Equal(info.ModTime()) || ev.size != info.Size() || !ev.readAt.After(ev.modTime.Add(waitingRacyWindow)) {
			meta, err := readMetadata(id)
			if err != nil {
				delete(waitingFileCache, id)
				return nil
			}
			ev = &waitingFileEval{modTime: info.ModTime(), size: info.Size(), readAt: time.Now()}
			if k := waitingKind(meta); k != "" {
				ev.kind, ev.meta = k, meta
			}
			waitingFileCache[id] = ev
		}
		if ev.kind != "" {
			cands = append(cands, candidate{id: id, ev: ev})
		}
		return nil
	})
	for id := range waitingFileCache { // a file that is gone
		if _, ok := seen[id]; !ok {
			delete(waitingFileCache, id)
		}
	}

	sum := &waitingSummary{Items: []waitingItem{}}
	if len(cands) == 0 {
		return sum
	}
	ids := make(map[string]bool, len(cands))
	for _, c := range cands {
		ids[c.id] = true
	}
	deleted := deletedOnlyAmong(ids)
	for _, c := range cands {
		meta := c.ev.meta
		if deleted[c.id] || !uploadedSince(meta, waitingSince) {
			continue
		}
		// A moderator drew a manual blur and readers get that version (it replaces the "needs review" hiding and the full blur).
		// Only a video that is still held for approval keeps waiting: the approver has to look at it.
		if !holdActive(meta) && manualActive(meta, c.id) {
			continue
		}
		if c.ev.kind == waitingVideo {
			sum.Videos++
		} else {
			sum.Images++
		}
		sum.Items = append(sum.Items, waitingItem{ID: c.id, Kind: c.ev.kind, Filename: metaString(meta, "filename"), UploadedAt: metaString(meta, "uploadedAt")})
	}
	sort.SliceStable(sum.Items, func(i, j int) bool { return sum.Items[i].UploadedAt < sum.Items[j].UploadedAt })
	return sum
}

// currentWaiting: the count and the list, without waiting for a count unless a change was announced.
func currentWaiting() *waitingSummary {
	for attempt := 0; attempt < 3; attempt++ {
		gen := waitingGen.Load()
		if s := waitingSnap.Load(); s != nil && s.gen >= gen {
			if time.Since(s.at) >= waitingCacheTTL {
				startWaitingFlight(gen) // old: count again in the background, answer with what there is
			}
			return s.sum
		}
		<-startWaitingFlight(gen).done // nothing yet, or a change was announced: wait for a count that began after it
	}
	if s := waitingSnap.Load(); s != nil {
		return s.sum
	}
	return &waitingSummary{Items: []waitingItem{}}
}

// getWaiting: GET /api/admin/hold/waiting (approvers and owners): what waits for a decision, the oldest first.
func getWaiting(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, currentWaiting())
}

// publishWaitingChanged tells open pages that the answer of getWaiting may have changed. The live stream goes to every reader, so the
// message carries no numbers: an approver's page asks again (and readers are not allowed to).
func publishWaitingChanged(ctx context.Context) {
	rdb.Publish(ctx, "events", []byte(`{"type":"hold-waiting"}`))
}

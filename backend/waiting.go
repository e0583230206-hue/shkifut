package main

import (
	"context"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // the date of WAITING_SINCE is in Israel time, also in an image without the system zones
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

var (
	waitingMu      sync.Mutex
	waitingCached  *waitingSummary
	waitingExpires time.Time
)

// waitingInvalidate: a file changed state, the next question counts again.
func waitingInvalidate() {
	waitingMu.Lock()
	waitingExpires = time.Time{}
	waitingMu.Unlock()
}

// currentWaiting: the count and the list, from a scan of the metadata that is repeated at most every waitingCacheTTL (or after a change).
func currentWaiting() *waitingSummary {
	waitingMu.Lock()
	defer waitingMu.Unlock()
	if waitingCached != nil && time.Now().Before(waitingExpires) {
		return waitingCached
	}
	sum := &waitingSummary{Items: []waitingItem{}}
	_ = filepath.WalkDir(rootUploadPath, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".yaml") {
			return nil
		}
		id := strings.TrimSuffix(filepath.Base(p), ".yaml")
		if !validFileId(id) {
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
		if kind == waitingVideo {
			sum.Videos++
		} else {
			sum.Images++
		}
		sum.Items = append(sum.Items, waitingItem{ID: id, Kind: kind, Filename: metaString(meta, "filename"), UploadedAt: metaString(meta, "uploadedAt")})
		return nil
	})
	sort.SliceStable(sum.Items, func(i, j int) bool { return sum.Items[i].UploadedAt < sum.Items[j].UploadedAt })
	waitingCached, waitingExpires = sum, time.Now().Add(waitingCacheTTL)
	return sum
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

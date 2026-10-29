package main

import (
	"context"
	"io/fs"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// What waits for an approver (the banner at the top for approvers and owners):
//   - a video the readers do not get yet: held until approved (HOLD_VIDEOS_UNTIL_APPROVED) or flagged "needs review" (STRICT_UNTIL_REVIEWED);
//   - an image in which people were found and no moderator has reviewed yet (STRICT_UNTIL_REVIEWED): readers get it fully blurred.
// It is computed from the metadata of the files, not kept in a second place that every decision would have to update.

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
		if kind == "" {
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

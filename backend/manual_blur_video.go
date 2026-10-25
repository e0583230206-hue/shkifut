package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"channel/manualblur"
)

// MANUAL_BLUR_VIDEO=1 (off by default, separate from MANUAL_BLUR): the manual blur tool for videos. The rules are those of the pictures (see
// manual_blur.go): the blur only ever ADDS blur on top of what the automatic check gives readers, it is valid only for exactly that base,
// the original and the automatic versions are never touched, owners and approvers only.
//
// What is different: a video takes seconds to render, so saving starts a JOB and returns at once (202); the page shows the progress and
// is told when it ends (the same "file-moderation" event as every other change). One render at a time, in a queue of its own that does not
// touch the queue of the automatic check. The service renders to a file named after the job (<fileid>.<job>.mp4); the backend renames it
// to <fileid>.mp4 (through the service, which is the only one that can write to the blurred folder) only after checking that the automatic
// result has not changed meanwhile, and only then writes the metadata. A render that fails, is cancelled or goes stale changes nothing:
// readers keep the version they had.
var manualBlurVideoEnabled = os.Getenv("MANUAL_BLUR_VIDEO") == "1"

const (
	manualJobTimeout = 30 * time.Minute
	manualJobPoll    = 2 * time.Second
)

var manualVideoClient = &http.Client{} // no timeout of its own: every call has a context

// manualUser: who is asking (the session; a variable so that the tests need no session store).
var manualUser = sessionEmail

func manualVideoRelPath(id string) string {
	return filepath.Join("manual", id[:2], id[2:4], id+".mp4")
}

func manualVideoTmpRelPath(id, job string) string {
	return filepath.Join("manual", id[:2], id[2:4], id+"."+job+".mp4")
}

// ---- jobs ----

type manualJob struct {
	ID      string
	State   string // queued | rendering | done | failed | cancelled
	Percent int
	Error   string
	Started time.Time
	Ended   time.Time
	cancel  context.CancelFunc
}

type manualJobInfo struct {
	State   string `json:"state"`
	Percent int    `json:"percent,omitempty"`
	Error   string `json:"error,omitempty"`
}

type manualVideoTask struct {
	id     string
	tracks []manualblur.Track
	sig    string
	base   manualBase
	user   string
	job    *manualJob
	ctx    context.Context
}

var (
	manualJobsMu     sync.Mutex
	manualJobs       = map[string]*manualJob{}
	manualVideoQueue = make(chan *manualVideoTask, 50)
	manualWorkerOnce sync.Once
)

// startManualVideoWorker: the one worker that renders manual videos, one at a time.
func startManualVideoWorker() {
	if !manualBlurVideoEnabled {
		return
	}
	manualWorkerOnce.Do(func() {
		go func() {
			for t := range manualVideoQueue {
				runManualVideo(t)
			}
		}()
	})
}

func manualJobInfoFor(id string) *manualJobInfo {
	manualJobsMu.Lock()
	defer manualJobsMu.Unlock()
	j := manualJobs[id]
	if j == nil {
		return nil
	}
	return &manualJobInfo{State: j.State, Percent: j.Percent, Error: j.Error}
}

func newJobID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%016x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func setJob(j *manualJob, f func(*manualJob)) {
	manualJobsMu.Lock()
	f(j)
	manualJobsMu.Unlock()
}

// ---- API ----

// getManualVideo: GET /api/admin/files/{fileid}/manual-blur for a video.
func getManualVideo(w http.ResponseWriter, id string, meta map[string]any) {
	b := manualBaseOf(meta)
	out := map[string]any{"kind": "video", "available": b.OK, "reason": b.Reason, "tracks": []manualblur.Track{}}
	if b.OK {
		out["base"] = b.Base.Kind
	}
	if e := manualEntry(meta); e != nil {
		out["tracks"] = manualblur.TracksFromMeta(e["tracks"])
		out["active"] = manualValid(meta, id)
		out["by"], out["at"] = metaString(e, "by"), metaString(e, "at")
	}
	if j := manualJobInfoFor(id); j != nil {
		out["job"] = j
	}
	out["padFrames"] = manualblur.PadFrames
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, out)
}

// setManualVideo: POST /api/admin/files/{fileid}/manual-blur {"tracks":[...]}. Starts a render and answers 202; no tracks clears the manual blur.
func setManualVideo(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Tracks []manualblur.Track `json:"tracks"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	user := manualUser(r)
	if len(req.Tracks) == 0 {
		deleteManualVideo(w, r, id)
		return
	}
	tracks, err := manualblur.ValidateTracks(req.Tracks)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := readMetadata(id)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	base := manualBaseOf(meta)
	if !base.OK {
		http.Error(w, "manual blur is not available for this file: "+base.Reason, http.StatusConflict)
		return
	}
	if moderationURL == "" {
		http.Error(w, errManualNoSvc.Error(), http.StatusServiceUnavailable)
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	job := &manualJob{ID: newJobID(), State: "queued", Started: time.Now(), cancel: cancel}
	task := &manualVideoTask{id: id, tracks: tracks, sig: manualSignature(meta, base), base: base, user: user, job: job, ctx: ctx}

	manualJobsMu.Lock()
	if old := manualJobs[id]; old != nil && (old.State == "queued" || old.State == "rendering") {
		old.cancel() // the newer request replaces the one still running
	}
	manualJobs[id] = job
	manualJobsMu.Unlock()
	select {
	case manualVideoQueue <- task:
	default:
		cancel()
		setJob(job, func(j *manualJob) { j.State, j.Error = "failed", "busy" })
		http.Error(w, "too many renders waiting, try again in a minute", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]any{"success": true, "state": job.State, "job": job.ID})
}

// deleteManualVideo: DELETE /api/admin/files/{fileid}/manual-blur for a video.
func deleteManualVideo(w http.ResponseWriter, r *http.Request, id string) {
	manualJobsMu.Lock()
	if j := manualJobs[id]; j != nil && (j.State == "queued" || j.State == "rendering") {
		j.cancel()
	}
	delete(manualJobs, id)
	manualJobsMu.Unlock()

	manualSaveMu.Lock()
	defer manualSaveMu.Unlock()
	metaMu.Lock()
	meta, err := readMetadata(id)
	had := false
	if err == nil {
		_, had = meta[manualBlurMetaKey]
		delete(meta, manualBlurMetaKey)
		if had {
			err = writeMetadata(id, meta)
		}
	}
	status := metaString(meta, "moderation")
	metaMu.Unlock()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	manualServiceRemove(manualVideoRelPath(id))
	if had {
		appendYamlLog(moderationLogFile, map[string]any{"action": "manual-blur-cleared", "fileId": id, "by": manualUser(r), "kind": "video"})
		publishFileModeration(r.Context(), id, status)
	}
	writeJSON(w, map[string]any{"success": true, "tracks": 0, "active": false})
}

// ---- the job ----

// runManualVideo renders one video and, if everything is still as it was when the request was made, makes it the manual version.
func runManualVideo(t *manualVideoTask) {
	if t.ctx.Err() != nil { // replaced or cancelled while it waited
		setJob(t.job, func(j *manualJob) { j.State, j.Ended = "cancelled", time.Now() })
		return
	}
	setJob(t.job, func(j *manualJob) { j.State = "rendering" })
	publishFileModeration(context.Background(), t.id, metaStatusOf(t.id))

	ctx, cancel := context.WithTimeout(t.ctx, manualJobTimeout)
	defer cancel()
	tmpRel := filepath.ToSlash(manualVideoTmpRelPath(t.id, t.job.ID))

	stopProgress := make(chan struct{})
	go manualProgressLoop(ctx, t.job, stopProgress)
	err := callManualVideo(ctx, t, tmpRel)
	close(stopProgress)

	fail := func(state, msg string) {
		manualServiceRemove(tmpRel)
		setJob(t.job, func(j *manualJob) { j.State, j.Error, j.Ended = state, msg, time.Now() })
		log.Printf("manual blur (video) of %s: %s: %s", t.id, state, msg)
		appendYamlLog(moderationLogFile, map[string]any{"action": "manual-blur-failed", "fileId": t.id, "by": t.user, "state": state, "error": msg, "kind": "video"})
		publishFileModeration(context.Background(), t.id, metaStatusOf(t.id))
	}
	if t.ctx.Err() != nil {
		manualCancelService(t.job.ID)
		fail("cancelled", "replaced by a newer save or cleared")
		return
	}
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			manualCancelService(t.job.ID)
			fail("failed", "timeout")
			return
		}
		fail("failed", err.Error())
		return
	}

	// Commit: only if the automatic result is still the one this video was drawn on.
	manualSaveMu.Lock()
	defer manualSaveMu.Unlock()
	metaMu.Lock()
	meta, rerr := readMetadata(t.id)
	if rerr != nil {
		metaMu.Unlock()
		fail("failed", "file not found")
		return
	}
	if nb := manualBaseOf(meta); !nb.OK || manualSignature(meta, nb) != t.sig {
		metaMu.Unlock()
		fail("failed", "stale: the automatic result changed while the video was rendered")
		return
	}
	if cerr := manualServiceCommit(tmpRel, filepath.ToSlash(manualVideoRelPath(t.id))); cerr != nil {
		metaMu.Unlock()
		fail("failed", "could not publish the rendered video: "+cerr.Error())
		return
	}
	meta[manualBlurMetaKey] = map[string]any{
		"tracks": manualblur.TracksToMeta(t.tracks),
		"by":     t.user,
		"at":     time.Now().UTC().Format(time.RFC3339),
		"sig":    t.sig,
		"rev":    t.job.ID,
	}
	// The approval of a held video is NOT cleared: the manual blur only adds blur to the version that was approved. A video that is still
	// waiting for approval is approved as before, looking at the manual version (holdToken knows its revision).
	werr := writeMetadata(t.id, meta)
	status := metaString(meta, "moderation")
	metaMu.Unlock()
	if werr != nil {
		fail("failed", "could not save")
		return
	}
	setJob(t.job, func(j *manualJob) { j.State, j.Percent, j.Ended = "done", 100, time.Now() })
	appendYamlLog(moderationLogFile, map[string]any{"action": "manual-blur", "fileId": t.id, "by": t.user, "tracks": len(t.tracks), "base": t.base.Base.Kind, "kind": "video",
		"seconds": int(time.Since(t.job.Started).Seconds())})
	publishFileModeration(context.Background(), t.id, status)
}

func metaStatusOf(id string) string {
	meta, err := readMetadata(id)
	if err != nil {
		return ""
	}
	return metaString(meta, "moderation")
}

// ---- the moderation service (V2 of the plan implements the other side) ----

var errManualRejected = errors.New("rejected")

func callManualVideo(ctx context.Context, t *manualVideoTask, tmpRel string) error {
	body, _ := json.Marshal(map[string]any{
		"job":        t.job.ID,
		"base":       t.base.Rel,
		"base_root":  t.base.Root,
		"out":        tmpRel,
		"tracks":     t.tracks,
		"pad_frames": manualblur.PadFrames,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, moderationURL+"/manual-video", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := manualVideoClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusUnprocessableEntity:
		var e struct {
			Error string `json:"error"`
		}
		json.Unmarshal(data, &e)
		return fmt.Errorf("%w: %s", errManualRejected, e.Error)
	}
	return fmt.Errorf("moderation service status %d", resp.StatusCode)
}

// manualProgressLoop asks the service how far the render is, until it ends.
func manualProgressLoop(ctx context.Context, job *manualJob, stop <-chan struct{}) {
	tick := time.NewTicker(manualJobPoll)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ctx.Done():
			return
		case <-tick.C:
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, moderationURL+"/manual-video-progress?job="+url.QueryEscape(job.ID), nil)
			if err != nil {
				return
			}
			resp, err := manualVideoClient.Do(req)
			if err != nil {
				continue
			}
			var p struct {
				Percent int `json:"percent"`
			}
			json.NewDecoder(io.LimitReader(resp.Body, 1024)).Decode(&p)
			resp.Body.Close()
			if p.Percent > 0 && p.Percent < 100 {
				setJob(job, func(j *manualJob) { j.Percent = p.Percent })
			}
		}
	}
}

func manualCancelService(job string) {
	body, _ := json.Marshal(map[string]string{"job": job})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, moderationURL+"/manual-video-cancel", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if resp, err := manualVideoClient.Do(req); err == nil {
		resp.Body.Close()
	}
}

func manualServiceCommit(from, to string) error {
	body, _ := json.Marshal(map[string]string{"from": filepath.ToSlash(from), "to": filepath.ToSlash(to)})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, moderationURL+"/manual-commit", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := manualVideoClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("moderation service status %d", resp.StatusCode)
	}
	return nil
}

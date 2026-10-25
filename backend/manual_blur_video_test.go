package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"channel/manualblur"
)

// Tests of the manual blur of videos that need no moderation service and no ffmpeg: a fake service stands in for it (it writes and moves files
// in a temporary "blurred" folder, like the real one). They need a Redis only because the package connects to one when it starts
// (see moderation/README.md, MANUAL_BLUR).
//   go test -run ManualVideo .

const (
	vid      = "cccccccccccccccccccccccccccccccccccccccc"
	vidHash  = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	vidMtime = "2026-10-25T10:00:00Z"
)

type fakeService struct {
	*httptest.Server
	mu       sync.Mutex
	calls    []string
	renderFn func(r *http.Request, body map[string]any) (int, string) // what /manual-video answers (it may write the output file)
	commitOK bool
}

func newFakeService(t *testing.T, blurred string) *fakeService {
	t.Helper()
	f := &fakeService{commitOK: true}
	f.renderFn = func(r *http.Request, body map[string]any) (int, string) {
		out := filepath.Join(blurred, filepath.FromSlash(body["out"].(string)))
		os.MkdirAll(filepath.Dir(out), 0o755)
		os.WriteFile(out, []byte("rendered video"), 0o644)
		return 200, `{"ok":true}`
	}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.calls = append(f.calls, r.URL.Path)
		f.mu.Unlock()
		switch r.URL.Path {
		case "/manual-video":
			code, resp := f.renderFn(r, body)
			w.WriteHeader(code)
			w.Write([]byte(resp))
		case "/manual-video-progress":
			w.Write([]byte(`{"percent":42}`))
		case "/manual-video-cancel":
			w.Write([]byte(`{"ok":true}`))
		case "/manual-commit":
			if !f.commitOK {
				w.WriteHeader(500)
				return
			}
			from, to := filepath.Join(blurred, filepath.FromSlash(body["from"].(string))), filepath.Join(blurred, filepath.FromSlash(body["to"].(string)))
			os.MkdirAll(filepath.Dir(to), 0o755)
			if err := os.Rename(from, to); err != nil {
				w.WriteHeader(422)
				return
			}
			w.Write([]byte(`{"ok":true}`))
		case "/manual-remove":
			os.Remove(filepath.Join(blurred, filepath.FromSlash(body["path"].(string))))
			w.Write([]byte(`{"ok":true}`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeService) called(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == path {
			n++
		}
	}
	return n
}

type videoEnv struct {
	up, bl string
	svc    *fakeService
}

func videoSetup(t *testing.T) *videoEnv {
	t.Helper()
	oldUp, oldBl, oldImg, oldVid, oldURL, oldStrict, oldHold, oldLog, oldUser := rootUploadPath, rootBlurredPath, manualBlurEnabled, manualBlurVideoEnabled, moderationURL, strictUntilReviewed, holdVideos, moderationLogFile, manualUser
	manualUser = func(*http.Request) string { return "owner@example.com" }
	t.Cleanup(func() {
		manualUser = oldUser
		rootUploadPath, rootBlurredPath, manualBlurEnabled, manualBlurVideoEnabled, moderationURL, strictUntilReviewed, holdVideos, moderationLogFile = oldUp, oldBl, oldImg, oldVid, oldURL, oldStrict, oldHold, oldLog
	})
	e := &videoEnv{up: t.TempDir(), bl: t.TempDir()}
	rootUploadPath, rootBlurredPath = e.up, e.bl
	manualBlurEnabled, manualBlurVideoEnabled, strictUntilReviewed, holdVideos = false, true, false, false
	moderationLogFile = filepath.Join(t.TempDir(), "moderation.yaml")
	e.svc = newFakeService(t, e.bl)
	moderationURL = e.svc.URL
	writeTestFile(t, filepath.Join(e.up, vidHash[:2], vidHash[2:4], vidHash)) // the original
	return e
}

func videoMeta(status string) map[string]any {
	return map[string]any{"type": "video", "mime": "video/mp4", "hash": vidHash, "moderation": status, "autoDecision": status,
		"autoCheckedAt": vidMtime, "modGen": 1, "filename": "v.mp4"}
}

func storeMeta(t *testing.T, id string, meta map[string]any) {
	t.Helper()
	os.MkdirAll(filepath.Dir(metadataPath(id)), 0o755)
	if err := writeMetadata(id, meta); err != nil {
		t.Fatal(err)
	}
}

func tracksFor(t *testing.T) []manualblur.Track {
	t.Helper()
	tr, err := manualblur.ValidateTracks([]manualblur.Track{{Type: manualblur.Rect, Keys: []manualblur.Key{
		{T: 1, X: 0.1, Y: 0.1, W: 0.2, H: 0.2}, {T: 3, X: 0.5, Y: 0.4, W: 0.2, H: 0.2}}}})
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func newTask(t *testing.T, id string, meta map[string]any) *manualVideoTask {
	t.Helper()
	base := manualBaseOf(meta)
	if !base.OK {
		t.Fatalf("base not available: %s", base.Reason)
	}
	ctx, cancel := context.WithCancel(context.Background())
	job := &manualJob{ID: "0123456789abcdef", State: "queued", Started: time.Now(), cancel: cancel}
	manualJobsMu.Lock()
	manualJobs[id] = job
	manualJobsMu.Unlock()
	t.Cleanup(func() { cancel(); manualJobsMu.Lock(); delete(manualJobs, id); manualJobsMu.Unlock() })
	return &manualVideoTask{id: id, tracks: tracksFor(t), sig: manualSignature(meta, base), base: base, user: "owner@example.com", job: job, ctx: ctx}
}

func TestManualVideoFlagsAreSeparate(t *testing.T) {
	videoSetup(t)
	if manualEnabledFor("image") || !manualEnabledFor("video") || manualEnabledFor("audio") {
		t.Fatal("MANUAL_BLUR (pictures) and MANUAL_BLUR_VIDEO (videos) must be independent")
	}
	manualBlurEnabled, manualBlurVideoEnabled = true, false
	if !manualEnabledFor("image") || manualEnabledFor("video") {
		t.Fatal("pictures on, videos off")
	}
	meta := videoMeta(ModOpen)
	if manualActive(meta, vid) {
		t.Error("the video tool is off: no manual version may be served")
	}
}

func TestManualVideoBase(t *testing.T) {
	videoSetup(t)
	for _, st := range []string{ModOpen, ModRegional, ModBlurred, ModPending, ""} {
		if b := manualBaseOf(videoMeta(st)); !b.OK || b.Base.Kind != "original" || b.Root != "files" {
			t.Errorf("status %q: from scratch the base is always the original: %+v", st, b)
		}
	}
	notVideo := videoMeta(ModOpen)
	notVideo["mime"] = "application/pdf"
	if b := manualBaseOf(notVideo); b.OK || b.Reason != "unsupported_format" {
		t.Errorf("not a video: %+v", b)
	}
	strictUntilReviewed = true // a crowd video that STRICT_UNTIL_REVIEWED hides: a moderator may still decide for himself
	crowd := videoMeta(ModRegional)
	crowd["autoNeedsReview"] = true
	if b := manualBaseOf(crowd); !b.OK {
		t.Errorf("hidden crowd video: %+v", b)
	}
}

func TestManualVideoServedOnlyWhileValid(t *testing.T) {
	e := videoSetup(t)
	meta := videoMeta(ModBlurred)
	b := manualBaseOf(meta)
	writeTestFile(t, filepath.Join(e.bl, manualVideoRelPath(vid)))
	meta[manualBlurMetaKey] = map[string]any{"tracks": manualblur.TracksToMeta(tracksFor(t)), "sig": manualSignature(meta, b), "rev": "abc"}
	if v := baseVariant(meta, vid); v != VariantManual {
		t.Fatalf("valid manual video on a fully blurred file: %s", v)
	}
	if got := manualPathFor(meta, vid); filepath.Ext(got) != ".mp4" {
		t.Errorf("the file of a video is an .mp4: %s", got)
	}
	stays := map[string]func(m map[string]any){
		"check again":         func(m map[string]any) { m["modGen"] = 2 },
		"new automatic check": func(m map[string]any) { m["autoCheckedAt"] = "2026-10-25T12:00:00Z" },
		"automatic status":    func(m map[string]any) { m["moderation"] = ModRegional },
	}
	for name, change := range stays {
		m := videoMeta(ModBlurred)
		m[manualBlurMetaKey] = meta[manualBlurMetaKey]
		change(m)
		if v := baseVariant(m, vid); v != VariantManual {
			t.Errorf("%s: the automatic result is irrelevant, the manual version must stay (%s)", name, v)
		}
	}
	m := videoMeta(ModBlurred)
	m[manualBlurMetaKey] = meta[manualBlurMetaKey]
	m["reviewedAt"] = "2026-10-25T12:30:00Z" // a decision by hand made later wins
	if v := baseVariant(m, vid); v == VariantManual {
		t.Error("a decision by hand after the manual video must win")
	}
	os.Remove(filepath.Join(e.bl, manualVideoRelPath(vid)))
	if v := baseVariant(meta, vid); v == VariantManual {
		t.Error("the file is gone: must not be served")
	}
}

func TestManualVideoHoldTokenFollowsTheManualVersion(t *testing.T) {
	videoSetup(t)
	meta := videoMeta(ModOpen)
	before := holdToken(meta)
	b := manualBaseOf(meta)
	meta[manualBlurMetaKey] = map[string]any{"sig": manualSignature(meta, b), "rev": "r1"}
	t1 := holdToken(meta)
	meta[manualBlurMetaKey] = map[string]any{"sig": manualSignature(meta, b), "rev": "r2"}
	t2 := holdToken(meta)
	if before == t1 || t1 == t2 {
		t.Errorf("the approver must look again after a manual blur is saved or changed: %q %q %q", before, t1, t2)
	}
	meta[manualBlurMetaKey] = map[string]any{"sig": "an old base", "rev": "r1"}
	if holdToken(meta) != before {
		t.Error("a stale manual version must not change what the approver has to look at")
	}
}

func TestManualVideoJobSuccess(t *testing.T) {
	e := videoSetup(t)
	meta := videoMeta(ModOpen)
	meta["approvedBy"], meta["approvedAt"], meta["holdRequired"] = "approver@example.com", "2026-10-25T09:00:00Z", true
	storeMeta(t, vid, meta)
	task := newTask(t, vid, meta)
	runManualVideo(task)

	if info := manualJobInfoFor(vid); info == nil || info.State != "done" || info.Percent != 100 {
		t.Fatalf("job: %+v", info)
	}
	got, _ := readMetadata(vid)
	entry := manualEntry(got)
	if entry == nil || metaString(entry, "sig") != task.sig || metaString(entry, "rev") != task.job.ID || metaString(entry, "by") != "owner@example.com" {
		t.Fatalf("metadata: %+v", entry)
	}
	if len(manualblur.TracksFromMeta(entry["tracks"])) != 1 {
		t.Error("the tracks were not saved")
	}
	if _, err := os.Stat(filepath.Join(e.bl, manualVideoRelPath(vid))); err != nil {
		t.Error("the final file is not there")
	}
	if _, err := os.Stat(filepath.Join(e.bl, manualVideoTmpRelPath(vid, task.job.ID))); err == nil {
		t.Error("the job file was not renamed")
	}
	if metaString(got, "approvedAt") == "" {
		t.Error("an approved video must stay approved: the manual blur only adds blur")
	}
	if !manualActive(got, vid) || baseVariant(got, vid) != VariantManual {
		t.Error("readers must get the manual version now")
	}
	if e.svc.called("/manual-commit") != 1 {
		t.Error("the backend must publish through the service")
	}
}

func TestManualVideoJobFailuresChangeNothing(t *testing.T) {
	cases := map[string]func(e *videoEnv){
		"the service answers 500": func(e *videoEnv) {
			e.svc.renderFn = func(r *http.Request, b map[string]any) (int, string) { return 500, "" }
		},
		"the service refuses the request (422)": func(e *videoEnv) {
			e.svc.renderFn = func(r *http.Request, b map[string]any) (int, string) {
				return 422, `{"error":"time after the end of the video"}`
			}
		},
		"the rendered video cannot be published": func(e *videoEnv) { e.svc.commitOK = false },
	}
	for name, arrange := range cases {
		t.Run(name, func(t *testing.T) {
			e := videoSetup(t)
			meta := videoMeta(ModOpen)
			// an earlier manual version exists and must stay exactly as it was
			b := manualBaseOf(meta)
			writeTestFile(t, filepath.Join(e.bl, manualVideoRelPath(vid)))
			old := map[string]any{"tracks": manualblur.TracksToMeta(tracksFor(t)), "sig": manualSignature(meta, b), "rev": "old", "by": "before@example.com"}
			meta[manualBlurMetaKey] = old
			storeMeta(t, vid, meta)
			arrange(e)
			task := newTask(t, vid, meta)
			runManualVideo(task)
			info := manualJobInfoFor(vid)
			if info == nil || info.State != "failed" || info.Error == "" {
				t.Fatalf("job: %+v", info)
			}
			got, _ := readMetadata(vid)
			if metaString(manualEntry(got), "rev") != "old" || metaString(manualEntry(got), "by") != "before@example.com" {
				t.Error("the earlier manual version was changed by a failed render")
			}
			data, _ := os.ReadFile(filepath.Join(e.bl, manualVideoRelPath(vid)))
			if len(data) == 0 {
				t.Error("the earlier manual file was lost")
			}
			if _, err := os.Stat(filepath.Join(e.bl, manualVideoTmpRelPath(vid, task.job.ID))); err == nil {
				t.Error("the job's file was left behind")
			}
			if e.svc.called("/manual-remove") == 0 {
				t.Error("the backend must ask the service to delete the job's file")
			}
		})
	}
}

func TestManualVideoStaleWhileRenderingIsDiscarded(t *testing.T) {
	e := videoSetup(t)
	meta := videoMeta(ModOpen)
	storeMeta(t, vid, meta)
	task := newTask(t, vid, meta)
	// while the video is being rendered, a moderator decides the file by hand (that decision must win over the manual video)
	e.svc.renderFn = func(r *http.Request, body map[string]any) (int, string) {
		out := filepath.Join(e.bl, filepath.FromSlash(body["out"].(string)))
		os.MkdirAll(filepath.Dir(out), 0o755)
		os.WriteFile(out, []byte("rendered video"), 0o644)
		m, _ := readMetadata(vid)
		m["moderation"], m["reviewedAt"] = ModBlurred, "2026-10-25T12:30:00Z"
		writeMetadata(vid, m)
		return 200, `{"ok":true}`
	}
	runManualVideo(task)
	if info := manualJobInfoFor(vid); info == nil || info.State != "failed" || !strings.Contains(info.Error, "stale") {
		t.Fatalf("job: %+v", info)
	}
	got, _ := readMetadata(vid)
	if manualEntry(got) != nil {
		t.Error("a manual version made before a later decision by hand was saved")
	}
	if _, err := os.Stat(filepath.Join(e.bl, manualVideoRelPath(vid))); err == nil {
		t.Error("a stale video became the final file")
	}
	if e.svc.called("/manual-commit") != 0 {
		t.Error("a stale video must never be published")
	}
}

func TestManualVideoCancelledJob(t *testing.T) {
	e := videoSetup(t)
	meta := videoMeta(ModOpen)
	storeMeta(t, vid, meta)
	task := newTask(t, vid, meta)
	started := make(chan struct{})
	e.svc.renderFn = func(r *http.Request, body map[string]any) (int, string) {
		close(started)
		<-r.Context().Done() // the render is running until the backend gives up
		return 500, ""
	}
	done := make(chan struct{})
	go func() { runManualVideo(task); close(done) }()
	<-started
	task.job.cancel() // replaced by a newer save, or cleared
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the job did not stop")
	}
	if info := manualJobInfoFor(vid); info == nil || info.State != "cancelled" {
		t.Fatalf("job: %+v", info)
	}
	got, _ := readMetadata(vid)
	if manualEntry(got) != nil {
		t.Error("a cancelled render changed the metadata")
	}
	if e.svc.called("/manual-video-cancel") == 0 {
		t.Error("the service must be told to stop")
	}
	// waiting in the queue when it is cancelled: not even started
	task2 := newTask(t, vid, meta)
	task2.job.cancel()
	before := e.svc.called("/manual-video")
	runManualVideo(task2)
	if e.svc.called("/manual-video") != before {
		t.Error("a cancelled job in the queue called the service")
	}
}

func TestManualVideoAPIRules(t *testing.T) {
	e := videoSetup(t)
	storeMeta(t, vid, videoMeta(ModOpen))
	body := func(s string) *http.Request { return httptest.NewRequest("POST", "/x", strings.NewReader(s)) }
	call := func(h func(http.ResponseWriter, *http.Request, string), s string) int {
		w := httptest.NewRecorder()
		h(w, body(s), vid)
		return w.Code
	}
	good := `{"tracks":[{"type":"rect","keys":[{"t":1,"x":0.1,"y":0.1,"w":0.2,"h":0.2}]}]}`
	if c := call(setManualVideo, "not json"); c != 400 {
		t.Errorf("not json: %d", c)
	}
	if c := call(setManualVideo, `{"tracks":[{"type":"star","keys":[{"t":1,"x":0.1,"y":0.1,"w":0.2,"h":0.2}]}]}`); c != 400 {
		t.Errorf("invalid track: %d", c)
	}
	moderationURL = ""
	if c := call(setManualVideo, good); c != 503 {
		t.Errorf("no service: %d", c)
	}
	moderationURL = e.svc.URL
	notVideo := videoMeta(ModOpen)
	notVideo["mime"] = "application/pdf"
	storeMeta(t, vid, notVideo)
	if c := call(setManualVideo, good); c != 409 {
		t.Errorf("not a video: %d", c)
	}
	storeMeta(t, vid, videoMeta(ModBlurred)) // a fully blurred video can be edited: the manual blur is drawn from scratch

	// accepted: 202, a job is queued, an earlier one still running is cancelled
	w := httptest.NewRecorder()
	setManualVideo(w, body(good), vid)
	if w.Code != 202 || !strings.Contains(w.Header().Get("Content-Type"), "json") {
		t.Fatalf("accepted: %d %s", w.Code, w.Header().Get("Content-Type"))
	}
	first := <-manualVideoQueue
	if first.id != vid || len(first.tracks) != 1 || first.sig == "" {
		t.Errorf("queued task: %+v", first)
	}
	setManualVideo(httptest.NewRecorder(), body(good), vid)
	second := <-manualVideoQueue
	if first.ctx.Err() == nil {
		t.Error("the newer save must cancel the older render")
	}
	if second.ctx.Err() != nil {
		t.Error("the newer render was cancelled")
	}
	if info := manualJobInfoFor(vid); info == nil || info.State != "queued" {
		t.Errorf("job info: %+v", info)
	}

	// GET
	g := httptest.NewRecorder()
	getManualVideo(g, vid, videoMeta(ModOpen))
	var out map[string]any
	json.Unmarshal(g.Body.Bytes(), &out)
	if out["kind"] != "video" || out["available"] != true || out["base"] != "original" || out["padFrames"] != float64(manualblur.PadFrames) {
		t.Errorf("GET: %v", out)
	}
	// DELETE clears the saved manual version and the job
	meta := videoMeta(ModOpen)
	meta[manualBlurMetaKey] = map[string]any{"tracks": manualblur.TracksToMeta(tracksFor(t)), "sig": "x", "rev": "r"}
	storeMeta(t, vid, meta)
	d := httptest.NewRecorder()
	deleteManualVideo(d, httptest.NewRequest("DELETE", "/x", nil), vid)
	got, _ := readMetadata(vid)
	if d.Code != 200 || manualEntry(got) != nil || manualJobInfoFor(vid) != nil || second.ctx.Err() == nil {
		t.Errorf("DELETE: code %d entry %v job %v", d.Code, manualEntry(got), manualJobInfoFor(vid))
	}
	if e.svc.called("/manual-remove") == 0 {
		t.Error("DELETE must remove the file through the service")
	}
}

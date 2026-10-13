package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/go-chi/chi"
	"github.com/icza/dyno"
	"gopkg.in/yaml.v3"
)

// Moderation statuses stored in the file metadata YAML ("moderation" field).
const (
	ModPending  = "pending"  // being checked - shown fully blurred to readers
	ModOpen     = "open"     // visible to everyone
	ModRegional = "regional" // readers get the version where only non-men figures are blurred
	ModBlurred  = "blurred"  // readers get the fully blurred version only
)

// What a reader (non-moderator) receives for a file.
const (
	VariantOriginal = "original"
	VariantRegional = "regional"
	VariantBlurred  = "blurred"
	VariantHidden   = "hidden" // STRICT_UNTIL_REVIEWED only: not shown to readers at all (a 404)
)

// STRICT_UNTIL_REVIEWED=1 (off by default): while no moderator has opened the review grid and saved (or decided the file by
// hand), a file in which the automatic check found people is shown to readers fully blurred, and a video flagged "needs review"
// (a crowd) is not shown at all. Moderators see everything as usual. It only ever hides more: automatic release is unchanged.
var strictUntilReviewed = os.Getenv("STRICT_UNTIL_REVIEWED") == "1"

// figuresReviewed: a moderator saved the review grid for this file, or made a manual decision about it.
func figuresReviewed(meta map[string]any) bool {
	return metaString(meta, "figuresReviewedAt") != "" || metaString(meta, "reviewedBy") != ""
}

// autoFoundPeople: the automatic check ran and did not report "no people".
func autoFoundPeople(meta map[string]any) bool {
	if metaString(meta, "autoDecision") == "" {
		return false
	}
	if reasons, ok := meta["autoReasons"].([]any); ok {
		for _, v := range reasons {
			if s, _ := v.(string); s == "no_people" {
				return false
			}
		}
	}
	return true
}

func strictUnreviewed(meta map[string]any) bool {
	return strictUntilReviewed && isModeratedType(metaString(meta, "type")) && autoFoundPeople(meta) && !figuresReviewed(meta)
}

func strictHidden(meta map[string]any) bool {
	needs, _ := meta["autoNeedsReview"].(bool)
	return strictUntilReviewed && metaString(meta, "type") == "video" && needs && !figuresReviewed(meta)
}

var (
	moderationURL     = os.Getenv("MODERATION_URL") // e.g. http://moderation:8000 ; empty = manual review only
	rootBlurredPath   = envOr("BLURRED_PATH", "/app/blurred/")
	moderationLogFile = "/app/logs/moderation.yaml"
	// Separate queues so images are never stuck behind a long video render.
	imageQueue = make(chan string, 1000)
	videoQueue = make(chan string, 1000)
	// A moderator is waiting for these (saved corrections, "check again"): served before the normal queue.
	urgentImageQueue = make(chan string, 1000)
	urgentVideoQueue = make(chan string, 1000)
	// Automatic checks that are running right now, so that a manual decision can stop them.
	inflightMu        sync.Mutex
	inflight          = map[string]context.CancelFunc{}
	moderationPending = "moderation:pending" // redis set of file ids waiting for automatic check
	metaMu            sync.Mutex
	moderationClient  = &http.Client{Timeout: 45 * time.Minute} // long videos are rendered twice
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func isHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

func validFileId(id string) bool { return isHex(id, 40) }

func isModeratedType(t string) bool { return t == "image" || t == "video" }

func metadataPath(id string) string {
	return filepath.Join(rootUploadPath, id[:2], id[2:4], id+".yaml")
}

func readMetadata(id string) (map[string]any, error) {
	if !validFileId(id) {
		return nil, os.ErrNotExist
	}
	data, err := os.ReadFile(metadataPath(id))
	if err != nil {
		return nil, err
	}
	var meta map[string]any
	if err := yaml.Unmarshal(data, &meta); err != nil {
		return nil, err
	}
	return meta, nil
}

// writeMetadata replaces the YAML atomically. Callers that read-modify-write must hold metaMu.
func writeMetadata(id string, meta map[string]any) error {
	data, err := yaml.Marshal(meta)
	if err != nil {
		return err
	}
	p := metadataPath(id)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func metaString(meta map[string]any, key string) string {
	s, _ := dyno.GetString(meta[key])
	return s
}

func metaHash(meta map[string]any) (string, bool) {
	h := metaString(meta, "hash")
	return h, isHex(h, 64)
}

// blurredRelPath is shared by all uploads of the same content (dedup by hash).
func blurredRelPath(hash string) string {
	return filepath.Join(hash[:2], hash[2:4], hash+".jpg")
}

func blurredExists(hash string) bool {
	_, err := os.Stat(filepath.Join(rootBlurredPath, blurredRelPath(hash)))
	return err == nil
}

// regionalRelPath is the version where only figures that are not confidently men are blurred.
func regionalRelPath(hash, kind string) string {
	ext := ".regional.jpg"
	if kind == "video" {
		ext = ".regional.mp4"
	}
	return filepath.Join(hash[:2], hash[2:4], hash+ext)
}

func regionalExists(hash, kind string) bool {
	_, err := os.Stat(filepath.Join(rootBlurredPath, regionalRelPath(hash, kind)))
	return err == nil
}

// publicVariant decides what readers get. Anything uncertain falls back to the fully blurred version.
func publicVariant(meta map[string]any) string {
	kind := metaString(meta, "type")
	if !isModeratedType(kind) {
		return VariantOriginal
	}
	if strictUntilReviewed {
		if strictHidden(meta) {
			return VariantHidden
		}
		if strictUnreviewed(meta) {
			return VariantBlurred
		}
	}
	switch metaString(meta, "moderation") {
	case ModOpen:
		return VariantOriginal
	case ModRegional:
		hash, ok := metaHash(meta)
		if ok && regionalExists(hash, kind) {
			return VariantRegional
		}
		// Nothing was found to hide, so the regional version is the original itself.
		if metaString(meta, "autoDecision") == ModOpen {
			return VariantOriginal
		}
	}
	return VariantBlurred
}

// enqueueModeration marks a file as waiting for an automatic check and schedules it.
func enqueueModeration(id string) {
	if moderationURL == "" {
		return // stays pending until a moderator decides
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rdb.SAdd(ctx, moderationPending, id)
	queueModeration(id)
}

// enqueueModerationUrgent: like enqueueModeration, for work a moderator is waiting for (it goes ahead of the queue).
func enqueueModerationUrgent(id string) {
	if moderationURL == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rdb.SAdd(ctx, moderationPending, id)
	queueModerationTo(id, true)
}

// queueModeration schedules a file without blocking (a full queue is retried by the periodic sweep).
func queueModeration(id string) { queueModerationTo(id, false) }

func queueModerationTo(id string, urgent bool) {
	q := imageQueue
	if urgent {
		q = urgentImageQueue
	}
	if meta, err := readMetadata(id); err == nil && metaString(meta, "type") == "video" {
		q = videoQueue
		if urgent {
			q = urgentVideoQueue
		}
	}
	select {
	case q <- id:
	default:
	}
}

// cancelInflight stops the automatic check that is running for this file (a moderator just decided it by hand).
func cancelInflight(id string) {
	inflightMu.Lock()
	cancel := inflight[id]
	inflightMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// manualDecisionMakesCheckPointless: a moderator opened or blurred the file by hand, so the automatic result would not be
// applied anyway (and an hour-long video would block everything behind it). Regional needs the analysis, so it is not skipped.
func manualDecisionMakesCheckPointless(meta map[string]any) bool {
	if metaString(meta, "reviewedBy") == "" {
		return false
	}
	st := metaString(meta, "moderation")
	return st == ModOpen || st == ModBlurred
}

// markLegacyPending gives pre-moderation media files a pending status and queues them.
func markLegacyPending(id string) {
	metaMu.Lock()
	meta, err := readMetadata(id)
	if err == nil && metaString(meta, "moderation") == "" {
		meta["moderation"] = ModPending
		err = writeMetadata(id, meta)
	}
	metaMu.Unlock()
	if err == nil {
		enqueueModeration(id)
	}
}

func startModeration() {
	if moderationURL == "" {
		log.Println("MODERATION_URL not set: new media stays pending (blurred) until a moderator opens it")
		return
	}
	go moderationWorker(imageQueue, urgentImageQueue)
	go moderationWorker(videoQueue, urgentVideoQueue)
	go func() {
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			ids, err := rdb.SMembers(ctx, moderationPending).Result()
			cancel()
			if err == nil {
				for _, id := range ids {
					queueModeration(id)
				}
			}
			time.Sleep(2 * time.Minute)
		}
	}()
}

func moderationWorker(queue, urgent chan string) {
	for {
		var id string
		select { // urgent work first
		case id = <-urgent:
		default:
			select {
			case id = <-urgent:
			case id = <-queue:
			}
		}
		if err := moderateFile(id); err != nil {
			log.Printf("moderation of %s failed (will retry): %v", id, err)
		}
	}
}

type moderationResult struct {
	Decision   string   `json:"decision"`
	Reasons    []string `json:"reasons"`
	Confidence float64  `json:"confidence"`
	Regions    int      `json:"regions"`
	FullFrames int      `json:"full_frames"`
	Uncovered  int      `json:"uncovered_frames"`
	ElapsedMs  int      `json:"elapsed_ms"`
	Error      string   `json:"error,omitempty"`
	// Flags for the moderators (moderation service): a crowd cannot be judged automatically; "likely men" are blurred
	// figures with clear male faces that wait for the moderator's confirmation (DECISION_V2).
	NeedsReview   bool     `json:"needs_review,omitempty"`
	ReviewReasons []string `json:"review_reasons,omitempty"`
	LikelyMen     int      `json:"likely_men,omitempty"`
}

func callModerationService(endpoint string, meta map[string]any) (*moderationResult, error) {
	return callModerationServiceCtx(context.Background(), endpoint, meta)
}

func callModerationServiceCtx(ctx context.Context, endpoint string, meta map[string]any) (*moderationResult, error) {
	hash, ok := metaHash(meta)
	if !ok {
		return nil, errors.New("invalid hash in metadata")
	}
	body, _ := json.Marshal(map[string]any{
		"path":         filepath.ToSlash(filepath.Join(hash[:2], hash[2:4], hash)),
		"kind":         metaString(meta, "type"),
		"blurred_out":  filepath.ToSlash(blurredRelPath(hash)),
		"regional_out": filepath.ToSlash(regionalRelPath(hash, metaString(meta, "type"))),
		"review_out":   filepath.ToSlash(reviewRelDir(hash)),
		"overrides":    metaOverrides(meta),
		"level":        moderationLevel(),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, moderationURL+endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := moderationClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("moderation service status %d", resp.StatusCode)
	}
	var res moderationResult
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}
	return &res, nil
}

// redisCtx gives a short-lived context for one Redis call. A context created before a long
// video render would already be expired afterwards (that left files stuck in the pending set).
func redisCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}

func moderateFile(id string) error {
	ctx, cancel := redisCtx()
	// Duplicate queue entries: only ids still in the pending set are processed.
	member, err := rdb.SIsMember(ctx, moderationPending, id).Result()
	cancel()
	if err == nil && !member {
		return nil
	}
	meta, err := readMetadata(id)
	if err != nil || !isModeratedType(metaString(meta, "type")) {
		ctx, cancel := redisCtx()
		rdb.SRem(ctx, moderationPending, id)
		cancel()
		return nil
	}

	if manualDecisionMakesCheckPointless(meta) {
		ctx, cancel := redisCtx()
		rdb.SRem(ctx, moderationPending, id)
		cancel()
		appendYamlLog(moderationLogFile, map[string]any{"action": "skipped", "fileId": id, "reason": "manual decision: " + metaString(meta, "moderation")})
		return nil
	}

	level := moderationLevel()
	gen := metaGeneration(meta)
	runCtx, runCancel := context.WithCancel(context.Background())
	inflightMu.Lock()
	inflight[id] = runCancel
	inflightMu.Unlock()
	res, err := callModerationServiceCtx(runCtx, "/process", meta)
	canceled := runCtx.Err() != nil
	inflightMu.Lock()
	delete(inflight, id)
	inflightMu.Unlock()
	runCancel()
	if canceled || (res != nil && res.Decision == "cancelled") {
		// A moderator decided the file by hand while it was being checked: the result is not needed.
		stopCtx, stopCancel := redisCtx()
		rdb.SRem(stopCtx, moderationPending, id)
		stopCancel()
		appendYamlLog(moderationLogFile, map[string]any{"action": "cancelled", "fileId": id, "reason": "manual decision during the check"})
		return nil
	}
	if err != nil {
		return err
	}
	decision := res.Decision
	if decision != ModOpen && decision != ModRegional {
		decision = ModBlurred // anything unexpected is treated as fully blurred
	}

	metaMu.Lock()
	meta, err = readMetadata(id)
	if err != nil {
		metaMu.Unlock()
		return err
	}
	if metaGeneration(meta) != gen {
		// "Check again" was requested while this run was in flight: drop this result, run again.
		metaMu.Unlock()
		queueModeration(id)
		return nil
	}
	hash, _ := metaHash(meta)
	manual := metaString(meta, "reviewedBy") != ""
	if !manual {
		meta["moderation"] = decision
	}
	meta["autoDecision"] = decision
	meta["autoReasons"] = res.Reasons
	meta["autoConfidence"] = res.Confidence
	meta["autoRegions"] = res.Regions
	meta["autoFullFrames"] = res.FullFrames
	meta["autoLevel"] = level
	// "Needs review" lasts until a moderator has dealt with the file (any correction or a manual decision).
	if res.NeedsReview && !manual && len(metaOverrides(meta)) == 0 && metaString(meta, "figuresReviewedAt") == "" {
		meta["autoNeedsReview"] = true
		meta["autoReviewReasons"] = res.ReviewReasons
	} else {
		delete(meta, "autoNeedsReview")
		delete(meta, "autoReviewReasons")
	}
	if res.LikelyMen > 0 {
		meta["autoLikelyMen"] = res.LikelyMen
	} else {
		delete(meta, "autoLikelyMen")
	}
	meta["autoCheckedAt"] = time.Now().UTC().Format(time.RFC3339)
	if blurredExists(hash) {
		meta["blurredPath"] = filepath.ToSlash(blurredRelPath(hash))
	}
	if regionalExists(hash, metaString(meta, "type")) {
		meta["regionalPath"] = filepath.ToSlash(regionalRelPath(hash, metaString(meta, "type")))
	}
	err = writeMetadata(id, meta)
	status := metaString(meta, "moderation")
	metaMu.Unlock()
	if err != nil {
		return err
	}

	ctx, cancel = redisCtx()
	defer cancel()
	if err := rdb.SRem(ctx, moderationPending, id).Err(); err != nil {
		log.Printf("moderation: could not clear pending flag of %s: %v", id, err)
	}
	appendYamlLog(moderationLogFile, map[string]any{
		"action":     "auto",
		"fileId":     id,
		"level":      level,
		"decision":   decision,
		"applied":    !manual,
		"reasons":    res.Reasons,
		"confidence": res.Confidence,
		"regions":    res.Regions,
		"fullFrames": res.FullFrames,
		"uncovered":  res.Uncovered,
		"elapsedMs":  res.ElapsedMs,
		"error":      res.Error,
	})
	publishFileModeration(ctx, id, status)
	return nil
}

func publishFileModeration(ctx context.Context, id, status string) {
	data, _ := json.Marshal(map[string]any{
		"type": "file-moderation",
		"file": map[string]string{"id": id, "status": status},
	})
	rdb.Publish(ctx, "events", data)
}

type FileModerationInfo struct {
	ID             string   `json:"id"`
	Status         string   `json:"status"`
	Kind           string   `json:"kind"`
	PublicVariant  string   `json:"publicVariant"` // what readers receive: original | regional | blurred
	AutoRegions    int      `json:"autoRegions,omitempty"`
	AutoFullFrames int      `json:"autoFullFrames,omitempty"`
	AutoLevel      string   `json:"autoLevel,omitempty"`
	ReviewedBy     string   `json:"reviewedBy,omitempty"`
	ReviewedAt     string   `json:"reviewedAt,omitempty"`
	AutoDecision   string   `json:"autoDecision,omitempty"`
	AutoReasons    []string `json:"autoReasons,omitempty"`
	AutoConfidence float64  `json:"autoConfidence"`
	NeedsReview    bool     `json:"needsReview,omitempty"`   // moderators only: e.g. a crowd that cannot be judged automatically
	ReviewReasons  []string `json:"reviewReasons,omitempty"` // moderators only
	LikelyMen      int      `json:"likelyMen,omitempty"`     // moderators only: blurred figures that look like men, waiting for confirmation
	Unreviewed     bool     `json:"unreviewed,omitempty"`    // moderators only: STRICT_UNTIL_REVIEWED is on and nobody has reviewed the figures yet
}

// getFileModeration returns the status of a file. Review details are for moderators only.
func getFileModeration(w http.ResponseWriter, r *http.Request) {
	id := stripExtension(chi.URLParam(r, "fileid"))
	meta, err := readMetadata(id)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	kind := metaString(meta, "type")
	info := FileModerationInfo{ID: id, Kind: kind, Status: ModOpen, PublicVariant: VariantOriginal}
	if isModeratedType(kind) {
		info.Status = metaString(meta, "moderation")
		if info.Status == "" {
			go markLegacyPending(id)
			info.Status = ModPending
		}
		info.PublicVariant = publicVariant(meta)
	}
	if checkPrivilege(r, Moderator) {
		info.ReviewedBy = metaString(meta, "reviewedBy")
		info.ReviewedAt = metaString(meta, "reviewedAt")
		info.AutoDecision = metaString(meta, "autoDecision")
		info.AutoLevel = metaString(meta, "autoLevel")
		if reasons, ok := meta["autoReasons"].([]any); ok {
			for _, v := range reasons {
				if s, ok := v.(string); ok {
					info.AutoReasons = append(info.AutoReasons, s)
				}
			}
		}
		info.Unreviewed = strictUnreviewed(meta)
		info.NeedsReview, _ = meta["autoNeedsReview"].(bool)
		if reasons, ok := meta["autoReviewReasons"].([]any); ok {
			for _, v := range reasons {
				if s, ok := v.(string); ok {
					info.ReviewReasons = append(info.ReviewReasons, s)
				}
			}
		}
		info.LikelyMen, _ = meta["autoLikelyMen"].(int)
		info.AutoRegions, _ = meta["autoRegions"].(int)
		info.AutoFullFrames, _ = meta["autoFullFrames"].(int)
		switch v := meta["autoConfidence"].(type) { // YAML may decode 1.0 as int
		case float64:
			info.AutoConfidence = v
		case int:
			info.AutoConfidence = float64(v)
		}
	}

	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(info)
}

// setFileModeration lets a moderator open a file to everyone or blur it.
func setFileModeration(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	req.ID = stripExtension(req.ID)
	if req.Status != ModOpen && req.Status != ModRegional && req.Status != ModBlurred {
		http.Error(w, "status must be open, regional or blurred", http.StatusBadRequest)
		return
	}

	meta, err := readMetadata(req.ID)
	if err != nil || !isModeratedType(metaString(meta, "type")) {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	hash, ok := metaHash(meta)
	if !ok {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	// Make sure a fully blurred version exists before relying on it (best effort; a placeholder is served otherwise).
	if req.Status != ModOpen && !blurredExists(hash) && moderationURL != "" {
		if _, err := callModerationService("/blur", meta); err != nil {
			log.Printf("blur generation for %s failed: %v", req.ID, err)
		}
	}

	session, _ := store.Get(r, cookieName)
	user, _ := session.Values["user"].(Session)

	metaMu.Lock()
	meta, err = readMetadata(req.ID)
	if err != nil {
		metaMu.Unlock()
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	previous := metaString(meta, "moderation")
	meta["moderation"] = req.Status
	meta["reviewedBy"] = user.Email
	meta["reviewedAt"] = time.Now().UTC().Format(time.RFC3339)
	if blurredExists(hash) {
		meta["blurredPath"] = filepath.ToSlash(blurredRelPath(hash))
	}
	err = writeMetadata(req.ID, meta)
	metaMu.Unlock()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	// "Regional" needs the regional version: make sure the file gets (re)processed if it is missing (ahead of the queue).
	if req.Status == ModRegional && !regionalExists(hash, metaString(meta, "type")) && metaString(meta, "autoDecision") != ModOpen {
		enqueueModerationUrgent(req.ID)
	}
	// Open / blurred by hand: the automatic check of this file is no longer needed - stop it and tell the service to stop working.
	if req.Status != ModRegional {
		cancelInflight(req.ID)
		go func(path string) {
			body, _ := json.Marshal(map[string]string{"path": path})
			if resp, err := moderationClient.Post(moderationURL+"/cancel", "application/json", bytes.NewReader(body)); err == nil {
				resp.Body.Close()
			}
		}(filepath.ToSlash(filepath.Join(hash[:2], hash[2:4], hash)))
	}

	appendYamlLog(moderationLogFile, map[string]any{
		"action":   "manual",
		"fileId":   req.ID,
		"from":     previous,
		"to":       req.Status,
		"by":       user.Email,
		"autoWas":  metaString(meta, "autoDecision"),
		"filename": metaString(meta, "filename"),
	})
	publishFileModeration(r.Context(), req.ID, req.Status)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{Success: true})
}

// Strictness presets understood by the moderation service.
var moderationLevels = map[string]bool{"strict": true, "normal": true, "lenient": true}

// moderationLevel is the admin setting "moderation_level" (strict | normal | lenient), default strict.
func moderationLevel() string {
	if l := settingConfig.ModerationLevel; moderationLevels[l] {
		return l
	}
	return "strict"
}

// reprocessFile runs the automatic check again (e.g. after changing the strictness level).
// Any manual decision is cleared so the new automatic result is applied; readers see the file blurred meanwhile.
func reprocessFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	req.ID = stripExtension(req.ID)
	if moderationURL == "" {
		http.Error(w, "automatic moderation is not configured", http.StatusServiceUnavailable)
		return
	}

	metaMu.Lock()
	meta, err := readMetadata(req.ID)
	if err != nil || !isModeratedType(metaString(meta, "type")) {
		metaMu.Unlock()
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	previous := metaString(meta, "moderation")
	meta["moderation"] = ModPending
	meta["modGen"] = metaGeneration(meta) + 1
	delete(meta, "reviewedBy")
	delete(meta, "reviewedAt")
	delete(meta, "figuresReviewedAt") // a fresh automatic check: the figures have to be looked at again
	delete(meta, "figuresReviewedBy")
	err = writeMetadata(req.ID, meta)
	metaMu.Unlock()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	session, _ := store.Get(r, cookieName)
	user, _ := session.Values["user"].(Session)
	appendYamlLog(moderationLogFile, map[string]any{
		"action": "reprocess",
		"fileId": req.ID,
		"from":   previous,
		"by":     user.Email,
		"level":  moderationLevel(),
	})
	enqueueModerationUrgent(req.ID)
	publishFileModeration(r.Context(), req.ID, ModPending)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{Success: true})
}

// metaGeneration counts "check again" requests, so a result computed before the latest request is discarded.
func metaGeneration(meta map[string]any) int {
	g, _ := meta["modGen"].(int)
	return g
}

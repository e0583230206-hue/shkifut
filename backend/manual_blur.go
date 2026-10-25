package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"channel/manualblur"

	"github.com/go-chi/chi"
)

// MANUAL_BLUR=1 (off by default) turns on the manual blur tool for images: an owner or approver draws rectangles / ellipses on a picture
// and the result is a separate file (<blurred>/manual/xx/yy/<fileid>.jpg). The original and the automatic versions are never changed.
//
// FROM SCRATCH: the manual blur is drawn on the ORIGINAL, independent of what the automatic check decided. Readers get the original with
// ONLY the shapes the moderator drew blurred (everything else is shown); the moderator decides, the automatic result is not consulted.
// It is valid while the original is the same and no decision by hand was made after it (see manualSignature); then readers get the automatic
// version again. A video that waits for approval (HOLD_VIDEOS_UNTIL_APPROVED) is still hidden until approved.
// With the flag off nothing here is reachable and no manual version is served.
var manualBlurEnabled = os.Getenv("MANUAL_BLUR") == "1"

// MANUAL_IMAGE_MAX_SIDE: longest side of a manual picture made from an original (the regional picture is at most 1600 px already).
var manualImageMaxSide = envInt("MANUAL_IMAGE_MAX_SIDE", 2560)

var (
	manualSaveMu   sync.Mutex // saves are rare; one at a time keeps the file and the metadata of a picture in step
	manualClient   = &http.Client{Timeout: 60 * time.Second}
	errManualNoSvc = errors.New("moderation service is not configured")
)

const manualBlurMetaKey = "manualBlur"

// manualEnabledFor: the tool of this kind of file is on (MANUAL_BLUR for pictures, MANUAL_BLUR_VIDEO for videos: separate flags).
func manualEnabledFor(kind string) bool {
	switch kind {
	case "image":
		return manualBlurEnabled
	case "video":
		return manualBlurVideoEnabled
	}
	return false
}

// canManualBlurKind: owners (ADMIN_USERS) and approvers (APPROVER_EMAILS), who must also be moderators, and only with the flag of that kind on.
func canManualBlurKind(r *http.Request, kind string) bool {
	return manualEnabledFor(kind) && isMediaModerator(r) && emailIsApprover(sessionEmail(r))
}

// protectedWithManualBlur: the routes exist when either flag is on and are for owners / approvers; each handler then checks the flag of the
// kind of the file (404 when that tool is off).
func protectedWithManualBlur(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !manualBlurEnabled && !manualBlurVideoEnabled {
			http.NotFound(w, r)
			return
		}
		if !isMediaModerator(r) || !emailIsApprover(sessionEmail(r)) {
			http.Error(w, "User not authorized or not privilege", http.StatusUnauthorized)
			return
		}
		handler(w, r)
	}
}

func manualRelPath(id string) string {
	return filepath.Join("manual", id[:2], id[2:4], id+".jpg")
}

func manualAbsPath(id string) string { return filepath.Join(rootBlurredPath, manualRelPath(id)) }

// manualPathFor: the file of the manual version of a picture (.jpg) or a video (.mp4).
func manualPathFor(meta map[string]any, id string) string {
	if metaString(meta, "type") == "video" {
		return filepath.Join(rootBlurredPath, manualVideoRelPath(id))
	}
	return manualAbsPath(id)
}

// manualBase is what a manual version would be drawn on, or why the tool is not available for this file.
type manualBase struct {
	OK      bool
	Reason  string // when not OK: not_image | unsupported_format | unreviewed | fully_blurred | no_regional_version | no_hash
	Root    string // "files" (the original) or "blurred" (the regional picture): which folder the moderation service reads from
	Rel     string
	Base    manualblur.Base
	absPath string
}

func manualBaseOf(meta map[string]any) manualBase {
	kind := metaString(meta, "type")
	if kind != "image" && kind != "video" {
		return manualBase{Reason: "not_image"}
	}
	hash, ok := metaHash(meta)
	if !ok {
		return manualBase{Reason: "no_hash"}
	}
	original := filepath.Join(rootUploadPath, hash[:2], hash[2:4], hash)
	mime := detectMime(meta, original)
	if kind == "image" && !manualblur.StaticImageMime(mime) || kind == "video" && !manualblur.VideoMime(mime) {
		return manualBase{Reason: "unsupported_format"}
	}
	// From scratch: the manual blur is drawn on the ORIGINAL, whatever the automatic check decided.
	return manualBase{OK: true, Root: "files", Rel: filepath.ToSlash(filepath.Join(hash[:2], hash[2:4], hash)),
		Base: manualblur.Base{Kind: "original", Version: versionTag(original)}, absPath: original}
}

// manualSignature: what a manual version stays valid for: the original file, and the last decision by hand (open / regional / blurred, "check
// again", saved figures: the person who made the manual version did not know about a decision made later, and the latest decision wins).
// The automatic result is NOT part of it: a manual version is drawn from scratch, on the original.
func manualSignature(meta map[string]any, b manualBase) string {
	return manualblur.Signature("scratch", 0, "", metaString(meta, "reviewedAt"), b.Base)
}

func manualEntry(meta map[string]any) map[string]any {
	m, _ := meta[manualBlurMetaKey].(map[string]any)
	return m
}

// manualValid: a manual version exists, was made on the picture readers get from the automatic check right now, and its file is there.
func manualValid(meta map[string]any, id string) bool {
	e := manualEntry(meta)
	if e == nil {
		return false
	}
	b := manualBaseOf(meta)
	if !b.OK || metaString(e, "sig") != manualSignature(meta, b) {
		return false
	}
	_, err := os.Stat(manualPathFor(meta, id))
	return err == nil
}

// manualActive: readers get the manual version of this file.
func manualActive(meta map[string]any, id string) bool {
	return manualEnabledFor(metaString(meta, "type")) && validFileId(id) && manualValid(meta, id)
}

// manualRevIfValid: the revision of the manual version when it was made on the automatic result readers get now (the signature is the
// same), without looking at the file. For the approval of held videos, which has no file id at hand.
func manualRevIfValid(meta map[string]any) (string, bool) {
	e := manualEntry(meta)
	if e == nil || !manualEnabledFor(metaString(meta, "type")) {
		return "", false
	}
	b := manualBaseOf(meta)
	if !b.OK || metaString(e, "sig") != manualSignature(meta, b) {
		return "", false
	}
	return metaString(e, "rev"), true
}

// manualOr: the automatic variant, or the manual one when it applies.
func manualOr(meta map[string]any, id, variant string) string {
	if manualActive(meta, id) { // from scratch: it replaces even a fully blurred or an unreviewed result (a held video is hidden before this is asked)
		return VariantManual
	}
	return variant
}

func serveManual(w http.ResponseWriter, r *http.Request, id, kind string, wm *watermarkConfig) {
	p := manualAbsPath(id)
	if kind == "video" {
		p = filepath.Join(rootBlurredPath, manualVideoRelPath(id))
	}
	if kind != "video" && wm != nil && serveWatermarked(w, r, wm, p, "m", id) {
		return
	}
	f, err := os.Open(p)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	setPrivateCacheHeaders(w, "m-"+id+"-"+versionTag(p))
	if kind == "video" {
		w.Header().Set("Content-Type", "video/mp4")
	} else {
		w.Header().Set("Content-Type", "image/jpeg")
	}
	w.Header().Set("Content-Disposition", "inline")
	http.ServeContent(w, r, "", time.Time{}, f) // Range / If-None-Match
}

// manualInfo is what the moderation info of a file tells an owner / approver about the tool.
type manualInfo struct {
	Available bool           `json:"available"`
	Reason    string         `json:"reason,omitempty"`
	Active    bool           `json:"active"`
	Stale     bool           `json:"stale,omitempty"` // there is a saved manual blur, made on a base that has changed since
	Shapes    int            `json:"shapes"`          // pictures: the shapes; videos: the tracks
	Job       *manualJobInfo `json:"job,omitempty"`   // videos: the render that is running or has just ended
}

func manualInfoFor(meta map[string]any, id string) *manualInfo {
	b := manualBaseOf(meta)
	info := &manualInfo{Available: b.OK, Reason: b.Reason}
	if e := manualEntry(meta); e != nil {
		if metaString(meta, "type") == "video" {
			info.Shapes = len(manualblur.TracksFromMeta(e["tracks"]))
		} else {
			info.Shapes = len(manualblur.FromMeta(e["shapes"]))
		}
		info.Active = manualValid(meta, id)
		info.Stale = !info.Active
	}
	if metaString(meta, "type") == "video" {
		info.Job = manualJobInfoFor(id)
	}
	return info
}

// ---- API ----

func manualFileID(w http.ResponseWriter, r *http.Request) (string, map[string]any, bool) {
	id := stripExtension(chi.URLParam(r, "fileid"))
	meta, err := readMetadata(id)
	if err != nil || !isModeratedType(metaString(meta, "type")) {
		http.Error(w, "File not found", http.StatusNotFound)
		return "", nil, false
	}
	return id, meta, true
}

// getManualBlur: GET /api/admin/files/{fileid}/manual-blur
func getManualBlur(w http.ResponseWriter, r *http.Request) {
	id, meta, ok := manualFileID(w, r)
	if !ok {
		return
	}
	kind := metaString(meta, "type")
	if !manualEnabledFor(kind) {
		http.NotFound(w, r)
		return
	}
	if kind == "video" {
		getManualVideo(w, id, meta)
		return
	}
	b := manualBaseOf(meta)
	out := map[string]any{"available": b.OK, "reason": b.Reason, "shapes": []manualblur.Shape{}}
	if b.OK {
		out["base"] = b.Base.Kind
	}
	if e := manualEntry(meta); e != nil {
		out["shapes"] = manualblur.FromMeta(e["shapes"])
		out["active"] = manualValid(meta, id)
		out["by"], out["at"] = metaString(e, "by"), metaString(e, "at")
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, out)
}

// setManualBlur: POST /api/admin/files/{fileid}/manual-blur {"shapes":[{"type":"rect|ellipse","x","y","w","h"}]}. No shapes clears it.
func setManualBlur(w http.ResponseWriter, r *http.Request) {
	id, kindMeta, ok := manualFileID(w, r)
	if !ok {
		return
	}
	if !manualEnabledFor(metaString(kindMeta, "type")) {
		http.NotFound(w, r)
		return
	}
	if metaString(kindMeta, "type") == "video" {
		setManualVideo(w, r, id)
		return
	}
	var req struct {
		Shapes []manualblur.Shape `json:"shapes"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	shapes, err := manualblur.Validate(req.Shapes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	user := sessionEmail(r)

	manualSaveMu.Lock()
	defer manualSaveMu.Unlock()
	meta, err := readMetadata(id)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	if len(shapes) == 0 {
		clearManualBlur(w, r, id, meta, user)
		return
	}
	base := manualBaseOf(meta)
	if !base.OK {
		http.Error(w, "manual blur is not available for this file: "+base.Reason, http.StatusConflict)
		return
	}
	sig := manualSignature(meta, base)
	if err := renderManual(id, base, shapes); err != nil {
		switch {
		case errors.Is(err, errManualNoSvc):
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
		case isManualRejected(err):
			http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		default:
			log.Printf("manual blur render of %s failed: %v", id, err)
			http.Error(w, "render failed", http.StatusBadGateway)
		}
		return
	}

	metaMu.Lock()
	meta, err = readMetadata(id)
	if err == nil {
		// The automatic result may have changed while the picture was being drawn: the new manual version would sit on a base that is gone.
		if nb := manualBaseOf(meta); !nb.OK || manualSignature(meta, nb) != sig {
			metaMu.Unlock()
			manualServiceRemove(manualRelPath(id))
			http.Error(w, "the automatic result changed meanwhile, open the tool again", http.StatusConflict)
			return
		}
		meta[manualBlurMetaKey] = map[string]any{
			"shapes": manualblur.ToMeta(shapes),
			"by":     user,
			"at":     time.Now().UTC().Format(time.RFC3339),
			"sig":    sig,
		}
		clearApproval(meta) // what readers get changed: an earlier approval no longer covers it
		err = writeMetadata(id, meta)
	}
	status := metaString(meta, "moderation")
	metaMu.Unlock()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	appendYamlLog(moderationLogFile, map[string]any{"action": "manual-blur", "fileId": id, "by": user, "shapes": len(shapes), "base": base.Base.Kind})
	publishFileModeration(r.Context(), id, status)
	writeJSON(w, map[string]any{"success": true, "shapes": len(shapes), "active": true})
}

// deleteManualBlur: DELETE /api/admin/files/{fileid}/manual-blur
func deleteManualBlur(w http.ResponseWriter, r *http.Request) {
	id, kindMeta, ok := manualFileID(w, r)
	if !ok {
		return
	}
	if !manualEnabledFor(metaString(kindMeta, "type")) {
		http.NotFound(w, r)
		return
	}
	if metaString(kindMeta, "type") == "video" {
		deleteManualVideo(w, r, id)
		return
	}
	manualSaveMu.Lock()
	defer manualSaveMu.Unlock()
	meta, err := readMetadata(id)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	clearManualBlur(w, r, id, meta, sessionEmail(r))
}

func clearManualBlur(w http.ResponseWriter, r *http.Request, id string, _ map[string]any, user string) {
	metaMu.Lock()
	meta, err := readMetadata(id)
	had := false
	if err == nil {
		_, had = meta[manualBlurMetaKey]
		delete(meta, manualBlurMetaKey)
		if had {
			clearApproval(meta)
			err = writeMetadata(id, meta)
		}
	}
	status := metaString(meta, "moderation")
	metaMu.Unlock()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	manualServiceRemove(manualRelPath(id))
	if had {
		appendYamlLog(moderationLogFile, map[string]any{"action": "manual-blur-cleared", "fileId": id, "by": user})
		publishFileModeration(r.Context(), id, status)
	}
	writeJSON(w, map[string]any{"success": true, "shapes": 0, "active": false})
}

// ---- the moderation service renders the picture ----

type manualRejected struct{ msg string }

func (e manualRejected) Error() string { return e.msg }

func isManualRejected(err error) bool { var m manualRejected; return errors.As(err, &m) }

func renderManual(id string, base manualBase, shapes []manualblur.Shape) error {
	if moderationURL == "" {
		return errManualNoSvc
	}
	body, _ := json.Marshal(map[string]any{
		"base":      base.Rel,
		"base_root": base.Root,
		"out":       filepath.ToSlash(manualRelPath(id)),
		"shapes":    shapes,
		"max_side":  manualImageMaxSide,
	})
	resp, err := manualClient.Post(moderationURL+"/manual-image", "application/json", bytes.NewReader(body))
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
		return manualRejected{msg: e.Error}
	}
	return fmt.Errorf("moderation service status %d", resp.StatusCode)
}

// manualServiceRemove deletes a file of the manual blur through the moderation service: the backend sees the blurred folder read-only, only
// the service can write there. Best effort (a file left behind is never served: no valid manual entry points to it).
func manualServiceRemove(rel string) {
	if moderationURL == "" {
		return
	}
	body, _ := json.Marshal(map[string]string{"path": filepath.ToSlash(rel)})
	resp, err := manualClient.Post(moderationURL+"/manual-remove", "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("manual blur: could not remove %s: %v", rel, err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("manual blur: removing %s: moderation service status %d", rel, resp.StatusCode)
	}
}

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
// The manual blur only ever adds blur: it is drawn on the picture readers get from the automatic check (the original of an "open"
// file, the regional picture of a "regional" one). It is valid only for exactly that base (see package manualblur): when the automatic
// result changes, readers get the automatic version again, and the moderator sees that the manual version is no longer valid.
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

// canManualBlur: owners (ADMIN_USERS) and approvers (APPROVER_EMAILS), who must also be moderators, and only with the flag on.
func canManualBlur(r *http.Request) bool {
	return manualBlurEnabled && checkPrivilege(r, Moderator) && emailIsApprover(sessionEmail(r))
}

func protectedWithManualBlur(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !manualBlurEnabled {
			http.NotFound(w, r)
			return
		}
		if !canManualBlur(r) {
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
	if metaString(meta, "type") != "image" {
		return manualBase{Reason: "not_image"}
	}
	hash, ok := metaHash(meta)
	if !ok {
		return manualBase{Reason: "no_hash"}
	}
	original := filepath.Join(rootUploadPath, hash[:2], hash[2:4], hash)
	if !manualblur.StaticImageMime(detectMime(meta, original)) {
		return manualBase{Reason: "unsupported_format"}
	}
	if strictUnreviewed(meta) { // readers get the fully blurred version until the figures are reviewed: nothing to add to
		return manualBase{Reason: "unreviewed"}
	}
	originalBase := manualBase{OK: true, Root: "files", Rel: filepath.ToSlash(filepath.Join(hash[:2], hash[2:4], hash)),
		Base: manualblur.Base{Kind: "original", Version: versionTag(original)}, absPath: original}
	switch metaString(meta, "moderation") {
	case ModOpen:
		return originalBase
	case ModRegional:
		if regionalExists(hash, "image") {
			p := filepath.Join(rootBlurredPath, regionalRelPath(hash, "image"))
			return manualBase{OK: true, Root: "blurred", Rel: filepath.ToSlash(regionalRelPath(hash, "image")),
				Base: manualblur.Base{Kind: "regional", Version: versionTag(p)}, absPath: p}
		}
		if metaString(meta, "autoDecision") == ModOpen { // nothing was found to hide: the regional version is the original itself
			return originalBase
		}
		return manualBase{Reason: "no_regional_version"}
	}
	return manualBase{Reason: "fully_blurred"}
}

func manualSignature(meta map[string]any, b manualBase) string {
	return manualblur.Signature(metaString(meta, "moderation"), metaGeneration(meta), metaString(meta, "autoCheckedAt"), metaString(meta, "reviewedAt"), b.Base)
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
	_, err := os.Stat(manualAbsPath(id))
	return err == nil
}

// manualActive: readers get the manual version of this file.
func manualActive(meta map[string]any, id string) bool {
	return manualBlurEnabled && validFileId(id) && manualValid(meta, id)
}

// manualOr: the automatic variant, or the manual one when it applies. Only an original / regional result can be replaced: a fully
// blurred or hidden file stays so.
func manualOr(meta map[string]any, id, variant string) string {
	if (variant == VariantOriginal || variant == VariantRegional) && manualActive(meta, id) {
		return VariantManual
	}
	return variant
}

func serveManual(w http.ResponseWriter, r *http.Request, id string, wm *watermarkConfig) {
	p := manualAbsPath(id)
	if wm != nil && serveWatermarked(w, r, wm, p, "m", id) {
		return
	}
	f, err := os.Open(p)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	setPrivateCacheHeaders(w, "m-"+id+"-"+versionTag(p))
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Content-Disposition", "inline")
	http.ServeContent(w, r, "", time.Time{}, f)
}

// manualInfo is what the moderation info of a file tells an owner / approver about the tool.
type manualInfo struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	Active    bool   `json:"active"`
	Stale     bool   `json:"stale,omitempty"` // there is a saved manual blur, made on a base that has changed since
	Shapes    int    `json:"shapes"`
}

func manualInfoFor(meta map[string]any, id string) *manualInfo {
	b := manualBaseOf(meta)
	info := &manualInfo{Available: b.OK, Reason: b.Reason}
	if e := manualEntry(meta); e != nil {
		info.Shapes = len(manualblur.FromMeta(e["shapes"]))
		info.Active = manualValid(meta, id)
		info.Stale = !info.Active
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
	id, _, ok := manualFileID(w, r)
	if !ok {
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
			os.Remove(manualAbsPath(id))
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
	id, _, ok := manualFileID(w, r)
	if !ok {
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
	os.Remove(manualAbsPath(id))
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

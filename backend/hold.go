package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi"
)

// HOLD_VIDEOS_UNTIL_APPROVED=1 (off by default): a video uploaded while the flag is on ("holdRequired" in its metadata) is not
// served to readers at all (a 404, the page says "waiting for approval") until an approver presses "approve" for it.
// The check and the blur run as usual; moderators and approvers see the video as always. Images are not affected, and neither are
// videos uploaded before the flag was turned on (they have no "holdRequired", so they count as approved).
//
// The approval is tied to what the approver actually looked at: the approver must have requested the video with ?view=public
// ("show as readers see") in the current check. A manual decision, "check again" or a saved correction ends the approval.
var holdVideos = os.Getenv("HOLD_VIDEOS_UNTIL_APPROVED") == "1"

// APPROVER_EMAILS (comma separated) are the people who may review figures and approve videos while the flag is on, in addition
// to the owners (ADMIN_USERS). An approver also has to be a moderator in the users list.
func emailIsApprover(email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return false
	}
	for _, list := range []string{os.Getenv("APPROVER_EMAILS"), strings.Join(adminUsers, ",")} {
		for _, e := range strings.Split(list, ",") {
			if strings.ToLower(strings.TrimSpace(e)) == email {
				return true
			}
		}
	}
	return false
}

func sessionEmail(r *http.Request) string {
	session, _ := store.Get(r, cookieName)
	s, _ := session.Values["user"].(Session)
	return s.Email
}

// canReviewFigures: who may open the review grid. Without the flag, every moderator (unchanged).
func canReviewFigures(r *http.Request) bool {
	if !checkPrivilege(r, Moderator) {
		return false
	}
	return !holdVideos || emailIsApprover(sessionEmail(r))
}

func protectedWithApprover(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !canReviewFigures(r) {
			http.Error(w, "User not authorized or not privilege", http.StatusUnauthorized)
			return
		}
		handler(w, r)
	}
}

// holdActive: readers get nothing of this video yet.
func holdActive(meta map[string]any) bool {
	if !holdVideos || metaString(meta, "type") != "video" {
		return false
	}
	required, _ := meta["holdRequired"].(bool)
	return required && metaString(meta, "approvedAt") == ""
}

// holdToken identifies what readers would get right now (variant, file revision, check generation). It changes whenever the
// video is regenerated (saved correction, "check again") or the decision changes.
func holdToken(meta map[string]any) string {
	variant := baseVariantAuto(meta) // videos only: the manual blur is for images
	rev := "0"
	if hash, ok := metaHash(meta); ok {
		switch variant {
		case VariantRegional:
			rev = versionTag(filepath.Join(rootBlurredPath, regionalRelPath(hash, metaString(meta, "type"))))
		case VariantBlurred:
			rev = versionTag(filepath.Join(rootBlurredPath, blurredRelPath(hash)))
		}
	}
	return fmt.Sprintf("%s-%s-%d-%s", variant, rev, metaGeneration(meta), metaString(meta, "moderation"))
}

// clearApproval ends an approval (and the approver's "I looked at it"). Call with metaMu held, before writing the metadata.
func clearApproval(meta map[string]any) {
	for _, k := range []string{"approvedBy", "approvedAt", "holdViewedBy", "holdViewedToken", "holdViewedAt"} {
		delete(meta, k)
	}
}

// recordHoldView: the approver requested the video the way readers would get it (?view=public). Remembered per check.
func recordHoldView(id, email string) {
	metaMu.Lock()
	defer metaMu.Unlock()
	meta, err := readMetadata(id)
	if err != nil || !holdActive(meta) {
		return
	}
	token := holdToken(meta)
	if metaString(meta, "holdViewedToken") == token && metaString(meta, "holdViewedBy") == email {
		return
	}
	meta["holdViewedToken"] = token
	meta["holdViewedBy"] = email
	meta["holdViewedAt"] = time.Now().UTC().Format(time.RFC3339)
	if err := writeMetadata(id, meta); err != nil {
		log.Printf("hold: could not record the view of %s: %v", id, err)
	}
}

// holdViewedBy: this approver has looked at the current version as readers see it.
func holdViewedBy(meta map[string]any, email string) bool {
	return metaString(meta, "holdViewedBy") == email && metaString(meta, "holdViewedToken") == holdToken(meta)
}

// approveVideo: POST /api/admin/files/{fileid}/approve (approver)
func approveVideo(w http.ResponseWriter, r *http.Request) {
	id := stripExtension(chi.URLParam(r, "fileid"))
	if !holdVideos {
		http.Error(w, "HOLD_VIDEOS_UNTIL_APPROVED is off", http.StatusBadRequest)
		return
	}
	email := sessionEmail(r)

	metaMu.Lock()
	meta, err := readMetadata(id)
	if err != nil || metaString(meta, "type") != "video" {
		metaMu.Unlock()
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	if required, _ := meta["holdRequired"].(bool); !required || metaString(meta, "approvedAt") != "" {
		metaMu.Unlock() // nothing to approve (or already approved)
		writeJSON(w, map[string]any{"success": true, "approvedBy": metaString(meta, "approvedBy")})
		return
	}
	if metaString(meta, "moderation") == ModPending {
		metaMu.Unlock()
		http.Error(w, "the automatic check has not finished", http.StatusConflict)
		return
	}
	if !holdViewedBy(meta, email) {
		metaMu.Unlock()
		http.Error(w, "view_required", http.StatusConflict)
		return
	}
	meta["approvedBy"] = email
	meta["approvedAt"] = time.Now().UTC().Format(time.RFC3339)
	err = writeMetadata(id, meta)
	status := metaString(meta, "moderation")
	metaMu.Unlock()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	appendYamlLog(moderationLogFile, map[string]any{"action": "approved", "fileId": id, "by": email, "filename": metaString(meta, "filename")})
	publishFileModeration(r.Context(), id, status) // open pages fetch the new state
	writeJSON(w, map[string]any{"success": true, "approvedBy": email})
}

// holdInfoFor: what the review grid and the media bar show about the hold (moderators only).
func holdInfoFor(r *http.Request, meta map[string]any) map[string]any {
	if !holdVideos || metaString(meta, "type") != "video" {
		return nil
	}
	required, _ := meta["holdRequired"].(bool)
	if !required {
		return nil
	}
	email := sessionEmail(r)
	approved := metaString(meta, "approvedAt") != ""
	return map[string]any{
		"held":       !approved,
		"approvedBy": metaString(meta, "approvedBy"),
		"approvedAt": metaString(meta, "approvedAt"),
		"viewed":     !approved && holdViewedBy(meta, email),
		"pending":    metaString(meta, "moderation") == ModPending,
		"canApprove": emailIsApprover(email),
	}
}

// --- Notification to the private Chat space, through the bridge (text only, no media).

var (
	bridgeNotifyURL = os.Getenv("BRIDGE_NOTIFY_URL") // e.g. http://bridge:8080/notify ; empty = no notification
	bridgeNotifyKey = os.Getenv("BRIDGE_NOTIFY_KEY")
	notifyClient    = &http.Client{Timeout: 8 * time.Second}
)

// holdMarkNotified: true once per video, when its first automatic check has finished. Call with metaMu held.
func holdMarkNotified(meta map[string]any) bool {
	if !holdActive(meta) || metaString(meta, "holdNotifiedAt") != "" {
		return false
	}
	meta["holdNotifiedAt"] = time.Now().UTC().Format(time.RFC3339)
	return true
}

func holdReviewLink(id string) string {
	if publicURL == "" {
		return "/review/" + id
	}
	return publicURL + "/review/" + url.PathEscape(id)
}

func notifyHoldPending(id, filename string) {
	if bridgeNotifyURL == "" || bridgeNotifyKey == "" {
		return
	}
	if len(filename) > 60 {
		filename = filename[:60]
	}
	text := "🎬 סרטון חדש ממתין לאישור פרסום\n" + strings.TrimSpace(filename) + "\nלבדיקה ואישור: " + holdReviewLink(id)
	body, _ := json.Marshal(map[string]string{"text": text})
	req, err := http.NewRequest(http.MethodPost, bridgeNotifyURL, bytes.NewReader(body))
	if err != nil {
		log.Printf("hold notify: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Notify-Key", bridgeNotifyKey)
	resp, err := notifyClient.Do(req)
	if err != nil {
		log.Printf("hold notify of %s failed: %v", id, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		log.Printf("hold notify of %s: bridge answered %d", id, resp.StatusCode)
	}
}

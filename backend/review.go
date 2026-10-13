package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi"
)

// Moderator review grid: the moderation service saves a small crop of every figure it found (in the blurred
// volume, review/<hash>/), and moderators confirm or correct each one ("man" = show, "blur" = hide).
// Corrections are stored in the file metadata ("figureOverrides"), sent back to the service on every
// re-run, and kept - crop + label - as training data for a future model trained on the channel's own content.

var (
	trainingDir   = envOr("TRAINING_DIR", "/app/training")
	reviewCropRe  = regexp.MustCompile(`^[0-9]{1,4}\.jpg$`)
	trainingLogMu sync.Mutex
)

func reviewRelDir(hash string) string { return filepath.Join("review", hash) }

type reviewManifest struct {
	Level   string           `json:"level"`
	Total   int              `json:"total"`
	Figures []map[string]any `json:"figures"`
}

func readReviewManifest(hash string) (*reviewManifest, error) {
	data, err := os.ReadFile(filepath.Join(rootBlurredPath, reviewRelDir(hash), "figures.json"))
	if err != nil {
		return nil, err
	}
	var m reviewManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func metaOverrides(meta map[string]any) map[string]string {
	out := map[string]string{}
	if m, ok := meta["figureOverrides"].(map[string]any); ok {
		for k, v := range m {
			if s, ok := v.(string); ok && (s == "man" || s == "blur") {
				out[k] = s
			}
		}
	}
	return out
}

// getFigures: GET /api/admin/files/{fileid}/figures (moderator)
func getFigures(w http.ResponseWriter, r *http.Request) {
	id := stripExtension(chi.URLParam(r, "fileid"))
	meta, err := readMetadata(id)
	if err != nil || !isModeratedType(metaString(meta, "type")) {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	hash, _ := metaHash(meta)
	m, err := readReviewManifest(hash)
	if err != nil {
		m = &reviewManifest{Figures: []map[string]any{}}
	}
	for _, f := range m.Figures {
		if name, ok := f["crop"].(string); ok {
			f["cropUrl"] = "/api/admin/files/" + id + "/figures/" + name
		}
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, map[string]any{
		"id": id, "status": metaString(meta, "moderation"), "level": m.Level, "total": m.Total,
		"figures": m.Figures, "overrides": metaOverrides(meta),
		"reviewed": figuresReviewed(meta), "strictMode": strictUntilReviewed,
	})
}

// getFigureCrop: GET /api/admin/files/{fileid}/figures/{name} (moderator) - the crop of one figure
func getFigureCrop(w http.ResponseWriter, r *http.Request) {
	id := stripExtension(chi.URLParam(r, "fileid"))
	name := chi.URLParam(r, "name")
	meta, err := readMetadata(id)
	if err != nil || !reviewCropRe.MatchString(name) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	hash, _ := metaHash(meta)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeFile(w, r, filepath.Join(rootBlurredPath, reviewRelDir(hash), name))
}

// setFigures: POST /api/admin/files/{fileid}/figures {"overrides": {"<key>": "man"|"blur"|""}} (moderator)
// Saves the corrections, records them as training data and re-runs the moderation with them.
func setFigures(w http.ResponseWriter, r *http.Request) {
	id := stripExtension(chi.URLParam(r, "fileid"))
	var req struct {
		Overrides map[string]string `json:"overrides"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	session, _ := store.Get(r, cookieName)
	user, _ := session.Values["user"].(Session)

	metaMu.Lock()
	meta, err := readMetadata(id)
	if err != nil || !isModeratedType(metaString(meta, "type")) {
		metaMu.Unlock()
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	hash, _ := metaHash(meta)
	current := metaOverrides(meta)
	changed := map[string]string{}
	for k, v := range req.Overrides {
		if len(k) > 64 || !strings.Contains(k, ":") {
			continue
		}
		switch v {
		case "man", "blur":
			if current[k] != v {
				current[k] = v
				changed[k] = v
			}
		case "":
			if _, ok := current[k]; ok {
				delete(current, k)
				changed[k] = ""
			}
		}
	}
	stored := map[string]any{}
	for k, v := range current {
		stored[k] = v
	}
	meta["figureOverrides"] = stored
	// Opening the grid and saving - even without a single correction - is the moderator's review of the figures.
	meta["figuresReviewedAt"] = time.Now().UTC().Format(time.RFC3339)
	meta["figuresReviewedBy"] = user.Email
	if len(changed) == 0 {
		// Nothing to re-process: the file keeps its current result, it is now reviewed.
		delete(meta, "autoNeedsReview")
		delete(meta, "autoReviewReasons")
		status := metaString(meta, "moderation")
		err = writeMetadata(id, meta)
		metaMu.Unlock()
		if err != nil {
			http.Error(w, "error", http.StatusInternalServerError)
			return
		}
		appendYamlLog(moderationLogFile, map[string]any{"action": "figures-reviewed", "fileId": id, "by": user.Email})
		publishFileModeration(r.Context(), id, status)
		writeJSON(w, map[string]any{"success": true, "changed": 0})
		return
	}
	// Re-run: the automatic result (now with the corrections) is applied, as with "check again".
	meta["moderation"] = ModPending
	meta["modGen"] = metaGeneration(meta) + 1
	delete(meta, "reviewedBy")
	delete(meta, "reviewedAt")
	err = writeMetadata(id, meta)
	metaMu.Unlock()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	saveTrainingExamples(id, hash, changed, user.Email)
	appendYamlLog(moderationLogFile, map[string]any{"action": "figures", "fileId": id, "by": user.Email, "changed": changed})
	enqueueModeration(id)
	publishFileModeration(r.Context(), id, ModPending)
	writeJSON(w, map[string]any{"success": true, "changed": len(changed)})
}

// saveTrainingExamples copies the crop of every corrected figure with its label into TRAINING_DIR:
// <label>/<fileid>_<n>.jpg plus one JSON line per example in labels.jsonl.
func saveTrainingExamples(id, hash string, changed map[string]string, by string) {
	m, err := readReviewManifest(hash)
	if err != nil {
		return
	}
	trainingLogMu.Lock()
	defer trainingLogMu.Unlock()
	for _, f := range m.Figures {
		key, _ := f["key"].(string)
		label, ok := changed[key]
		crop, _ := f["crop"].(string)
		if !ok || label == "" || !reviewCropRe.MatchString(crop) {
			continue
		}
		dir := filepath.Join(trainingDir, label)
		if err := os.MkdirAll(dir, 0755); err != nil {
			return
		}
		name := id + "_" + strings.TrimSuffix(crop, ".jpg") + ".jpg"
		data, err := os.ReadFile(filepath.Join(rootBlurredPath, reviewRelDir(hash), crop))
		if err != nil || os.WriteFile(filepath.Join(dir, name), data, 0644) != nil {
			continue
		}
		line, _ := json.Marshal(map[string]any{
			"time": time.Now().UTC().Format(time.RFC3339), "fileId": id, "key": key, "label": label,
			"image": filepath.ToSlash(filepath.Join(label, name)), "modelDecision": f["decision"],
			"faceMale": f["faceMale"], "bodyMale": f["bodyMale"], "level": m.Level, "by": by,
		})
		if lf, err := os.OpenFile(filepath.Join(trainingDir, "labels.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644); err == nil {
			lf.Write(append(line, '\n'))
			lf.Close()
		}
	}
}

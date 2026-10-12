package main

import (
	"context"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Orphan media cleanup. An uploaded file is deleted only when ALL of these hold:
//   - it was uploaded more than MEDIA_CLEANUP_DAYS days ago (default 7; 0 disables the daily job),
//   - no message references it (deleted messages count - they can be restored),
//   - no scheduled message references it, and it is not the channel logo.
// The stored content (shared by hash between uploads) is removed only when no remaining upload uses it.
// Every deletion is written to logs/media-cleanup.yaml.

var (
	fileRefRe          = regexp.MustCompile(`/api/files/([0-9a-f]{40})`)
	mediaCleanupLog    = "/app/logs/media-cleanup.yaml"
	mediaCleanupDays   = envInt("MEDIA_CLEANUP_DAYS", 7)
	mediaCleanupPeriod = 24 * time.Hour
)

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return v
	}
	return def
}

type cleanupReport struct {
	DryRun        bool     `json:"dryRun"`
	Uploads       int      `json:"uploads"`
	Referenced    int      `json:"referenced"`
	Orphans       []string `json:"orphans"`      // upload ids removed (or that would be)
	ContentFiles  int      `json:"contentFiles"` // stored blobs removed (or that would be)
	FreedBytes    int64    `json:"freedBytes"`
	OlderThanDays int      `json:"olderThanDays"`
}

// referencedFileIDs collects every file id used by messages, scheduled messages and the channel logo.
func referencedFileIDs(ctx context.Context) (map[string]bool, error) {
	refs := map[string]bool{}
	add := func(text string) {
		for _, m := range fileRefRe.FindAllStringSubmatch(text, -1) {
			refs[m[1]] = true
		}
	}
	keys, err := rdb.ZRange(ctx, "m_times:1", 0, -1).Result()
	if err != nil {
		return nil, err
	}
	for _, k := range keys {
		text, err := rdb.HGet(ctx, k, "text").Result()
		if err == nil {
			add(text)
		}
	}
	if list, err := dbGetScheduledMessages(ctx); err == nil && list != nil {
		for _, m := range *list {
			add(m.Text)
		}
	}
	if c, err := getChannelDetails(ctx); err == nil {
		add(c["logoUrl"])
	}
	return refs, nil
}

func cleanupOrphanMedia(ctx context.Context, days int, dryRun bool) (*cleanupReport, error) {
	rep := &cleanupReport{DryRun: dryRun, OlderThanDays: days, Orphans: []string{}}
	refs, err := referencedFileIDs(ctx)
	if err != nil {
		return nil, err
	}
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour)

	type upload struct {
		id, yamlPath, hash string
		old                bool
	}
	var uploads []upload
	err = filepath.WalkDir(rootUploadPath, func(p string, d fs.DirEntry, err error) error {
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
		meta, err := readMetadata(id)
		if err != nil {
			return nil
		}
		hash, _ := metaHash(meta)
		uploaded := info.ModTime() // files uploaded before "uploadedAt" existed
		if t, err := time.Parse(time.RFC3339, metaString(meta, "uploadedAt")); err == nil {
			uploaded = t
		}
		uploads = append(uploads, upload{id: id, yamlPath: p, hash: hash, old: uploaded.Before(cutoff)})
		return nil
	})
	if err != nil {
		return nil, err
	}
	rep.Uploads = len(uploads)

	hashInUse := map[string]bool{}
	var orphans []upload
	for _, u := range uploads {
		if refs[u.id] {
			rep.Referenced++
		}
		if !refs[u.id] && u.old {
			orphans = append(orphans, u)
		} else if u.hash != "" {
			hashInUse[u.hash] = true
		}
	}

	removedHashes := map[string]bool{}
	for _, u := range orphans {
		rep.Orphans = append(rep.Orphans, u.id)
		if !dryRun {
			if err := os.Remove(u.yamlPath); err != nil {
				log.Printf("media cleanup: %v", err)
				continue
			}
			ctx2, cancel := redisCtx()
			rdb.SRem(ctx2, moderationPending, u.id)
			cancel()
		}
		if u.hash == "" || hashInUse[u.hash] || removedHashes[u.hash] {
			continue
		}
		removedHashes[u.hash] = true
		blob := filepath.Join(rootUploadPath, u.hash[:2], u.hash[2:4], u.hash)
		if st, err := os.Stat(blob); err == nil {
			rep.FreedBytes += st.Size()
			rep.ContentFiles++
			if !dryRun {
				os.Remove(blob)
			}
		}
	}

	if !dryRun && len(rep.Orphans) > 0 {
		appendYamlLog(mediaCleanupLog, map[string]any{
			"removedUploads": rep.Orphans, "removedContentFiles": rep.ContentFiles,
			"freedBytes": rep.FreedBytes, "olderThanDays": days,
		})
	}
	return rep, nil
}

// startMediaCleanup runs the cleanup once a day (MEDIA_CLEANUP_DAYS=0 disables it).
func startMediaCleanup() {
	if mediaCleanupDays <= 0 {
		return
	}
	go func() {
		for {
			time.Sleep(mediaCleanupPeriod)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			if rep, err := cleanupOrphanMedia(ctx, mediaCleanupDays, false); err != nil {
				log.Printf("media cleanup failed: %v", err)
			} else if len(rep.Orphans) > 0 {
				log.Printf("media cleanup: removed %d unused uploads (%d bytes)", len(rep.Orphans), rep.FreedBytes)
			}
			cancel()
		}
	}()
}

// mediaCleanupHandler: POST /api/admin/media/cleanup?dryRun=1&days=7 (admin). Dry run by default.
func mediaCleanupHandler(w http.ResponseWriter, r *http.Request) {
	days := mediaCleanupDays
	if d, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && d >= 1 {
		days = d
	}
	if days <= 0 {
		days = 7
	}
	dryRun := r.URL.Query().Get("dryRun") != "0"
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	rep, err := cleanupOrphanMedia(ctx, days, dryRun)
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, rep)
}

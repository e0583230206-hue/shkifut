package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"channel/modretry"
)

// Limits for the automatic check of one file (see package modretry for why):
//
//	MODERATION_MAX_ATTEMPTS    failed checks after which the file is given up and stays fully blurred for a moderator (default 3, 0 = never)
//	MODERATION_ATTEMPT_TIMEOUT one check is stopped (and the service told to stop) after this long (default 30m)
//	MODERATION_RETRY_DELAY     pause before the next try, times the number of failures so far (default 3m)
var (
	moderationSweepInterval  = envDuration("MODERATION_SWEEP_INTERVAL", 2*time.Minute) // how often pending files are put back into the queue
	moderationAttemptTimeout = envDuration("MODERATION_ATTEMPT_TIMEOUT", 30*time.Minute)
	moderationAttempts       = "moderation:attempts" // redis hash: file id -> failed checks
	modTracker               = modretry.New(envInt("MODERATION_MAX_ATTEMPTS", 3), envDuration("MODERATION_RETRY_DELAY", 3*time.Minute), redisAttempts{})
)

func envDuration(key string, def time.Duration) time.Duration {
	if v, err := time.ParseDuration(os.Getenv(key)); err == nil && v > 0 {
		return v
	}
	return def
}

// redisAttempts keeps the failure counts in Redis, so a restart of the backend does not give a bad file new chances for ever.
type redisAttempts struct{}

func (redisAttempts) Incr(id string) (int, error) {
	ctx, cancel := redisCtx()
	defer cancel()
	n, err := rdb.HIncrBy(ctx, moderationAttempts, id, 1).Result()
	return int(n), err
}

func (redisAttempts) Clear(id string) {
	ctx, cancel := redisCtx()
	defer cancel()
	rdb.HDel(ctx, moderationAttempts, id)
}

// moderationAttemptFailed is called when the service could not check the file (error, crash, or the time limit). It returns the error for
// the log; after the last allowed attempt the file is given up instead.
func moderationAttemptFailed(id string, cause error, timedOut bool) error {
	if timedOut {
		cause = fmt.Errorf("no answer within %s: %w", moderationAttemptTimeout, cause)
	}
	attempts, giveUp := modTracker.Failed(id)
	if giveUp {
		giveUpModeration(id, cause, attempts)
		return fmt.Errorf("gave up after %d failed checks: %w", attempts, cause)
	}
	return fmt.Errorf("attempt %d failed (next try after a pause): %w", attempts, cause)
}

// giveUpModeration stops checking a file that keeps failing. The file stays fully blurred for readers (nothing unclear is ever
// shown), is marked "needs review" for the moderators, and leaves the pending set, so it no longer takes the queue's time.
// A moderator can still open it by hand or press "check again" (which starts counting from zero).
func giveUpModeration(id string, cause error, attempts int) {
	metaMu.Lock()
	meta, err := readMetadata(id)
	if err != nil {
		metaMu.Unlock()
		log.Printf("moderation: cannot give up %s (metadata): %v", id, err)
		dropPending(id)
		return
	}
	manual := metaString(meta, "reviewedBy") != ""
	if !manual {
		meta["moderation"] = ModBlurred
	}
	meta["autoDecision"] = ModBlurred
	meta["autoReasons"] = []string{"analysis_error"}
	meta["autoConfidence"] = 0.0
	meta["autoNeedsReview"] = true
	meta["autoReviewReasons"] = []string{"analysis_error"}
	meta["autoCheckedAt"] = time.Now().UTC().Format(time.RFC3339)
	err = writeMetadata(id, meta)
	status := metaString(meta, "moderation")
	metaMu.Unlock()
	if err != nil {
		log.Printf("moderation: cannot give up %s (write): %v", id, err)
		return // stays pending: the next sweep tries to give up again
	}
	dropPending(id)
	modTracker.Reset(id)
	appendYamlLog(moderationLogFile, map[string]any{
		"action":   "gave_up",
		"fileId":   id,
		"attempts": attempts,
		"error":    cause.Error(),
		"filename": metaString(meta, "filename"),
	})
	log.Printf("moderation: gave up %s after %d failed checks, it stays blurred for a moderator: %v", id, attempts, cause)
	ctx, cancel := redisCtx()
	defer cancel()
	publishFileModeration(ctx, id, status)
}

func dropPending(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rdb.SRem(ctx, moderationPending, id)
}

// cancelServiceJob tells the moderation service to stop working on this file (after our time limit or a manual decision).
func cancelServiceJob(meta map[string]any) {
	if hash, ok := metaHash(meta); ok {
		cancelServiceJobPath(filepath.ToSlash(filepath.Join(hash[:2], hash[2:4], hash)))
	}
}

func cancelServiceJobPath(path string) {
	body, _ := json.Marshal(map[string]string{"path": path})
	if resp, err := moderationClient.Post(moderationURL+"/cancel", "application/json", bytes.NewReader(body)); err == nil {
		resp.Body.Close()
	}
}

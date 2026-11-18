package main

// Reverse index for M1/M2 of the review: file id -> the message keys whose text references the file.
//
// Why it exists: deletedOnlyAmong used to read the text of EVERY message ever stored, on every recount of the waiting bar.
// The index lets it read only the messages that may reference the files it was asked about.
//
// Rules that keep it safe:
//   - The index is a SUPERSET: it may list a message that no longer references a file (after an edit), but it is never
//     allowed to miss one. Entries are never removed, so two concurrent edits cannot drop a reference that is still in the text.
//   - Every candidate is checked again against its current text, the same rule the full scan uses, so a stale entry
//     cannot make a file look deleted.
//   - Until the backfill has finished (the built flag exists), the full scan is used, so a partial index is never trusted.
//   - Missing information always means "not deleted-only", which keeps the file waiting (the safe direction).

import (
	"context"
	"log"
	"os"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const fileMsgsBuiltKey = "file_msgs:built:v1"

func fileMsgsKey(fid string) string { return "file_msgs:" + fid }

// refsInText: the file ids a message text references, with the same rule as the full scan.
func refsInText(text string) []string {
	if !strings.Contains(text, "/api/files/") {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for _, m := range fileRefRe.FindAllStringSubmatch(text, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}

// updateFileIndex: called AFTER a message was written with its new text. It adds the references of the new text.
// It never removes entries (see the superset rule above).
func updateFileIndex(ctx context.Context, msgKey, newText string) error {
	refs := refsInText(newText)
	if len(refs) == 0 {
		return nil
	}
	pipe := rdb.Pipeline()
	for _, fid := range refs {
		pipe.SAdd(ctx, fileMsgsKey(fid), msgKey)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		// The index may now miss a reference: stop trusting it until a new complete backfill sets the flag again.
		rdb.Del(ctx, fileMsgsBuiltKey)
		return err
	}
	return nil
}

// fileIndexReady: true only after a complete backfill.
func fileIndexReady(ctx context.Context) bool {
	n, err := rdb.Exists(ctx, fileMsgsBuiltKey).Result()
	return err == nil && n == 1
}

// backfillFileIndex: one pass over the time index, adding the references of every stored message. Safe to run again
// and again (SADD is idempotent) and safe while the channel is running (new messages index themselves).
// The built flag is set only when the whole pass has finished.
func backfillFileIndex(ctx context.Context) (messages int, refs int, err error) {
	keys, err := rdb.ZRange(ctx, "m_times:1", 0, -1).Result()
	if err != nil {
		return 0, 0, err
	}
	const batch = 500
	for start := 0; start < len(keys); start += batch {
		end := start + batch
		if end > len(keys) {
			end = len(keys)
		}
		pipe := rdb.Pipeline()
		cmds := make([]*redis.StringCmd, 0, end-start)
		for _, k := range keys[start:end] {
			cmds = append(cmds, pipe.HGet(ctx, k, "text"))
		}
		if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
			// individual misses (no text field) are normal; the per-command results below decide
			_ = err
		}
		add := rdb.Pipeline()
		n := 0
		for i, c := range cmds {
			text, e := c.Result()
			if e != nil {
				continue
			}
			for _, fid := range refsInText(text) {
				add.SAdd(ctx, fileMsgsKey(fid), keys[start+i])
				n++
			}
		}
		if n > 0 {
			if _, err := add.Exec(ctx); err != nil {
				return messages, refs, err
			}
		}
		messages += end - start
		refs += n
	}
	if err := rdb.Set(ctx, fileMsgsBuiltKey, time.Now().UTC().Format(time.RFC3339), 0).Err(); err != nil {
		return messages, refs, err
	}
	return messages, refs, nil
}

// deletedOnlyAmong: of the given files, those whose only messages were deleted. Uses the index when it is complete,
// otherwise the full scan. The answer is the same in both cases (see the equivalence test).
func deletedOnlyAmong(ids map[string]bool) map[string]bool {
	if len(ids) == 0 {
		return map[string]bool{}
	}
	ctx, cancel := redisCtx()
	defer cancel()
	if !fileIndexReady(ctx) {
		return deletedOnlyAmongScan(ids)
	}
	return deletedOnlyAmongIndexed(ctx, ids)
}

// deletedOnlyAmongIndexed: reads only the messages the index lists for the requested files.
func deletedOnlyAmongIndexed(ctx context.Context, ids map[string]bool) map[string]bool {
	out := map[string]bool{}
	candidates := map[string][]string{} // file id -> message keys listed for it
	var all []string
	seenKey := map[string]bool{}
	for fid := range ids {
		members, err := rdb.SMembers(ctx, fileMsgsKey(fid)).Result()
		if err != nil {
			return map[string]bool{} // on a Redis error nothing is decided as deleted-only (the safe direction)
		}
		candidates[fid] = members
		for _, k := range members {
			if !seenKey[k] {
				seenKey[k] = true
				all = append(all, k)
			}
		}
	}
	type info struct {
		text, deleted string
		inTime        bool
	}
	read := make(map[string]info, len(all))
	const batch = 500
	for start := 0; start < len(all); start += batch {
		end := start + batch
		if end > len(all) {
			end = len(all)
		}
		pipe := rdb.Pipeline()
		hm := make([]*redis.SliceCmd, 0, end-start)
		zs := make([]*redis.FloatCmd, 0, end-start)
		for _, k := range all[start:end] {
			hm = append(hm, pipe.HMGet(ctx, k, "text", "deleted"))
			zs = append(zs, pipe.ZScore(ctx, "m_times:1", k))
		}
		if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
			_ = err // per-command results below
		}
		for i, k := range all[start:end] {
			vals, err := hm[i].Result()
			if err != nil || len(vals) != 2 {
				continue
			}
			text, _ := vals[0].(string)
			del, _ := vals[1].(string)
			_, zerr := zs[i].Result()
			read[k] = info{text: text, deleted: del, inTime: zerr == nil}
		}
	}
	for fid := range ids {
		hasDeleted, hasLive := false, false
		for _, k := range candidates[fid] {
			in, ok := read[k]
			if !ok || !in.inTime {
				continue // not a message of the time index (the scan never looked at it either)
			}
			found := false
			for _, r := range refsInText(in.text) {
				if r == fid {
					found = true
					break
				}
			}
			if !found {
				continue // stale index entry: the text no longer references the file
			}
			if in.deleted == "1" || in.deleted == "true" {
				hasDeleted = true
			} else {
				hasLive = true
			}
		}
		if hasDeleted && !hasLive {
			out[fid] = true
		}
	}
	return out
}

// backfillOnStartup: runs the backfill only when the operator asks for it (BACKFILL_FILE_INDEX=1). It is never automatic,
// so a running channel is not changed by a deploy alone.
func backfillOnStartup() {
	if os.Getenv("BACKFILL_FILE_INDEX") != "1" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	m, r, err := backfillFileIndex(ctx)
	if err != nil {
		log.Printf("file index backfill failed (the full scan stays in use): %v", err)
		return
	}
	log.Printf("file index backfill done: %d messages, %d references", m, r)
}

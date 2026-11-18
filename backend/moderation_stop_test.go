package main

import (
	"context"
	"fmt"
	"testing"

	"github.com/redis/go-redis/v9"
)

// A message was deleted: the automatic check of a file that no live message uses any more stops (and is not queued again).
//   go test -run StopCheck .      (needs any Redis, like the other tests)

type stopFixture struct {
	deletedOnly, shared, decided, image, onlyDeletedImage string
	liveMsg                                               string
	cleanup                                               func()
}

func stopSetup(t *testing.T) *stopFixture {
	t.Helper()
	oldRoot, oldLog, oldURL := rootUploadPath, moderationLogFile, moderationURL
	rootUploadPath, moderationLogFile, moderationURL = t.TempDir(), t.TempDir()+"/moderation.yaml", ""
	f := &stopFixture{
		deletedOnly: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", shared: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
		decided: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3", image: "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
		onlyDeletedImage: "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
	}
	hash := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	writeWaitingFile(t, f.deletedOnly, map[string]any{"type": "video", "moderation": ModPending, "hash": hash, "filename": "a.mp4"})
	writeWaitingFile(t, f.shared, map[string]any{"type": "video", "moderation": ModPending, "hash": hash, "filename": "b.mp4"})
	writeWaitingFile(t, f.decided, map[string]any{"type": "video", "moderation": ModBlurred, "hash": hash, "filename": "c.mp4"})
	writeWaitingFile(t, f.image, map[string]any{"type": "image", "moderation": ModPending, "hash": hash, "filename": "d.jpg"})
	writeWaitingFile(t, f.onlyDeletedImage, map[string]any{"type": "image", "moderation": ModPending, "hash": hash, "filename": "e.jpg"})

	ctx := context.Background()
	msgs := map[string]struct{ text, deleted string }{
		"990101": {"[video-embedded#](/api/files/" + f.deletedOnly + ".mp4) one", "1"}, // the deleted message of the first file
		"990102": {"[video-embedded#](/api/files/" + f.shared + ".mp4) two", "1"},      // deleted ...
		"990103": {"[video-embedded#](/api/files/" + f.shared + ".mp4) copy", "0"},     // ... but the same file is in a live message too
		"990104": {"[video-embedded#](/api/files/" + f.decided + ".mp4) three", "1"},   // already decided
		"990105": {"[image-embedded#](/api/files/" + f.onlyDeletedImage + ".jpg) four", "1"},
		"990106": {"[image-embedded#](/api/files/" + f.image + ".jpg) five", "0"}, // a live message: stays
	}
	for id, m := range msgs {
		key := "messages:" + id
		rdb.HSet(ctx, key, "text", m.text, "deleted", m.deleted)
		var score float64
		fmt.Sscanf(id, "%f", &score)
		rdb.ZAdd(ctx, "m_times:1", redis.Z{Score: 990000000 + score, Member: key})
	}
	for _, id := range []string{f.deletedOnly, f.shared, f.decided, f.image, f.onlyDeletedImage} {
		rdb.SAdd(ctx, moderationPending, id)
	}
	f.cleanup = func() {
		for id := range msgs {
			rdb.Del(ctx, "messages:"+id)
			rdb.ZRem(ctx, "m_times:1", "messages:"+id)
		}
		for _, id := range []string{f.deletedOnly, f.shared, f.decided, f.image, f.onlyDeletedImage} {
			rdb.SRem(ctx, moderationPending, id)
		}
		rootUploadPath, moderationLogFile, moderationURL = oldRoot, oldLog, oldURL
		waitingInvalidate()
	}
	t.Cleanup(f.cleanup)
	return f
}

func pendingNow(id string) bool {
	ok, _ := rdb.SIsMember(context.Background(), moderationPending, id).Result()
	return ok
}

func TestStopCheckOfADeletedMessage(t *testing.T) {
	f := stopSetup(t)

	// the check of the first file is running right now
	cancelled := make(chan struct{}, 1)
	inflightMu.Lock()
	inflight[f.deletedOnly] = func() { cancelled <- struct{}{} }
	inflightMu.Unlock()
	t.Cleanup(func() { inflightMu.Lock(); delete(inflight, f.deletedOnly); inflightMu.Unlock() })

	stopChecksOfDeletedFiles("990101")
	if pendingNow(f.deletedOnly) {
		t.Errorf("the file of the deleted message must leave the waiting set")
	}
	select {
	case <-cancelled:
	default:
		t.Errorf("the check that was running must be stopped")
	}
	meta, _ := readMetadata(f.deletedOnly)
	if metaString(meta, "moderation") != ModPending {
		t.Errorf("the status stays pending (readers get it blurred): %q", metaString(meta, "moderation"))
	}

	// the same file in a live message too: the check goes on
	stopChecksOfDeletedFiles("990102")
	if !pendingNow(f.shared) {
		t.Errorf("a file that a live message still uses must go on being checked")
	}
	// already decided: not touched
	stopChecksOfDeletedFiles("990104")
	if !pendingNow(f.decided) {
		t.Errorf("a decided file is left as it is") // (it was put in the set by the fixture on purpose: the status, not the set, decides)
	}
	// a live message: nothing happens
	stopChecksOfDeletedFiles("990106")
	if !pendingNow(f.image) {
		t.Errorf("the file of a live message goes on being checked")
	}
	// another deleted message with an image only it uses
	stopChecksOfDeletedFiles("990105")
	if pendingNow(f.onlyDeletedImage) {
		t.Errorf("an image used only by a deleted message stops being checked too")
	}
}

func TestDropPendingChecksAtStart(t *testing.T) {
	f := stopSetup(t)
	dropPendingChecksOfDeletedMessages()
	for id, want := range map[string]bool{f.deletedOnly: false, f.onlyDeletedImage: false, f.shared: true, f.image: true, f.decided: true} {
		if got := pendingNow(id); got != want {
			t.Errorf("file %s... pending=%v, want %v", id[:4], got, want)
		}
	}
}

func TestStopCheckOfAMessageThatIsGone(t *testing.T) {
	stopSetup(t)
	stopChecksOfDeletedFiles("999999999")                              // no such message: nothing, no panic
	stopCheckOfDeletedFile("ffffffffffffffffffffffffffffffffffffffff") // no such file
}

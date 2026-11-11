package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// HOLD_VIDEOS_UNTIL_APPROVED also hides the MESSAGE of a video that waits for approval, not only the video.
//
// A new message whose text points at a held video (see holdActive) gets the field "held" in its hash. Readers get nothing of it: not in
// the list, the topics, the search, the pins, its own page, the sitemap, the live stream, the push or the webhook. Those who may approve videos (the same check as the approval: canReviewFigures)
// see it, with Message.Held set, also live (the stream marks it approversOnly). A Writer who may not approve does not. Messages that already exist never get the field, so the rule only applies to messages created after
// this build.
//
// When the last held video of the message is approved, the message is released once: it gets the time of that approval (so it goes
// to the top of the list), the live stream tells the open pages, and the push and the webhook go out. Nothing else sends them.

const (
	heldField       = "held"
	heldMessagesSet = "held_messages" // ids of the messages that are held now, for the sweep at start
)

func heldByFileKey(fileID string) string { return "held_by_file:" + fileID }

var heldMu sync.Mutex // one release at a time: "once only" for the push and the webhook

// heldFilesOf: the files in the text of a message that still wait for approval.
func heldFilesOf(text string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range fileRefRe.FindAllStringSubmatch(text, -1) {
		id := m[1]
		if seen[id] {
			continue
		}
		seen[id] = true
		meta, err := readMetadata(id)
		if err == nil && holdActive(meta) {
			out = append(out, id)
		}
	}
	return out
}

// holdNewMessage marks a message that was just stored as held when it carries a video that waits for approval.
// It reports whether the message is held now. A failure to mark is logged and the message stays visible (as before this feature).
func holdNewMessage(ctx context.Context, m *Message) bool {
	if !holdVideos {
		return false
	}
	files := heldFilesOf(m.Text)
	if len(files) == 0 {
		return false
	}
	key := fmt.Sprintf("messages:%d", m.ID)
	idStr := strconv.Itoa(m.ID)
	pipe := rdb.TxPipeline()
	pipe.HSet(ctx, key, heldField, "1")
	pipe.SAdd(ctx, heldMessagesSet, idStr)
	for _, f := range files {
		pipe.SAdd(ctx, heldByFileKey(f), idStr)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		log.Printf("hold: could not hold message %d: %v", m.ID, err)
		return false
	}
	m.Held = true
	// A video may have been approved between the check above and the mark: look again, so the message is not stuck.
	go releaseHeldMessage(m.ID)
	return true
}

// messageIsHeld: the message exists and is held. Used by the places that read one message by id.
func messageIsHeld(ctx context.Context, id int) bool {
	v, err := rdb.HGet(ctx, fmt.Sprintf("messages:%d", id), heldField).Result()
	return err == nil && v == "1"
}

// afterMessageCreated: the follow-up of a new message (webhook and push), except for a held one: that one goes out when it is released.
func afterMessageCreated(m *Message) {
	if m.Held {
		return
	}
	go SendWebhook(context.Background(), "create", m)
	go pushFcmMessage(m)
}

// releaseHeldFor: a video was approved; releases the messages that were waiting only for it.
func releaseHeldFor(fileID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	ids, err := rdb.SMembers(ctx, heldByFileKey(fileID)).Result()
	cancel()
	if err != nil {
		log.Printf("hold: could not list the messages of file %s: %v", fileID, err)
		return
	}
	for _, s := range ids {
		if id, err := strconv.Atoi(s); err == nil {
			releaseHeldMessage(id)
		}
	}
}

// releaseHeldMessage publishes a held message when none of its videos waits any more. Returns true when it was released now.
func releaseHeldMessage(id int) bool {
	heldMu.Lock()
	defer heldMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	key := fmt.Sprintf("messages:%d", id)
	h, err := rdb.HGetAll(ctx, key).Result()
	if err != nil || h[heldField] != "1" {
		return false
	}
	if len(heldFilesOf(h["text"])) > 0 {
		return false // another video of the message still waits
	}

	now := time.Now()
	m := messageFromHash(id, h)
	m.Held = false
	m.Timestamp = now
	m.Poll = dbGetPoll(ctx, id)
	pipe := rdb.TxPipeline()
	pipe.HSet(ctx, key, "timestamp", now.Format(time.RFC3339Nano))
	pipe.HDel(ctx, key, heldField)
	pipe.ZAdd(ctx, "m_times:1", redis.Z{Score: float64(now.Unix()), Member: key})
	pipe.SRem(ctx, heldMessagesSet, strconv.Itoa(id))
	if _, err := pipe.Exec(ctx); err != nil {
		log.Printf("hold: could not release message %d: %v", id, err)
		return false
	}
	indexMessageTopic(ctx, &m, "") // the topic list gets the new time as well
	for _, f := range fileRefRe.FindAllStringSubmatch(m.Text, -1) {
		rdb.SRem(ctx, heldByFileKey(f[1]), strconv.Itoa(id))
	}
	if m.Deleted {
		return true // deleted while it was held: it is not announced
	}
	publishMessageEvent(ctx, "new-message", &m)
	go SendWebhook(context.Background(), "create", &m)
	go pushFcmMessage(&m)
	log.Printf("hold: message %d released", id)
	return true
}

// publishMessageEvent sends a message event to the live stream (open pages).
func publishMessageEvent(ctx context.Context, eventType string, m *Message) {
	data, _ := json.Marshal(PushMessage{Type: eventType, M: *m, ApproversOnly: m.Held})
	rdb.Publish(ctx, "events", data)
}

// sweepHeldMessages runs at start: a release that was cut short (a restart right after an approval) or a flag that was turned off
// leaves held messages that nothing would release.
func sweepHeldMessages() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	ids, err := rdb.SMembers(ctx, heldMessagesSet).Result()
	cancel()
	if err != nil {
		return
	}
	for _, s := range ids {
		if id, err := strconv.Atoi(s); err == nil {
			releaseHeldMessage(id)
		}
	}
}

// messageFromHash builds a Message from its hash the way the single-message page does. Writers' fields (author) are included:
// the caller decides what a reader may see.
func messageFromHash(id int, h map[string]string) Message {
	m := Message{ID: id, Type: h["type"], Text: h["text"], Topic: h["topic"], IsAds: h["is_ads"] == "1", Author: h["author"], AuthorId: h["authorId"]}
	m.Deleted = h["deleted"] == "1" || h["deleted"] == "true"
	m.Held = h[heldField] == "1"
	m.Timestamp, _ = time.Parse(time.RFC3339Nano, h["timestamp"])
	m.LastEdit, _ = time.Parse(time.RFC3339Nano, h["last_edit"])
	if raw := h["reactions"]; raw != "" {
		_ = json.Unmarshal([]byte(raw), &m.Reactions) // best effort: an unreadable value is shown as no reactions
	}
	return m
}

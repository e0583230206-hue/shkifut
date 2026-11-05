package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// validApiKey rejects requests when no API key is configured (previously an empty key matched an empty header).
func validApiKey(r *http.Request) bool {
	expected := settingConfig.ApiSecretKey
	key := r.Header.Get("X-API-Key")
	return expected != "" && subtle.ConstantTimeCompare([]byte(key), []byte(expected)) == 1
}

// importDeleteMessage: POST /api/import/delete {"id": N} (X-API-Key). The bridge removes the message of a WhatsApp message that was deleted there.
// Only a message that came through the import API (it has no author: a message written on the site has one) and is not deleted yet; the deletion is the
// same soft one as the owner's ("deleted" is set on the message, nothing is erased).
func importDeleteMessage(w http.ResponseWriter, r *http.Request) {
	if !validApiKey(r) {
		http.Error(w, "error", http.StatusUnauthorized)
		return
	}
	var body struct {
		ID int `json:"id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil || body.ID <= 0 {
		http.Error(w, "id is required", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	id := strconv.Itoa(body.ID)
	vals, err := rdb.HMGet(ctx, "messages:"+id, "text", "author", "deleted").Result()
	if err != nil || len(vals) < 3 || vals[0] == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if author, _ := vals[1].(string); author != "" {
		http.Error(w, "only a message that came from the bridge can be deleted here", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if d, _ := vals[2].(string); d == "1" || d == "true" {
		json.NewEncoder(w).Encode(map[string]any{"deleted": false, "already": true})
		return
	}
	if err := funcDeleteMessage(ctx, id); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	afterMessageDeleted(ctx, id, &Message{ID: body.ID, Deleted: true})
	log.Printf("import: message %d deleted at the request of the bridge (its WhatsApp message was deleted)", body.ID)
	json.NewEncoder(w).Encode(map[string]any{"deleted": true})
}

// importUpload is uploadFile for the import API (X-API-Key). Media goes through the same moderation pipeline.
func importUpload(w http.ResponseWriter, r *http.Request) {
	if !validApiKey(r) {
		http.Error(w, "error", http.StatusUnauthorized)
		return
	}
	uploadFile(w, r)
}

func addNewPost(w http.ResponseWriter, r *http.Request) {
	if !validApiKey(r) {
		http.Error(w, "error", http.StatusUnauthorized)
		return
	}

	var message Message
	var err error
	defer r.Body.Close()

	body := Message{}
	if err = json.NewDecoder(r.Body).Decode(&body); err != nil {
		log.Printf("Failed to decode message: %v", err)
		http.Error(w, "error", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.Text) == "" && body.Poll == nil {
		http.Error(w, "text is required", http.StatusBadRequest)
		return
	}
	pollDef, err := pollFor(&body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	message.ID = getMessageNextId(ctx)
	message.Type = "md"
	message.Author = body.Author
	// A missing timestamp used to be stored as 0001-01-01; a far-future one would pin the message on top.
	message.Timestamp = body.Timestamp
	if now := time.Now(); message.Timestamp.IsZero() || message.Timestamp.After(now.Add(5*time.Minute)) {
		message.Timestamp = now
	}
	message.Text = body.Text
	message.Views = 0
	message.IsAds = body.IsAds
	message.Topic = body.Topic // topic id or name; unknown names are ignored
	if err = storePoll(ctx, &message, pollDef); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	if err = setMessage(ctx, &message, false); err != nil {
		log.Printf("Failed to set new message: %v", err)
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	// Same follow-up as a message published from the site.
	go SendWebhook(context.Background(), "create", &message)
	go pushFcmMessage(&message)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(message)
}

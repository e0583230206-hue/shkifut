package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"
)

// validApiKey rejects requests when no API key is configured (previously an empty key matched an empty header).
func validApiKey(r *http.Request) bool {
	expected := settingConfig.ApiSecretKey
	key := r.Header.Get("X-API-Key")
	return expected != "" && subtle.ConstantTimeCompare([]byte(key), []byte(expected)) == 1
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
	if strings.TrimSpace(body.Text) == "" {
		http.Error(w, "text is required", http.StatusBadRequest)
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

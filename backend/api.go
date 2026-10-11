package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
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
		http.Error(w, "error", http.StatusBadRequest)
		return
	}

	var message Message
	var err error
	defer r.Body.Close()

	body := Message{}
	if err = json.NewDecoder(r.Body).Decode(&body); err != nil {
		log.Printf("Failed to decode message: %v\n", err)
		http.Error(w, "error", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	message.ID = getMessageNextId(ctx)
	message.Type = "md" //body.Type
	message.Author = body.Author
	message.Timestamp = body.Timestamp
	message.Text = body.Text
	message.Views = 0
	message.IsAds = body.IsAds

	if err = setMessage(ctx, &message, false); err != nil {
		log.Printf("Failed to set new message: %v\n", err)
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(message)
}

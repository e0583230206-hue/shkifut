package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi"
)

func getMessages(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	offsetFromClient := r.URL.Query().Get("offset")
	limitFromClient := r.URL.Query().Get("limit")
	direction := r.URL.Query().Get("direction")

	offset, err := strconv.Atoi(offsetFromClient)
	if err != nil {
		offset = 0
	}

	limit, err := strconv.Atoi(limitFromClient)
	if err != nil {
		limit = 20
	}

	topic := r.URL.Query().Get("topic")
	if topic != "" && !topicIDRe.MatchString(topic) {
		topic = ""
	}
	messages, err := funcGetMessageRange(ctx, int64(offset), int64(limit), checkPrivilege(r, Writer), settingConfig.CountViews, direction, topic)
	if err != nil {
		log.Printf("Failed to get messages: %v\n", err)
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	attachPolls(ctx, messages)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(messages)

	addViewsToMessages(ctx, messages)
}

// getMessage: GET /api/messages/<id> - one message, for its own page (/m/<id>). A missing or deleted message is a 404.
// Like the list, the author is shown to writers only. Views are not counted here.
func getMessage(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	idStr := chi.URLParam(r, "id")
	if !messageIDRe.MatchString(idStr) {
		http.NotFound(w, r)
		return
	}
	id, _ := strconv.Atoi(idStr)
	h, err := rdb.HGetAll(ctx, fmt.Sprintf("messages:%d", id)).Result()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	if len(h) == 0 || h["deleted"] == "1" || h["deleted"] == "true" {
		http.NotFound(w, r)
		return
	}

	m := Message{ID: id, Type: h["type"], Text: h["text"], Topic: h["topic"], IsAds: h["is_ads"] == "1"}
	m.Timestamp, _ = time.Parse(time.RFC3339Nano, h["timestamp"])
	m.LastEdit, _ = time.Parse(time.RFC3339Nano, h["last_edit"])
	if raw := h["reactions"]; raw != "" {
		_ = json.Unmarshal([]byte(raw), &m.Reactions) // best effort: an unreadable value is shown as no reactions
	}
	if checkPrivilege(r, Writer) {
		m.Author, m.AuthorId = h["author"], h["authorId"]
	} else {
		m.Author, m.AuthorId = "Anonymous", "Anonymous"
	}
	m.Poll = dbGetPoll(ctx, id)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(m)
}

func addMessage(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var message Message
	var err error
	defer r.Body.Close()

	session, _ := store.Get(r, cookieName)
	user, _ := session.Values["user"].(Session)

	body := Message{}
	if err = json.NewDecoder(r.Body).Decode(&body); err != nil {
		log.Printf("Failed to decode message: %v\n", err)
		http.Error(w, "error", http.StatusBadRequest)
		return
	}
	pollDef, err := pollFor(&body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	message.ID = getMessageNextId(ctx)
	message.Type = body.Type
	message.Author = user.PublicName
	message.AuthorId = user.ID
	message.Timestamp = time.Now()
	message.Text = body.Text
	message.File = body.File
	message.Views = 0
	message.IsAds = body.IsAds
	message.Topic = body.Topic
	if err = storePoll(ctx, &message, pollDef); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	if err = setMessage(ctx, &message, false); err != nil {
		log.Printf("Failed to set new message: %v\n", err)
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	go SendWebhook(context.Background(), "create", &message)
	go pushFcmMessage(&message)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(message)
}

func updateMessage(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var err error
	defer r.Body.Close()

	body := Message{}
	if err = json.NewDecoder(r.Body).Decode(&body); err != nil {
		response := Response{Success: false}
		json.NewEncoder(w).Encode(response)
		return
	}

	body.LastEdit = time.Now()
	body.Poll = dbGetPoll(ctx, body.ID) // polls are never changed by an edit; send the real results

	if err := setMessage(ctx, &body, true); err != nil {
		response := Response{Success: false}
		json.NewEncoder(w).Encode(response)
		return
	}

	go SendWebhook(context.Background(), "update", &body)

	response := Response{Success: true}
	json.NewEncoder(w).Encode(response)
}

func deleteMessage(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	id := chi.URLParam(r, "id")

	idInt, _ := strconv.Atoi(id)
	message := Message{ID: idInt, Deleted: true}

	if err := funcDeleteMessage(ctx, id); err != nil {
		response := Response{Success: false}
		json.NewEncoder(w).Encode(response)
		return
	}

	if n, _ := rdb.ZRem(ctx, pinnedKey, id).Result(); n > 0 {
		publishPinsChanged(ctx) // a deleted message cannot stay pinned
	}

	go SendWebhook(context.Background(), "delete", &message)

	response := Response{Success: true}
	json.NewEncoder(w).Encode(response)
}

func getEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	clientCtx := r.Context()
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	_, err := fmt.Fprintf(w, "data: {\"type\": \"heartbeat\"}\n\n")
	if err != nil {
		return
	}
	flusher.Flush()

	if s, ok := sessionUser(r); ok { // an open live-update connection = this reader is online
		presenceConnOpened(s)
		defer presenceConnClosed(s)
	}
	go increaseCounterSSE()
	defer decreaseCounterSSE()

	pubsub := rdb.Subscribe(r.Context(), "events")
	defer pubsub.Close()

	if _, err := pubsub.Receive(clientCtx); err != nil {
		http.Error(w, "Failed to subscribe to events", http.StatusInternalServerError)
		return
	}

	ch := pubsub.Channel()
	for {
		select {
		case <-clientCtx.Done():
			return

		case <-heartbeat.C:
			_, err := fmt.Fprintf(w, "data: {\"type\": \"heartbeat\"}\n\n")
			if err != nil {
				return
			}
			flusher.Flush()

		case msg, ok := <-ch:
			if !ok {
				return
			}
			_, err := fmt.Fprintf(w, "data: %s\n\n", msg.Payload)
			if err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

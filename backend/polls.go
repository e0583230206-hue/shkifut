package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Polls are attached to a message. The definition ("poll:<id>") and the votes ("poll:<id>:votes",
// user id -> JSON list of option indexes) live outside the message hash, so editing a message can never
// change a poll or its results; counts are always computed here.

type PollOption struct {
	Text  string `json:"text"`
	Count int    `json:"count"`
}

type Poll struct {
	Question string       `json:"question"`
	Options  []PollOption `json:"options"`
	Multiple bool         `json:"multiple"`
	Closed   bool         `json:"closed"`
	Voters   int          `json:"voters"`
}

type pollDefinition struct {
	Question string   `json:"question"`
	Options  []string `json:"options"`
	Multiple bool     `json:"multiple"`
	Closed   bool     `json:"closed"`
}

func pollKey(id int) string      { return fmt.Sprintf("poll:%d", id) }
func pollVotesKey(id int) string { return fmt.Sprintf("poll:%d:votes", id) }

var errInvalidPoll = errors.New("invalid poll")

// normalizePoll validates a poll sent by a writer: question 1-200 chars, 2-10 distinct options of 1-100 chars.
func normalizePoll(p *Poll) (*pollDefinition, error) {
	q := strings.TrimSpace(p.Question)
	if n := utf8.RuneCountInString(q); n < 1 || n > 200 {
		return nil, fmt.Errorf("%w: question must be 1-200 characters", errInvalidPoll)
	}
	if len(p.Options) < 2 || len(p.Options) > 10 {
		return nil, fmt.Errorf("%w: 2-10 options", errInvalidPoll)
	}
	def := &pollDefinition{Question: q, Multiple: p.Multiple}
	seen := map[string]bool{}
	for _, o := range p.Options {
		t := strings.TrimSpace(o.Text)
		if n := utf8.RuneCountInString(t); n < 1 || n > 100 {
			return nil, fmt.Errorf("%w: options must be 1-100 characters", errInvalidPoll)
		}
		if seen[strings.ToLower(t)] {
			return nil, fmt.Errorf("%w: duplicate option", errInvalidPoll)
		}
		seen[strings.ToLower(t)] = true
		def.Options = append(def.Options, t)
	}
	return def, nil
}

func dbCreatePoll(ctx context.Context, id int, def *pollDefinition) error {
	data, _ := json.Marshal(def)
	return rdb.Set(ctx, pollKey(id), data, 0).Err()
}

func dbGetPollDefinition(ctx context.Context, id int) (*pollDefinition, error) {
	raw, err := rdb.Get(ctx, pollKey(id)).Result()
	if err != nil {
		return nil, err
	}
	var def pollDefinition
	if err := json.Unmarshal([]byte(raw), &def); err != nil {
		return nil, err
	}
	return &def, nil
}

// dbGetPoll returns the poll with current counts, or nil if the message has no poll.
func dbGetPoll(ctx context.Context, id int) *Poll {
	def, err := dbGetPollDefinition(ctx, id)
	if err != nil {
		return nil
	}
	votes, _ := rdb.HVals(ctx, pollVotesKey(id)).Result()
	return buildPoll(def, votes)
}

func buildPoll(def *pollDefinition, votes []string) *Poll {
	p := &Poll{Question: def.Question, Multiple: def.Multiple, Closed: def.Closed}
	for _, o := range def.Options {
		p.Options = append(p.Options, PollOption{Text: o})
	}
	for _, v := range votes {
		var choice []int
		if json.Unmarshal([]byte(v), &choice) != nil || len(choice) == 0 {
			continue
		}
		p.Voters++
		for _, i := range choice {
			if i >= 0 && i < len(p.Options) {
				p.Options[i].Count++
			}
		}
	}
	return p
}

// attachPolls adds poll results to a page of messages (one pipelined round trip).
func attachPolls(ctx context.Context, messages []Message) {
	if len(messages) == 0 {
		return
	}
	pipe := rdb.Pipeline()
	defs := make([]interface{ Result() (string, error) }, len(messages))
	for i, m := range messages {
		defs[i] = pipe.Get(ctx, pollKey(m.ID))
	}
	pipe.Exec(ctx) // missing keys are expected
	for i := range messages {
		if raw, err := defs[i].Result(); err == nil && raw != "" {
			messages[i].Poll = dbGetPoll(ctx, messages[i].ID)
		}
	}
}

func publishPoll(ctx context.Context, id int, p *Poll) {
	data, _ := json.Marshal(map[string]any{"type": "poll", "messageId": id, "poll": p})
	rdb.Publish(ctx, "events", data)
}

// votePoll records the logged-in user's choice (an empty list withdraws the vote).
func votePoll(w http.ResponseWriter, r *http.Request) {
	session, _ := store.Get(r, cookieName)
	user, _ := session.Values["user"].(Session)
	var req struct {
		MessageID int   `json:"messageId"`
		Options   []int `json:"options"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || user.ID == "" {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	def, err := dbGetPollDefinition(ctx, req.MessageID)
	if err != nil {
		http.Error(w, "Poll not found", http.StatusNotFound)
		return
	}
	if deleted, _ := rdb.HGet(ctx, fmt.Sprintf("messages:%d", req.MessageID), "deleted").Result(); deleted == "1" {
		http.Error(w, "Poll not found", http.StatusNotFound)
		return
	}
	if def.Closed {
		http.Error(w, "Poll is closed", http.StatusConflict)
		return
	}
	choice := slices.Clone(req.Options)
	slices.Sort(choice)
	choice = slices.Compact(choice)
	if len(choice) != len(req.Options) || (!def.Multiple && len(choice) > 1) {
		http.Error(w, "invalid choice", http.StatusBadRequest)
		return
	}
	for _, i := range choice {
		if i < 0 || i >= len(def.Options) {
			http.Error(w, "invalid choice", http.StatusBadRequest)
			return
		}
	}
	if len(choice) == 0 {
		err = rdb.HDel(ctx, pollVotesKey(req.MessageID), user.ID).Err()
	} else {
		data, _ := json.Marshal(choice)
		err = rdb.HSet(ctx, pollVotesKey(req.MessageID), user.ID, data).Err()
	}
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	p := dbGetPoll(ctx, req.MessageID)
	publishPoll(ctx, req.MessageID, p)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"poll": p, "mine": choice})
}

// myVotes returns the logged-in user's choices for the given poll messages (?ids=1,2,3).
func myVotes(w http.ResponseWriter, r *http.Request) {
	session, _ := store.Get(r, cookieName)
	user, _ := session.Values["user"].(Session)
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	out := map[string][]int{}
	for _, s := range strings.Split(r.URL.Query().Get("ids"), ",") {
		id, err := strconv.Atoi(strings.TrimSpace(s))
		if err != nil || id <= 0 || len(out) >= 100 {
			continue
		}
		if raw, err := rdb.HGet(ctx, pollVotesKey(id), user.ID).Result(); err == nil {
			var choice []int
			if json.Unmarshal([]byte(raw), &choice) == nil {
				out[strconv.Itoa(id)] = choice
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// closePoll closes or reopens voting (writers).
func closePoll(w http.ResponseWriter, r *http.Request) {
	var req struct {
		MessageID int  `json:"messageId"`
		Closed    bool `json:"closed"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	def, err := dbGetPollDefinition(ctx, req.MessageID)
	if err != nil {
		http.Error(w, "Poll not found", http.StatusNotFound)
		return
	}
	def.Closed = req.Closed
	if err := dbCreatePoll(ctx, req.MessageID, def); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	p := dbGetPoll(ctx, req.MessageID)
	publishPoll(ctx, req.MessageID, p)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"poll": p})
}

// pollFor validates the poll sent with a new message (nil when there is none). Call before taking an id.
func pollFor(m *Message) (*pollDefinition, error) {
	if m.Poll == nil {
		return nil, nil
	}
	return normalizePoll(m.Poll)
}

// storePoll saves the poll of a message that now has its id, and shows it with empty results.
// A poll without text gets the question as its text (for search, previews and notifications).
func storePoll(ctx context.Context, m *Message, def *pollDefinition) error {
	if def == nil {
		m.Poll = nil
		return nil
	}
	if strings.TrimSpace(m.Text) == "" {
		m.Text = "📊 " + def.Question
	}
	m.Poll = buildPoll(def, nil)
	return dbCreatePoll(ctx, m.ID, def)
}

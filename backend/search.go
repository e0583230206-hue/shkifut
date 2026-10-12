package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Full-text search over the channel (newest first). Messages are scanned in pipelined batches; this is fast
// enough for tens of thousands of messages and needs no separate index to keep in sync.

type SearchResult struct {
	ID        int       `json:"id"`
	Timestamp time.Time `json:"timestamp"`
	Snippet   string    `json:"snippet"`
	Topic     string    `json:"topic,omitempty"`
}

// normalizeForSearch lowercases and removes Hebrew niqqud/cantillation so "שָׁלוֹם" matches "שלום".
func normalizeForSearch(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if r >= 0x0591 && r <= 0x05C7 {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// snippetAround returns about 140 characters of plain text around the first match.
func snippetAround(plain, term string) string {
	runes := []rune(plain)
	norm := []rune(normalizeForSearch(plain))
	idx := strings.Index(string(norm), term)
	pos := 0
	if idx >= 0 {
		pos = utf8.RuneCountInString(string(norm)[:idx])
	}
	// norm drops niqqud, so positions can drift slightly; that is fine for a preview window.
	start := max(0, pos-50)
	end := min(len(runes), start+140)
	out := strings.TrimSpace(string(runes[start:end]))
	if start > 0 {
		out = "…" + out
	}
	if end < len(runes) {
		out += "…"
	}
	return out
}

func searchTerms(q string) []string {
	var terms []string
	for _, t := range strings.FieldsFunc(normalizeForSearch(q), func(r rune) bool {
		return unicode.IsSpace(r) || r == '"' || r == ','
	}) {
		if t != "" {
			terms = append(terms, t)
		}
	}
	return terms
}

func searchMessages(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(q) < 2 || utf8.RuneCountInString(q) > 100 {
		http.Error(w, "query must be 2-100 characters", http.StatusBadRequest)
		return
	}
	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit <= 0 || limit > 100 {
		limit = 30
	}
	topic := r.URL.Query().Get("topic")
	terms := searchTerms(q)
	if len(terms) == 0 {
		http.Error(w, "empty query", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	results, err := dbSearchMessages(ctx, terms, topic, limit)
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(results)
}

func dbSearchMessages(ctx context.Context, terms []string, topic string, limit int) ([]SearchResult, error) {
	keys, err := rdb.ZRevRange(ctx, "m_times:1", 0, -1).Result()
	if err != nil {
		return nil, err
	}
	results := []SearchResult{}
	const batch = 500
	for i := 0; i < len(keys) && len(results) < limit; i += batch {
		chunk := keys[i:min(i+batch, len(keys))]
		pipe := rdb.Pipeline()
		cmds := make([]interface{ Val() []interface{} }, len(chunk))
		for j, k := range chunk {
			cmds[j] = pipe.HMGet(ctx, k, "id", "text", "deleted", "timestamp", "topic")
		}
		if _, err := pipe.Exec(ctx); err != nil {
			return nil, err
		}
		for _, c := range cmds {
			v := c.Val()
			id, _ := strconv.Atoi(asString(v[0]))
			if id == 0 || asString(v[2]) == "1" {
				continue // missing or deleted
			}
			if topic != "" && asString(v[4]) != topic {
				continue
			}
			plain := plainText(asString(v[1]))
			norm := normalizeForSearch(plain)
			matched := true
			for _, t := range terms {
				if !strings.Contains(norm, t) {
					matched = false
					break
				}
			}
			if !matched {
				continue
			}
			ts, _ := time.Parse(time.RFC3339Nano, asString(v[3]))
			results = append(results, SearchResult{ID: id, Timestamp: ts, Snippet: snippetAround(plain, terms[0]), Topic: asString(v[4])})
			if len(results) >= limit {
				break
			}
		}
	}
	return results, nil
}

func asString(v interface{}) string {
	s, _ := v.(string)
	return s
}

package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestNewsArticleJSON(t *testing.T) {
	published := time.Date(2026, 11, 10, 17, 0, 0, 0, time.UTC)
	out := newsArticleJSON("כותרת </script><b>x</b> & עוד", "תיאור", "https://example.test/m/1/x", "שקיפות", published)
	if strings.Contains(out, "</script>") || strings.Contains(out, "<b>") {
		t.Fatalf("the text can close the script tag: %s", out)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("not valid JSON: %v", err)
	}
	if got["@type"] != "NewsArticle" || got["datePublished"] != "2026-11-10T17:00:00Z" || got["mainEntityOfPage"] != "https://example.test/m/1/x" {
		t.Fatalf("unexpected fields: %v", got)
	}
	if h, _ := got["headline"].(string); !strings.Contains(h, "</script>") {
		t.Fatalf("the headline should come back unchanged after decoding: %q", h)
	}
	if _, has := got["image"]; has {
		t.Fatal("no image may be listed (files can need a login)")
	}
	long := strings.Repeat("א", 300)
	var got2 map[string]any
	json.Unmarshal([]byte(newsArticleJSON(long, "d", "u", "n", time.Time{})), &got2)
	if h, _ := got2["headline"].(string); len([]rune(h)) > 110 {
		t.Fatalf("headline longer than 110: %d", len([]rune(h)))
	}
	if _, has := got2["datePublished"]; has {
		t.Fatal("an empty date must not be written")
	}
}

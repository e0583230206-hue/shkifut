package pushtext

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestPlainTextStaysAsIs(t *testing.T) {
	if got := Body("עדכון חשוב: הכביש נפתח", false, 140); got != "עדכון חשוב: הכביש נפתח" {
		t.Fatalf("got %q", got)
	}
}

func TestMarkdownIsRemoved(t *testing.T) {
	got := Body("**חדשות** _דחופות_ ו`קוד` ~~ישן~~\n> ציטוט\n# כותרת\n- פריט", false, 140)
	for _, bad := range []string{"*", "_", "`", "~", ">", "#"} {
		if strings.Contains(got, bad) {
			t.Fatalf("%q still in %q", bad, got)
		}
	}
	for _, want := range []string{"חדשות", "דחופות", "ציטוט", "כותרת", "פריט"} {
		if !strings.Contains(got, want) {
			t.Fatalf("%q lost from %q", want, got)
		}
	}
}

func TestNoEmbedMarkersOrFileAddresses(t *testing.T) {
	in := "תמונה מהמקום\n[image-embedded#](/api/files/0123456789012345678901234567890123456789.jpg?w=800&h=600)\n[video-embedded#](/api/files/abc.mp4)"
	got := Body(in, false, 140)
	for _, bad := range []string{"embedded", "/api/files", "](", "[", "http"} {
		if strings.Contains(got, bad) {
			t.Fatalf("%q in %q", bad, got)
		}
	}
	if !strings.Contains(got, "תמונה מהמקום") || !strings.HasPrefix(got, "🎬") {
		t.Fatalf("text kept and the video icon in front, got %q", got)
	}
}

func TestMediaOnlyMessagesGetALabel(t *testing.T) {
	cases := map[string]string{
		"[image-embedded#](/api/files/a.jpg)":                                  "📷 תמונה חדשה",
		"[image-embedded#](/api/files/a.jpg)\n[image-embedded#](/api/files/b)": "📷 תמונות חדשות",
		"[gallery-embedded#](/a|/b|/c)":                                        "📷 תמונות חדשות",
		"[video-embedded#](/api/files/v.mp4)":                                  "🎬 סרטון חדש",
		"[audio-embedded#](/api/files/a.ogg)":                                  "🎧 הקלטה חדשה",
		"":                                                                     "הודעה חדשה",
		"   \n ":                                                               "הודעה חדשה",
	}
	for in, want := range cases {
		if got := Body(in, false, 140); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
	if got := Body("", true, 140); got != "📊 סקר חדש" {
		t.Errorf("poll: %q", got)
	}
}

func TestLinksAndAddresses(t *testing.T) {
	if got := Body("קראו [את הכתבה](https://example.com/a?x=1) עכשיו", false, 140); got != "קראו את הכתבה עכשיו" {
		t.Errorf("markdown link keeps its words, got %q", got)
	}
	if got := Body("הכתבה כאן https://example.com/very/long/path?x=1&y=2 תודה", false, 140); got != "הכתבה כאן קישור תודה" {
		t.Errorf("a bare address becomes the word 'קישור', got %q", got)
	}
}

func TestQuoteAndHTMLRemoved(t *testing.T) {
	got := Body("[quote-embedded#](12@תמונה 📷)\nתשובה <b>חשובה</b><script>alert(1)</script>", false, 140)
	if strings.Contains(got, "quote") || strings.Contains(got, "<") || got != "תשובה חשובה alert(1)" {
		t.Errorf("got %q", got)
	}
}

func TestTruncateAtAWordWithEllipsis(t *testing.T) {
	long := strings.Repeat("מילה ", 60)
	got := Body(long, false, 100)
	if utf8.RuneCountInString(got) > 100 || !strings.HasSuffix(got, "…") || strings.Contains(got, " …") {
		t.Fatalf("got %q (%d)", got, utf8.RuneCountInString(got))
	}
	if strings.HasSuffix(strings.TrimSuffix(got, "…"), "מיל") {
		t.Fatalf("cut in the middle of a word: %q", got)
	}
	if got := Body(strings.Repeat("א", 300), false, 50); utf8.RuneCountInString(got) != 50 {
		t.Fatalf("one long word is cut by characters, got %d", utf8.RuneCountInString(got))
	}
	if got := Body("קצר", false, 140); got != "קצר" {
		t.Fatalf("short text is not touched: %q", got)
	}
}

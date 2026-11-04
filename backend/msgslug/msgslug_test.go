package msgslug

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestMessageSlug(t *testing.T) {
	cases := map[string]string{
		"ידיעה חשובה על \"בדיקת SEO\"": "ידיעה-חשובה-על-בדיקת-seo",
		"  שלום,   עולם!!  ":           "שלום-עולם",
		"בְּרֵאשִׁית בָּרָא":           "בראשית-ברא", // vowel points are dropped
		"":                             "",
		"!!! ???":                      "",
	}
	for in, want := range cases {
		if got := Slug(in); got != want {
			t.Errorf("Slug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMessageSlugIsCutAtAWordBoundary(t *testing.T) {
	got := Slug(strings.Repeat("מילה ", 40))
	if utf8.RuneCountInString(got) > MaxRunes || strings.HasSuffix(got, "-") || strings.HasSuffix(got, "מיל") {
		t.Errorf("slug not cut cleanly: %q", got)
	}
	if got := Slug(strings.Repeat("א", 200)); utf8.RuneCountInString(got) != MaxRunes {
		t.Errorf("a single long word is cut to %d letters, got %d", MaxRunes, utf8.RuneCountInString(got))
	}
}

func TestMessagePaths(t *testing.T) {
	if Path("766", "") != "/m/766" || PlainPath("766", "") != "/m/766" {
		t.Error("no slug: /m/<id>")
	}
	if got := Path("766", "שלום-עולם"); got != "/m/766/%D7%A9%D7%9C%D7%95%D7%9D-%D7%A2%D7%95%D7%9C%D7%9D" {
		t.Errorf("escaped path: %s", got)
	}
}

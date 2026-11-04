// Package msgslug builds the readable address of a message: /m/<id>/<slug>.
package msgslug

import (
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

var (
	marksRe = regexp.MustCompile(`\p{M}+`)         // Hebrew vowel points, accents
	junkRe  = regexp.MustCompile(`[^\p{L}\p{N}]+`) // everything but letters (Hebrew too) and digits
)

const MaxRunes = 60

// Slug turns the text of a message into the readable part of its address: letters and digits joined by "-",
// cut at a word boundary. Empty for a message without text (only media).
func Slug(plain string) string {
	s := strings.ToLower(marksRe.ReplaceAllString(plain, ""))
	slug := ""
	for _, w := range strings.Fields(junkRe.ReplaceAllString(s, " ")) {
		next := w
		if slug != "" {
			next = slug + "-" + w
		}
		if utf8.RuneCountInString(next) > MaxRunes {
			if slug == "" { // a single very long word
				slug = string([]rune(w)[:MaxRunes])
			}
			break
		}
		slug = next
	}
	return slug
}

// PlainPath is the path as the server sees it (decoded); Path is the one to write in a link, a redirect or the sitemap.
func PlainPath(id, slug string) string {
	if slug == "" {
		return "/m/" + id
	}
	return "/m/" + id + "/" + slug
}

func Path(id, slug string) string {
	if slug == "" {
		return "/m/" + id
	}
	return "/m/" + id + "/" + url.PathEscape(slug)
}

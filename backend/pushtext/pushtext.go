// Package pushtext makes the text of a push notification out of a message: plain, short, without the markers that the site uses inside
// messages (media embeds, markdown, HTML, web addresses). Message text is stored as markdown with embeds such as
// "[image-embedded#](/api/files/...)"; sent as it is, the notification showed all of that. No Redis or HTTP here, so it is tested alone.
package pushtext

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

var (
	quoteRe   = regexp.MustCompile(`\[quote-embedded#\]\([^)]*\)`)
	mediaRe   = regexp.MustCompile(`\[(image|video|audio|gallery)-embedded#\]\(([^)]*)\)`)
	imageMdRe = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	linkMdRe  = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	htmlRe    = regexp.MustCompile(`<[^>]+>`)
	urlRe     = regexp.MustCompile(`(?i)\b(?:https?://|www\.)\S+`)
	markRe    = regexp.MustCompile("[*_`~>#|]+")
	bulletRe  = regexp.MustCompile(`(?m)^\s*[-+]\s+`)
	spacesRe  = regexp.MustCompile(`\s+`)
)

// Body returns the notification text: at most max characters. A message that is only a picture, video, recording or poll gets a short label.
func Body(text string, hasPoll bool, max int) string {
	var video, audio, images int
	for _, m := range mediaRe.FindAllStringSubmatch(text, -1) {
		switch m[1] {
		case "video":
			video++
		case "audio":
			audio++
		case "gallery":
			images += 2 // a gallery is several pictures
		default:
			images++
		}
	}
	t := quoteRe.ReplaceAllString(text, " ")
	t = mediaRe.ReplaceAllString(t, " ")
	t = imageMdRe.ReplaceAllString(t, " ")
	t = linkMdRe.ReplaceAllString(t, "$1")
	t = htmlRe.ReplaceAllString(t, " ")
	t = urlRe.ReplaceAllString(t, "קישור")
	t = bulletRe.ReplaceAllString(t, "")
	t = markRe.ReplaceAllString(t, " ")
	t = strings.TrimSpace(spacesRe.ReplaceAllString(t, " "))

	var icon, label string
	switch {
	case video > 0:
		icon, label = "🎬", "סרטון חדש"
	case images > 1:
		icon, label = "📷", "תמונות חדשות"
	case images == 1:
		icon, label = "📷", "תמונה חדשה"
	case audio > 0:
		icon, label = "🎧", "הקלטה חדשה"
	case hasPoll:
		icon, label = "📊", "סקר חדש"
	}
	switch {
	case t == "" && label != "":
		t = icon + " " + label
	case t == "":
		t = "הודעה חדשה"
	case icon != "":
		t = icon + " " + t // a text with a picture / video: the icon tells that there is one
	}
	return Truncate(t, max)
}

// Truncate cuts to max characters at a word boundary and adds "…".
func Truncate(s string, max int) string {
	if max <= 0 || utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)[:max-1]
	if i := strings.LastIndex(string(r), " "); i > max/2 {
		return strings.TrimRight(string(r)[:i], " ,.;:-–") + "…"
	}
	return strings.TrimSpace(string(r)) + "…"
}

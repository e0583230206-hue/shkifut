package main

import (
	"bytes"
	"context"
	"fmt"
	"html"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi"
)

// Server-side SEO: the Angular app is a single page, so crawlers and link previews (WhatsApp, Telegram,
// Facebook) get their title / description / image from tags injected here into index.html.

const (
	defaultSiteName    = "שקיפות"
	defaultDescription = "שקיפות - ערוץ חדשות ועדכונים"
)

type pageMeta struct {
	Title       string
	Description string
	Image       string // absolute URL
	Path        string // canonical path
	Type        string // og:type
	Body        string // plain-text content for crawlers without JavaScript
	NoIndex     bool
}

// SPA routes that exist; anything else gets the app with a real 404 status.
var spaRoutes = map[string]bool{"/": true, "/login": true, "/privacy": true, "/terms": true, "/index.html": true}

var (
	embedRe     = regexp.MustCompile(`\[(?:image|video|audio|quote|gallery)-embedded#\]\(([^)]*)\)`)
	htmlTagRe   = regexp.MustCompile(`<[^>]+>`)
	imageRe     = regexp.MustCompile(`\[image-embedded#\]\(([^)\s]+)\)`)
	mdLinkRe    = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	mdMarkRe    = regexp.MustCompile("[*_`~>#|]+")
	spacesRe    = regexp.MustCompile(`\s+`)
	messageIDRe = regexp.MustCompile(`^[0-9]{1,12}$`)
)

func baseURL(r *http.Request) string {
	if publicURL != "" {
		return publicURL
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func absURL(r *http.Request, u string) string {
	if u == "" || strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
		return u
	}
	return baseURL(r) + "/" + strings.TrimLeft(u, "/")
}

// plainText turns a message's markdown into readable text (embeds and markup removed).
func plainText(md string) string {
	t := embedRe.ReplaceAllString(md, " ")
	t = htmlTagRe.ReplaceAllString(t, " ")
	t = mdLinkRe.ReplaceAllString(t, "$1")
	t = mdMarkRe.ReplaceAllString(t, " ")
	return strings.TrimSpace(spacesRe.ReplaceAllString(t, " "))
}

func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:n-1])) + "…"
}

func channelMeta(ctx context.Context) (name, description, logo string) {
	c, _ := getChannelDetails(ctx)
	name, description, logo = c["name"], c["description"], c["logoUrl"]
	if name == "" {
		name = defaultSiteName
	}
	if description == "" {
		description = defaultDescription
	}
	return
}

func renderIndex(w http.ResponseWriter, r *http.Request, m pageMeta, status int) {
	content, err := os.ReadFile(filepath.Join(settingConfig.RootStaticFolder, "index.html"))
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	e := html.EscapeString
	canonical := baseURL(r) + m.Path
	var head strings.Builder
	fmt.Fprintf(&head, "<title>%s</title>\n", e(m.Title))
	fmt.Fprintf(&head, "  <meta name=\"description\" content=\"%s\">\n", e(m.Description))
	fmt.Fprintf(&head, "  <link rel=\"canonical\" href=\"%s\">\n", e(canonical))
	if m.NoIndex {
		head.WriteString("  <meta name=\"robots\" content=\"noindex\">\n")
	}
	fmt.Fprintf(&head, "  <meta property=\"og:site_name\" content=\"%s\">\n", e(defaultSiteName))
	fmt.Fprintf(&head, "  <meta property=\"og:locale\" content=\"he_IL\">\n")
	fmt.Fprintf(&head, "  <meta property=\"og:type\" content=\"%s\">\n", e(m.Type))
	fmt.Fprintf(&head, "  <meta property=\"og:title\" content=\"%s\">\n", e(m.Title))
	fmt.Fprintf(&head, "  <meta property=\"og:description\" content=\"%s\">\n", e(m.Description))
	fmt.Fprintf(&head, "  <meta property=\"og:url\" content=\"%s\">\n", e(canonical))
	card := "summary"
	if m.Image != "" {
		fmt.Fprintf(&head, "  <meta property=\"og:image\" content=\"%s\">\n", e(m.Image))
		card = "summary_large_image"
	}
	fmt.Fprintf(&head, "  <meta name=\"twitter:card\" content=\"%s\">\n", card)

	// The original index.html has an empty <title></title> placeholder.
	content = bytes.Replace(content, []byte("<title></title>"), []byte(head.String()), 1)
	if m.Body != "" {
		noscript := fmt.Sprintf("<noscript><article><h1>%s</h1><p>%s</p></article></noscript>\n</body>", e(m.Title), e(m.Body))
		content = bytes.Replace(content, []byte("</body>"), []byte(noscript), 1)
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(status)
	w.Write(content)
}

// serveSpaFile serves the app for every non-API path, with channel meta tags and a real 404 for unknown paths.
func serveSpaFile(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	name, description, logo := channelMeta(ctx)
	title := name
	if settingConfig.CustomTitle != "" {
		title = settingConfig.CustomTitle
	}
	m := pageMeta{Title: title, Description: description, Image: absURL(r, logo), Path: r.URL.Path, Type: "website"}
	status := http.StatusOK
	switch r.URL.Path {
	case "/privacy":
		m.Title, m.Description = "מדיניות פרטיות | "+name, "מדיניות הפרטיות של "+name
	case "/terms":
		m.Title, m.Description = "תנאי שימוש | "+name, "תנאי השימוש באתר "+name
	case "/login":
		m.NoIndex = true
	}
	if !spaRoutes[r.URL.Path] {
		status = http.StatusNotFound
		m.Title, m.NoIndex, m.Path = "הדף לא נמצא | "+name, true, "/"
	}
	renderIndex(w, r, m, status)
}

// serveMessagePage is the shareable address of a single message: /m/{id}.
func serveMessagePage(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	name, description, logo := channelMeta(ctx)
	id := chi.URLParam(r, "id")
	m := pageMeta{Title: name, Description: description, Image: absURL(r, logo), Path: "/m/" + id, Type: "article"}

	if !messageIDRe.MatchString(id) {
		m.NoIndex = true
		renderIndex(w, r, m, http.StatusNotFound)
		return
	}
	// With "require login" the content is private: previews show only the channel.
	if settingConfig.RequireAuth {
		m.NoIndex = true
		renderIndex(w, r, m, http.StatusOK)
		return
	}
	vals, err := rdb.HMGet(ctx, "messages:"+id, "text", "deleted").Result()
	text, _ := vals[0].(string)
	deleted, _ := vals[1].(string)
	if err != nil || text == "" || deleted == "1" || deleted == "true" {
		m.Title, m.NoIndex = "ההודעה לא נמצאה | "+name, true
		renderIndex(w, r, m, http.StatusNotFound)
		return
	}
	plain := plainText(text)
	if plain != "" {
		m.Title = truncate(plain, 70) + " | " + name
		m.Description = truncate(plain, 200)
		m.Body = plain
	}
	// Preview image: the first image of the message. /api/files serves readers (and crawlers) only the
	// version they may see - blurred or regionally blurred when needed - so this never leaks an original.
	if im := imageRe.FindStringSubmatch(text); im != nil {
		m.Image = absURL(r, im[1])
	}
	renderIndex(w, r, m, http.StatusOK)
}

func serveRobots(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if privateSite {
		fmt.Fprint(w, "User-agent: *\nDisallow: /\n")
		return
	}
	fmt.Fprintf(w, "User-agent: *\nDisallow: /api/\nDisallow: /auth/\nDisallow: /login\nAllow: /api/files/\n\nSitemap: %s/sitemap.xml\n", baseURL(r))
}

// serveSitemap lists the home page, static pages and the latest 5000 published messages.
func serveSitemap(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	base := baseURL(r)
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n" + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` + "\n")
	for _, p := range []string{"/", "/privacy", "/terms"} {
		fmt.Fprintf(&b, "  <url><loc>%s%s</loc></url>\n", base, p)
	}
	if !settingConfig.RequireAuth {
		members, _ := rdb.ZRevRangeWithScores(ctx, "m_times:1", 0, 4999).Result()
		for _, z := range members {
			key, _ := z.Member.(string)
			id := strings.TrimPrefix(key, "messages:")
			if _, err := strconv.Atoi(id); err != nil {
				continue
			}
			if d, _ := rdb.HGet(ctx, key, "deleted").Result(); d == "1" || d == "true" {
				continue
			}
			lastmod := time.Unix(int64(z.Score), 0).UTC().Format("2006-01-02")
			fmt.Fprintf(&b, "  <url><loc>%s/m/%s</loc><lastmod>%s</lastmod></url>\n", base, id, lastmod)
		}
	}
	b.WriteString("</urlset>\n")
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Write([]byte(b.String()))
}

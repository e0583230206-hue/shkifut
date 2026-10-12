package main

import (
	"log"
	"net/http"
	"os"
	"strings"
)

// Private site: when ALLOWED_EMAILS is set (comma separated), only those accounts and ADMIN_USERS may log in,
// and every request without such a session is refused here, before any handler runs. The login page, its
// static files and the bridge API (which has its own key) stay reachable. Unset = public site (as before).

var allowedEmails = func() map[string]bool {
	m := map[string]bool{}
	for _, e := range strings.Split(os.Getenv("ALLOWED_EMAILS"), ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			m[e] = true
		}
	}
	return m
}()

var privateSite = len(allowedEmails) > 0

// isAllowedEmail: in private mode, the listed accounts and the admins; otherwise everyone.
func isAllowedEmail(email string) bool {
	if !privateSite {
		return true
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if allowedEmails[email] {
		return true
	}
	for _, a := range adminUsers {
		if strings.EqualFold(strings.TrimSpace(a), email) && email != "" {
			return true
		}
	}
	return false
}

// Reachable without an approved session in private mode.
var privatePublicPaths = map[string]bool{
	"/login": true, "/auth/google": true, "/auth/login": true, "/auth/logout": true, "/auth/dev-login": true,
	"/favicon.ico": true, "/assets/favicon.ico": true, "/robots.txt": true,
	"/api/import/post": true, "/api/import/upload": true, // bridge: X-API-Key
}

func privateAccess(next http.Handler) http.Handler {
	if !privateSite {
		return next
	}
	log.Printf("private site: %d allowed accounts (+ admins); everything else requires their login", len(allowedEmails))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		p := r.URL.Path
		if privatePublicPaths[p] || (strings.HasPrefix(p, "/assets/") && !strings.Contains(p, "..")) {
			next.ServeHTTP(w, r)
			return
		}
		session, _ := store.Get(r, cookieName)
		if s, ok := session.Values["user"].(Session); ok && isAllowedEmail(s.Email) {
			next.ServeHTTP(w, r)
			return
		}
		// Not allowed: pages go to the login screen, everything else is refused.
		if r.Method == http.MethodGet && !strings.HasPrefix(p, "/api/") && strings.Contains(r.Header.Get("Accept"), "text/html") {
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		http.Error(w, "login required", http.StatusUnauthorized)
	})
}

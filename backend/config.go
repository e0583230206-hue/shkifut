package main

import (
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
)

// Deployment settings (environment variables).
var (
	// APP_ENV=production enables production safeguards (secure cookies, no dev login).
	isProduction = strings.EqualFold(os.Getenv("APP_ENV"), "production")
	// PUBLIC_URL is the site's public origin, e.g. https://30206.co.il (no trailing slash).
	// Used for the OAuth redirect URI instead of trusting the request's Origin header.
	publicURL = strings.TrimRight(os.Getenv("PUBLIC_URL"), "/")
	// NOINDEX_SITE=1 asks search engines to stay away from the whole site (header, meta tag, robots.txt, no sitemap), independently of PRIVATE_SITE.
	noindexSite = os.Getenv("NOINDEX_SITE") == "1"
)

// checkProductionConfig refuses to start with settings that must never reach production.
func checkProductionConfig() {
	if !isProduction {
		return
	}
	if devLoginEnabled {
		log.Fatal("DEV_LOGIN must not be enabled when APP_ENV=production")
	}
	if len(secretKey) < 32 {
		log.Fatal("SECRET_KEY must be at least 32 characters in production")
	}
	if publicURL == "" {
		log.Println("WARNING: PUBLIC_URL is not set; Google login will use the request Origin header")
	}
}

// securityHeaders adds conservative browser security headers to every response.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if noindexSite {
			h.Set("X-Robots-Tag", "noindex, nofollow")
		}
		next.ServeHTTP(w, r)
	})
}

// hashedAsset matches the Angular build outputs whose names contain a content hash (main-6SCDYTF5.js).
var hashedAsset = regexp.MustCompile(`-[A-Z0-9]{8}\.(js|css)$`)

// staticCache lets browsers keep content-hashed build files for a year (a new build has new names).
func staticCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hashedAsset.MatchString(r.URL.Path) {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		next.ServeHTTP(w, r)
	})
}

// oauthRedirectURL is the redirect URI registered in the Google console: <origin>/login.
func oauthRedirectURL(r *http.Request) string {
	// Through an SSH tunnel (deploy/tunnel.ps1) the browser is on http://localhost:<port>; Google only accepts the
	// redirect URIs registered in its console, so a loopback origin is passed through and anything else is ignored.
	if o := r.Header.Get("Origin"); publicURL != "" && isLoopbackOrigin(o) {
		return o + "/login"
	}
	if publicURL != "" {
		return publicURL + "/login"
	}
	return r.Header.Get("Origin") + "/login"
}

// isLoopbackOrigin: exactly http://localhost[:port] or http://127.0.0.1[:port] (no path, no userinfo).
func isLoopbackOrigin(o string) bool {
	u, err := url.Parse(o)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	h := u.Hostname()
	return h == "localhost" || h == "127.0.0.1"
}

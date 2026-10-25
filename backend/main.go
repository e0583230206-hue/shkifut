package main

import (
	"encoding/gob"
	"log"
	"net/http"
	_ "net/http/pprof"
	"os"

	"github.com/boj/redistore"
	"github.com/go-chi/chi"
	"github.com/go-chi/chi/middleware"
)

var rootStaticFolder = os.Getenv("ROOT_STATIC_FOLDER")

func protectedWithPrivilege(Privilege Privilege, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !checkPrivilege(r, Privilege) {
			http.Error(w, "User not authorized or not privilege", http.StatusUnauthorized)
			return
		}
		handler(w, r)
	}
}

func ifRequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check every time
		if settingConfig.RequireAuth {
			checkLogin(next).ServeHTTP(w, r)
		} else {
			next.ServeHTTP(w, r)
		}
	})
}

func main() {
	gob.Register(Session{})
	checkProductionConfig()
	initializePrivilegeUsers()
	go statLogger()
	startModeration()
	startManualVideoWorker() // MANUAL_BLUR_VIDEO: the one worker that renders manual videos (does nothing while the flag is off)
	startMediaCleanup()
	startPresenceCleanup()

	var err error
	store, err = redistore.NewRediStore(10, redisType, redisAddr, "", redisPass, []byte(secretKey))
	if err != nil {
		panic(err)
	}
	store.SetMaxAge(60 * 60 * 24 * 30)
	store.Options.HttpOnly = true
	store.Options.SameSite = http.SameSiteLaxMode
	store.Options.Secure = isProduction // HTTPS only in production
	defer store.Close()

	r := chi.NewRouter()
	r.Use(middleware.RealIP) // client IP from nginx (X-Real-IP); the backend only listens on localhost in production
	r.Use(middleware.Logger)
	r.Use(securityHeaders)
	r.Use(privateAccess) // ALLOWED_EMAILS: closed site, enforced here for every route (access.go)

	// Protected with api key
	r.Post("/api/import/post", addNewPost)
	r.Post("/api/import/upload", importUpload)
	r.Post("/api/contact", submitContact)

	if devLoginEnabled {
		log.Println("WARNING: DEV_LOGIN is enabled - /auth/dev-login bypasses Google OAuth. Never enable this in production.")
		r.Get("/auth/dev-login", devLogin)
	}

	r.Get("/auth/google", getGoogleAuthValues)
	r.Post("/auth/login", login)
	r.Post("/auth/logout", logout)
	r.Get("/assets/favicon.ico", getFavicon)
	r.Get("/favicon.ico", getFavicon)
	r.Get("/apple-touch-icon.png", getAppleTouchIcon)

	r.Group(func(r chi.Router) {
		r.Use(checkLogin)
		r.Post("/api/reactions/set-reactions", setReactions)
		r.Post("/api/messages/report", reportMessage)
		r.Post("/api/polls/vote", votePoll)
		r.Get("/api/polls/mine", myVotes)
	})

	r.Group(func(r chi.Router) {
		r.Use(ifRequireAuth)
		r.Get("/firebase-messaging-sw.js", getFirebaseMessagingSW)
		r.Route("/api", func(api chi.Router) {
			api.Get("/ads/settings", getAdsSettings)
			api.Get("/emojis/list", getEmojisList)
			api.Get("/channel/notifications-config", getNotificationsConfig)
			api.Post("/channel/notifications-subscribe", subscribeNotifications)

			api.Get("/channel/info", getChannelInfo)
			api.Get("/messages", withPresence(getMessages))
			api.Get("/messages/search", searchMessages)
			api.Get("/messages/pinned", getPinnedMessages)
			api.Get("/topics", getTopics)
			api.Get("/events", getEvents)
			api.Get("/files/{fileid}", serveFile)
			api.Get("/files/{fileid}/moderation", getFileModeration)
			api.Get("/user-info", withPresence(getUserInfo))

			api.Route("/admin", func(protected chi.Router) {
				// ⚠️ WARNING: Route not check privilege use protectedWithPrivilege to check privilege.

				protected.Post("/new", protectedWithPrivilege(Writer, addMessage))
				protected.Post("/edit-message", protectedWithPrivilege(Writer, updateMessage))
				protected.Get("/delete-message/{id}", protectedWithPrivilege(Writer, deleteMessage))
				protected.Post("/pin", protectedWithPrivilege(Writer, setPinned))
				protected.Post("/topics", protectedWithPrivilege(Moderator, setTopics))
				protected.Post("/polls/close", protectedWithPrivilege(Writer, closePoll))
				protected.Post("/upload", protectedWithPrivilege(Writer, uploadFile))
				protected.Get("/scheduled-messages/get", protectedWithPrivilege(Writer, getScheduledMessages))
				protected.Post("/scheduled-messages/update", protectedWithPrivilege(Writer, updateScheduledMessages))

				protected.Post("/edit-channel-info", protectedWithPrivilege(Moderator, editChannelInfo))
				protected.Get("/statistics", protectedWithPrivilege(Moderator, getStatistics))
				protected.Post("/set-emojis", protectedWithPrivilege(Moderator, setEmojis))
				protected.Post("/files/moderation", protectedWithMediaModerator(setFileModeration))
				protected.Post("/files/reprocess", protectedWithMediaModerator(reprocessFile))
				protected.Get("/files/{fileid}/figures", protectedWithApprover(getFigures))
				protected.Get("/files/{fileid}/figures/{name}", protectedWithApprover(getFigureCrop))
				protected.Post("/files/{fileid}/figures", protectedWithApprover(setFigures))
				protected.Post("/files/{fileid}/approve", protectedWithApprover(approveVideo))
				// MANUAL_BLUR (off by default): draw blur shapes on an image; owners and approvers only (404 while the flag is off)
				protected.Get("/files/{fileid}/manual-blur", protectedWithManualBlur(getManualBlur))
				protected.Post("/files/{fileid}/manual-blur", protectedWithManualBlur(setManualBlur))
				protected.Delete("/files/{fileid}/manual-blur", protectedWithManualBlur(deleteManualBlur))
				protected.Get("/presence", protectedWithPrivilege(Moderator, getPresence)) // "מנהל 1" and the owner (not "מנהל 2")
				protected.Get("/contact", protectedWithPrivilege(Moderator, getContactMessages))
				protected.Post("/contact/set", protectedWithPrivilege(Moderator, setContactHandled))

				protected.Post("/statistics/reset", protectedWithPrivilege(Admin, resetStatistics))
				protected.Get("/privilegs-users/get-list", protectedWithPrivilege(Admin, getPrivilegeUsersList))
				protected.Post("/privilegs-users/set", protectedWithPrivilege(Admin, setPrivilegeUsers))
				protected.Get("/settings/get", protectedWithPrivilege(Admin, getSettings))
				protected.Post("/settings/set", protectedWithPrivilege(Admin, setSettings))
				protected.Get("/reports/get", protectedWithPrivilege(Admin, getReports))
				protected.Post("/reports/set", protectedWithPrivilege(Admin, setReports))
				protected.Post("/media/cleanup", protectedWithPrivilege(Admin, mediaCleanupHandler))
			})
		})
	})

	if settingConfig.RootStaticFolder != "" {
		r.Handle("/assets/*", staticCache(http.StripPrefix("/assets/", http.FileServer(http.Dir(settingConfig.RootStaticFolder)))))
		// SEO: meta tags for link previews, a shareable page per message, sitemap and robots (seo.go)
		r.Get("/m/{id}", serveMessagePage)
		r.Get("/robots.txt", serveRobots)
		r.Get("/sitemap.xml", serveSitemap)
		r.NotFound(serveSpaFile)
	}

	go func() {
		log.Fatal(http.ListenAndServe("localhost:6060", nil))
	}()

	if err := http.ListenAndServe(":"+os.Getenv("SERVER_PORT"), r); err != nil {
		log.Fatal(err)
	}
}

package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type Privilege string              //privilege type
type Privileges map[Privilege]bool // map of privileges
var privilegesUsers sync.Map
var adminUsers []string = strings.Split(os.Getenv("ADMIN_USERS"), ",")

const (
	Admin     Privilege = "admin"     // root privilege
	Moderator Privilege = "moderator" // admin privilege
	Writer    Privilege = "writer"    // can write posts
	// Reviewer is "מנהל 2": the media moderation tools only (open / blur / review figures / approve videos / manual blur), nothing else:
	// no contact messages, no list of who is online, no statistics, topics or settings. Moderator ("מנהל 1") can do all of this and
	// also reads the contact messages, sees who is online and manages the channel.
	Reviewer Privilege = "reviewer"
)

// privilegesOfEmail: the privileges of an account in the users list (nothing for an unknown one).
func privilegesOfEmail(email string) Privileges {
	if v, ok := privilegesUsers.Load(email); ok {
		return v.(User).Privileges
	}
	if v, ok := privilegesUsers.Load(strings.ToLower(strings.TrimSpace(email))); ok {
		return v.(User).Privileges
	}
	return Privileges{}
}

// canModerateMedia: may see the original of a file and use the media moderation tools: a "מנהל 1" (Moderator) or a "מנהל 2" (Reviewer).
func canModerateMedia(p Privileges) bool { return p[Moderator] || p[Reviewer] }

func isMediaModerator(r *http.Request) bool {
	session, _ := store.Get(r, cookieName)
	s, ok := session.Values["user"].(Session)
	return ok && canModerateMedia(currentPrivileges(s))
}

func protectedWithMediaModerator(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isMediaModerator(r) {
			http.Error(w, "User not authorized or not privilege", http.StatusUnauthorized)
			return
		}
		handler(w, r)
	}
}

func initializePrivilegeUsers() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	privilegesUsers.Clear()
	users, err := dbGetUsersList(ctx)
	if err != nil && err != redis.Nil {
		panic("Failed to get users list from database: " + err.Error())
	}
	existsEmails := make(map[string]bool)
	for _, user := range users {
		existsEmails[user.Email] = true
	}
	for _, admin := range adminUsers {
		if !existsEmails[admin] {
			users = append(users, User{
				Username: "",
				Email:    admin,
				Privileges: Privileges{
					Admin:     true,
					Moderator: true,
					Writer:    true,
				},
			})
		}
	}

	for _, user := range users {
		privilegesUsers.Store(user.Email, user)
	}

	if err := dbSetUsersList(ctx, users); err != nil {
		panic("Failed to set users list in database: " + err.Error())
	}
}

func (p Privileges) MarshalBinary() ([]byte, error) {
	return json.Marshal(p)
}

func (p *Privileges) UnmarshalBinary(data []byte) error {
	return json.Unmarshal(data, p)
}

func getPrivilegeUsersList(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	users, err := dbGetUsersList(ctx)
	if err != nil {
		http.Error(w, "Failed to get users list", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(users)
}

func setPrivilegeUsers(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var req struct {
		List []User `json:"list"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()
	log.Println("Setting privileges for users:", req.List)

	if err := dbSetUsersList(ctx, req.List); err != nil {
		http.Error(w, "Failed to set users list", http.StatusInternalServerError)
		return
	}

	initializePrivilegeUsers()

	response := Response{Success: true}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

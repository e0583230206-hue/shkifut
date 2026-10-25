package main

import "testing"

// The two kinds of managers. They need no moderation service and no session: go test -run Roles .  (needs any Redis, see moderation/README.md)

func withUsers(t *testing.T, users ...User) {
	t.Helper()
	privilegesUsers.Clear()
	for _, u := range users {
		privilegesUsers.Store(u.Email, u)
	}
	t.Cleanup(func() { privilegesUsers.Clear() })
}

func TestRolesWhoCanModerateMedia(t *testing.T) {
	cases := map[string]struct {
		p    Privileges
		want bool
	}{
		"manager 1 (moderator)":        {Privileges{Moderator: true}, true},
		"manager 2 (reviewer)":         {Privileges{Reviewer: true}, true},
		"both":                         {Privileges{Moderator: true, Reviewer: true}, true},
		"owner flags":                  {Privileges{Admin: true, Moderator: true, Writer: true}, true},
		"admin alone":                  {Privileges{Admin: true}, false},
		"writer alone":                 {Privileges{Writer: true}, false},
		"nothing":                      {Privileges{}, false},
		"explicit false":               {Privileges{Moderator: false, Reviewer: false}, false},
		"reviewer with writer (posts)": {Privileges{Reviewer: true, Writer: true}, true},
	}
	for name, c := range cases {
		if got := canModerateMedia(c.p); got != c.want {
			t.Errorf("%s: %v, want %v", name, got, c.want)
		}
	}
}

// Both kinds approve videos and review figures; that is what the owner asked for. Nobody else does, even when listed in the old lists.
func TestRolesApproversAreTheTwoKindsOfManagers(t *testing.T) {
	withUsers(t,
		User{Email: "one@example.com", Privileges: Privileges{Moderator: true}},
		User{Email: "two@example.com", Privileges: Privileges{Reviewer: true}},
		User{Email: "writer@example.com", Privileges: Privileges{Writer: true}},
		User{Email: "admin-only@example.com", Privileges: Privileges{Admin: true}},
	)
	for email, want := range map[string]bool{
		"one@example.com": true, "two@example.com": true, "ONE@Example.com ": true,
		"writer@example.com": false, "admin-only@example.com": false, "nobody@example.com": false, "": false,
	} {
		if got := emailIsApprover(email); got != want {
			t.Errorf("%q: %v, want %v", email, got, want)
		}
	}
	// a manager loses it as soon as the flag is taken away in the permissions screen
	withUsers(t, User{Email: "two@example.com", Privileges: Privileges{Reviewer: false}})
	if emailIsApprover("two@example.com") {
		t.Error("a reviewer whose flag was removed is still an approver")
	}
}

func TestRolesPrivilegesOfEmail(t *testing.T) {
	withUsers(t, User{Email: "a@example.com", Privileges: Privileges{Reviewer: true}})
	if !privilegesOfEmail("a@example.com")[Reviewer] || !privilegesOfEmail(" A@EXAMPLE.com")[Reviewer] {
		t.Error("lookup by email (case and spaces do not matter)")
	}
	if len(privilegesOfEmail("unknown@example.com")) != 0 {
		t.Error("an unknown account has no privileges")
	}
}

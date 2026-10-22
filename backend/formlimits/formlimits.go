// Package formlimits holds the rules for the two forms that anyone with a Google account (or, for the contact form, anyone at all) can fill
// in: the report of a message and the contact form. Length rules and a rate limit, without Redis or HTTP of their own (the counter is an
// interface), so they are tested alone.
package formlimits

import (
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	ErrTooShort = errors.New("text too short")
	ErrTooLong  = errors.New("text too long")
)

// Clean trims the text, drops control characters (a new line becomes a space) and checks its length in characters (not bytes).
func Clean(s string, min, max int) (string, error) {
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			return ' '
		case unicode.IsControl(r):
			return -1
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	n := utf8.RuneCountInString(s)
	if n < min {
		return "", ErrTooShort
	}
	if n > max {
		return "", ErrTooLong
	}
	return s, nil
}

// Counter counts events per key inside a window: the first Incr of a key starts the window (Redis: INCR + EXPIRE).
type Counter interface {
	Incr(key string, window time.Duration) (int64, error)
}

// Rule: at most Limit events per Window.
type Rule struct {
	Name   string
	Limit  int64
	Window time.Duration
}

type Limiter struct{ Counter Counter }

// Allow counts one event under every rule and says whether it is within all of them. When the counter fails the request is let through
// (a broken counter must not close the forms); the failure is the caller's to log.
func (l Limiter) Allow(key string, rules ...Rule) (ok bool, broken Rule, err error) {
	for _, r := range rules {
		n, e := l.Counter.Incr(key+":"+r.Name, r.Window)
		if e != nil {
			err = e
			continue
		}
		if n > r.Limit {
			return false, r, err
		}
	}
	return true, Rule{}, err
}

package formlimits

import (
	"errors"
	"strings"
	"testing"
	"time"
)

type memCounter struct {
	n    map[string]int64
	fail bool
}

func (m *memCounter) Incr(key string, _ time.Duration) (int64, error) {
	if m.fail {
		return 0, errors.New("redis down")
	}
	m.n[key]++
	return m.n[key], nil
}

func TestCleanLengthCountsCharactersNotBytes(t *testing.T) {
	if _, err := Clean(strings.Repeat("א", 500), 3, 500); err != nil {
		t.Fatalf("500 Hebrew letters (1000 bytes) are within 500 characters: %v", err)
	}
	if _, err := Clean(strings.Repeat("א", 501), 3, 500); err != ErrTooLong {
		t.Fatalf("501 characters must be too long: %v", err)
	}
	if _, err := Clean("אב", 3, 500); err != ErrTooShort {
		t.Fatalf("2 characters must be too short: %v", err)
	}
}

func TestCleanTrimsAndStripsControlCharacters(t *testing.T) {
	got, err := Clean("  שלום\n\n  עולם\x00\x07\t!  ", 3, 100)
	if err != nil || got != "שלום עולם !" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := Clean("   \n\t  ", 3, 100); err != ErrTooShort {
		t.Fatal("only blanks counts as empty")
	}
}

func TestLimiterStopsAfterTheLimitPerRule(t *testing.T) {
	l := Limiter{&memCounter{n: map[string]int64{}}}
	rules := []Rule{{"minute", 2, time.Minute}, {"hour", 5, time.Hour}}
	for i := 1; i <= 2; i++ {
		if ok, _, _ := l.Allow("u1", rules...); !ok {
			t.Fatalf("event %d must pass", i)
		}
	}
	ok, broken, _ := l.Allow("u1", rules...)
	if ok || broken.Name != "minute" {
		t.Fatalf("third event within the minute must be refused by the minute rule, got ok=%v rule=%q", ok, broken.Name)
	}
}

func TestLimiterKeysAreIndependent(t *testing.T) {
	l := Limiter{&memCounter{n: map[string]int64{}}}
	r := Rule{"hour", 1, time.Hour}
	if ok, _, _ := l.Allow("a", r); !ok {
		t.Fatal("a first")
	}
	if ok, _, _ := l.Allow("a", r); ok {
		t.Fatal("a second must be refused")
	}
	if ok, _, _ := l.Allow("b", r); !ok {
		t.Fatal("another key is not affected")
	}
}

func TestBrokenCounterLetsRequestsThrough(t *testing.T) {
	l := Limiter{&memCounter{n: map[string]int64{}, fail: true}}
	ok, _, err := l.Allow("a", Rule{"hour", 1, time.Hour})
	if !ok || err == nil {
		t.Fatalf("a failing counter must let the request through and report the error: ok=%v err=%v", ok, err)
	}
}

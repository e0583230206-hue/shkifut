package main

import (
	"context"
	"testing"

	"github.com/redis/go-redis/v9"
)

// Regression for M1: myItems now reads the lists in one pipeline. The result must stay the same:
// only the caller's own reports and contact messages, newest first, and nothing of another person's.
func TestMyItemsOwnOnlyNewestFirst(t *testing.T) {
	ctx := context.Background()
	reader := Session{ID: "regression-reader", Email: "Regression-Reader@example.test"}
	type seed struct {
		key   string
		score float64
		h     map[string]any
		list  string
	}
	seeds := []seed{
		{"report:9300001", 1001, map[string]any{"id": 9300001, "reporterId": reader.ID, "reason": "mine old", "createdAt": "2026-11-18T10:00:00Z"}, "reports:list"},
		{"report:9300002", 1002, map[string]any{"id": 9300002, "reporterId": "someone-else", "reason": "not mine", "createdAt": "2026-11-18T10:01:00Z"}, "reports:list"},
		{"report:9300003", 1003, map[string]any{"id": 9300003, "reporterId": reader.ID, "reason": "mine new", "createdAt": "2026-11-18T10:03:00Z"}, "reports:list"},
		{"contact:9300004", 1004, map[string]any{"id": 9300004, "userEmail": "regression-reader@example.test", "subject": "mine by email case", "message": "hi", "createdAt": "2026-11-18T10:04:00Z"}, "contact:list"},
		{"contact:9300005", 1005, map[string]any{"id": 9300005, "userEmail": "other@example.test", "subject": "not mine", "message": "x", "createdAt": "2026-11-18T10:05:00Z"}, "contact:list"},
	}
	for _, s := range seeds {
		rdb.HSet(ctx, s.key, s.h)
		// Far-future offset: these items are always the newest, so the 500-item window of the summary always includes them.
		rdb.ZAdd(ctx, s.list, redis.Z{Score: s.score + 4102444800, Member: s.key})
	}
	defer func() {
		for _, s := range seeds {
			rdb.Del(ctx, s.key)
			rdb.ZRem(ctx, s.list, s.key)
		}
	}()

	items := myItems(ctx, reader)
	var got []int64
	for _, it := range items {
		got = append(got, it.ID)
	}
	want := []int64{9300004, 9300003, 9300001}
	if len(got) != len(want) {
		t.Fatalf("own items: want %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("own items order: want %v, got %v", want, got)
		}
	}
	if items[0].Kind != "contact" || items[1].Kind != "report" {
		t.Fatalf("kinds: %+v", items)
	}
}

package main

import (
	"context"
	"net/http"
	"time"
)

// getInboxCounts: how many reports and contact messages are still open (not handled). The admin panel shows them as a number next to the
// tabs and next to "ניהול ערוץ", so the owner and "מנהל 1" see that something new is waiting. Counts only; nothing of the content.
func getInboxCounts(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	reports, err1 := rdb.ZCard(ctx, "reports:open").Result()
	contact, err2 := rdb.ZCard(ctx, "contact:open").Result()
	if err1 != nil || err2 != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, map[string]int64{"reports": reports, "contact": contact})
}

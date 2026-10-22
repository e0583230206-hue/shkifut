package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"channel/formlimits"
)

type Report struct {
	Id            int64     `json:"id" redis:"id"`
	MessageId     int64     `json:"messageId" redis:"messageId"`
	Reason        string    `json:"reason" redis:"reason"`
	CreatedAt     time.Time `json:"createdAt" redis:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt" redis:"updatedAt"`
	ReporterID    string    `json:"reporterId" redis:"reporterId"`
	ReportedEmail string    `json:"reportedEmail" redis:"reportedEmail"`
	ReporterName  string    `json:"reporterName" redis:"reporterName"`
	Closed        bool      `json:"closed" redis:"closed"`
}

type Reports []*Report

type ReportStatus string

const (
	Open   ReportStatus = "open"
	Closed ReportStatus = "closed"
	All    ReportStatus = "all"
)

func (s ReportStatus) IsValid() bool {
	return s == Open || s == Closed || s == All
}

func reportMessage(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	session, _ := store.Get(r, cookieName)
	s, ok := session.Values["user"].(Session)
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Only the message number and the reason are taken from the request; everything else is filled in here.
	r.Body = http.MaxBytesReader(w, r.Body, reportBodyMax)
	defer r.Body.Close()
	var in struct {
		MessageId int64  `json:"messageId"`
		Reason    string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	reason, err := formlimits.Clean(in.Reason, reportReasonMin, reportReasonMax)
	if err != nil {
		http.Error(w, "reason must be "+strconv.Itoa(reportReasonMin)+"-"+strconv.Itoa(reportReasonMax)+" characters", http.StatusBadRequest)
		return
	}
	if in.MessageId <= 0 {
		http.Error(w, "Invalid message", http.StatusBadRequest)
		return
	}
	if n, err := rdb.Exists(ctx, fmt.Sprintf("messages:%d", in.MessageId)).Result(); err != nil || n == 0 {
		http.Error(w, "Message not found", http.StatusNotFound)
		return
	}

	reporter := s.ID
	if reporter == "" {
		reporter = s.Email
	}
	for _, c := range []struct {
		key   string
		rules []formlimits.Rule
	}{{"report:user:" + reporter, reportUserRules}, {"report:ip:" + clientIP(r), reportIPRules}, {"report:all", reportAllRules}} {
		allowed, broken, err := formLimiter.Allow(c.key, c.rules...)
		if err != nil {
			log.Println("report rate limit counter:", err)
		}
		if !allowed {
			log.Printf("report refused: too many (%s, rule %s)", c.key, broken.Name)
			http.Error(w, "too many reports, try again later", http.StatusTooManyRequests)
			return
		}
	}
	// The same account reports the same message only once a day.
	if fresh, err := rdb.SetNX(ctx, fmt.Sprintf("report:seen:%s:%d", reporter, in.MessageId), 1, 24*time.Hour).Result(); err == nil && !fresh {
		http.Error(w, "already reported", http.StatusConflict)
		return
	}

	report := Report{MessageId: in.MessageId, Reason: reason, CreatedAt: time.Now(), ReporterID: s.ID, ReportedEmail: s.Email, ReporterName: s.Username}
	if err := dbReportMessage(ctx, &report); err != nil {
		log.Println("Error saving report:", err)
		http.Error(w, "Error saving report", http.StatusInternalServerError)
		return
	}

	var response Response
	response.Success = true
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func getReports(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	status := ReportStatus(r.URL.Query().Get("status"))
	if !status.IsValid() {
		http.Error(w, "Invalid status", http.StatusBadRequest)
		return
	}

	reports, err := dbGetReports(ctx, status)
	if err != nil {
		log.Printf("Error retrieving reports: %v\n", err)
		http.Error(w, "Error retrieving reports", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(reports)
}

func setReports(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	defer r.Body.Close()
	var report Report
	if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	report.UpdatedAt = time.Now()

	if err := dbSetReports(ctx, &report); err != nil {
		http.Error(w, "Error saving reports", http.StatusInternalServerError)
		return
	}

	var response Response
	response.Success = true
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

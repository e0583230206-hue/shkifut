package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	stdmime "mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi"
	"github.com/redis/go-redis/v9"
)

func isStaff(r *http.Request) bool {
	s, ok := myUser(r)
	if !ok {
		return false
	}
	p := currentPrivileges(s)
	return p[Admin] || p[Moderator] || p[Reviewer] || p[Writer]
}
func protectedWithStaff(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		if !isStaff(r) {
			http.Error(w, "staff only", http.StatusForbidden)
			return
		}
		h(w, r)
	}
}
func staffName(email string) string {
	if v, ok := privilegesUsers.Load(email); ok {
		u := v.(User)
		if strings.TrimSpace(u.PublicName) != "" {
			return u.PublicName
		}
		if u.Username != "" {
			return u.Username
		}
	}
	return "איש צוות"
}

type staffFile struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Mime  string `json:"mime"`
	Size  int64  `json:"size"`
	Owner string `json:"-"`
}
type staffMessage struct {
	ID    int64       `json:"id"`
	Text  string      `json:"text"`
	At    string      `json:"at"`
	Name  string      `json:"name"`
	Mine  bool        `json:"mine"`
	Files []staffFile `json:"files"`
}

var staffFileID = regexp.MustCompile(`^[0-9a-f]{32}$`)
var staffFilesMu sync.Mutex

func staffIdentity(r *http.Request) string { s, _ := myUser(r); return personalKey(s, "staff") }
func staffFileKey(id string) string        { return "staff:file:" + id }
func staffFilePath(id string) string       { return filepath.Join(rootUploadPath, "staff", id) }
func staffUnread(ctx context.Context, identity string) (int64, error) {
	seen, err := rdb.Get(ctx, identity+":seen").Int64()
	if err != nil && err != redis.Nil {
		return 0, err
	}
	min := "(" + strconv.FormatInt(seen, 10)
	total, err := rdb.ZCount(ctx, "staff:messages", min, "+inf").Result()
	if err != nil {
		return 0, err
	}
	own, err := rdb.ZCount(ctx, identity+":sent", min, "+inf").Result()
	if err != nil {
		return 0, err
	}
	return max(int64(0), total-own), nil
}
func staffSummary(w http.ResponseWriter, r *http.Request) {
	n, err := staffUnread(r.Context(), staffIdentity(r))
	if err != nil {
		http.Error(w, "unavailable", 500)
		return
	}
	latest, _ := rdb.Get(r.Context(), "staff:next").Int64()
	writeJSON(w, map[string]int64{"unread": n, "latest": latest})
}
func getStaffMessages(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	q := &redis.ZRangeBy{Min: "-inf", Max: "+inf", Count: 50}
	if before > 0 {
		q.Max = "(" + strconv.FormatInt(before, 10)
	}
	var ids []string
	var err error
	if after > 0 {
		q.Min = "(" + strconv.FormatInt(after, 10)
		ids, err = rdb.ZRangeByScore(ctx, "staff:messages", q).Result()
	} else {
		ids, err = rdb.ZRevRangeByScore(ctx, "staff:messages", q).Result()
	}
	if err != nil {
		http.Error(w, "unavailable", 500)
		return
	}
	out := []staffMessage{}
	identity := staffIdentity(r)
	for _, id := range ids {
		h, e := rdb.HGetAll(ctx, "staff:message:"+id).Result()
		if e != nil {
			http.Error(w, "unavailable", 500)
			return
		}
		if len(h) == 0 {
			continue
		}
		n, _ := strconv.ParseInt(id, 10, 64)
		m := staffMessage{ID: n, Text: h["text"], At: h["at"], Name: staffName(h["by"]), Mine: h["owner"] == identity, Files: []staffFile{}}
		if h["files"] != "" {
			json.Unmarshal([]byte(h["files"]), &m.Files)
		}
		out = append(out, m)
	}
	if after == 0 {
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	writeJSON(w, out)
}
func sendStaffMessage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	var req struct {
		Text  string   `json:"text"`
		Files []string `json:"files"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil || len(req.Files) > 4 {
		http.Error(w, "invalid message", 400)
		return
	}
	text, ok := cleanText(req.Text, 2000)
	if !ok && (strings.TrimSpace(req.Text) != "" || len(req.Files) == 0) {
		http.Error(w, "invalid text", 400)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	staffFilesMu.Lock()
	defer staffFilesMu.Unlock()
	files := []staffFile{}
	identity := staffIdentity(r)
	seen := map[string]bool{}
	for _, id := range req.Files {
		if !staffFileID.MatchString(id) || seen[id] {
			http.Error(w, "invalid attachment", 400)
			return
		}
		seen[id] = true
		h, err := rdb.HGetAll(ctx, staffFileKey(id)).Result()
		if err != nil {
			http.Error(w, "unavailable", 500)
			return
		}
		if h["owner"] != identity || h["used"] == "1" {
			http.Error(w, "attachment unavailable", 404)
			return
		}
		if _, err = os.Stat(staffFilePath(id)); err != nil {
			http.Error(w, "attachment unavailable", 404)
			return
		}
		size, _ := strconv.ParseInt(h["size"], 10, 64)
		files = append(files, staffFile{ID: id, Name: h["name"], Mime: h["mime"], Size: size})
	}
	id, err := rdb.Incr(ctx, "staff:next").Result()
	if err != nil {
		http.Error(w, "unavailable", 500)
		return
	}
	s, _ := myUser(r)
	at := nowText()
	raw, _ := json.Marshal(files)
	sid := strconv.FormatInt(id, 10)
	pipe := rdb.TxPipeline()
	pipe.HSet(ctx, "staff:message:"+sid, "text", text, "by", s.Email, "owner", identity, "at", at, "files", string(raw))
	pipe.ZAdd(ctx, "staff:messages", redis.Z{Score: float64(id), Member: sid})
	pipe.ZAdd(ctx, identity+":sent", redis.Z{Score: float64(id), Member: sid})
	for _, f := range files {
		pipe.HSet(ctx, staffFileKey(f.ID), "used", "1")
		pipe.ZRem(ctx, "staff:pending-files", f.ID)
	}
	if _, err = pipe.Exec(ctx); err != nil {
		http.Error(w, "could not save", 500)
		return
	}
	writeJSON(w, staffMessage{ID: id, Text: text, At: at, Name: staffName(s.Email), Mine: true, Files: files})
}

var staffSeenScript = redis.NewScript(`local last=tonumber(redis.call('GET','staff:next') or '0'); local n=math.min(tonumber(ARGV[1]),last); local old=tonumber(redis.call('GET',KEYS[1]) or '0'); if n>old then redis.call('SET',KEYS[1],n) end; return 1`)

func markStaffSeen(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var req struct {
		UpTo int64 `json:"upTo"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil || req.UpTo < 0 {
		http.Error(w, "invalid request", 400)
		return
	}
	if staffSeenScript.Run(r.Context(), rdb, []string{staffIdentity(r) + ":seen"}, req.UpTo).Err() != nil {
		http.Error(w, "unavailable", 500)
		return
	}
	writeJSON(w, Response{Success: true})
}
func uploadStaffFile(w http.ResponseWriter, r *http.Request) {
	const maxSize = int64(25 << 20)
	r.Body = http.MaxBytesReader(w, r.Body, maxSize+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		http.Error(w, "file too large", 413)
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, h, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file required", 400)
		return
	}
	defer f.Close()
	if h.Size <= 0 || h.Size > maxSize {
		http.Error(w, "file too large", 413)
		return
	}
	random := make([]byte, 16)
	if _, err = rand.Read(random); err != nil {
		http.Error(w, "unavailable", 500)
		return
	}
	id := hex.EncodeToString(random)
	if err = os.MkdirAll(filepath.Join(rootUploadPath, "staff"), 0700); err != nil {
		http.Error(w, "unavailable", 500)
		return
	}
	out, err := os.OpenFile(staffFilePath(id), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		http.Error(w, "unavailable", 500)
		return
	}
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	mime := http.DetectContentType(head[:n])
	_, err = out.Write(head[:n])
	var written int64
	if err == nil {
		written, err = io.Copy(out, io.LimitReader(f, maxSize-int64(n)+1))
	}
	closeErr := out.Close()
	if err != nil || closeErr != nil || written+int64(n) > maxSize {
		os.Remove(staffFilePath(id))
		http.Error(w, "could not save file", 400)
		return
	}
	name := filepath.Base(strings.ReplaceAll(h.Filename, "\\", "/"))
	if len([]rune(name)) > 150 {
		name = string([]rune(name)[:150])
	}
	file := staffFile{ID: id, Name: name, Mime: mime, Size: written + int64(n)}
	pipe := rdb.TxPipeline()
	pipe.HSet(r.Context(), staffFileKey(id), "name", name, "mime", mime, "size", file.Size, "owner", staffIdentity(r), "used", "0")
	pipe.ZAdd(r.Context(), "staff:pending-files", redis.Z{Score: float64(time.Now().Unix()), Member: id})
	if _, err = pipe.Exec(r.Context()); err != nil {
		os.Remove(staffFilePath(id))
		http.Error(w, "could not save file", 500)
		return
	}
	writeJSON(w, file)
}
func serveStaffFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !staffFileID.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	h, err := rdb.HGetAll(r.Context(), staffFileKey(id)).Result()
	if err != nil || len(h) == 0 || (h["used"] != "1" && h["owner"] != staffIdentity(r)) {
		http.NotFound(w, r)
		return
	}
	mime := h["mime"]
	inline := mime == "image/jpeg" || mime == "image/png" || mime == "image/gif" || mime == "image/webp" || mime == "video/mp4" || mime == "video/webm" || strings.HasPrefix(mime, "audio/")
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	disposition := "attachment"
	if inline {
		disposition = "inline"
	}
	w.Header().Set("Content-Disposition", stdmime.FormatMediaType(disposition, map[string]string{"filename": h["name"]}))
	f, err := os.Open(staffFilePath(id))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	http.ServeContent(w, r, "", time.Time{}, f)
}

// Separate lifecycle: ordinary channel media cleanup never sees these files.
func cleanupStaffUploads() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	staffFilesMu.Lock()
	defer staffFilesMu.Unlock()
	ids, err := rdb.ZRangeByScore(ctx, "staff:pending-files", &redis.ZRangeBy{Min: "-inf", Max: strconv.FormatInt(time.Now().Add(-24*time.Hour).Unix(), 10), Count: 500}).Result()
	if err != nil {
		return
	}
	for _, id := range ids {
		if !staffFileID.MatchString(id) {
			continue
		}
		used, err := rdb.HGet(ctx, staffFileKey(id), "used").Result()
		if err != nil && err != redis.Nil {
			continue
		}
		if used == "1" {
			rdb.ZRem(ctx, "staff:pending-files", id)
			continue
		}
		if err = os.Remove(staffFilePath(id)); err == nil || os.IsNotExist(err) {
			rdb.Del(ctx, staffFileKey(id))
			rdb.ZRem(ctx, "staff:pending-files", id)
		}
	}
}
func startStaffCleanup() {
	go func() {
		for {
			cleanupStaffUploads()
			time.Sleep(time.Hour)
		}
	}()
}

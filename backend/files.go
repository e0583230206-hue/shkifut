package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi"
	"github.com/h2non/filetype"
	"github.com/subosito/gozaru"
	"gopkg.in/yaml.v3"
)

var rootUploadPath = "/app/files/"

type FileResponse struct {
	URL      string `json:"url"`
	Filename string `json:"filename"`
	FileType string `json:"filetype"`
}

var maxBytesReader *http.MaxBytesError

func stripExtension(id string) string {
	if i := strings.IndexByte(id, '.'); i >= 0 {
		return id[:i]
	}
	return id
}

// pendingPlaceholder is served to readers while a file has no blurred version yet.
const pendingPlaceholder = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">` +
	`<rect width="640" height="360" fill="#9aa0a6"/>` +
	`<text x="320" y="190" font-family="sans-serif" font-size="40" fill="#fff" text-anchor="middle" direction="rtl">ממתין לאישור</text></svg>`

func setPrivateCacheHeaders(w http.ResponseWriter, etag string) {
	// Same URL returns different content per user (original vs blurred): never let shared caches store it.
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Vary", "Cookie")
	w.Header().Set("ETag", `"`+etag+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func detectMime(meta map[string]any, filePath string) string {
	if m := metaString(meta, "mime"); m != "" {
		return m
	}
	f, err := os.Open(filePath)
	if err != nil {
		return "application/octet-stream"
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := f.Read(head)
	if t, err := filetype.Match(head[:n]); err == nil && t != filetype.Unknown {
		return t.MIME.Value
	}
	return http.DetectContentType(head[:n])
}

func serveFile(w http.ResponseWriter, r *http.Request) {
	fileId := stripExtension(chi.URLParam(r, "fileid"))

	metaData, err := readMetadata(fileId)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	if deleted, _ := metaData["delete"].(bool); deleted {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	fileHash, ok := metaHash(metaData)
	if !ok {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	filePath := filepath.Join(rootUploadPath, fileHash[:2], fileHash[2:4], fileHash)
	originalFileName := metaString(metaData, "filename")
	kind := metaString(metaData, "type")

	if isModeratedType(kind) {
		status := metaString(metaData, "moderation")
		if status == "" { // uploaded before moderation existed
			go markLegacyPending(fileId)
			status = ModPending
		}
		// Server-side enforcement: only moderators get the original of a non-open file.
		// ?view=public lets a moderator see exactly what readers see.
		if status != ModOpen && (!checkPrivilege(r, Moderator) || r.URL.Query().Get("view") == "public") {
			switch publicVariant(metaData) {
			case VariantRegional:
				serveRegional(w, r, fileHash, kind)
				return
			case VariantBlurred:
				serveBlurred(w, r, fileHash)
				return
			}
		}
	}

	f, err := os.Open(filePath)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	setPrivateCacheHeaders(w, "o-"+fileHash)
	w.Header().Set("Content-Type", detectMime(metaData, filePath))
	w.Header().Set("Content-Disposition", `inline; filename*=UTF-8''`+url.PathEscape(originalFileName))
	http.ServeContent(w, r, "", time.Time{}, f) // handles Range / If-None-Match
}

func serveRegional(w http.ResponseWriter, r *http.Request, fileHash, kind string) {
	f, err := os.Open(filepath.Join(rootBlurredPath, regionalRelPath(fileHash, kind)))
	if err != nil {
		serveBlurred(w, r, fileHash)
		return
	}
	defer f.Close()
	setPrivateCacheHeaders(w, "r-"+fileHash)
	if kind == "video" {
		w.Header().Set("Content-Type", "video/mp4")
	} else {
		w.Header().Set("Content-Type", "image/jpeg")
	}
	w.Header().Set("Content-Disposition", "inline")
	http.ServeContent(w, r, "", time.Time{}, f) // Range support for the video
}

func serveBlurred(w http.ResponseWriter, r *http.Request, fileHash string) {
	f, err := os.Open(filepath.Join(rootBlurredPath, blurredRelPath(fileHash)))
	if err != nil {
		setPrivateCacheHeaders(w, "p")
		w.Header().Set("Content-Type", "image/svg+xml")
		http.ServeContent(w, r, "", time.Time{}, strings.NewReader(pendingPlaceholder))
		return
	}
	defer f.Close()
	setPrivateCacheHeaders(w, "b-"+fileHash)
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Content-Disposition", "inline")
	http.ServeContent(w, r, "", time.Time{}, f)
}

func uploadFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, int64(settingConfig.MaxFileSize)<<20)

	file, handler, err := r.FormFile("file")
	if err != nil {
		if errors.As(err, &maxBytesReader) {
			http.Error(w, "File too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "error", http.StatusBadRequest)
		return
	}
	defer file.Close()

	if err := os.MkdirAll(rootUploadPath, os.ModePerm); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	head := make([]byte, 512)
	file.Read(head)

	t, _ := filetype.Match(head)

	file.Seek(0, io.SeekStart)
	fileHash, err := generatedFileHash(file)
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	hashSubDir := filepath.Join(rootUploadPath, fileHash[:2], fileHash[2:4])
	if err := os.MkdirAll(hashSubDir, os.ModePerm); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	var isDuplicateFile bool
	testISDuplicateFilePath := filepath.Join(hashSubDir, fileHash)
	_, err = os.Stat(testISDuplicateFilePath)
	if err == nil { //|| !os.IsNotExist(err)
		isDuplicateFile = true
	}

	if !isDuplicateFile {
		destPath := filepath.Join(hashSubDir, fileHash)

		file.Seek(0, io.SeekStart)
		destFile, err := os.Create(destPath)
		if err != nil {
			http.Error(w, "error", http.StatusInternalServerError)
			return
		}
		defer destFile.Close()

		if _, err := io.Copy(destFile, file); err != nil {
			http.Error(w, "error", http.StatusInternalServerError)
			return
		}
	}

	id := generatedRandomID(20)
	if id == "" {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	yamlFileDir := filepath.Join(rootUploadPath, id[:2], id[2:4])
	if err := os.MkdirAll(yamlFileDir, os.ModePerm); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	safeFilename := gozaru.Sanitize(handler.Filename)

	fileMetadata := map[string]any{
		"id":       id,
		"filename": safeFilename,
		"hash":     fileHash,
		"type":     t.MIME.Type,
		"mime":     t.MIME.Value,
		"delete":   false,
	}
	if isModeratedType(t.MIME.Type) {
		fileMetadata["moderation"] = ModPending
	}
	metadataFilePath := filepath.Join(rootUploadPath, id[:2], id[2:4], id+".yaml")
	metadataFile, err := os.Create(metadataFilePath)
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	defer metadataFile.Close()

	yamlData, err := yaml.Marshal(fileMetadata)
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	if _, err := metadataFile.Write(yamlData); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	metadataFile.Close()

	if isModeratedType(t.MIME.Type) {
		enqueueModeration(id)
	}

	// The extension is cosmetic (serveFile strips it) but helps proxies and players pick the right handler.
	fileUrl := "/api/files/" + id
	if t != filetype.Unknown && t.Extension != "" {
		fileUrl += "." + t.Extension
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(FileResponse{
		URL:      fileUrl,
		Filename: handler.Filename,
		FileType: t.MIME.Type,
	})
}

func generatedFileHash(file io.Reader) (string, error) {
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}

func generatedRandomID(len int) string {
	b := make([]byte, len)
	_, err := rand.Read(b)
	if err != nil {
		return ""
	}

	return hex.EncodeToString(b)
}

// TODO: Image size limitation
func getFavicon(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c, err := getChannelDetails(ctx)
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}

	logoUrl := c["logoUrl"]
	if logoUrl == "" {
		logoUrl = "assets/favicon.ico"
	}
	fileId := stripExtension(path.Base(logoUrl))

	metaData, err := readMetadata(fileId)
	if err != nil {
		http.ServeFile(w, r, "assets/favicon.ico")
		return
	}

	if deleted, _ := metaData["delete"].(bool); deleted {
		http.ServeFile(w, r, "assets/favicon.ico")
		return
	}

	fileHash, ok := metaHash(metaData)
	if !ok {
		http.ServeFile(w, r, "assets/favicon.ico")
		return
	}
	filePath := filepath.Join(rootUploadPath, fileHash[:2], fileHash[2:4], fileHash)

	http.ServeFile(w, r, filePath)
}

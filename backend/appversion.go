package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// The version of the site as a reader's browser sees it: a hash of index.html, which names the hashed script files of the app, so it changes
// exactly when the frontend changes (a deployment of the backend alone does not make readers refresh). renderIndex puts it into the page
// (<meta name="app-version">), and the page asks /api/version now and then: when the two differ, it offers to refresh.
var (
	appVersionOnce sync.Once
	appVersionVal  string
)

func appVersion() string {
	appVersionOnce.Do(func() {
		content, err := os.ReadFile(filepath.Join(settingConfig.RootStaticFolder, "index.html"))
		if err != nil {
			return
		}
		sum := sha256.Sum256(content)
		appVersionVal = hex.EncodeToString(sum[:])[:12]
	})
	return appVersionVal
}

func getAppVersion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]string{"version": appVersion()})
}

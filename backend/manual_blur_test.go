package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// These tests need no Redis and no moderation service: they use temporary folders for the files.
//   go test -run Manual .   (needs any Redis: see moderation/README.md, MANUAL_BLUR)

const (
	testID   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func manualTestSetup(t *testing.T, enabled bool) (upload, blurred string) {
	t.Helper()
	oldUp, oldBl, oldEn, oldStrict := rootUploadPath, rootBlurredPath, manualBlurEnabled, strictUntilReviewed
	t.Cleanup(func() {
		rootUploadPath, rootBlurredPath, manualBlurEnabled, strictUntilReviewed = oldUp, oldBl, oldEn, oldStrict
	})
	rootUploadPath, rootBlurredPath = t.TempDir(), t.TempDir()
	manualBlurEnabled, strictUntilReviewed = enabled, false
	return rootUploadPath, rootBlurredPath
}

func writeTestFile(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func imageMeta(status string) map[string]any {
	return map[string]any{"type": "image", "mime": "image/jpeg", "hash": testHash, "moderation": status,
		"autoDecision": status, "autoCheckedAt": "2026-10-25T10:00:00Z", "modGen": 1}
}

// saveManual puts a manual version on the current base, the way setManualBlur does.
func saveManual(t *testing.T, meta map[string]any) {
	t.Helper()
	b := manualBaseOf(meta)
	if !b.OK {
		t.Fatalf("base not available: %s", b.Reason)
	}
	writeTestFile(t, manualAbsPath(testID))
	meta[manualBlurMetaKey] = map[string]any{"shapes": []any{map[string]any{"type": "rect", "x": 0.1, "y": 0.1, "w": 0.3, "h": 0.3}},
		"by": "owner@example.com", "sig": manualSignature(meta, b)}
}

func TestManualBaseOfFollowsTheAutomaticResult(t *testing.T) {
	up, bl := manualTestSetup(t, true)
	writeTestFile(t, filepath.Join(up, testHash[:2], testHash[2:4], testHash))

	if b := manualBaseOf(imageMeta(ModOpen)); !b.OK || b.Base.Kind != "original" || b.Root != "files" {
		t.Errorf("open: %+v", b)
	}
	reg := imageMeta(ModRegional)
	if b := manualBaseOf(reg); b.OK || b.Reason != "no_regional_version" {
		t.Errorf("regional without the regional picture and with something to hide must not be available: %+v", b)
	}
	writeTestFile(t, filepath.Join(bl, regionalRelPath(testHash, "image")))
	if b := manualBaseOf(reg); !b.OK || b.Base.Kind != "regional" || b.Root != "blurred" {
		t.Errorf("regional: %+v", b)
	}
	// "regional" because nothing was found to hide, and no regional picture: the original is the base
	nothing := imageMeta(ModRegional)
	nothing["autoDecision"] = ModOpen
	os.Remove(filepath.Join(bl, regionalRelPath(testHash, "image")))
	if b := manualBaseOf(nothing); !b.OK || b.Base.Kind != "original" {
		t.Errorf("regional with nothing hidden: %+v", b)
	}
	for _, st := range []string{ModBlurred, ModPending, ""} {
		if b := manualBaseOf(imageMeta(st)); b.OK || b.Reason != "fully_blurred" {
			t.Errorf("status %q: a fully blurred file must not be editable: %+v", st, b)
		}
	}
}

func TestManualBaseOfRefusesWhatItCannotEdit(t *testing.T) {
	up, _ := manualTestSetup(t, true)
	writeTestFile(t, filepath.Join(up, testHash[:2], testHash[2:4], testHash))
	gif := imageMeta(ModOpen)
	gif["mime"] = "image/gif"
	if b := manualBaseOf(gif); b.OK || b.Reason != "unsupported_format" {
		t.Errorf("gif: %+v", b)
	}
	video := imageMeta(ModOpen)
	video["type"] = "video"
	if b := manualBaseOf(video); b.OK || b.Reason != "not_image" {
		t.Errorf("video: %+v", b)
	}
	strictUntilReviewed = true
	if b := manualBaseOf(imageMeta(ModRegional)); b.OK || b.Reason != "unreviewed" {
		t.Errorf("STRICT_UNTIL_REVIEWED with people found and nobody reviewed: %+v", b)
	}
}

func TestManualReplacesOnlyOriginalOrRegionalAndOnlyWhileValid(t *testing.T) {
	up, bl := manualTestSetup(t, true)
	writeTestFile(t, filepath.Join(up, testHash[:2], testHash[2:4], testHash))
	meta := imageMeta(ModOpen)
	if v := baseVariant(meta, testID); v != VariantOriginal {
		t.Fatalf("no manual blur yet: %s", v)
	}
	saveManual(t, meta)
	if v := baseVariant(meta, testID); v != VariantManual {
		t.Errorf("valid manual version on an open file: %s", v)
	}
	if v := baseVariantAuto(meta); v != VariantOriginal {
		t.Errorf("the base for the editor must ignore the manual version: %s", v)
	}

	// flag off: nothing is served, even with a saved version
	manualBlurEnabled = false
	if v := baseVariant(meta, testID); v != VariantOriginal {
		t.Errorf("flag off must serve the automatic version: %s", v)
	}
	manualBlurEnabled = true

	// the file of the manual version is gone
	os.Remove(manualAbsPath(testID))
	if v := baseVariant(meta, testID); v != VariantOriginal {
		t.Errorf("missing manual file: %s", v)
	}
	saveManual(t, meta)

	// a regional file: the manual version sits on the regional picture
	reg := imageMeta(ModRegional)
	writeTestFile(t, filepath.Join(bl, regionalRelPath(testHash, "image")))
	saveManual(t, reg)
	if v := baseVariant(reg, testID); v != VariantManual {
		t.Errorf("regional + manual: %s", v)
	}
}

// The safety rule: a manual version made on one automatic result must not be shown once that result has changed.
func TestManualBecomesStaleWhenTheAutomaticResultChanges(t *testing.T) {
	up, bl := manualTestSetup(t, true)
	writeTestFile(t, filepath.Join(up, testHash[:2], testHash[2:4], testHash))
	regional := filepath.Join(bl, regionalRelPath(testHash, "image"))
	writeTestFile(t, regional)
	meta := imageMeta(ModRegional)
	saveManual(t, meta)
	if v := baseVariant(meta, testID); v != VariantManual {
		t.Fatalf("setup: %s", v)
	}

	changes := map[string]func(m map[string]any){
		"check again / saved correction":     func(m map[string]any) { m["modGen"] = 2 },
		"new automatic check":                func(m map[string]any) { m["autoCheckedAt"] = "2026-10-25T12:00:00Z" },
		"manual decision: open":              func(m map[string]any) { m["moderation"] = ModOpen },
		"manual decision again, same status": func(m map[string]any) { m["reviewedAt"] = "2026-10-25T12:30:00Z" },
		"manual decision: blurred":           func(m map[string]any) { m["moderation"] = ModBlurred },
		"regional picture regenerated": func(m map[string]any) {
			later := time.Now().Add(time.Hour)
			os.Chtimes(regional, later, later)
		},
	}
	for name, change := range changes {
		m := imageMeta(ModRegional)
		saveManual(t, m)
		if baseVariant(m, testID) != VariantManual {
			t.Fatalf("%s: setup", name)
		}
		change(m)
		if v := baseVariant(m, testID); v == VariantManual {
			t.Errorf("%s: a stale manual version is still served", name)
		}
		if manualValid(m, testID) {
			t.Errorf("%s: still valid", name)
		}
		info := manualInfoFor(m, testID)
		if info.Active || !info.Stale {
			t.Errorf("%s: info should say stale: %+v", name, info)
		}
		os.Chtimes(regional, time.Now().Add(-time.Hour), time.Now().Add(-time.Hour)) // back to the same version for the next case
	}
}

func TestManualNeverOverridesBlurredOrHidden(t *testing.T) {
	up, _ := manualTestSetup(t, true)
	writeTestFile(t, filepath.Join(up, testHash[:2], testHash[2:4], testHash))
	meta := imageMeta(ModOpen)
	saveManual(t, meta)
	for _, v := range []string{VariantBlurred, VariantHidden} {
		if got := manualOr(meta, testID, v); got != v {
			t.Errorf("%s was replaced by %s", v, got)
		}
	}
}

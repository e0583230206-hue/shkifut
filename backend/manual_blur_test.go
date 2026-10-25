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

// From scratch: the base is always the original, whatever the automatic check decided.
func TestManualBaseIsAlwaysTheOriginal(t *testing.T) {
	up, bl := manualTestSetup(t, true)
	writeTestFile(t, filepath.Join(up, testHash[:2], testHash[2:4], testHash))
	writeTestFile(t, filepath.Join(bl, regionalRelPath(testHash, "image")))
	for _, st := range []string{ModOpen, ModRegional, ModBlurred, ModPending, ""} {
		b := manualBaseOf(imageMeta(st))
		if !b.OK || b.Base.Kind != "original" || b.Root != "files" {
			t.Errorf("status %q: %+v", st, b)
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
	audio := imageMeta(ModOpen)
	audio["type"] = "audio"
	if b := manualBaseOf(audio); b.OK || b.Reason != "not_image" {
		t.Errorf("audio: %+v", b)
	}
	videoWithPictureMime := imageMeta(ModOpen) // the video tool needs a video
	videoWithPictureMime["type"] = "video"
	if b := manualBaseOf(videoWithPictureMime); b.OK || b.Reason != "unsupported_format" {
		t.Errorf("video with a picture mime: %+v", b)
	}
	// the strict modes and the automatic result do not stop a moderator who decides for himself
	strictUntilReviewed = true
	people := imageMeta(ModBlurred)
	people["autoNeedsReview"] = true
	if b := manualBaseOf(people); !b.OK {
		t.Errorf("STRICT_UNTIL_REVIEWED must not stop a manual blur from scratch: %+v", b)
	}
}

func TestManualReplacesTheAutomaticResultWhileValid(t *testing.T) {
	up, bl := manualTestSetup(t, true)
	writeTestFile(t, filepath.Join(up, testHash[:2], testHash[2:4], testHash))
	writeTestFile(t, filepath.Join(bl, regionalRelPath(testHash, "image")))
	meta := imageMeta(ModOpen)
	if v := baseVariant(meta, testID); v != VariantOriginal {
		t.Fatalf("no manual blur yet: %s", v)
	}
	saveManual(t, meta)
	if v := baseVariant(meta, testID); v != VariantManual {
		t.Errorf("valid manual version on an open file: %s", v)
	}
	if v := baseVariantAuto(meta); v != VariantOriginal {
		t.Errorf("the automatic result is not changed by it: %s", v)
	}
	// it replaces whatever the automatic check decided: regional, fully blurred, still being checked
	for _, st := range []string{ModRegional, ModBlurred, ModPending} {
		m := imageMeta(st)
		saveManual(t, m)
		if v := baseVariant(m, testID); v != VariantManual {
			t.Errorf("status %s: %s", st, v)
		}
		if v := baseVariantAuto(m); v == VariantManual {
			t.Errorf("status %s: the automatic variant must stay automatic", st)
		}
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
}

// The automatic result does not matter to a manual version drawn from scratch; a later decision by hand, or a changed original, does.
func TestManualSurvivesAutomaticChangesAndYieldsToALaterDecision(t *testing.T) {
	up, _ := manualTestSetup(t, true)
	original := filepath.Join(up, testHash[:2], testHash[2:4], testHash)
	writeTestFile(t, original)
	keeps := map[string]func(m map[string]any){
		"check again (modGen)":      func(m map[string]any) { m["modGen"] = 2 },
		"a new automatic check":     func(m map[string]any) { m["autoCheckedAt"] = "2026-10-25T12:00:00Z"; m["autoDecision"] = ModBlurred },
		"the automatic status":      func(m map[string]any) { m["moderation"] = ModBlurred },
		"the automatic status, 2nd": func(m map[string]any) { m["moderation"] = ModRegional },
	}
	for name, change := range keeps {
		m := imageMeta(ModOpen)
		saveManual(t, m)
		change(m)
		if baseVariant(m, testID) != VariantManual || !manualValid(m, testID) {
			t.Errorf("%s: the manual version must stay (the automatic result is irrelevant)", name)
		}
	}
	yields := map[string]func(m map[string]any){
		"open by hand":     func(m map[string]any) { m["moderation"] = ModOpen; m["reviewedAt"] = "2026-10-25T12:30:00Z" },
		"blurred by hand":  func(m map[string]any) { m["moderation"] = ModBlurred; m["reviewedAt"] = "2026-10-25T12:30:00Z" },
		"regional by hand": func(m map[string]any) { m["moderation"] = ModRegional; m["reviewedAt"] = "2026-10-25T12:30:00Z" },
		"the same decision again": func(m map[string]any) {
			m["reviewedAt"] = "2026-10-25T13:00:00Z"
		},
	}
	for name, change := range yields {
		m := imageMeta(ModOpen)
		saveManual(t, m)
		change(m)
		if v := baseVariant(m, testID); v == VariantManual || manualValid(m, testID) {
			t.Errorf("%s: a decision made after the manual blur must win (served %s)", name, v)
		}
		info := manualInfoFor(m, testID)
		if info.Active || !info.Stale {
			t.Errorf("%s: info should say stale: %+v", name, info)
		}
	}
	// a decision by hand that was made BEFORE the manual blur does not stop it
	before := imageMeta(ModBlurred)
	before["reviewedAt"] = "2026-10-25T09:00:00Z"
	saveManual(t, before)
	if baseVariant(before, testID) != VariantManual {
		t.Error("a decision made before the manual blur must not cancel it")
	}
	// the original changed (a new upload with the same id is not possible, but the file version is part of the signature)
	m := imageMeta(ModOpen)
	saveManual(t, m)
	later := time.Now().Add(time.Hour)
	os.Chtimes(original, later, later)
	if manualValid(m, testID) {
		t.Error("the original changed: the manual version must not be served")
	}
}

// A video that waits for approval is hidden from readers before the manual version is asked about.
func TestManualDoesNotBypassTheHoldOfAVideo(t *testing.T) {
	up, _ := manualTestSetup(t, true)
	writeTestFile(t, filepath.Join(up, testHash[:2], testHash[2:4], testHash))
	manualBlurVideoEnabled = true
	oldHold := holdVideos
	holdVideos = true
	defer func() { holdVideos, manualBlurVideoEnabled = oldHold, false }()
	meta := imageMeta(ModOpen)
	meta["type"], meta["mime"], meta["holdRequired"] = "video", "video/mp4", true
	b := manualBaseOf(meta)
	writeTestFile(t, filepath.Join(rootBlurredPath, manualVideoRelPath(testID)))
	meta[manualBlurMetaKey] = map[string]any{"sig": manualSignature(meta, b), "rev": "r"}
	if v := publicVariant(meta, testID); v != VariantHidden {
		t.Errorf("a held video must stay hidden, even with a manual version: %s", v)
	}
	meta["approvedAt"] = "2026-10-25T10:00:00Z"
	if v := publicVariant(meta, testID); v != VariantManual {
		t.Errorf("once approved, readers get the manual version: %s", v)
	}
}

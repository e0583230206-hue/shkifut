package mediadims

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func box(typ string, body ...[]byte) []byte {
	payload := bytes.Join(body, nil)
	out := make([]byte, 8, 8+len(payload))
	binary.BigEndian.PutUint32(out[0:4], uint32(8+len(payload)))
	copy(out[4:8], typ)
	return append(out, payload...)
}

// tkhd builds a version 0 track header with a 16.16 size and a matrix (a, d = 0x10000 for no rotation, 0 for 90 degrees).
func tkhd(w, h uint32, rotated bool) []byte {
	b := make([]byte, 4+4+4+4+4+4+8+2+2+2+2+36+8)
	skip := 4 + 4 + 4 + 4 + 4 + 4 + 8 + 2 + 2 + 2 + 2
	if rotated {
		binary.BigEndian.PutUint32(b[skip+4:], 0x10000)     // b
		binary.BigEndian.PutUint32(b[skip+12:], 0xFFFF0000) // c
	} else {
		binary.BigEndian.PutUint32(b[skip:], 0x10000)    // a
		binary.BigEndian.PutUint32(b[skip+16:], 0x10000) // d
	}
	binary.BigEndian.PutUint32(b[skip+36:], w<<16)
	binary.BigEndian.PutUint32(b[skip+40:], h<<16)
	return box("tkhd", b)
}

func write(t *testing.T, name string, data []byte) string {
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestImagePNG(t *testing.T) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 640, 360))); err != nil {
		t.Fatal(err)
	}
	if w, h := Size(write(t, "a.png", buf.Bytes()), "image"); w != 640 || h != 360 {
		t.Fatalf("got %dx%d", w, h)
	}
}

func TestMP4MoovFirst(t *testing.T) {
	data := bytes.Join([][]byte{box("ftyp", []byte("isom")), box("moov", box("trak", tkhd(848, 480, false))), box("mdat", make([]byte, 1000))}, nil)
	if w, h := Size(write(t, "a.mp4", data), "video"); w != 848 || h != 480 {
		t.Fatalf("got %dx%d", w, h)
	}
}

func TestMP4MoovLast(t *testing.T) {
	data := bytes.Join([][]byte{box("ftyp", []byte("isom")), box("mdat", make([]byte, 5000)), box("moov", box("trak", tkhd(1920, 1080, false)))}, nil)
	if w, h := Size(write(t, "a.mp4", data), "video"); w != 1920 || h != 1080 {
		t.Fatalf("got %dx%d", w, h)
	}
}

func TestMP4PhoneRotation(t *testing.T) {
	data := bytes.Join([][]byte{box("ftyp", []byte("isom")), box("moov", box("trak", tkhd(1920, 1080, true)))}, nil)
	if w, h := Size(write(t, "a.mp4", data), "video"); w != 1080 || h != 1920 {
		t.Fatalf("rotated video must be shown upright: got %dx%d", w, h)
	}
}

func TestMP4SkipsAudioTrack(t *testing.T) {
	data := bytes.Join([][]byte{box("ftyp", []byte("isom")), box("moov", box("trak", tkhd(0, 0, false)), box("trak", tkhd(640, 360, false)))}, nil)
	if w, h := Size(write(t, "a.mp4", data), "video"); w != 640 || h != 360 {
		t.Fatalf("got %dx%d", w, h)
	}
}

func TestUnreadableGivesZero(t *testing.T) {
	for name, data := range map[string][]byte{"empty.mp4": nil, "junk.mp4": []byte("not a video at all, just text"), "trunc.mp4": box("moov", []byte{1, 2})[:10]} {
		if w, h := Size(write(t, name, data), "video"); w != 0 || h != 0 {
			t.Fatalf("%s: got %dx%d", name, w, h)
		}
	}
	if w, h := Size("/no/such/file", "image"); w != 0 || h != 0 {
		t.Fatal("missing file")
	}
	if w, h := Size(write(t, "x.jpg", []byte("nope")), "image"); w != 0 || h != 0 {
		t.Fatal("bad image")
	}
}

// Real files (tests/media is not in git): sizes known from ffprobe.
func TestRealFiles(t *testing.T) {
	for name, want := range map[string][2]int{"short.mp4": {848, 478}, "protest.mp4": {478, 850}, "long.mp4": {848, 480}} {
		p := filepath.Join("..", "..", "tests", "media", name)
		if _, err := os.Stat(p); err != nil {
			t.Skip("tests/media not present")
		}
		if w, h := Size(p, "video"); w != want[0] || h != want[1] {
			t.Errorf("%s: got %dx%d, want %dx%d", name, w, h, want[0], want[1])
		}
	}
	if p := filepath.Join("..", "..", "tests", "media", "man_twain.jpg"); fileExists(p) {
		if w, h := Size(p, "image"); w <= 0 || h <= 0 {
			t.Errorf("jpeg: got %dx%d", w, h)
		}
	}
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

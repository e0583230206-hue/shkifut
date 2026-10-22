// Package mediadims reads the display size (width x height) of an uploaded image or MP4 video without decoding it, so that the page can
// reserve the right box before the file has loaded (no jumping while the page loads). It has no Redis or HTTP code and is tested alone.
package mediadims

import (
	"encoding/binary"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"os"

	_ "golang.org/x/image/webp"
)

// Size returns the display size of the file, or 0, 0 when it cannot be read (the page then falls back to a default box).
// kind is the first part of the MIME type ("image" / "video").
func Size(path, kind string) (w, h int) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	switch kind {
	case "image":
		cfg, _, err := image.DecodeConfig(f)
		if err != nil {
			return 0, 0
		}
		return cfg.Width, cfg.Height
	case "video":
		return mp4Size(f)
	}
	return 0, 0
}

const maxMoov = 32 << 20 // a moov box larger than this is not read

// mp4Size walks the top-level boxes (moov may come before or after mdat) and reads the first video track's tkhd.
func mp4Size(f *os.File) (int, int) {
	var pos int64
	for {
		size, typ, header, ok := readBox(f, pos)
		if !ok {
			return 0, 0
		}
		if typ == "moov" {
			if size > maxMoov {
				return 0, 0
			}
			buf := make([]byte, size-header)
			if _, err := f.ReadAt(buf, pos+header); err != nil && err != io.EOF {
				return 0, 0
			}
			return findVideoTrack(buf)
		}
		if size == 0 { // box runs to the end of the file
			return 0, 0
		}
		pos += size
	}
}

// readBox reads the header of the box at pos: total size, 4-letter type and header length.
func readBox(f *os.File, pos int64) (size int64, typ string, header int64, ok bool) {
	var h [16]byte
	n, err := f.ReadAt(h[:], pos)
	if n < 8 || (err != nil && err != io.EOF) {
		return 0, "", 0, false
	}
	size = int64(binary.BigEndian.Uint32(h[0:4]))
	typ = string(h[4:8])
	header = 8
	if size == 1 {
		if n < 16 {
			return 0, "", 0, false
		}
		size = int64(binary.BigEndian.Uint64(h[8:16]))
		header = 16
	}
	if size != 0 && size < header {
		return 0, "", 0, false
	}
	return size, typ, header, true
}

// children splits a container box body into (type, body) pairs.
func children(b []byte) (out []struct {
	typ  string
	body []byte
}) {
	for len(b) >= 8 {
		size := int(binary.BigEndian.Uint32(b[0:4]))
		header := 8
		if size == 1 && len(b) >= 16 {
			size = int(binary.BigEndian.Uint64(b[8:16]))
			header = 16
		}
		if size == 0 {
			size = len(b)
		}
		if size < header || size > len(b) {
			return
		}
		out = append(out, struct {
			typ  string
			body []byte
		}{string(b[4:8]), b[header:size]})
		b = b[size:]
	}
	return
}

func findVideoTrack(moov []byte) (int, int) {
	for _, trak := range children(moov) {
		if trak.typ != "trak" {
			continue
		}
		for _, c := range children(trak.body) {
			if c.typ == "tkhd" {
				if w, h := parseTkhd(c.body); w > 0 && h > 0 { // audio tracks have 0 x 0
					return w, h
				}
			}
		}
	}
	return 0, 0
}

// parseTkhd: version/flags, times, track id, duration, layer, volume, a 3x3 matrix (rotation), then width and height as 16.16 fixed point.
func parseTkhd(b []byte) (int, int) {
	if len(b) < 4 {
		return 0, 0
	}
	skip := 4 + 4 + 4 + 4 + 4 + 4 + 8 + 2 + 2 + 2 + 2 // version 0: up to the matrix
	if b[0] == 1 {
		skip += 12 // 64-bit creation, modification times and duration
	}
	if len(b) < skip+36+8 {
		return 0, 0
	}
	m := b[skip : skip+36]
	a, d := int32(binary.BigEndian.Uint32(m[0:4])), int32(binary.BigEndian.Uint32(m[16:20]))
	w := int(binary.BigEndian.Uint32(b[skip+36:]) >> 16)
	h := int(binary.BigEndian.Uint32(b[skip+40:]) >> 16)
	if a == 0 && d == 0 { // turned by 90 or 270 degrees (phone held upright): the picture is shown the other way round
		w, h = h, w
	}
	return w, h
}

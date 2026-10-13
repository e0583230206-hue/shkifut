package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// Channel-logo watermark on images served to readers. It is applied to exactly the bytes a reader gets
// (original, regional or fully blurred version), i.e. always AFTER blurring. Moderators viewing the source
// get no watermark; "?view=public" shows them the reader version, watermark included.
// Results are cached on disk per configuration (settings + logo), so a change produces fresh files.

var (
	watermarkCacheDir = filepath.Join(rootUploadPath, "_wmcache")
	watermarkLocks    sync.Map // cache path -> *sync.Mutex
	watermarkLogo     struct {
		sync.Mutex
		hash string
		img  image.Image
	}
)

type watermarkConfig struct {
	position string  // top-left | top-right | bottom-left | bottom-right | center
	size     float64 // logo width as a share of the image width
	opacity  float64 // 0..1
	margin   float64 // share of the image width
	logoHash string
	logoPath string
}

var watermarkPositions = map[string]bool{"top-left": true, "top-right": true, "bottom-left": true, "bottom-right": true, "center": true}

// currentWatermark returns the active configuration, or nil when the watermark is off or there is no logo.
func currentWatermark(ctx context.Context) *watermarkConfig {
	if !settingConfig.WatermarkEnabled {
		return nil
	}
	c, err := getChannelDetails(ctx)
	if err != nil || c["logoUrl"] == "" {
		return nil
	}
	meta, err := readMetadata(stripExtension(path.Base(c["logoUrl"])))
	if err != nil || metaString(meta, "type") != "image" {
		return nil
	}
	hash, ok := metaHash(meta)
	if !ok {
		return nil
	}
	cfg := &watermarkConfig{
		position: settingConfig.WatermarkPosition,
		size:     float64(clampInt(settingConfig.WatermarkSize, 5, 50, 18)) / 100,
		opacity:  float64(clampInt(settingConfig.WatermarkOpacity, 10, 100, 70)) / 100,
		margin:   0.03,
		logoHash: hash,
		logoPath: filepath.Join(rootUploadPath, hash[:2], hash[2:4], hash),
	}
	if !watermarkPositions[cfg.position] {
		cfg.position = "bottom-left"
	}
	return cfg
}

func clampInt(v, lo, hi, def int64) int64 {
	if v == 0 {
		return def
	}
	return max(lo, min(hi, v))
}

func (c *watermarkConfig) key() string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%.3f|%.3f|%.3f|%s", c.position, c.size, c.opacity, c.margin, c.logoHash)))
	return hex.EncodeToString(sum[:6])
}

// serveWatermarked serves the watermarked form of srcPath (variant: o/r/b, used in cache name and ETag).
// It returns false when nothing was served (unsupported format, the logo itself, errors) so the caller
// falls back to the unwatermarked file.
func serveWatermarked(w http.ResponseWriter, r *http.Request, cfg *watermarkConfig, srcPath, variant, contentHash string) bool {
	if cfg == nil || contentHash == cfg.logoHash {
		return false
	}
	key := cfg.key()
	dir := filepath.Join(watermarkCacheDir, key)
	cachePath := filepath.Join(dir, variant+"-"+contentHash)

	lockAny, _ := watermarkLocks.LoadOrStore(cachePath, &sync.Mutex{})
	lock := lockAny.(*sync.Mutex)
	lock.Lock()
	ctype, err := cachedContentType(cachePath)
	if err == nil && cacheOlderThan(cachePath, srcPath) {
		err = errors.New("stale") // the blurred/regional source was regenerated after this copy was made
	}
	if err != nil {
		ctype, err = renderWatermark(cfg, srcPath, cachePath)
		if err == nil {
			pruneWatermarkCache(key)
		}
	}
	lock.Unlock()
	if err != nil {
		if err != errNotWatermarkable {
			log.Printf("watermark %s: %v", srcPath, err)
		}
		return false
	}

	f, err := os.Open(cachePath)
	if err != nil {
		return false
	}
	defer f.Close()
	setPrivateCacheHeaders(w, "w"+key+"-"+variant+"-"+contentHash+"-"+versionTag(srcPath))
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Disposition", "inline")
	http.ServeContent(w, r, "", time.Time{}, f)
	return true
}

func cacheOlderThan(cachePath, srcPath string) bool {
	c, err1 := os.Stat(cachePath)
	s, err2 := os.Stat(srcPath)
	return err1 == nil && err2 == nil && s.ModTime().After(c.ModTime())
}

func cachedContentType(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	head := make([]byte, 8)
	if _, err := io.ReadFull(f, head); err != nil {
		return "", err
	}
	if bytes.HasPrefix(head, []byte("\x89PNG")) {
		return "image/png", nil
	}
	return "image/jpeg", nil
}

var errNotWatermarkable = fmt.Errorf("not watermarkable")

func renderWatermark(cfg *watermarkConfig, srcPath, outPath string) (string, error) {
	data, err := os.ReadFile(srcPath)
	if err != nil {
		return "", err
	}
	_, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || format == "gif" { // keep GIF animations intact
		return "", errNotWatermarkable
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", errNotWatermarkable
	}
	if format == "jpeg" {
		src = applyExifOrientation(src, jpegOrientation(data))
	}
	logo, err := loadWatermarkLogo(cfg)
	if err != nil {
		return "", err
	}

	b := src.Bounds()
	canvas := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(canvas, canvas.Bounds(), src, b.Min, draw.Src)

	lw := max(1, int(float64(b.Dx())*cfg.size))
	lb := logo.Bounds()
	lh := max(1, lw*lb.Dy()/max(1, lb.Dx()))
	scaled := image.NewRGBA(image.Rect(0, 0, lw, lh))
	xdraw.CatmullRom.Scale(scaled, scaled.Bounds(), logo, lb, xdraw.Over, nil)

	m := int(float64(b.Dx()) * cfg.margin)
	var x, y int
	switch cfg.position {
	case "top-left":
		x, y = m, m
	case "top-right":
		x, y = b.Dx()-lw-m, m
	case "bottom-right":
		x, y = b.Dx()-lw-m, b.Dy()-lh-m
	case "center":
		x, y = (b.Dx()-lw)/2, (b.Dy()-lh)/2
	default: // bottom-left
		x, y = m, b.Dy()-lh-m
	}
	mask := image.NewUniform(color.Alpha{A: uint8(cfg.opacity * 255)})
	draw.DrawMask(canvas, image.Rect(x, y, x+lw, y+lh), scaled, image.Point{}, mask, image.Point{}, draw.Over)

	if err := os.MkdirAll(filepath.Dir(outPath), 0755); err != nil {
		return "", err
	}
	var buf bytes.Buffer
	ctype := "image/jpeg"
	if format == "png" {
		ctype = "image/png"
		err = png.Encode(&buf, canvas)
	} else {
		err = jpeg.Encode(&buf, canvas, &jpeg.Options{Quality: 88})
	}
	if err != nil {
		return "", err
	}
	tmp := outPath + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0644); err != nil {
		return "", err
	}
	return ctype, os.Rename(tmp, outPath)
}

func loadWatermarkLogo(cfg *watermarkConfig) (image.Image, error) {
	watermarkLogo.Lock()
	defer watermarkLogo.Unlock()
	if watermarkLogo.hash == cfg.logoHash && watermarkLogo.img != nil {
		return watermarkLogo.img, nil
	}
	data, err := os.ReadFile(cfg.logoPath)
	if err != nil {
		return nil, err
	}
	img, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if format == "jpeg" {
		img = applyExifOrientation(img, jpegOrientation(data))
	}
	watermarkLogo.hash, watermarkLogo.img = cfg.logoHash, img
	return img, nil
}

// pruneWatermarkCache removes cache folders of older configurations.
func pruneWatermarkCache(current string) {
	entries, err := os.ReadDir(watermarkCacheDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() && e.Name() != current {
			os.RemoveAll(filepath.Join(watermarkCacheDir, e.Name()))
		}
	}
}

// jpegOrientation reads the EXIF orientation tag (1 = normal) from a JPEG.
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	for i := 2; i+4 <= len(data); {
		if data[i] != 0xFF {
			return 1
		}
		marker := data[i+1]
		size := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		if marker == 0xDA || size < 2 || i+2+size > len(data) {
			return 1
		}
		seg := data[i+4 : i+2+size]
		if marker == 0xE1 && len(seg) > 14 && string(seg[:6]) == "Exif\x00\x00" {
			return exifOrientation(seg[6:])
		}
		i += 2 + size
	}
	return 1
}

func exifOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	ifd := int(bo.Uint32(tiff[4:8]))
	if ifd+2 > len(tiff) {
		return 1
	}
	n := int(bo.Uint16(tiff[ifd : ifd+2]))
	for k := 0; k < n; k++ {
		e := ifd + 2 + k*12
		if e+12 > len(tiff) {
			return 1
		}
		if bo.Uint16(tiff[e:e+2]) == 0x0112 {
			if v := int(bo.Uint16(tiff[e+8 : e+10])); v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}

// applyExifOrientation turns the decoded pixels upright (browsers do this for the original file).
func applyExifOrientation(img image.Image, o int) image.Image {
	if o <= 1 || o > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	ow, oh := w, h
	if o >= 5 {
		ow, oh = h, w
	}
	out := image.NewRGBA(image.Rect(0, 0, ow, oh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var nx, ny int
			switch o {
			case 2:
				nx, ny = w-1-x, y
			case 3:
				nx, ny = w-1-x, h-1-y
			case 4:
				nx, ny = x, h-1-y
			case 5:
				nx, ny = y, x
			case 6:
				nx, ny = h-1-y, x
			case 7:
				nx, ny = h-1-y, w-1-x
			case 8:
				nx, ny = y, w-1-x
			}
			out.Set(nx, ny, img.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return out
}

// watermarkedImageKind reports whether a served file kind gets the watermark (still images only).
func watermarkedImageKind(kind string) bool {
	return strings.EqualFold(kind, "image")
}

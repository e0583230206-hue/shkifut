package manualblur

import (
	"errors"
	"fmt"
	"math"
)

// The manual blur of a video (MANUAL_BLUR_VIDEO): a list of tracks. A track is one blurred area that moves: a shape (rectangle or
// ellipse) with keyframes, boxes at given seconds of the video. Between two keyframes the box moves smoothly (PCHIP, see Curve); before
// the first keyframe there is no blur, after the last one the box stays where it is until the track ends (by default: the end of
// the video, the safe side). Like the blur on a picture it only ADDS blur on top of the automatic result.
//
// The same numbers are used in three places, which must agree to the last digit: this package (validation and the reference
// implementation), the renderer in the moderation service (Python) and the editor in the page (TypeScript). They are all tested against
// the values scipy computes (tests/fixtures/pchip_vectors.json).

const (
	MaxTracks = 30
	MaxKeys   = 200
	// MaxVideoSec: no time after this is accepted (the service refuses longer videos anyway: MAX_VIDEO_SEC).
	MaxVideoSec = 900.0
	// PadFrames: the blur starts this many frames before the first keyframe and lasts this many frames after the end of the track, so that
	// a difference of a frame between the player in the page and the encoder never shows a frame without the blur. It only adds blur.
	PadFrames = 2

	Pchip  = "pchip"
	Linear = "linear"
	// minGap: two keyframes closer than this (seconds) are the same moment.
	minGap = 0.001
)

// Key is a box at a moment: t in seconds, x, y, w, h as shares of the picture (like Shape).
type Key struct {
	T float64 `json:"t" yaml:"t"`
	X float64 `json:"x" yaml:"x"`
	Y float64 `json:"y" yaml:"y"`
	W float64 `json:"w" yaml:"w"`
	H float64 `json:"h" yaml:"h"`
}

// Track is one moving blurred area.
type Track struct {
	Type   string   `json:"type" yaml:"type"`                         // rect | ellipse
	Keys   []Key    `json:"keys" yaml:"keys"`                         // strictly increasing in t
	End    *float64 `json:"end,omitempty" yaml:"end,omitempty"`       // second at which the blur ends; absent = the end of the video
	Interp string   `json:"interp,omitempty" yaml:"interp,omitempty"` // pchip (default) | linear
}

var ErrTooManyTracks = errors.New("too many tracks")

// ValidateTracks checks a request and returns the tracks with every box clipped to the picture. Anything wrong is an error (not silently
// repaired): the moderator must see what was saved. Times beyond the real length of the video are refused later, by the service, which
// is the one that knows the length.
func ValidateTracks(in []Track) ([]Track, error) {
	if len(in) == 0 {
		return nil, errors.New("no tracks")
	}
	if len(in) > MaxTracks {
		return nil, fmt.Errorf("%w: at most %d", ErrTooManyTracks, MaxTracks)
	}
	out := make([]Track, 0, len(in))
	for i, tr := range in {
		n := i + 1
		if tr.Type != Rect && tr.Type != Ellipse {
			return nil, fmt.Errorf("track %d: unknown type %q", n, tr.Type)
		}
		if tr.Interp == "" {
			tr.Interp = Pchip
		}
		if tr.Interp != Pchip && tr.Interp != Linear {
			return nil, fmt.Errorf("track %d: unknown interpolation %q", n, tr.Interp)
		}
		if len(tr.Keys) == 0 || len(tr.Keys) > MaxKeys {
			return nil, fmt.Errorf("track %d: between 1 and %d keyframes", n, MaxKeys)
		}
		keys := make([]Key, 0, len(tr.Keys))
		for j, k := range tr.Keys {
			for _, v := range []float64{k.T, k.X, k.Y, k.W, k.H} {
				if math.IsNaN(v) || math.IsInf(v, 0) {
					return nil, fmt.Errorf("track %d, keyframe %d: not a number", n, j+1)
				}
			}
			if k.T < 0 || k.T > MaxVideoSec {
				return nil, fmt.Errorf("track %d, keyframe %d: time outside the video", n, j+1)
			}
			if j > 0 && k.T-keys[j-1].T < minGap {
				return nil, fmt.Errorf("track %d, keyframe %d: times must increase", n, j+1)
			}
			x1, y1, x2, y2 := clamp(k.X), clamp(k.Y), clamp(k.X+k.W), clamp(k.Y+k.H)
			if x2-x1 < MinSize || y2-y1 < MinSize {
				return nil, fmt.Errorf("track %d, keyframe %d: box too small or outside the picture", n, j+1)
			}
			keys = append(keys, Key{T: round6(k.T), X: round6(x1), Y: round6(y1), W: round6(x2 - x1), H: round6(y2 - y1)})
		}
		out1 := Track{Type: tr.Type, Keys: keys, Interp: tr.Interp}
		if tr.End != nil {
			e := *tr.End
			if math.IsNaN(e) || math.IsInf(e, 0) || e > MaxVideoSec || e < keys[len(keys)-1].T {
				return nil, fmt.Errorf("track %d: the end must be after the last keyframe", n)
			}
			e = round6(e)
			out1.End = &e
		}
		out = append(out, out1)
	}
	return out, nil
}

// Curve is a track prepared for evaluation (the derivatives of the PCHIP are computed once).
type Curve struct {
	tr   Track
	ts   []float64
	vals [4][]float64 // x, y, w, h
	ders [4][]float64
}

// Compile prepares a track. The track must have passed ValidateTracks.
func Compile(tr Track) *Curve {
	c := &Curve{tr: tr}
	for _, k := range tr.Keys {
		c.ts = append(c.ts, k.T)
		c.vals[0] = append(c.vals[0], k.X)
		c.vals[1] = append(c.vals[1], k.Y)
		c.vals[2] = append(c.vals[2], k.W)
		c.vals[3] = append(c.vals[3], k.H)
	}
	for i := range c.vals {
		if tr.Interp == Linear {
			c.ders[i] = nil
		} else {
			c.ders[i] = PchipDerivatives(c.ts, c.vals[i])
		}
	}
	return c
}

// BoxAt is the box of the track at second t, and whether the track is active then. `pad` seconds are added before the first keyframe
// and after the end (the padding of PadFrames): there the box is the first / last one.
func (c *Curve) BoxAt(t, pad float64) (Shape, bool) {
	first, last := c.ts[0], c.ts[len(c.ts)-1]
	if t < first-pad {
		return Shape{}, false
	}
	if c.tr.End != nil && t > *c.tr.End+pad {
		return Shape{}, false
	}
	var v [4]float64
	for i := range v {
		v[i] = c.eval(i, t, first, last)
	}
	// the interpolated box stays inside the picture and is never smaller than the smallest allowed box
	x1, y1 := clamp(v[0]), clamp(v[1])
	x2, y2 := clamp(v[0]+v[2]), clamp(v[1]+v[3])
	return Shape{Type: c.tr.Type, X: x1, Y: y1, W: x2 - x1, H: y2 - y1}, true
}

func (c *Curve) eval(ch int, t, first, last float64) float64 {
	ys := c.vals[ch]
	if t <= first {
		return ys[0]
	}
	if t >= last {
		return ys[len(ys)-1]
	}
	// the segment [ts[i], ts[i+1]] that holds t
	lo, hi := 0, len(c.ts)-1
	for hi-lo > 1 {
		mid := (lo + hi) / 2
		if c.ts[mid] <= t {
			lo = mid
		} else {
			hi = mid
		}
	}
	h := c.ts[lo+1] - c.ts[lo]
	s := (t - c.ts[lo]) / h
	if c.ders[ch] == nil {
		return ys[lo] + (ys[lo+1]-ys[lo])*s
	}
	s2, s3 := s*s, s*s*s
	return (2*s3-3*s2+1)*ys[lo] + (s3-2*s2+s)*h*c.ders[ch][lo] + (-2*s3+3*s2)*ys[lo+1] + (s3-s2)*h*c.ders[ch][lo+1]
}

// PchipDerivatives are the slopes at the keyframes of the monotone cubic (Fritsch-Carlson / PCHIP) through the points (ts, ys), the
// same as scipy.interpolate.PchipInterpolator: between two keyframes the value never goes outside the two values (no overshoot), and the
// movement has no stops at the keyframes.
func PchipDerivatives(ts, ys []float64) []float64 {
	n := len(ts)
	d := make([]float64, n)
	if n < 2 {
		return d
	}
	h := make([]float64, n-1)
	m := make([]float64, n-1)
	for i := 0; i < n-1; i++ {
		h[i] = ts[i+1] - ts[i]
		m[i] = (ys[i+1] - ys[i]) / h[i]
	}
	if n == 2 {
		d[0], d[1] = m[0], m[0]
		return d
	}
	for k := 1; k < n-1; k++ {
		if sign(m[k-1]) != sign(m[k]) || m[k-1] == 0 || m[k] == 0 {
			d[k] = 0
			continue
		}
		w1 := 2*h[k] + h[k-1]
		w2 := h[k] + 2*h[k-1]
		d[k] = (w1 + w2) / (w1/m[k-1] + w2/m[k])
	}
	d[0] = edge(h[0], h[1], m[0], m[1])
	d[n-1] = edge(h[n-2], h[n-3], m[n-2], m[n-3])
	return d
}

// edge is the end-point slope (a three-point formula that keeps the shape): scipy's _edge_case.
func edge(h0, h1, m0, m1 float64) float64 {
	d := ((2*h0+h1)*m0 - h0*m1) / (h0 + h1)
	if sign(d) != sign(m0) {
		return 0
	}
	if sign(m0) != sign(m1) && math.Abs(d) > 3*math.Abs(m0) {
		return 3 * m0
	}
	return d
}

func sign(v float64) int {
	switch {
	case v > 0:
		return 1
	case v < 0:
		return -1
	}
	return 0
}

// TracksFromMeta reads the tracks back from the file metadata (decoded from YAML: lists of maps, numbers as int or float).
func TracksFromMeta(v any) []Track {
	list, _ := v.([]any)
	out := make([]Track, 0, len(list))
	for _, it := range list {
		m, _ := it.(map[string]any)
		if m == nil {
			continue
		}
		tr := Track{Interp: Pchip}
		tr.Type, _ = m["type"].(string)
		if s, _ := m["interp"].(string); s != "" {
			tr.Interp = s
		}
		if e, ok := m["end"]; ok && e != nil {
			f := num(e)
			tr.End = &f
		}
		keys, _ := m["keys"].([]any)
		for _, kv := range keys {
			km, _ := kv.(map[string]any)
			if km == nil {
				continue
			}
			tr.Keys = append(tr.Keys, Key{T: num(km["t"]), X: num(km["x"]), Y: num(km["y"]), W: num(km["w"]), H: num(km["h"])})
		}
		out = append(out, tr)
	}
	return out
}

// TracksToMeta is the form stored in the YAML metadata.
func TracksToMeta(tracks []Track) []any {
	out := make([]any, 0, len(tracks))
	for _, tr := range tracks {
		keys := make([]any, 0, len(tr.Keys))
		for _, k := range tr.Keys {
			keys = append(keys, map[string]any{"t": k.T, "x": k.X, "y": k.Y, "w": k.W, "h": k.H})
		}
		m := map[string]any{"type": tr.Type, "keys": keys, "interp": tr.Interp}
		if tr.End != nil {
			m["end"] = *tr.End
		}
		out = append(out, m)
	}
	return out
}

// StaticVideoMime: the formats the tool edits (the service decodes them with ffmpeg).
func VideoMime(mime string) bool {
	m := lower(mime)
	return len(m) > 6 && m[:6] == "video/"
}

func lower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

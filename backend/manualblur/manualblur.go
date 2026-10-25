// Package manualblur holds the rules of the manual blur tool (MANUAL_BLUR): what a blur shape is, how a request is validated, and when a
// manual version is still valid. It has no Redis, HTTP or file access, so it can be tested anywhere.
//
// The manual blur only ever ADDS blur on top of what the automatic check gives readers. A manual version is built on one exact
// base (the original for an "open" file, the regional picture for a "regional" one); when that base changes (check again, saved
// corrections, a manual decision) the manual version is no longer valid and readers get the automatic version again.
package manualblur

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

const (
	MaxShapes = 50
	// MinSize is the smallest width / height of a shape, as a share of the picture: a smaller one is a click, not a blur.
	MinSize = 0.005

	Rect    = "rect"
	Ellipse = "ellipse"
)

// Shape is one blurred area. All numbers are shares of the picture (0..1): x, y is the top-left corner of the box
// (for an ellipse, the box around it), w, h its size. Shares make the shape independent of the size the picture is shown or stored at.
type Shape struct {
	Type string  `json:"type" yaml:"type"`
	X    float64 `json:"x" yaml:"x"`
	Y    float64 `json:"y" yaml:"y"`
	W    float64 `json:"w" yaml:"w"`
	H    float64 `json:"h" yaml:"h"`
}

var ErrTooMany = errors.New("too many shapes")

// Validate checks a request and returns the shapes clipped to the picture. Anything that is not a finite number, an unknown type or
// a shape that is (after clipping) too small is an error, not silently dropped: the moderator must see what was saved.
func Validate(in []Shape) ([]Shape, error) {
	if len(in) > MaxShapes {
		return nil, fmt.Errorf("%w: at most %d", ErrTooMany, MaxShapes)
	}
	out := make([]Shape, 0, len(in))
	for i, s := range in {
		if s.Type != Rect && s.Type != Ellipse {
			return nil, fmt.Errorf("shape %d: unknown type %q", i+1, s.Type)
		}
		for _, v := range []float64{s.X, s.Y, s.W, s.H} {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return nil, fmt.Errorf("shape %d: not a number", i+1)
			}
		}
		x1, y1 := clamp(s.X), clamp(s.Y)
		x2, y2 := clamp(s.X+s.W), clamp(s.Y+s.H)
		if x2-x1 < MinSize || y2-y1 < MinSize {
			return nil, fmt.Errorf("shape %d: too small or outside the picture", i+1)
		}
		out = append(out, Shape{Type: s.Type, X: round6(x1), Y: round6(y1), W: round6(x2 - x1), H: round6(y2 - y1)})
	}
	return out, nil
}

func clamp(v float64) float64 { return math.Min(1, math.Max(0, v)) }

func round6(v float64) float64 { return math.Round(v*1e6) / 1e6 }

// FromMeta reads the shapes back from the file metadata (decoded from YAML: a list of maps, numbers as int or float).
func FromMeta(v any) []Shape {
	list, _ := v.([]any)
	out := make([]Shape, 0, len(list))
	for _, it := range list {
		m, _ := it.(map[string]any)
		if m == nil {
			continue
		}
		t, _ := m["type"].(string)
		out = append(out, Shape{Type: t, X: num(m["x"]), Y: num(m["y"]), W: num(m["w"]), H: num(m["h"])})
	}
	return out
}

// ToMeta is the form stored in the YAML metadata.
func ToMeta(shapes []Shape) []any {
	out := make([]any, 0, len(shapes))
	for _, s := range shapes {
		out = append(out, map[string]any{"type": s.Type, "x": s.X, "y": s.Y, "w": s.W, "h": s.H})
	}
	return out
}

func num(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	}
	return 0
}

// Base describes what a manual version is built on.
type Base struct {
	Kind    string // "original" or "regional"
	Version string // changes whenever the base file is regenerated (its modification time)
}

// Signature identifies the exact base a manual version was built on: the moderation status, the "check again" generation, the time of
// the automatic check and the base file itself. If any of them differs from the one stored with the manual version, the version is
// stale and must not be served: it was made on a picture that readers no longer get, and could show a figure the new check hides.
func Signature(status string, gen int, autoCheckedAt string, b Base) string {
	return strings.Join([]string{status, strconv.Itoa(gen), autoCheckedAt, b.Kind, b.Version}, "|")
}

// StaticImageMime: the formats the tool edits. Animated pictures (GIF) are not supported: a still frame cannot stand for them.
func StaticImageMime(mime string) bool {
	switch strings.ToLower(strings.TrimSpace(mime)) {
	case "image/jpeg", "image/png", "image/webp":
		return true
	}
	return false
}

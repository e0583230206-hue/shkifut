package manualblur

import (
	"errors"
	"math"
	"reflect"
	"testing"
)

func TestValidateClipsToThePicture(t *testing.T) {
	got, err := Validate([]Shape{{Type: Rect, X: -0.2, Y: 0.5, W: 0.5, H: 0.9}, {Type: Ellipse, X: 0.9, Y: 0.1, W: 0.5, H: 0.2}})
	if err != nil {
		t.Fatal(err)
	}
	if got[0].X != 0 || got[0].W != 0.3 || got[0].Y != 0.5 || got[0].H != 0.5 {
		t.Errorf("first shape not clipped: %+v", got[0])
	}
	if math.Abs(got[1].X+got[1].W-1) > 1e-9 {
		t.Errorf("second shape leaves the picture: %+v", got[1])
	}
}

func TestValidateRejects(t *testing.T) {
	bad := map[string]Shape{
		"unknown type": {Type: "star", X: 0.1, Y: 0.1, W: 0.2, H: 0.2},
		"NaN":          {Type: Rect, X: math.NaN(), Y: 0.1, W: 0.2, H: 0.2},
		"Inf":          {Type: Rect, X: 0.1, Y: 0.1, W: math.Inf(1), H: 0.2},
		"too small":    {Type: Rect, X: 0.1, Y: 0.1, W: 0.001, H: 0.2},
		"outside":      {Type: Rect, X: 1.2, Y: 0.1, W: 0.2, H: 0.2},
		"negative":     {Type: Rect, X: 0.5, Y: 0.5, W: -0.2, H: 0.2},
	}
	for name, s := range bad {
		if _, err := Validate([]Shape{s}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestValidateLimit(t *testing.T) {
	ok := make([]Shape, MaxShapes)
	for i := range ok {
		ok[i] = Shape{Type: Rect, X: 0.1, Y: 0.1, W: 0.2, H: 0.2}
	}
	if _, err := Validate(ok); err != nil {
		t.Fatalf("%d shapes should pass: %v", MaxShapes, err)
	}
	if _, err := Validate(append(ok, ok[0])); !errors.Is(err, ErrTooMany) {
		t.Errorf("one more should fail with ErrTooMany, got %v", err)
	}
	if got, err := Validate(nil); err != nil || len(got) != 0 {
		t.Errorf("no shapes is allowed (it clears the manual blur): %v %v", got, err)
	}
}

func TestMetaRoundTripAcceptsYamlNumbers(t *testing.T) {
	in := []Shape{{Type: Ellipse, X: 0.25, Y: 0.5, W: 0.5, H: 0.25}}
	back := FromMeta(ToMeta(in))
	if len(back) != 1 || !reflect.DeepEqual(back[0], in[0]) {
		t.Errorf("round trip: %+v", back)
	}
	// YAML decodes 1.0 as int 1 and 0.5 as float
	yamlLike := []any{map[string]any{"type": "rect", "x": 0, "y": 0, "w": 1, "h": 0.5}}
	got := FromMeta(yamlLike)
	if len(got) != 1 || got[0].W != 1 || got[0].H != 0.5 {
		t.Errorf("int numbers: %+v", got)
	}
	if len(FromMeta("garbage")) != 0 || len(FromMeta(nil)) != 0 {
		t.Error("garbage must give no shapes")
	}
}

func TestSignatureChangesWithEveryPartOfTheBase(t *testing.T) {
	b := Base{Kind: "regional", Version: "abc"}
	ref := Signature("regional", 2, "2026-10-25T10:00:00Z", "2026-10-25T09:00:00Z", b)
	cases := map[string]string{
		"status":                Signature("open", 2, "2026-10-25T10:00:00Z", "2026-10-25T09:00:00Z", b),
		"check gen":             Signature("regional", 3, "2026-10-25T10:00:00Z", "2026-10-25T09:00:00Z", b),
		"checked":               Signature("regional", 2, "2026-10-25T11:00:00Z", "2026-10-25T09:00:00Z", b),
		"decided by hand again": Signature("regional", 2, "2026-10-25T10:00:00Z", "2026-10-25T09:30:00Z", b),
		"base kind":             Signature("regional", 2, "2026-10-25T10:00:00Z", "2026-10-25T09:00:00Z", Base{Kind: "original", Version: "abc"}),
		"base file":             Signature("regional", 2, "2026-10-25T10:00:00Z", "2026-10-25T09:00:00Z", Base{Kind: "regional", Version: "abd"}),
	}
	for name, s := range cases {
		if s == ref {
			t.Errorf("%s change does not change the signature", name)
		}
	}
	if ref != Signature("regional", 2, "2026-10-25T10:00:00Z", "2026-10-25T09:00:00Z", b) {
		t.Error("signature is not stable")
	}
}

func TestStaticImageMime(t *testing.T) {
	for _, m := range []string{"image/jpeg", "IMAGE/PNG", "image/webp"} {
		if !StaticImageMime(m) {
			t.Errorf("%s should be editable", m)
		}
	}
	for _, m := range []string{"image/gif", "video/mp4", "", "application/pdf"} {
		if StaticImageMime(m) {
			t.Errorf("%s should not be editable", m)
		}
	}
}

func TestBrushStrokes(t *testing.T) {
	ok := Shape{Type: Brush, R: 0.05, Pts: [][2]float64{{0.1, 0.1}, {0.5, 0.5}, {1.2, -0.3}}}
	got, err := Validate([]Shape{ok, {Type: Rect, X: 0.1, Y: 0.1, W: 0.2, H: 0.2}})
	if err != nil || len(got) != 2 {
		t.Fatalf("a brush stroke and a rectangle: %v %v", err, got)
	}
	if got[0].Pts[2] != [2]float64{1, 0} || got[0].R != 0.05 || got[0].Type != Brush {
		t.Errorf("the points are clipped to the picture: %+v", got[0])
	}
	dot, err := Validate([]Shape{{Type: Brush, R: 0.02, Pts: [][2]float64{{0.5, 0.5}}}})
	if err != nil || len(dot[0].Pts) != 1 {
		t.Errorf("a tap makes a dot: %v %v", err, dot)
	}
	bad := map[string]Shape{
		"no points":           {Type: Brush, R: 0.05},
		"radius too small":    {Type: Brush, R: 0.0001, Pts: [][2]float64{{0.5, 0.5}}},
		"radius too big":      {Type: Brush, R: 0.9, Pts: [][2]float64{{0.5, 0.5}}},
		"radius NaN":          {Type: Brush, R: math.NaN(), Pts: [][2]float64{{0.5, 0.5}}},
		"point NaN":           {Type: Brush, R: 0.05, Pts: [][2]float64{{math.NaN(), 0.5}}},
		"point Inf":           {Type: Brush, R: 0.05, Pts: [][2]float64{{0.5, math.Inf(1)}}},
		"too many points":     {Type: Brush, R: 0.05, Pts: make([][2]float64, MaxBrushPoints+1)},
		"radius zero (unset)": {Type: Brush, Pts: [][2]float64{{0.5, 0.5}}},
	}
	for name, s := range bad {
		if _, err := Validate([]Shape{s}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := Validate([]Shape{{Type: Brush, R: 0.05, Pts: make([][2]float64, MaxBrushPoints)}}); err != nil {
		t.Errorf("%d points should pass: %v", MaxBrushPoints, err)
	}
	// the metadata round trip, with the numbers YAML gives back
	back := FromMeta(ToMeta(got))
	if len(back) != 2 || back[0].Type != Brush || len(back[0].Pts) != 3 || back[0].R != 0.05 || back[0].Pts[1] != [2]float64{0.5, 0.5} {
		t.Errorf("round trip: %+v", back)
	}
	yamlLike := []any{map[string]any{"type": "brush", "r": 0.1, "pts": []any{[]any{0, 1}, []any{0.5, 0.25}}}}
	y := FromMeta(yamlLike)
	if len(y) != 1 || len(y[0].Pts) != 2 || y[0].Pts[0] != [2]float64{0, 1} {
		t.Errorf("int numbers in a stroke: %+v", y)
	}
}

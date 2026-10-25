package manualblur

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func key(t, x, y, w, h float64) Key { return Key{T: t, X: x, Y: y, W: w, H: h} }
func f64(v float64) *float64        { return &v }

func track(keys ...Key) Track { return Track{Type: Rect, Keys: keys, Interp: Pchip} }

// The values scipy computes for the same keyframes (tests/fixtures/pchip_vectors.json): the reference of the smooth movement. The renderer
// in the moderation service and the page have the same test.
func TestPchipMatchesScipy(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "tests", "fixtures", "pchip_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Cases []struct {
			Name   string    `json:"name"`
			T      []float64 `json:"t"`
			Y      []float64 `json:"y"`
			At     []float64 `json:"at"`
			Expect []float64 `json:"expect"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) < 8 {
		t.Fatalf("fixture has %d cases", len(fx.Cases))
	}
	for _, c := range fx.Cases {
		d := PchipDerivatives(c.T, c.Y)
		cv := &Curve{ts: c.T}
		cv.vals[0], cv.ders[0] = c.Y, d
		worst := 0.0
		for i, at := range c.At {
			got := cv.eval(0, at, c.T[0], c.T[len(c.T)-1])
			worst = math.Max(worst, math.Abs(got-c.Expect[i]))
		}
		if worst > 1e-12 {
			t.Errorf("%s: differs from scipy by %g", c.Name, worst)
		}
	}
}

func TestPchipNeverLeavesTheKeyframeValuesAndNeverStopsAtOne(t *testing.T) {
	ts, ys := []float64{0, 1, 2, 3, 4}, []float64{0.1, 0.7, 0.2, 0.8, 0.3}
	d := PchipDerivatives(ts, ys)
	cv := &Curve{ts: ts}
	cv.vals[0], cv.ders[0] = ys, d
	for seg := 0; seg < 4; seg++ {
		lo, hi := math.Min(ys[seg], ys[seg+1]), math.Max(ys[seg], ys[seg+1])
		for i := 0; i <= 100; i++ {
			v := cv.eval(0, ts[seg]+float64(i)/100, 0, 4)
			if v < lo-1e-12 || v > hi+1e-12 {
				t.Fatalf("segment %d overshoots: %v not in [%v, %v]", seg, v, lo, hi)
			}
		}
	}
	// a steady movement keeps its speed through the middle keyframe (no stop there)
	line := []float64{0.1, 0.3, 0.5, 0.7}
	dl := PchipDerivatives([]float64{0, 1, 2, 3}, line)
	for i, v := range dl {
		if math.Abs(v-0.2) > 1e-12 {
			t.Errorf("slope %d of a straight movement is %v, want 0.2", i, v)
		}
	}
}

func TestBoxAtActiveWindowAndHold(t *testing.T) {
	tr := track(key(2, 0.1, 0.1, 0.2, 0.2), key(4, 0.5, 0.1, 0.2, 0.2))
	c := Compile(tr)
	if _, ok := c.BoxAt(1.9, 0); ok {
		t.Error("active before the first keyframe")
	}
	if b, ok := c.BoxAt(2, 0); !ok || b.X != 0.1 {
		t.Errorf("first keyframe: %+v %v", b, ok)
	}
	if b, ok := c.BoxAt(3, 0); !ok || math.Abs(b.X-0.3) > 1e-9 {
		t.Errorf("middle of two keyframes: %+v", b)
	}
	if b, ok := c.BoxAt(1000, 0); !ok || b.X != 0.5 {
		t.Errorf("after the last keyframe, no end: the box stays to the end of the video: %+v %v", b, ok)
	}
	// padding: 2 frames of a 30 fps video before the first keyframe: the first box
	pad := PadFrames / 30.0
	if b, ok := c.BoxAt(2-pad+1e-9, pad); !ok || b.X != 0.1 {
		t.Errorf("padding before the start: %+v %v", b, ok)
	}
	if _, ok := c.BoxAt(2-pad-1e-6, pad); ok {
		t.Error("active more than the padding before the start")
	}
	// an explicit end: the box stays until it, plus the padding
	tr.End = f64(6)
	c = Compile(tr)
	if _, ok := c.BoxAt(6, 0); !ok {
		t.Error("not active at the end second")
	}
	if _, ok := c.BoxAt(6+pad-1e-9, pad); !ok {
		t.Error("padding after the end missing")
	}
	if _, ok := c.BoxAt(6+pad+1e-6, pad); ok {
		t.Error("active after the end and its padding")
	}
	// one keyframe: constant box
	one := Compile(track(key(1, 0.2, 0.3, 0.1, 0.1)))
	if b, ok := one.BoxAt(50, 0); !ok || b.X != 0.2 || b.Y != 0.3 {
		t.Errorf("single keyframe: %+v", b)
	}
}

func TestLinearInterpolation(t *testing.T) {
	tr := track(key(0, 0.1, 0.1, 0.2, 0.2), key(1, 0.3, 0.1, 0.2, 0.2), key(3, 0.7, 0.1, 0.2, 0.2))
	tr.Interp = Linear
	c := Compile(tr)
	b, _ := c.BoxAt(0.5, 0)
	if math.Abs(b.X-0.2) > 1e-12 {
		t.Errorf("linear at 0.5: %v", b.X)
	}
	b, _ = c.BoxAt(2, 0)
	if math.Abs(b.X-0.5) > 1e-12 {
		t.Errorf("linear at 2: %v", b.X)
	}
}

func TestInterpolatedBoxStaysInsideThePicture(t *testing.T) {
	tr := track(key(0, 0.8, 0.8, 0.2, 0.2), key(1, 0, 0, 0.2, 0.2), key(2, 0.8, 0.8, 0.2, 0.2))
	c := Compile(tr)
	for i := 0; i <= 200; i++ {
		b, ok := c.BoxAt(float64(i)/100, 0)
		if !ok || b.X < 0 || b.Y < 0 || b.X+b.W > 1+1e-12 || b.Y+b.H > 1+1e-12 || b.W <= 0 || b.H <= 0 {
			t.Fatalf("t=%v: %+v", float64(i)/100, b)
		}
	}
}

func TestValidateTracks(t *testing.T) {
	good := track(key(0, 0.1, 0.1, 0.2, 0.2), key(2, 0.5, 0.5, 0.2, 0.2))
	got, err := ValidateTracks([]Track{good})
	if err != nil || len(got) != 1 || got[0].Interp != Pchip || got[0].End != nil {
		t.Fatalf("good track: %v %+v", err, got)
	}
	clipped, err := ValidateTracks([]Track{track(key(0, -0.2, 0.5, 0.5, 0.9))})
	if err != nil || clipped[0].Keys[0].X != 0 || clipped[0].Keys[0].W != 0.3 || clipped[0].Keys[0].H != 0.5 {
		t.Errorf("clipping: %v %+v", err, clipped)
	}
	end := 5.0
	withEnd := good
	withEnd.End = &end
	if r, err := ValidateTracks([]Track{withEnd}); err != nil || *r[0].End != 5 {
		t.Errorf("end: %v", err)
	}

	bad := map[string]Track{
		"unknown type":     {Type: "star", Keys: good.Keys},
		"unknown interp":   {Type: Rect, Keys: good.Keys, Interp: "bezier"},
		"no keyframes":     {Type: Rect},
		"unsorted":         track(key(2, 0.1, 0.1, 0.2, 0.2), key(1, 0.1, 0.1, 0.2, 0.2)),
		"same time":        track(key(1, 0.1, 0.1, 0.2, 0.2), key(1.0005, 0.1, 0.1, 0.2, 0.2)),
		"negative time":    track(key(-1, 0.1, 0.1, 0.2, 0.2)),
		"time after 15min": track(key(901, 0.1, 0.1, 0.2, 0.2)),
		"NaN":              track(key(0, math.NaN(), 0.1, 0.2, 0.2)),
		"Inf time":         track(key(math.Inf(1), 0.1, 0.1, 0.2, 0.2)),
		"too small":        track(key(0, 0.1, 0.1, 0.001, 0.2)),
		"outside":          track(key(0, 1.4, 0.1, 0.2, 0.2)),
		"end before last":  {Type: Rect, Keys: good.Keys, End: f64(1)},
		"end after 15min":  {Type: Rect, Keys: good.Keys, End: f64(1000)},
		"end NaN":          {Type: Rect, Keys: good.Keys, End: f64(math.NaN())},
	}
	for name, tr := range bad {
		if _, err := ValidateTracks([]Track{tr}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := ValidateTracks(nil); err == nil {
		t.Error("no tracks accepted")
	}
	many := make([]Track, MaxTracks+1)
	for i := range many {
		many[i] = good
	}
	if _, err := ValidateTracks(many); err == nil {
		t.Errorf("%d tracks accepted", MaxTracks+1)
	}
	if _, err := ValidateTracks(many[:MaxTracks]); err != nil {
		t.Errorf("%d tracks refused: %v", MaxTracks, err)
	}
	keys := make([]Key, MaxKeys+1)
	for i := range keys {
		keys[i] = key(float64(i)*0.01, 0.1, 0.1, 0.2, 0.2)
	}
	if _, err := ValidateTracks([]Track{{Type: Rect, Keys: keys}}); err == nil {
		t.Errorf("%d keyframes accepted", MaxKeys+1)
	}
	if _, err := ValidateTracks([]Track{{Type: Rect, Keys: keys[:MaxKeys]}}); err != nil {
		t.Errorf("%d keyframes refused: %v", MaxKeys, err)
	}
}

func TestTracksMetaRoundTripAndYamlNumbers(t *testing.T) {
	in := []Track{{Type: Ellipse, Keys: []Key{key(0, 0.1, 0.2, 0.3, 0.4), key(1.5, 0.5, 0.5, 0.2, 0.2)}, End: f64(4), Interp: Linear}, track(key(2, 0, 0, 1, 1))}
	back := TracksFromMeta(TracksToMeta(in))
	if len(back) != 2 || back[0].Type != Ellipse || back[0].Interp != Linear || back[0].End == nil || *back[0].End != 4 || back[0].Keys[1].T != 1.5 {
		t.Errorf("round trip: %+v", back)
	}
	if back[1].End != nil || back[1].Interp != Pchip {
		t.Errorf("no end stays no end: %+v", back[1])
	}
	yamlLike := []any{map[string]any{"type": "rect", "keys": []any{map[string]any{"t": 0, "x": 0, "y": 0, "w": 1, "h": 1}}}}
	got := TracksFromMeta(yamlLike)
	if len(got) != 1 || got[0].Keys[0].W != 1 || got[0].Interp != Pchip {
		t.Errorf("int numbers: %+v", got)
	}
	if len(TracksFromMeta("garbage")) != 0 || len(TracksFromMeta(nil)) != 0 {
		t.Error("garbage must give no tracks")
	}
}

func TestVideoMime(t *testing.T) {
	for _, m := range []string{"video/mp4", "VIDEO/quicktime", "video/webm"} {
		if !VideoMime(m) {
			t.Errorf("%s", m)
		}
	}
	for _, m := range []string{"", "image/jpeg", "video", "application/octet-stream"} {
		if VideoMime(m) {
			t.Errorf("%s", m)
		}
	}
}

// ---- the golden file of whole tracks (window, hold, padding, clamping), shared with the renderer (Python) and the page (TypeScript) ----

type trackVectorCase struct {
	Name   string       `json:"name"`
	Track  Track        `json:"track"`
	Pad    float64      `json:"pad"`
	At     []float64    `json:"at"`
	Expect [][4]float64 `json:"expect"` // x1, y1, x2, y2 of the box, or [-1,-1,-1,-1] when the track is not active
}

func trackVectorInput() []trackVectorCase {
	pad := PadFrames / 30.0
	times := func(from, to float64, n int) []float64 {
		out := make([]float64, 0, n+1)
		for i := 0; i <= n; i++ {
			out = append(out, round6(from+(to-from)*float64(i)/float64(n)))
		}
		return out
	}
	return []trackVectorCase{
		{Name: "pchip, two keys, no end, no padding", Track: Track{Type: Rect, Interp: Pchip, Keys: []Key{key(1, 0.1, 0.1, 0.2, 0.2), key(3, 0.5, 0.4, 0.3, 0.1)}}, Pad: 0, At: times(0, 6, 60)},
		{Name: "pchip, two keys, padding of 2 frames at 30 fps", Track: Track{Type: Rect, Interp: Pchip, Keys: []Key{key(1, 0.1, 0.1, 0.2, 0.2), key(3, 0.5, 0.4, 0.3, 0.1)}}, Pad: pad, At: append(times(0.9, 1.1, 20), times(2.9, 3.2, 15)...)},
		{Name: "pchip, four keys, an end second", Track: Track{Type: Ellipse, Interp: Pchip, End: f64(7), Keys: []Key{
			key(0.5, 0.1, 0.1, 0.2, 0.2), key(2, 0.6, 0.2, 0.25, 0.15), key(3.5, 0.3, 0.7, 0.2, 0.2), key(6, 0.7, 0.6, 0.1, 0.3)}}, Pad: pad, At: times(0, 8, 80)},
		{Name: "linear, three keys", Track: Track{Type: Rect, Interp: Linear, Keys: []Key{key(0, 0.1, 0.1, 0.2, 0.2), key(1, 0.3, 0.5, 0.2, 0.2), key(4, 0.7, 0.2, 0.1, 0.1)}}, Pad: 0, At: times(0, 5, 50)},
		{Name: "one keyframe: the box stays, to the end of the video", Track: Track{Type: Ellipse, Interp: Pchip, Keys: []Key{key(2, 0.25, 0.25, 0.5, 0.5)}}, Pad: pad, At: []float64{0, 1.9, 1.94, 1.9333, 2, 5, 899}},
		{Name: "a box that would leave the picture is cut at its edge", Track: Track{Type: Rect, Interp: Pchip, Keys: []Key{key(0, 0.8, 0.8, 0.2, 0.2), key(1, 0, 0, 0.2, 0.2), key(2, 0.8, 0.8, 0.2, 0.2)}}, Pad: 0, At: times(0, 2, 40)},
		{Name: "the end is exactly the last keyframe", Track: Track{Type: Rect, Interp: Pchip, End: f64(2), Keys: []Key{key(1, 0.1, 0.1, 0.2, 0.2), key(2, 0.3, 0.3, 0.2, 0.2)}}, Pad: pad, At: []float64{0.9, 1, 1.5, 2, 2.05, 2.0666, 2.07}},
	}
}

func TestTrackVectorsGolden(t *testing.T) {
	cases := trackVectorInput()
	for i := range cases {
		c := Compile(cases[i].Track)
		for _, at := range cases[i].At {
			b, ok := c.BoxAt(at, cases[i].Pad)
			if ok {
				cases[i].Expect = append(cases[i].Expect, [4]float64{b.X, b.Y, b.X + b.W, b.Y + b.H})
			} else {
				cases[i].Expect = append(cases[i].Expect, [4]float64{-1, -1, -1, -1})
			}
		}
	}
	path := filepath.Join("..", "..", "tests", "fixtures", "track_vectors.json")
	if os.Getenv("UPDATE_VECTORS") == "1" {
		data, _ := json.MarshalIndent(map[string]any{"source": "backend/manualblur (Go): go test -run TrackVectorsGolden with UPDATE_VECTORS=1", "cases": cases}, "", " ")
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Log("written", path)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Cases []trackVectorCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &golden); err != nil {
		t.Fatal(err)
	}
	if len(golden.Cases) != len(cases) {
		t.Fatalf("the golden file has %d cases, the test %d: run with UPDATE_VECTORS=1 if the change is meant", len(golden.Cases), len(cases))
	}
	for i, c := range cases {
		for j := range c.Expect {
			for k := 0; k < 4; k++ {
				if math.Abs(c.Expect[j][k]-golden.Cases[i].Expect[j][k]) > 1e-9 {
					t.Fatalf("%s at %v: %v, the golden file says %v (the renderer and the page share it: change both on purpose)", c.Name, c.At[j], c.Expect[j], golden.Cases[i].Expect[j])
				}
			}
		}
	}
}

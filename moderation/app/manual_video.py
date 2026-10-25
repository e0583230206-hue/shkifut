"""Manual blur of one video (the backend's MANUAL_BLUR_VIDEO): draws the moving blur shapes an owner / approver placed on a video.

No models and no analysis. The video is decoded frame by frame (ffmpeg), the shapes of every track are pixelated into the frame at the
box the track has at that moment (keyframes + smooth movement, the same numbers as backend/manualblur/video.go: tests/fixtures/*.json),
and the frames are encoded again (H.264) with the audio of the base video. Kept apart from server.py (which loads the models when imported)
so it can be tested anywhere that has ffmpeg.

Safety, like the pictures: the blur is only ever ADDED to the base video the backend names (the original of an "open" file, the regional
video of a "regional" one). Nothing is published by this module: it writes `<fileid>.<job>.mp4`; the backend renames it after checking that
the automatic result has not changed. Before it returns, the result checks itself: the length is right, and in sampled frames the boxes
really are blurred and the rest of the picture is still the video. A video that fails the check is never handed over.

A render can be cancelled (it stops at the next frame and leaves no file), reports its progress, and runs at a low priority (`nice`, and
a low priority for its own thread), so that the automatic check of new media is not slowed down much.
"""
import math
import os
import re
import shutil
import subprocess
import threading
import time

import cv2
import numpy as np

import manual_image as MI

MAX_VIDEO_SEC = float(os.environ.get("MAX_VIDEO_SEC", 900))
MAX_OUTPUT_FPS = float(os.environ.get("MAX_OUTPUT_FPS", 30))
OUTPUT_MAX_SIDE = int(os.environ.get("OUTPUT_MAX_SIDE", 1280))
FFMPEG_THREADS = os.environ.get("MANUAL_FFMPEG_THREADS", "2")
CRF = os.environ.get("MANUAL_VIDEO_CRF", "21")
NICE = int(os.environ.get("MANUAL_NICE", "10"))
MAX_TRACKS, MAX_KEYS, MIN_GAP = 30, 200, 0.001
SAMPLES = 12                      # frames checked after the render
SELF_CHECK_RATIO = 0.6            # inside a box the detail of the result must be below this share of the base's detail
SELF_CHECK_MIN_DETAIL = 3.0       # (a box over a flat area proves nothing and is skipped)
SELF_CHECK_OUTSIDE = 24.0         # mean difference outside the boxes between the base frame and the result (re-encoding noise only)
STALE_SECONDS = 6 * 3600

# The only files this module reads and writes (a request must not reach any other file).
BASE_RES = {
    "files": re.compile(r"^[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}$"),
    "blurred": re.compile(r"^[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}\.regional\.mp4$"),
}


class Cancelled(Exception):
    pass


class SelfCheckFailed(Exception):
    """The rendered video did not pass its own check: it must not be published."""


class Rejected(MI.Rejected):
    pass


# ---------- request ----------

def check_paths(base, base_root, out, job):
    if base_root not in BASE_RES or not BASE_RES[base_root].match(base or ""):
        raise Rejected("base video not allowed")
    m = MI.VIDEO_TMP_RE.match(out or "")
    if not m or m.group(4) != job:
        raise Rejected("output path not allowed")
    if not re.match(r"^[0-9a-f]{16}$", job or ""):
        raise Rejected("job id not allowed")


class Track:
    def __init__(self, kind, keys, end, interp):
        self.kind, self.keys, self.end, self.interp = kind, keys, end, interp   # keys: list of (t, x, y, w, h)
        self.ts = [k[0] for k in keys]
        self.vals = [[k[i] for k in keys] for i in (1, 2, 3, 4)]
        self.ders = None if interp == "linear" else [pchip_derivatives(self.ts, v) for v in self.vals]

    def box_at(self, t, pad):
        """The box (x1, y1, x2, y2) of the track at second t, or None when the track is not active then. Same as Curve.BoxAt in Go."""
        first, last = self.ts[0], self.ts[-1]
        if t < first - pad:
            return None
        if self.end is not None and t > self.end + pad:
            return None
        v = [self._eval(i, t, first, last) for i in range(4)]
        x1, y1 = min(1.0, max(0.0, v[0])), min(1.0, max(0.0, v[1]))
        x2, y2 = min(1.0, max(0.0, v[0] + v[2])), min(1.0, max(0.0, v[1] + v[3]))
        return x1, y1, x2, y2

    def _eval(self, ch, t, first, last):
        ys = self.vals[ch]
        if t <= first:
            return ys[0]
        if t >= last:
            return ys[-1]
        lo, hi = 0, len(self.ts) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if self.ts[mid] <= t:
                lo = mid
            else:
                hi = mid
        h = self.ts[lo + 1] - self.ts[lo]
        s = (t - self.ts[lo]) / h
        if self.ders is None:
            return ys[lo] + (ys[lo + 1] - ys[lo]) * s
        s2, s3 = s * s, s * s * s
        d = self.ders[ch]
        return (2 * s3 - 3 * s2 + 1) * ys[lo] + (s3 - 2 * s2 + s) * h * d[lo] + (-2 * s3 + 3 * s2) * ys[lo + 1] + (s3 - s2) * h * d[lo + 1]


def _sign(v):
    return (v > 0) - (v < 0)


def _edge(h0, h1, m0, m1):
    d = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1)
    if _sign(d) != _sign(m0):
        return 0.0
    if _sign(m0) != _sign(m1) and abs(d) > 3 * abs(m0):
        return 3 * m0
    return d


def pchip_derivatives(ts, ys):
    """Slopes at the keyframes of the monotone cubic (PCHIP): the same as scipy.interpolate.PchipInterpolator and the Go package."""
    n = len(ts)
    d = [0.0] * n
    if n < 2:
        return d
    h = [ts[i + 1] - ts[i] for i in range(n - 1)]
    m = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    if n == 2:
        return [m[0], m[0]]
    for k in range(1, n - 1):
        if _sign(m[k - 1]) != _sign(m[k]) or m[k - 1] == 0 or m[k] == 0:
            d[k] = 0.0
            continue
        w1, w2 = 2 * h[k] + h[k - 1], h[k] + 2 * h[k - 1]
        d[k] = (w1 + w2) / (w1 / m[k - 1] + w2 / m[k])
    d[0] = _edge(h[0], h[1], m[0], m[1])
    d[n - 1] = _edge(h[n - 2], h[n - 3], m[n - 2], m[n - 3])
    return d


def validate_tracks(raw, duration):
    """The tracks of a request, checked again here (the backend checked the structure; this service knows the length of the video)."""
    if not isinstance(raw, list) or not raw:
        raise Rejected("no tracks")
    if len(raw) > MAX_TRACKS:
        raise Rejected(f"at most {MAX_TRACKS} tracks")
    tracks = []
    for i, tr in enumerate(raw, 1):
        if not isinstance(tr, dict) or tr.get("type") not in ("rect", "ellipse"):
            raise Rejected(f"track {i}: unknown type")
        interp = tr.get("interp") or "pchip"
        if interp not in ("pchip", "linear"):
            raise Rejected(f"track {i}: unknown interpolation")
        keys_raw = tr.get("keys")
        if not isinstance(keys_raw, list) or not 1 <= len(keys_raw) <= MAX_KEYS:
            raise Rejected(f"track {i}: between 1 and {MAX_KEYS} keyframes")
        keys = []
        for j, k in enumerate(keys_raw, 1):
            try:
                t, x, y, w, h = (float(k[c]) for c in ("t", "x", "y", "w", "h"))
            except (KeyError, TypeError, ValueError):
                raise Rejected(f"track {i}, keyframe {j}: not a number")
            if not all(math.isfinite(v) for v in (t, x, y, w, h)):
                raise Rejected(f"track {i}, keyframe {j}: not a number")
            if t < 0 or t > duration + MIN_GAP:
                raise Rejected(f"track {i}, keyframe {j}: time after the end of the video")
            if keys and t - keys[-1][0] < MIN_GAP:
                raise Rejected(f"track {i}, keyframe {j}: times must increase")
            x1, y1 = min(1.0, max(0.0, x)), min(1.0, max(0.0, y))
            x2, y2 = min(1.0, max(0.0, x + w)), min(1.0, max(0.0, y + h))
            if x2 - x1 < MI.MIN_SIZE or y2 - y1 < MI.MIN_SIZE:
                raise Rejected(f"track {i}, keyframe {j}: box too small or outside the picture")
            keys.append((t, x1, y1, x2 - x1, y2 - y1))
        end = tr.get("end")
        if end is not None:
            try:
                end = float(end)
            except (TypeError, ValueError):
                raise Rejected(f"track {i}: the end is not a number")
            if not math.isfinite(end) or end < keys[-1][0]:
                raise Rejected(f"track {i}: the end must be after the last keyframe")
            end = min(end, duration)
        tracks.append(Track(tr["type"], keys, end, interp))
    return tracks


# ---------- jobs: progress and cancel ----------

class Job:
    def __init__(self, job_id):
        self.id, self.percent, self.state = job_id, 0, "queued"
        self.cancel = threading.Event()


_JOBS = {}
_TOMBSTONES = {}
_JOBS_LOCK = threading.Lock()


def register(job_id):
    with _JOBS_LOCK:
        job = _JOBS[job_id] = Job(job_id)
        if _TOMBSTONES.pop(job_id, None) is not None:   # a cancel that arrived before the request
            job.cancel.set()
        for k in [k for k, v in _TOMBSTONES.items() if time.time() - v > 600]:
            del _TOMBSTONES[k]
        for k in [k for k, j in _JOBS.items() if j.state in ("done", "failed", "cancelled") and k != job_id][:-50]:
            del _JOBS[k]
    return job


def progress(job_id):
    with _JOBS_LOCK:
        j = _JOBS.get(job_id)
        return {"percent": j.percent, "state": j.state} if j else {"percent": 0, "state": "unknown"}


def cancel(job_id):
    with _JOBS_LOCK:
        j = _JOBS.get(job_id)
        if j:
            j.cancel.set()
        else:
            _TOMBSTONES[job_id] = time.time()


# ---------- ffmpeg ----------

def _low(cmd):
    return (["nice", "-n", str(NICE)] if NICE and shutil.which("nice") else []) + cmd


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:format=duration",
                          "-of", "json", path], capture_output=True, text=True, timeout=60)
    import json
    info = json.loads(out.stdout or "{}")
    video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not video or not video.get("width"):
        return None
    w, h = int(video["width"]), int(video["height"])
    rot = 0
    for sd in video.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    if abs(rot) % 180 == 90:
        w, h = h, w

    def rate(s):
        try:
            n, d = s.split("/")
            return float(n) / float(d) if float(d) else 0.0
        except (ValueError, AttributeError):
            return 0.0
    fps = rate(video.get("avg_frame_rate")) or rate(video.get("r_frame_rate")) or 25.0
    return {"w": w, "h": h, "fps": fps, "duration": float(info.get("format", {}).get("duration", 0) or 0),
            "audio": audio.get("codec_name") if audio else None}


def fit(w, h, max_side):
    s = min(1.0, max_side / max(w, h))
    return max(2, int(w * s) // 2 * 2), max(2, int(h * s) // 2 * 2)


def read_frames(path, fps, w, h):
    cmd = _low(["ffmpeg", "-v", "error", "-nostdin", "-threads", FFMPEG_THREADS, "-i", path, "-vf", f"fps={fps:.5f},scale={w}:{h}",
                "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"])
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = w * h * 3
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3).copy()
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()


def _detail(a):
    """The amount of fine detail (mean absolute Laplacian of the grey picture): pixelated blur has almost none."""
    g = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
    return float(np.mean(np.abs(cv2.Laplacian(g, cv2.CV_32F))))


# ---------- render ----------

def sweep_stale(blurred_root, max_age=STALE_SECONDS):
    """At start: delete the files of renders that were cut off (the service stopped in the middle): job files and .part files older than max_age."""
    base = os.path.join(blurred_root, "manual")
    removed = 0
    for d, _, files in os.walk(base):
        for f in files:
            rel = os.path.relpath(os.path.join(d, f), blurred_root).replace(os.sep, "/")
            if f.endswith(".part") or MI.VIDEO_TMP_RE.match(rel):
                p = os.path.join(d, f)
                try:
                    if time.time() - os.path.getmtime(p) > max_age:
                        os.remove(p)
                        removed += 1
                except OSError:
                    pass
    return removed


def _frame_boxes(tracks, fps, total, pad):
    """For every frame the boxes (kind, x1, y1, x2, y2) of the tracks that are active, as shares of the picture. t = frame / fps (the time the
    frame is shown at). Also tells which frames are inside a track (not only in its padding)."""
    boxes, inside = [], []
    for fr in range(total):
        t = fr / fps
        bs, ins = [], False
        for tr in tracks:
            b = tr.box_at(t, pad)
            if b:
                bs.append((tr.kind,) + b)
                if tr.box_at(t, 0):
                    ins = True
        boxes.append(bs)
        inside.append(ins)
    return boxes, inside


def _pick_samples(boxes, inside, k=SAMPLES):
    cand = [fr for fr, ok in enumerate(inside) if ok]
    if not cand:
        return []
    if len(cand) <= k:
        return cand
    return sorted({cand[int(i * (len(cand) - 1) / (k - 1))] for i in range(k)})


def _inner(box):
    """The part of a box that surely is inside the shape (the inscribed rectangle of an ellipse, a little smaller than the box)."""
    kind, x1, y1, x2, y2 = box
    mx = (x2 - x1) * (0.2 if kind == "ellipse" else 0.04)
    my = (y2 - y1) * (0.2 if kind == "ellipse" else 0.04)
    return x1 + mx, y1 + my, x2 - mx, y2 - my


def render(base_path, out_path, tracks_raw, job, pad_frames=2, max_frames=None):
    """Render the video with the blur to out_path (written as out_path + '.part' and moved there at the end). `job` is a Job (progress, cancel).
    Returns a dict about the result. Raises Rejected (the request cannot be done), Cancelled, SelfCheckFailed, or another error."""
    info = probe(base_path)
    if not info:
        raise Rejected("no video stream")
    if info["duration"] > MAX_VIDEO_SEC:
        raise Rejected("video too long")
    tracks = validate_tracks(tracks_raw, info["duration"])
    fps = min(info["fps"], MAX_OUTPUT_FPS)
    rw, rh = fit(info["w"], info["h"], OUTPUT_MAX_SIDE)
    total = max(1, int(round(info["duration"] * fps)))
    pad = max(0, int(pad_frames)) / fps
    boxes, inside = _frame_boxes(tracks, fps, total + 2, pad)
    samples = set(_pick_samples(boxes, inside))

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    part = out_path + ".part"
    enc = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{rw}x{rh}", "-r", f"{fps:.5f}", "-i", "pipe:0"]
    if info["audio"]:
        enc += ["-i", base_path, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "copy" if info["audio"] == "aac" else "aac", "-b:a", "128k", "-shortest"]
    enc += ["-c:v", "libx264", "-preset", "veryfast", "-crf", CRF, "-pix_fmt", "yuv420p", "-threads", FFMPEG_THREADS, "-movflags", "+faststart", "-f", "mp4", part]
    proc = subprocess.Popen(_low(enc), stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    kept = {}
    written = 0
    ok = False
    try:
        job.state = "rendering"
        for fr, frame in enumerate(read_frames(base_path, fps, rw, rh)):
            if job.cancel.is_set():
                raise Cancelled()
            if max_frames is not None and fr >= max_frames:
                break
            if fr in samples:
                kept[fr] = frame.copy()          # the frame as it was, to compare the result with
            if fr < len(boxes) and boxes[fr]:
                MI.apply_shapes(frame, [(k, x1, y1, x2, y2) for k, x1, y1, x2, y2 in boxes[fr]])
            try:
                proc.stdin.write(frame.tobytes())
            except (BrokenPipeError, OSError):
                raise RuntimeError("the encoder stopped")
            written += 1
            if written % 15 == 0:
                job.percent = min(98, int(100 * written / total))
        proc.stdin.close()
        rc = proc.wait()
        if rc != 0:
            raise RuntimeError(f"the encoder failed ({rc})")
        if written == 0:
            raise RuntimeError("no frames were decoded")
        checked = self_check(part, info, fps, rw, rh, written, kept, boxes)
        os.replace(part, out_path)
        ok = True
        job.percent, job.state = 100, "done"
        return {"width": rw, "height": rh, "fps": round(fps, 3), "frames": written, "duration": round(written / fps, 3),
                "audio": bool(info["audio"]), "samples_checked": checked}
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        if not ok:
            if os.path.exists(part):
                os.remove(part)
            job.state = "cancelled" if job.cancel.is_set() else "failed"


def self_check(path, info, fps, rw, rh, written, kept, boxes):
    """The rendered file against its own plan. Raises SelfCheckFailed. Returns how many frames were compared."""
    out = probe(path)
    if not out:
        raise SelfCheckFailed("the result has no video")
    expected = written / fps
    if abs(out["duration"] - expected) > max(0.5, 2.5 / fps):
        raise SelfCheckFailed(f"the length is {out['duration']:.2f} s, expected {expected:.2f} s")
    if bool(info["audio"]) != bool(out["audio"]):
        raise SelfCheckFailed("the audio is missing" if info["audio"] else "unexpected audio")
    if info["audio"] and out["duration"] < min(info["duration"], expected) - 0.5:
        raise SelfCheckFailed("the audio is shorter than the video")
    if not kept:
        return 0
    last = max(kept)
    checked = 0
    for fr, frame in enumerate(read_frames(path, fps, rw, rh)):
        if fr > last:
            break
        if fr not in kept:
            continue
        before, after = kept[fr], frame
        h, w = before.shape[:2]
        mask = np.ones((h, w), bool)
        for box in boxes[fr]:
            x1, y1, x2, y2 = _inner(box)
            px1, py1, px2, py2 = int(math.ceil(x1 * w)), int(math.ceil(y1 * h)), int(math.floor(x2 * w)), int(math.floor(y2 * h))
            if px2 - px1 < 8 or py2 - py1 < 8:
                continue
            d_before, d_after = _detail(before[py1:py2, px1:px2]), _detail(after[py1:py2, px1:px2])
            if d_before >= SELF_CHECK_MIN_DETAIL:
                checked += 1
                if d_after > SELF_CHECK_RATIO * d_before:
                    raise SelfCheckFailed(f"frame {fr}: the box is not blurred (detail {d_after:.1f} of {d_before:.1f})")
        for kind, x1, y1, x2, y2 in boxes[fr]:
            mask[max(0, int(y1 * h) - 2):min(h, int(math.ceil(y2 * h)) + 2), max(0, int(x1 * w) - 2):min(w, int(math.ceil(x2 * w)) + 2)] = False
        if mask.sum() > h * w * 0.1:
            diff = float(np.abs(before.astype(np.int16) - after.astype(np.int16)).mean(axis=2)[mask].mean())
            if diff > SELF_CHECK_OUTSIDE:
                raise SelfCheckFailed(f"frame {fr}: the picture outside the boxes changed (difference {diff:.1f})")
    return checked

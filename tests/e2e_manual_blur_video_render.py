"""End-to-end test of the manual blur of VIDEOS with the REAL moderation service (MANUAL_BLUR_VIDEO on): a video is drawn on, the render runs as a job
with progress, readers get the manual version, and the manual version never outlives the automatic result it was made on. Also: cancelling, replacing,
and the service killed in the middle of a render.

    docker compose -p tc-mb -f docker-compose.local.yml -f tests/docker-compose.manual-blur-render.yml up -d --build
    PIXEL_LIBS=<folder with Pillow and numpy> python -I tests/e2e_manual_blur_video_render.py http://localhost:18084

Needs tests/media/short.mp4 (not in git), Pillow + numpy (or PIXEL_LIBS) and ffmpeg / ffprobe on the host, and docker (for the part that kills the service).
"""
import http.cookiejar
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402

if os.environ.get("PIXEL_LIBS"):
    sys.path.insert(0, os.environ["PIXEL_LIBS"])
from PIL import Image  # noqa: E402
import numpy as np  # noqa: E402

B = base_url(sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18084")
MEDIA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "media")
PROJECT = os.environ.get("COMPOSE_PROJECT", "tc-mb")
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def opener():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def call(op, method, path, obj=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
    req = urllib.request.Request(B + path, data=data, method=method, headers=headers or ({"Content-Type": "application/json"} if data else {}))
    try:
        with op.open(req, timeout=180) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def jcall(op, method, path, obj=None):
    st, body = call(op, method, path, obj)
    try:
        return st, json.loads(body)
    except ValueError:
        return st, None


def upload(op, name):
    with open(name if os.path.isabs(name) else os.path.join(MEDIA, name), "rb") as fh:
        name = os.path.basename(name)
        data = fh.read() + uuid.uuid4().bytes
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: video/mp4\r\n\r\n").encode() + data + f"\r\n--{bnd}--\r\n".encode()
    st, resp = call(op, "POST", "/api/admin/upload", raw=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
    return re.search(r"/api/files/([0-9a-f]{40})", json.loads(resp)["url"]).group(1), data


def wait_checked(op, fid, timeout=600):
    end = time.time() + timeout
    while time.time() < end:
        st, info = jcall(op, "GET", f"/api/files/{fid}/moderation")
        if st == 200 and info["status"] != "pending" and info.get("autoDecision"):
            return info
        time.sleep(2)
    raise SystemExit(f"timeout: the check of {fid} did not finish")


def wait_job(op, url, states=("done", "failed", "cancelled"), timeout=180):
    seen, end = [], time.time() + timeout
    while time.time() < end:
        st, s = jcall(op, "GET", url)
        job = (s or {}).get("job") or {}
        if job.get("percent"):
            seen.append(job["percent"])
        if job.get("state") in states:
            return job, s, seen
        time.sleep(0.5)
    raise SystemExit("timeout: the render did not end")


def ffprobe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,duration,width,height", "-of", "json", path], capture_output=True, text=True)
    return {s["codec_type"]: s for s in json.loads(out.stdout)["streams"]}


def frame_png(path, t):
    p = tempfile.mktemp(suffix=".png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", path, "-frames:v", "1", p], check=True)
    with Image.open(p) as im:
        a = np.asarray(im.convert("RGB")).astype(int)
    os.remove(p)
    return a


def lap(a):
    g = a.mean(axis=2)
    return float(np.abs(g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]).mean())


def pixelated(a, box):
    """The picture `a` with the box (x1, y1, x2, y2 as shares) pixelated the way the renderer does (6 blocks across the shorter side)."""
    h, w = a.shape[:2]
    x1, y1, x2, y2 = int(box[0] * w), int(box[1] * h), int(-(-box[2] * w // 1)), int(-(-box[3] * h // 1))
    roi = Image.fromarray(a[y1:y2, x1:x2].astype("uint8"))
    rw, rh = roi.size
    sc = 6 / min(rw, rh)
    small = roi.resize((max(1, int(rw * sc)), max(1, int(rh * sc))), Image.BOX)
    out = a.copy()
    out[y1:y2, x1:x2] = np.asarray(small.resize((rw, rh), Image.BILINEAR)).astype(int)
    return out


def tmp_files():
    out = subprocess.run(["docker", "exec", f"{PROJECT}-moderation-1", "sh", "-c", "find /blurred/manual -type f 2>/dev/null"], capture_output=True, text=True)
    return [l for l in out.stdout.split() if l]


admin, reader = opener(), opener()
call(admin, "GET", "/auth/dev-login")
call(reader, "GET", "/auth/dev-login?email=reader-vrender@example.com")

fid, original_bytes = upload(admin, "short.mp4")
info = wait_checked(admin, fid)
print(f"     automatic result: {info['status']} ({info.get('autoDecision')})")
if info["status"] not in ("open", "regional"):
    call(admin, "POST", "/api/admin/files/moderation", {"id": fid, "status": "open"})   # a decision by hand: the base is the original
    info = jcall(admin, "GET", f"/api/files/{fid}/moderation")[1]
URL = f"/api/admin/files/{fid}/manual-blur"
st, state = jcall(admin, "GET", URL)
check("the tool is available for the video", st == 200 and state["available"], state)
base_kind = state["base"]
print(f"     base: {base_kind}")

st, base_bytes = call(admin, "GET", f"/api/files/{fid}?view=base")
base_path = tempfile.mktemp(suffix=".mp4")
open(base_path, "wb").write(base_bytes)
bp = ffprobe(base_path)
base_dur = float(bp["video"]["duration"])
w, h = int(bp["video"]["width"]), int(bp["video"]["height"])
print(f"     base video: {w}x{h}, {base_dur:.1f} s, audio: {'audio' in bp}")

# 1. a render as a job. The box is put over the part of the picture that has the most detail: over a flat area a blur proves nothing.
probe_frame = frame_png(base_path, 1.5)
bw, bh = int(0.3 * w), int(0.3 * h)
best = max(((lap(probe_frame[y:y + bh, x:x + bw]), x, y) for y in range(0, h - bh, max(1, bh // 3)) for x in range(0, w - bw, max(1, bw // 3))))
BX, BY = best[1] / w, best[2] / h
print(f"     the box goes where the detail is: x={BX:.2f} y={BY:.2f} (detail {best[0]:.1f})")
RECT = {"type": "rect", "keys": [{"t": 0.5, "x": BX, "y": BY, "w": 0.3, "h": 0.3}, {"t": 2.5, "x": BX, "y": BY, "w": 0.3, "h": 0.3}]}
st, resp = jcall(admin, "POST", URL, {"tracks": [RECT]})
check("saving answers 202 (a job), not a finished render", st == 202 and resp.get("state") in ("queued", "rendering"), (st, resp))
job, state, seen = wait_job(admin, URL)
check("the job ends 'done' at 100%", job["state"] == "done" and job["percent"] == 100, job)
check("the manual version is active and the tracks are returned", state["active"] is True and len(state["tracks"]) == 1, state)
st, info = jcall(admin, "GET", f"/api/files/{fid}/moderation")
check("readers' variant is 'manual', with a version tag", info["publicVariant"] == "manual" and bool(info.get("rev")) and info["manualBlur"]["active"], (info["publicVariant"], info.get("rev")))

st, served = call(admin, "GET", f"/api/files/{fid}?view=public")
manual_path = tempfile.mktemp(suffix=".mp4")
open(manual_path, "wb").write(served)
mp = ffprobe(manual_path)
check("a reader's file is an mp4 video of the same length", float(mp["video"]["duration"]) > 0 and abs(float(mp["video"]["duration"]) - base_dur) < 0.35, (mp["video"]["duration"], base_dur))
check("the audio is kept (and in step with the video)", ("audio" in mp) == ("audio" in bp) and ("audio" not in mp or abs(float(mp["audio"]["duration"]) - float(mp["video"]["duration"])) < 0.3), mp.get("audio"))
check("same size", (int(mp["video"]["width"]), int(mp["video"]["height"])) == (w, h), (mp["video"]["width"], mp["video"]["height"]))
check("a reader gets exactly that file", call(reader, "GET", f"/api/files/{fid}")[1] == served)
check("Range requests work on it (a player seeks)", call(admin, "GET", f"/api/files/{fid}?view=public")[0] == 200)
req = urllib.request.Request(B + f"/api/files/{fid}", headers={"Range": "bytes=0-99"})
rd = opener(); call(rd, "GET", "/auth/dev-login?email=reader-range@example.com")
try:
    with rd.open(req) as r:
        check("a Range request gets 206 and 100 bytes", r.status == 206 and len(r.read()) == 100)
except urllib.error.HTTPError as e:
    check("a Range request gets 206 and 100 bytes", False, e.code)
check("the original is untouched", call(admin, "GET", f"/api/files/{fid}")[1] == original_bytes)
check("the automatic version (?view=base) is untouched", call(admin, "GET", f"/api/files/{fid}?view=base")[1] == base_bytes)

# the picture: inside the box at 1.5 s the detail is gone, outside it is the video
t = 1.5
b, m = frame_png(base_path, t), frame_png(manual_path, t)
region = (slice(int(BY * h) + 6, int((BY + 0.3) * h) - 6), slice(int(BX * w) + 6, int((BX + 0.3) * w) - 6))
if lap(b[region]) > 3:   # a flat part of a real video proves nothing; the picture is checked on a synthetic video with detail below
    check("at 1.5 s the area of the box is blurred", lap(m[region]) < lap(b[region]) * 0.4, (lap(m[region]), lap(b[region])))
else:
    print(f"SKIP the pixel check on this video: the area of the box has little detail ({lap(b[region]):.1f}); see the synthetic video below")
out_mask = np.ones(b.shape[:2], bool)
out_mask[max(0, int(BY * h) - 4):int((BY + 0.3) * h) + 4, max(0, int(BX * w) - 4):int((BX + 0.3) * w) + 4] = False
check("outside the boxes the picture is the video (only re-encoded)", np.abs(m - b).mean(axis=2)[out_mask].mean() < 8)
b0, m0 = frame_png(base_path, 0.1), frame_png(manual_path, 0.1)
r0 = region
check("before the first keyframe nothing is blurred (the same area at 0.1 s)", lap(m0[r0]) > lap(b0[r0]) * 0.6 or lap(b0[r0]) < 2, (lap(m0[r0]), lap(b0[r0])))

# 2. a newer save replaces a render that is still running
RECT2 = {"type": "ellipse", "keys": [{"t": 0, "x": 0.6, "y": 0.1, "w": 0.3, "h": 0.4}], "end": 2}
st1, _ = jcall(admin, "POST", URL, {"tracks": [RECT, RECT2]})
st2, _ = jcall(admin, "POST", URL, {"tracks": [RECT2]})
check("two saves in a row are both accepted", st1 == 202 and st2 == 202, (st1, st2))
job, state, _ = wait_job(admin, URL)
check("the newer save wins: one track", job["state"] == "done" and len(state["tracks"]) == 1 and state["tracks"][0]["type"] == "ellipse", state["tracks"])
check("no job file is left in the volume", all(".mp4" not in f or re.search(r"/[0-9a-f]{40}\.mp4$", f) for f in tmp_files()), tmp_files())

# 3. cleared while rendering
jcall(admin, "POST", URL, {"tracks": [RECT]})
st, cleared = jcall(admin, "DELETE", URL)
time.sleep(4)
st, state = jcall(admin, "GET", URL)
check("DELETE during a render: nothing is active afterwards and readers get the automatic version", not state.get("active") and call(reader, "GET", f"/api/files/{fid}")[1] == base_bytes, state.get("job"))
check("... and nothing is left in the volume", tmp_files() == [], tmp_files())

# 4. 'check again' while the manual version exists, and while it renders
jcall(admin, "POST", URL, {"tracks": [RECT]})
wait_job(admin, URL)
before = call(reader, "GET", f"/api/files/{fid}")[1]
jcall(admin, "POST", URL, {"tracks": [RECT2]})
jcall(admin, "POST", "/api/admin/files/reprocess", {"id": fid})
wait_job(admin, URL)
info = wait_checked(admin, fid)
st, state = jcall(admin, "GET", URL)
check("after 'check again' the manual version is not active (stale) and readers do not get it", not state.get("active") and info["publicVariant"] != "manual", (state.get("active"), info["publicVariant"]))
check("the saved tracks are kept so they can be saved again", len(state["tracks"]) >= 1)
st, resp = jcall(admin, "POST", URL, {"tracks": state["tracks"]})
job, state, _ = wait_job(admin, URL)
check("saving again makes it valid on the new result", job["state"] == "done" and state["active"] is True)
jcall(admin, "DELETE", URL)

# 5. the service is killed in the middle of a render
jcall(admin, "POST", URL, {"tracks": [RECT]})
wait_job(admin, URL)
good = call(reader, "GET", f"/api/files/{fid}")[1]
check("setup: a manual version is served", good != base_bytes)
# a render that takes long enough to be cut off: 30 big ellipses (the most there can be) on every frame
heavy = [{"type": "ellipse", "keys": [{"t": i * 0.03, "x": 0.02 + (i % 5) * 0.02, "y": 0.02, "w": 0.9, "h": 0.9} for i in range(200)]} for _ in range(30)]
st, _ = jcall(admin, "POST", URL, {"tracks": heavy})
check("the heavy render is accepted", st == 202, st)
for _ in range(240):
    st, s = jcall(admin, "GET", URL)
    j = (s or {}).get("job") or {}
    if j.get("state") == "rendering" and j.get("percent", 0) >= 1:
        break
    time.sleep(0.25)
print(f"     killing the service while the render is at {j.get('percent')}%")
subprocess.run(["docker", "kill", f"{PROJECT}-moderation-1"], capture_output=True)
job, state, _ = wait_job(admin, URL, timeout=120)
check("the service died: the job is 'failed' (not stuck)", job["state"] == "failed", job)
check("the earlier manual version is still what readers get", call(reader, "GET", f"/api/files/{fid}")[1] == good)
check("the saved tracks are still the earlier ones", len(state["tracks"]) == 1, len(state["tracks"]))
subprocess.run(["docker", "start", f"{PROJECT}-moderation-1"], capture_output=True)
for _ in range(60):
    if subprocess.run(["docker", "inspect", "-f", "{{.State.Health.Status}}", f"{PROJECT}-moderation-1"], capture_output=True, text=True).stdout.strip() == "healthy":
        break
    time.sleep(3)
left = [f for f in tmp_files() if f.endswith(".part") or re.search(r"\.[0-9a-f]{16}\.mp4$", f)]
print(f"     files left by the killed render: {len(left)}")
check("the killed render left a partial file behind (so the sweep has something to do)", len(left) >= 1, left)
swept = subprocess.run(["docker", "exec", f"{PROJECT}-moderation-1", "python", "-c", "import manual_video; print(manual_video.sweep_stale('/blurred', 0))"], capture_output=True, text=True).stdout.strip()
check("the sweep at start deletes what a killed render leaves (here: with max age 0)", str(len(left)) == swept and all(f.endswith(".mp4") and re.search(r"/[0-9a-f]{40}\.mp4$", f) for f in tmp_files()), (len(left), swept, tmp_files()))
st, resp = jcall(admin, "POST", URL, {"tracks": [RECT]})
job, state, _ = wait_job(admin, URL)
check("after the service is back a new render works", job["state"] == "done", job)
jcall(admin, "DELETE", URL)
check("clean at the end: no files of the manual blur in the volume", tmp_files() == [], tmp_files())

# 6. the picture, on a synthetic video that is full of detail (an "open" video: the base is the original)
syn = tempfile.mktemp(suffix="-detail.mp4")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", syn], check=True)
sid, syn_bytes = upload(admin, syn)
sinfo = wait_checked(admin, sid)
print(f"     synthetic video: {sinfo['status']} ({sinfo.get('autoDecision')})")
if sinfo["status"] != "open":
    call(admin, "POST", "/api/admin/files/moderation", {"id": sid, "status": "open"})
SURL = f"/api/admin/files/{sid}/manual-blur"
TRK = {"type": "rect", "keys": [{"t": 1, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}, {"t": 3, "x": 0.5, "y": 0.2, "w": 0.3, "h": 0.4}]}
ELL = {"type": "ellipse", "keys": [{"t": 0, "x": 0.45, "y": 0.6, "w": 0.4, "h": 0.3}], "end": 2.0}
st, resp = jcall(admin, "POST", SURL, {"tracks": [TRK, ELL]})
job, sstate, _ = wait_job(admin, SURL)
check("synthetic video: base = original, the render is done", st == 202 and sstate["base"] == "original" and job["state"] == "done", (st, sstate.get("base"), job))
sbase = tempfile.mktemp(suffix=".mp4")
open(sbase, "wb").write(call(admin, "GET", f"/api/files/{sid}?view=base")[1])
smanual = tempfile.mktemp(suffix=".mp4")
open(smanual, "wb").write(call(admin, "GET", f"/api/files/{sid}?view=public")[1])
check("the original is untouched", call(admin, "GET", f"/api/files/{sid}")[1] == syn_bytes)
sp = ffprobe(smanual)
check("length and audio are kept", abs(float(sp["video"]["duration"]) - 5.0) < 0.3 and "audio" in sp and abs(float(sp["audio"]["duration"]) - 5.0) < 0.3, sp)
sw, sh = int(sp["video"]["width"]), int(sp["video"]["height"])
# at 2.0 s the rectangle is half way (x = 0.3 .. 0.6); the ellipse is at its end second (the padding of 2 frames, 0.08 s, keeps it to 2.08 s)
# the rectangle: the whole box, as the renderer pixelates it; the picture inside it (a shrunk copy of it, away from the edges) must be that, not the video
for t_check, label, full, blurred in [
        (2.0, "the moving rectangle (at 2.0 s, half way between its keyframes: x 0.3 .. 0.6)", (0.3, 0.2, 0.6, 0.6), True),
        (1.0, "the rectangle at its first keyframe (x 0.1 .. 0.4)", (0.1, 0.2, 0.4, 0.6), True),
        (3.0, "the rectangle at its last keyframe (x 0.5 .. 0.8)", (0.5, 0.2, 0.8, 0.6), True),
        (0.5, "the rectangle before its first keyframe", (0.1, 0.2, 0.4, 0.6), False)]:
    a, b = frame_png(sbase, t_check), frame_png(smanual, t_check)
    expected = pixelated(a, full)
    inner = (slice(int((full[1] + 0.04) * sh), int((full[3] - 0.04) * sh)), slice(int((full[0] + 0.03) * sw), int((full[2] - 0.03) * sw)))
    e_manual, e_base = np.abs(b[inner] - expected[inner]).mean(), np.abs(a[inner] - expected[inner]).mean()
    if blurred:
        check(f"{label}: blurred", e_manual < 0.5 * e_base and e_base > 6, f"the result differs {e_manual:.1f} from the expected blur, the video {e_base:.1f}")
    else:
        check(f"{label}: not blurred", np.abs(b[inner] - a[inner]).mean() < 5, f"difference from the video {np.abs(b[inner] - a[inner]).mean():.1f}")
for t_check, label, box, blurred in [
        (1.0, "the ellipse (inside it, before its end)", (0.55, 0.68, 0.75, 0.82), True),
        (2.4, "the ellipse after its end second", (0.55, 0.68, 0.75, 0.82), False)]:
    a, b = frame_png(sbase, t_check), frame_png(smanual, t_check)
    reg = (slice(int(box[1] * sh), int(box[3] * sh)), slice(int(box[0] * sw), int(box[2] * sw)))
    ratio = lap(b[reg]) / max(lap(a[reg]), 1e-6)
    check(f"{label}: {'blurred' if blurred else 'not blurred'}", ratio < 0.35 if blurred else ratio > 0.7, f"detail ratio {ratio:.2f}")
a, b = frame_png(sbase, 2.0), frame_png(smanual, 2.0)
mask = np.ones(a.shape[:2], bool)
mask[int(0.15 * sh):int(0.65 * sh), int(0.25 * sw):int(0.65 * sw)] = False
mask[int(0.55 * sh):int(0.95 * sh), int(0.4 * sw):int(0.9 * sw)] = False
check("outside the shapes the picture is the video (only re-encoded)", np.abs(a - b).mean(axis=2)[mask].mean() < 8, f"{np.abs(a - b).mean(axis=2)[mask].mean():.1f}")
check("readers get the manual version of it; clearing returns the original", call(reader, "GET", f"/api/files/{sid}")[1] == open(smanual, "rb").read()
      and jcall(admin, "DELETE", SURL)[1]["active"] is False and call(reader, "GET", f"/api/files/{sid}")[1] == syn_bytes)
check("clean at the end: no files of the manual blur in the volume", tmp_files() == [], tmp_files())

for p in (base_path, manual_path, syn, sbase, smanual):
    os.path.exists(p) and os.remove(p)
print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED: ' + str(failures)}")
sys.exit(1 if failures else 0)

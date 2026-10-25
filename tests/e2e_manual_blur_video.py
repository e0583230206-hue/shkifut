"""End-to-end test of the manual blur API for VIDEOS (MANUAL_BLUR_VIDEO) against the LOCAL UI test stack (default http://localhost:18083, DEV_LOGIN on).

    EXPECT_FLAG=off python -I tests/e2e_manual_blur_video.py http://localhost:18083   # the stack without the flag: nothing is reachable
    EXPECT_FLAG=on  python -I tests/e2e_manual_blur_video.py http://localhost:18083   # with tests/docker-compose.manual-blur-video-test.yml (video flag only)

The stack has no moderation service, so a valid save ends in 503 here; the rendering is tested by the unit tests of the service and, with the
real service, by tests/e2e_manual_blur_video_render.py. Needs tests/media/short.mp4 (not in git).
"""
import http.cookiejar
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402

B = base_url(sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18083")
FLAG = os.environ.get("EXPECT_FLAG", "on") == "on"
MEDIA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "media")
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
        with op.open(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def jget(op, path):
    st, body = call(op, "GET", path)
    try:
        return st, json.loads(body)
    except ValueError:
        return st, None


def upload(op, path, name, mime):
    with open(path, "rb") as fh:
        data = fh.read() + uuid.uuid4().bytes   # unique content
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").encode() + data + f"\r\n--{bnd}--\r\n".encode()
    st, resp = call(op, "POST", "/api/admin/upload", raw=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
    return re.search(r"/api/files/([0-9a-f]{40})", json.loads(resp)["url"]).group(1)


def moderate(op, fid, status):
    return call(op, "POST", "/api/admin/files/moderation", {"id": fid, "status": status})[0]


admin = opener()
call(admin, "GET", "/auth/dev-login")
reader = opener()
call(reader, "GET", "/auth/dev-login?email=reader-video@example.com")
anon = opener()

vid = upload(admin, os.path.join(MEDIA, "short.mp4"), "short.mp4", "video/mp4")
img = upload(admin, os.path.join(MEDIA, "landscape_hermon.jpg"), "a.jpg", "image/jpeg")
check("setup: the video and the picture are open", moderate(admin, vid, "open") == 200 and moderate(admin, img, "open") == 200)
URL = f"/api/admin/files/{vid}/manual-blur"
IMGURL = f"/api/admin/files/{img}/manual-blur"
K = lambda t, x=0.1, y=0.1, w=0.2, h=0.2: {"t": t, "x": x, "y": y, "w": w, "h": h}   # noqa: E731
GOOD = {"tracks": [{"type": "rect", "keys": [K(1), K(3, 0.5, 0.4)]}]}

if not FLAG:
    check("flag off: GET is 404", call(admin, "GET", URL)[0] == 404)
    check("flag off: POST is 404", call(admin, "POST", URL, GOOD)[0] == 404)
    check("flag off: DELETE is 404", call(admin, "DELETE", URL)[0] == 404)
    st, info = jget(admin, f"/api/files/{vid}/moderation")
    check("flag off: the file info has no manualBlur field", st == 200 and "manualBlur" not in info, info)
    check("flag off: ?view=base gives an owner nothing special (the video as before)", call(admin, "GET", f"/api/files/{vid}?view=base")[0] == 200)
else:
    check("reader (no privileges): 401", call(reader, "GET", URL)[0] == 401)
    check("not logged in: 401", call(anon, "GET", URL)[0] == 401)
    check("reader cannot save either", call(reader, "POST", URL, GOOD)[0] == 401)

    st, state = jget(admin, URL)
    check("owner: tool available on an open video, base = original", st == 200 and state["kind"] == "video" and state["available"] and state["base"] == "original" and state["tracks"] == [], state)
    check("the answer tells the padding (frames) the renderer adds", state.get("padFrames") == 2, state.get("padFrames"))
    st, info = jget(admin, f"/api/files/{vid}/moderation")
    check("owner: the file info says the tool is available", info.get("manualBlur", {}).get("available") is True and info["manualBlur"]["active"] is False, info.get("manualBlur"))
    st, info_r = jget(reader, f"/api/files/{vid}/moderation")
    check("reader: the file info does not mention the tool", "manualBlur" not in (info_r or {}), info_r)
    check("the video flag does not turn on the picture tool (separate flags)", call(admin, "GET", IMGURL)[0] == 404)
    st, base_bytes = call(admin, "GET", f"/api/files/{vid}?view=base")
    check("owner: ?view=base serves the video (what the editor plays)", st == 200 and len(base_bytes) > 1000)
    check("reader: ?view=base is not allowed to get around anything (401 without a login is the same as always)", call(anon, "GET", f"/api/files/{vid}?view=base")[0] == 401)

    bad = {
        "unknown type": {"tracks": [{"type": "star", "keys": [K(1)]}]},
        "unknown interpolation": {"tracks": [{"type": "rect", "interp": "bezier", "keys": [K(1)]}]},
        "no keyframes": {"tracks": [{"type": "rect", "keys": []}]},
        "keyframes not increasing": {"tracks": [{"type": "rect", "keys": [K(3), K(1)]}]},
        "same moment twice": {"tracks": [{"type": "rect", "keys": [K(1), K(1.0001)]}]},
        "negative time": {"tracks": [{"type": "rect", "keys": [K(-1)]}]},
        "time after 15 minutes": {"tracks": [{"type": "rect", "keys": [K(901)]}]},
        "box too small": {"tracks": [{"type": "rect", "keys": [K(1, w=0.0001)]}]},
        "box outside the picture": {"tracks": [{"type": "rect", "keys": [K(1, x=1.5)]}]},
        "end before the last keyframe": {"tracks": [{"type": "rect", "keys": [K(1), K(3)], "end": 2}]},
        "31 tracks": {"tracks": [{"type": "rect", "keys": [K(1)]}] * 31},
        "201 keyframes": {"tracks": [{"type": "rect", "keys": [K(i * 0.01) for i in range(201)]}]},
    }
    for name, body in bad.items():
        check(f"invalid ({name}): 400", call(admin, "POST", URL, body)[0] == 400)
    check("not JSON: 400", call(admin, "POST", URL, raw=b"nope", headers={"Content-Type": "application/json"})[0] == 400)
    check("unknown file: 404", call(admin, "GET", "/api/admin/files/" + "0" * 40 + "/manual-blur")[0] == 404)

    st, _ = call(admin, "POST", URL, GOOD)
    check("valid tracks without the moderation service: 503, nothing queued", st == 503, st)
    st, state = jget(admin, URL)
    check("after the failed save: nothing is active and there is no job", state["tracks"] == [] and not state.get("active") and "job" not in state, state)
    check("readers still get the video as before", call(reader, "GET", f"/api/files/{vid}")[0] == 200)
    check("an empty list of tracks clears (and is fine when nothing is saved)", call(admin, "POST", URL, {"tracks": []})[0] == 200)
    check("DELETE is fine when nothing is saved", call(admin, "DELETE", URL)[0] == 200)

    moderate(admin, vid, "blurred")
    st, state = jget(admin, URL)
    check("a fully blurred video is editable too: the manual blur is drawn from scratch, on the original", state["available"] is True and state["base"] == "original", state)
    check("saving on it reaches the service (503 here, there is none)", call(admin, "POST", URL, GOOD)[0] == 503)

print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)

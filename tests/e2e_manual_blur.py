"""End-to-end test of the manual blur API (MANUAL_BLUR) against the LOCAL UI test stack (default http://localhost:18083, DEV_LOGIN on).

    EXPECT_FLAG=off python -I tests/e2e_manual_blur.py http://localhost:18083   # the stack without the flag: nothing is reachable
    EXPECT_FLAG=on  python -I tests/e2e_manual_blur.py http://localhost:18083   # with tests/docker-compose.manual-blur-test.yml

The stack has no moderation service, so saving a picture ends in 503 here; the rendering is tested by moderation/tests/test_manual_image.py
and, with the real service, by tests/e2e_manual_blur_render.py.
"""
import http.cookiejar
import json
import os
import re
import struct
import sys
import urllib.error
import urllib.request
import uuid
import zlib

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402

B = base_url(sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18083")
FLAG = os.environ.get("EXPECT_FLAG", "on") == "on"
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
        with op.open(req, timeout=30) as r:
            body = r.read()
            return r.status, body, r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def jget(op, path):
    st, body, _ = call(op, "GET", path)
    try:
        return st, json.loads(body)
    except ValueError:
        return st, None


def png():
    raw = b"".join(b"\x00" + bytes(range(0, 192, 4)) for _ in range(32))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 48, 32, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


GIF = bytes.fromhex("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b")


def upload(op, data, name, mime):
    data += uuid.uuid4().bytes if mime != "image/gif" else b""
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").encode() + data + f"\r\n--{bnd}--\r\n".encode()
    st, resp, _ = call(op, "POST", "/api/admin/upload", raw=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
    url = json.loads(resp)["url"]
    return re.search(r"/api/files/([0-9a-f]{40})", url).group(1)


def moderate(op, fid, status):
    st, _, _ = call(op, "POST", "/api/admin/files/moderation", {"id": fid, "status": status})
    return st


admin = opener()
call(admin, "GET", "/auth/dev-login")
reader = opener()
call(reader, "GET", "/auth/dev-login?email=reader-manual@example.com")
anon = opener()

fid = upload(admin, png(), "manual.png", "image/png")
check("setup: open the picture by hand", moderate(admin, fid, "open") == 200)
URL = f"/api/admin/files/{fid}/manual-blur"
SHAPE = {"type": "rect", "x": 0.1, "y": 0.1, "w": 0.3, "h": 0.3}

if not FLAG:
    check("flag off: GET is 404", call(admin, "GET", URL)[0] == 404)
    check("flag off: POST is 404", call(admin, "POST", URL, {"shapes": [SHAPE]})[0] == 404)
    check("flag off: DELETE is 404", call(admin, "DELETE", URL)[0] == 404)
    st, info = jget(admin, f"/api/files/{fid}/moderation")
    check("flag off: the file info has no manualBlur field", st == 200 and "manualBlur" not in info, info)
    check("flag off: the file is served as before", call(admin, "GET", f"/api/files/{fid}?view=public")[0] == 200)
else:
    check("reader (no privileges): 401", call(reader, "GET", URL)[0] == 401)
    check("not logged in: 401", call(anon, "GET", URL)[0] == 401)
    check("reader cannot save either", call(reader, "POST", URL, {"shapes": [SHAPE]})[0] == 401)

    st, state = jget(admin, URL)
    check("owner: tool is available on an open picture, base = original", st == 200 and state["available"] and state["base"] == "original" and state["shapes"] == [], state)
    st, info = jget(admin, f"/api/files/{fid}/moderation")
    check("owner: the file info says the tool is available", info.get("manualBlur", {}).get("available") is True and info["manualBlur"]["active"] is False, info.get("manualBlur"))
    st, info_r = jget(reader, f"/api/files/{fid}/moderation")
    check("reader: the file info does not mention the tool", "manualBlur" not in (info_r or {}), info_r)

    bad = {
        "unknown type": [{"type": "star", "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}],
        "too small": [{"type": "rect", "x": 0.1, "y": 0.1, "w": 0.0001, "h": 0.2}],
        "outside the picture": [{"type": "rect", "x": 1.5, "y": 0.1, "w": 0.2, "h": 0.2}],
        "51 shapes": [SHAPE] * 51,
    }
    for name, shapes in bad.items():
        check(f"invalid ({name}): 400", call(admin, "POST", URL, {"shapes": shapes})[0] == 400)
    check("not JSON: 400", call(admin, "POST", URL, raw=b"nope", headers={"Content-Type": "application/json"})[0] == 400)
    check("unknown file: 404", call(admin, "GET", "/api/admin/files/" + "0" * 40 + "/manual-blur")[0] == 404)

    st, body, _ = call(admin, "POST", URL, {"shapes": [SHAPE]})
    check("valid shapes without the moderation service: 503, nothing saved", st == 503, st)
    st, state = jget(admin, URL)
    check("after the failed save: nothing is active", state["shapes"] == [] and not state.get("active"), state)
    check("readers still get the picture as before", call(reader, "GET", f"/api/files/{fid}")[0] == 200)
    check("clearing when nothing is saved is fine", call(admin, "DELETE", URL)[0] == 200)

    moderate(admin, fid, "blurred")
    st, state = jget(admin, URL)
    check("a fully blurred picture: not available (adding blur cannot release anything)", state["available"] is False and state["reason"] == "fully_blurred", state)
    check("saving on a fully blurred picture: 409", call(admin, "POST", URL, {"shapes": [SHAPE]})[0] == 409)

    gif = upload(admin, GIF, "anim.gif", "image/gif")
    moderate(admin, gif, "open")
    st, state = jget(admin, f"/api/admin/files/{gif}/manual-blur")
    check("a GIF: not available", state["available"] is False and state["reason"] == "unsupported_format", state)

print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)

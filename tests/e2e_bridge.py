"""End-to-end test of the WhatsApp bridge API against a local stack (http://localhost:18080 by default, BASE_URL to change; DEV_LOGIN on).

    python -I tests/e2e_bridge.py

Sets a temporary api_secret_key and restores the channel settings exactly afterwards.
"""
import http.cookiejar
import json
import secrets
import struct
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
import zlib

sys.stdout.reconfigure(encoding="utf-8")  # Hebrew / emoji output on Windows consoles
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402
B = base_url(sys.argv[1] if len(sys.argv) > 1 else None)
admin = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
admin.open(B + "/auth/dev-login").read()
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    if not cond:
        failures.append(name)


def png(w=64, h=48):
    raw = b"".join(b"\x00" + bytes([(x * 4) % 256 for x in range(w)]) for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def req(path, data=None, headers=None, opener=None):
    r = urllib.request.Request(B + path, data=data, headers=headers or {})
    try:
        with (opener or urllib.request.build_opener()).open(r) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def multipart(content, name):
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + content + f"\r\n--{bnd}--\r\n".encode()
    return body, {"Content-Type": "multipart/form-data; boundary=" + bnd}


def set_settings(lst):
    req("/api/admin/settings/set", json.dumps(lst).encode(), {"Content-Type": "application/json"}, admin)


original = json.loads(req("/api/admin/settings/get", opener=admin)[1] or b"[]") or []
key = secrets.token_hex(24)
try:
    # Without a configured key the import API must be closed.
    set_settings([s for s in original if s["key"] != "api_secret_key"])
    st, _ = req("/api/import/post", json.dumps({"text": "x"}).encode(), {"Content-Type": "application/json", "X-API-Key": ""})
    check("no key configured -> post rejected", st == 401, st)

    set_settings([s for s in original if s["key"] != "api_secret_key"] + [{"key": "api_secret_key", "value": key}])
    body, hdr = multipart(png(), "bridge.png")
    st, _ = req("/api/import/upload", body, hdr)
    check("upload without key -> 401", st == 401, st)
    st, _ = req("/api/import/upload", body, {**hdr, "X-API-Key": "wrong"})
    check("upload with wrong key -> 401", st == 401, st)
    st, out = req("/api/import/upload", body, {**hdr, "X-API-Key": key})
    up = json.loads(out) if st == 200 else {}
    check("upload with key -> 200 + url", st == 200 and up.get("url", "").startswith("/api/files/"), up)

    jh = {"Content-Type": "application/json", "X-API-Key": key}
    st, _ = req("/api/import/post", json.dumps({"text": "   "}).encode(), jh)
    check("empty text -> 400", st == 400, st)

    marker = "bridge-test-" + uuid.uuid4().hex[:8]
    text = f"{marker}\n[image-embedded#]({up.get('url')})"
    st, out = req("/api/import/post", json.dumps({"text": text, "author": "WhatsApp"}).encode(), jh)
    msg = json.loads(out) if st == 200 else {}
    ts = msg.get("timestamp", "")
    check("post without timestamp -> 200, timestamp = now", st == 200 and not ts.startswith("0001"), ts)

    st, out = req("/api/messages?offset=0&limit=5")
    check("message visible to readers", st == 200 and marker.encode() in out)

    fid = up.get("url", "").rsplit("/", 1)[-1].split(".")[0]
    for _ in range(30):
        s = json.loads(req(f"/api/files/{fid}/moderation")[1])
        if s["status"] != "pending":
            break
        time.sleep(1)
    check("bridge media went through moderation", s["status"] in ("open", "regional", "blurred"), s["status"])

    # clean up the test message (soft delete, as from the admin panel)
    req(f"/api/admin/delete-message/{msg.get('id')}", opener=admin)
finally:
    set_settings(original)
    restored = json.loads(req("/api/admin/settings/get", opener=admin)[1] or b"[]") or []
    check("settings restored", restored == original)

print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)

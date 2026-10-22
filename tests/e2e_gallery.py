"""End-to-end test of galleries through the bridge API (http://localhost:18080 by default, BASE_URL to change; DEV_LOGIN on).

    python -I tests/e2e_gallery.py

A WhatsApp album arrives as several uploads plus one post with consecutive image lines. Sets a temporary
api_secret_key and restores the settings afterwards; the test message is deleted.
(The display grouping itself is covered by tests/unit/gallery.test.mjs and the browser test.)
"""
import http.cookiejar
from html import unescape
import json
import re
import struct
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402
B = base_url(sys.argv[1] if len(sys.argv) > 1 else None)
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def call(op, path, data=None, headers=None):
    r = urllib.request.Request(B + path, data=data, headers=headers or {})
    try:
        with op.open(r) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body[:1] in (b"{", b"[") else body), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def png(color):
    w, h = 80, 60
    rows = b"".join(b"\x00" + bytes(color) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


admin = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
admin.open(B + "/auth/dev-login").read()
anon = urllib.request.build_opener()
reader = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))  # files need a login (require_auth_for_view_files)
reader.open(B + "/auth/dev-login?email=reader-gallery@example.com").read()
jh = {"Content-Type": "application/json"}
original = call(admin, "/api/admin/settings/get")[1] or []
key = uuid.uuid4().hex + uuid.uuid4().hex
marker = "album-" + uuid.uuid4().hex[:6]
msg_id = None
try:
    call(admin, "/api/admin/settings/set", json.dumps([s for s in original if s["key"] != "api_secret_key"]
                                                       + [{"key": "api_secret_key", "value": key}]).encode(), jh)
    urls = []
    seed = uuid.uuid4().bytes
    for i in range(5):
        bnd = uuid.uuid4().hex
        body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"album{i}.png\"\r\n"
                f"Content-Type: image/png\r\n\r\n").encode() + png((seed[i], 40 * i, 200)) + f"\r\n--{bnd}--\r\n".encode()
        st, out, _ = call(anon, "/api/import/upload", body, {"Content-Type": "multipart/form-data; boundary=" + bnd, "X-API-Key": key})
        urls.append(out["url"] if st == 200 else None)
    check("bridge uploaded 5 album images", all(urls), urls)

    text = f"אלבום מהגשר {marker}\n" + "\n".join(f"[image-embedded#]({u})" for u in urls)
    st, out, _ = call(anon, "/api/import/post", json.dumps({"text": text, "author": "WhatsApp"}).encode(), {**jh, "X-API-Key": key})
    msg_id = out.get("id") if st == 200 else None
    check("bridge posted the album as one message", st == 200 and msg_id, st)

    st, msgs, _ = call(anon, "/api/messages?offset=0&limit=5&direction=desc")
    stored = next((m["text"] for m in msgs if m["id"] == msg_id), "")
    check("stored text keeps the plain image lines (no new format to migrate)", stored.count("[image-embedded#]") == 5, stored[:80])

    for _ in range(60):
        ids = [u.rsplit("/", 1)[1].split(".")[0] for u in urls]
        if all(call(admin, f"/api/files/{i}/moderation")[1].get("status") != "pending" for i in ids):
            break
        time.sleep(1)
    served = [call(reader, u)[2].get("Content-Type", "") for u in urls]
    check("every album image is served to readers", all(c.startswith("image/") for c in served), served)

    st, html, _ = call(anon, f"/m/{msg_id}")
    og = re.search(rb'property="og:image" content="([^"]+)"', html or b"")
    check("link preview uses the first album image", bool(og) and unescape(og.group(1).decode()).endswith(urls[0]), og and og.group(1))

    st, res, _ = call(anon, "/api/messages/search?" + urllib.parse.urlencode({"q": marker}))
    check("album message is found by its text", st == 200 and [r["id"] for r in res] == [msg_id], res)
    check("search snippet hides the image lines", st == 200 and res and "embedded" not in res[0]["snippet"], res[:1])
finally:
    if msg_id:
        call(admin, f"/api/admin/delete-message/{msg_id}")
    call(admin, "/api/admin/settings/set", json.dumps(original).encode(), jh)
    check("settings restored", (call(admin, "/api/admin/settings/get")[1] or []) == original)

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)

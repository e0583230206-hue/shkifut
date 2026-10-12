"""End-to-end test of orphan media cleanup (http://localhost:8080, DEV_LOGIN on, channel_data bind-mounted).

    python -I tests/e2e_cleanup.py
"""
import http.cookiejar
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
import uuid
import zlib

sys.stdout.reconfigure(encoding="utf-8")
B = "http://localhost:8080"
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "channel_data")
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def login(email=None):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(B + "/auth/dev-login" + (f"?email={email}" if email else "")).read()
    return op


admin = login()


def call(op, path, obj=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else b"")
    r = urllib.request.Request(B + path, data=data, headers=headers or {"Content-Type": "application/json"})
    try:
        with op.open(r) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None


def png(seed):
    raw = b"".join(b"\x00" + bytes((x * seed) % 256 for x in range(40)) for _ in range(30))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 40, 30, 8, 0, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def upload(content, name):
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: image/png\r\n\r\n").encode() + content + f"\r\n--{bnd}--\r\n".encode()
    _, r = call(admin, "/api/admin/upload", raw=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
    fid = r["url"].rsplit("/", 1)[1].split(".")[0]
    return fid, r["url"]


def yaml_path(fid):
    return os.path.join(DATA, fid[:2], fid[2:4], fid + ".yaml")


def age(fid, days):
    """Pretend the file was uploaded `days` ago (after its moderation finished, so nothing rewrites it)."""
    for _ in range(60):
        st = json.loads(urllib.request.urlopen(f"{B}/api/files/{fid}/moderation").read())["status"]
        if st != "pending":
            break
        time.sleep(1)
    old = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - days * 86400))
    text = open(yaml_path(fid), encoding="utf-8").read()
    lines = [l for l in text.splitlines() if not l.startswith("uploadedAt:")]
    open(yaml_path(fid), "w", encoding="utf-8").write("\n".join(lines + [f'uploadedAt: "{old}"']) + "\n")


def status(fid):
    try:
        with urllib.request.urlopen(f"{B}/api/files/{fid}") as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


seed = int(time.time()) % 200 + 3
content_used = png(seed)
a, a_url = upload(content_used, "used.png")             # referenced by a message
b, _ = upload(png(seed + 1), "orphan.png")             # unused, unique content
c, _ = upload(content_used, "orphan-same-content.png")  # unused, but same content (hash) as a
d, _ = upload(png(seed + 2), "recent-orphan.png")      # unused but recent
_, msg = call(admin, "/api/admin/new", {"type": "md", "text": f"cleanup test\n[image-embedded#]({a_url})"})
for fid in (a, b, c):
    age(fid, 10)
try:
    st, rep = call(admin, "/api/admin/media/cleanup?dryRun=1&days=7")
    orph = set(rep["orphans"]) if rep else set()
    check("dry run lists old unused uploads", {b, c} <= orph, sorted(orph & {a, b, c, d}))
    check("dry run keeps the referenced upload", a not in orph)
    check("dry run keeps recent unused uploads", d not in orph)
    check("dry run deletes nothing", all(os.path.exists(yaml_path(x)) for x in (a, b, c, d)))

    st, _ = call(login(f"writer-{uuid.uuid4().hex[:6]}@example.com"), "/api/admin/media/cleanup?dryRun=1")
    check("non-admin cannot run cleanup", st == 401, st)

    st, rep = call(admin, "/api/admin/media/cleanup?dryRun=0&days=7")
    check("cleanup run", st == 200 and {b, c} <= set(rep["orphans"]), {"status": st, "freed": rep and rep.get("freedBytes"), "orphans": rep and len(rep.get("orphans", [])), "b": rep and b in rep.get("orphans", []), "c": rep and c in rep.get("orphans", [])})
    check("orphan removed (404)", status(b) == 404 and not os.path.exists(yaml_path(b)))
    check("orphan sharing content removed, content kept for the used upload",
          not os.path.exists(yaml_path(c)) and status(a) == 200)
    check("referenced upload intact", os.path.exists(yaml_path(a)) and status(a) == 200)
    check("recent unused upload intact", os.path.exists(yaml_path(d)))
finally:
    if msg:
        admin.open(B + f"/api/admin/delete-message/{msg['id']}").read()

print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)

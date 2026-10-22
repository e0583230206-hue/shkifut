"""End-to-end test of the channel-logo watermark against a local stack (http://localhost:18080 by default, BASE_URL to change; DEV_LOGIN on).

    python -I tests/e2e_watermark.py

Generates its own images (a red logo, a gradient "photo"), checks pixels with PIL inside the moderation
container, and restores the settings and channel details at the end.
"""
import base64
import http.cookiejar
import json
import os
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import zlib

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402
B = base_url(sys.argv[1] if len(sys.argv) > 1 else None)
COMPOSE = ["docker", "compose", "-f", "docker-compose.local.yml"]
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def call(op, path, obj=None):
    data = json.dumps(obj).encode() if obj is not None else None
    r = urllib.request.Request(B + path, data=data, headers={"Content-Type": "application/json"} if data else {})
    try:
        with op.open(r) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body[:1] in (b"{", b"[") else body)
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def fetch(op, path):
    with op.open(urllib.request.Request(B + path)) as resp:
        return resp.read(), resp.headers.get("Content-Type"), resp.headers.get("ETag")


def png(w, h, pixel):
    rows = b"".join(b"\x00" + b"".join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def upload(op, name, data):
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: image/png\r\n\r\n").encode() + data + f"\r\n--{bnd}--\r\n".encode()
    req = urllib.request.Request(B + "/api/admin/upload", data=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
    return json.loads(op.open(req).read())["url"]


ANALYZE = r'''
import base64, io, json, sys
from PIL import Image, ImageChops
d = json.load(sys.stdin)
img = lambda k: Image.open(io.BytesIO(base64.b64decode(d[k]))).convert("RGB")
out = {}
a = img("a")
out["size"] = list(a.size)
def red_share(im, box):
    px = list(im.crop(box).getdata())
    return sum(1 for r, g, b in px if r > 200 and g < 70 and b < 70) / max(1, len(px))
for name, box in d["boxes"].items():
    out["red_" + name] = round(red_share(a, box), 3)
if "ref" in d:
    ref = img("ref")
    for name, box in d.get("same", {}).items():
        diff = ImageChops.difference(a.crop(box), ref.crop(box))
        out["maxdiff_" + name] = max(max(c) for c in [diff.getextrema()[i] for i in range(3)])
print(json.dumps(out))
'''


def analyze(a, boxes, ref=None, same=None):
    payload = {"a": base64.b64encode(a).decode(), "boxes": boxes}
    if ref is not None:
        payload["ref"] = base64.b64encode(ref).decode()
        payload["same"] = same or {}
    r = subprocess.run(COMPOSE + ["exec", "-T", "moderation", "python", "-c", ANALYZE], input=json.dumps(payload).encode(),
                       capture_output=True, timeout=120, env={"MSYS_NO_PATHCONV": "1", **os.environ})
    return json.loads(r.stdout or b"{}")


admin = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
admin.open(B + "/auth/dev-login").read()
anon = urllib.request.build_opener()

orig_settings = call(admin, "/api/admin/settings/get")[1] or []
orig_info = call(anon, "/api/channel/info")[1]

W, H = 600, 400
seed = uuid.uuid4().bytes  # unique pixels -> a fresh upload (no dedup with earlier runs)
photo = png(W, H, lambda x, y: (20 + (x * 100) // W, 90 + (y * 120) // H, 160 + seed[(x + y) % 16] % 40))
logo = png(120, 60, lambda x, y: (255, 0, 0))
LW, LH = 120, 60   # 20% of the width -> 120 x 60
M = int(W * 0.03)  # margin
BL = (M, H - LH - M, M + LW, H - M)
TR = (W - LW - M, M, W - M, M + LH)
inner = lambda b: (b[0] + 6, b[1] + 6, b[2] - 6, b[3] - 6)  # ignore anti-aliased edges


def set_watermark(**kw):
    base = [s for s in orig_settings if not s["key"].startswith("watermark_")]
    st, _ = call(admin, "/api/admin/settings/set", base + [{"key": f"watermark_{k}", "value": v} for k, v in kw.items()])
    return st


try:
    logo_url = upload(admin, "logo.png", logo)
    call(admin, "/api/admin/edit-channel-info", {"name": orig_info["name"], "description": orig_info["description"], "logoUrl": logo_url})
    url = upload(admin, "photo.png", photo)
    fid = url.rsplit("/", 1)[1].split(".")[0]
    for _ in range(60):
        if call(admin, f"/api/files/{fid}/moderation")[1].get("status") != "pending":
            break
        time.sleep(1)
    check("test photo is open after the automatic check (no people)", call(admin, f"/api/files/{fid}/moderation")[1].get("status") == "open")

    set_watermark(enabled=True, position="bottom-left", size=20, opacity=100)
    a, ctype, etag1 = fetch(anon, url)
    m = analyze(a, {"bl": inner(BL), "tr": inner(TR)}, ref=photo, same={"top": (0, 0, W, H // 2)})
    check("reader gets the same image size", m.get("size") == [W, H], m.get("size"))
    check("logo at bottom-left (solid red)", m.get("red_bl", 0) > 0.95, m.get("red_bl"))
    check("rest of the image untouched (pixel-identical)", m.get("maxdiff_top") == 0, m.get("maxdiff_top"))
    check("PNG stays PNG", ctype == "image/png", ctype)

    o, _, _ = fetch(admin, url)
    check("moderator gets the original without a watermark", o == photo)
    p, _, _ = fetch(admin, url + "?view=public")
    check("moderator ?view=public shows the reader version", p == a)

    set_watermark(enabled=True, position="top-right", size=20, opacity=100)
    a2, _, etag2 = fetch(anon, url)
    m = analyze(a2, {"bl": inner(BL), "tr": inner(TR)})
    check("position setting moves the logo to top-right", m.get("red_tr", 0) > 0.95 and m.get("red_bl", 1) < 0.05, m)
    check("ETag changes with the configuration", etag1 != etag2, (etag1, etag2))
    for _ in range(60):
        if call(admin, f"/api/files/{logo_url.rsplit('/', 1)[1].split('.')[0]}/moderation")[1].get("status") != "pending":
            break
        time.sleep(1)
    lg, _, _ = fetch(anon, logo_url)
    check("the logo file itself is never watermarked", lg == logo)

    # blurred: the watermark must be applied AFTER blurring (a crisp logo on a blurred image)
    call(admin, "/api/admin/files/moderation", {"id": fid, "status": "blurred"})
    b, ctype, _ = fetch(anon, url)
    hsh = None
    meta = subprocess.run(COMPOSE + ["exec", "-T", "backend", "sh", "-c", f"cat /app/files/{fid[:2]}/{fid[2:4]}/{fid}.yaml"],
                          capture_output=True, timeout=30, env={"MSYS_NO_PATHCONV": "1", **os.environ}).stdout.decode()
    for line in meta.splitlines():
        if line.startswith("hash:"):
            hsh = line.split(":", 1)[1].strip()
    raw = subprocess.run(COMPOSE + ["exec", "-T", "backend", "cat", f"/app/blurred/{hsh[:2]}/{hsh[2:4]}/{hsh}.jpg"],
                         capture_output=True, timeout=30, env={"MSYS_NO_PATHCONV": "1", **os.environ}).stdout
    check("blurred version served to the reader as JPEG", ctype == "image/jpeg" and len(raw) > 0, ctype)
    m = analyze(b, {"tr": inner(TR)}, ref=raw, same={"bottom": (0, H // 2, W, H)})
    check("logo on the blurred image is crisp (watermark after blur)", m.get("red_tr", 0) > 0.9, m.get("red_tr"))
    check("outside the logo it is exactly the blurred version (JPEG noise only)", m.get("maxdiff_bottom", 99) <= 12, m.get("maxdiff_bottom"))

    # phone photo: JPEG stored sideways with EXIF orientation 6 -> must come out upright, logo in the right corner
    make = ("import io,sys,uuid;from PIL import Image;im=Image.new('RGB',(300,200),(40,120,200));"
            "im.putpixel((0,0),tuple(uuid.uuid4().bytes[:3]));ex=Image.Exif();ex[0x0112]=6;b=io.BytesIO();"
            "im.save(b,'JPEG',quality=95,exif=ex);sys.stdout.buffer.write(b.getvalue())")
    jpg = subprocess.run(COMPOSE + ["exec", "-T", "moderation", "python", "-c", make], capture_output=True, timeout=60,
                         env={"MSYS_NO_PATHCONV": "1", **os.environ}).stdout
    jurl = upload(admin, "rotated.jpg", jpg)
    jid = jurl.rsplit("/", 1)[1].split(".")[0]
    for _ in range(60):
        if call(admin, f"/api/files/{jid}/moderation")[1].get("status") != "pending":
            break
        time.sleep(1)
    j, _, _ = fetch(anon, jurl)
    # upright size is 200 x 300; logo 20% of 200 = 40 wide (x 20 high), top-right with a 6px margin
    m = analyze(j, {"tr": (200 - 40 - 6 + 4, 6 + 4, 200 - 6 - 4, 6 + 20 - 4)})
    check("EXIF-rotated photo comes out upright (300 tall)", m.get("size") == [200, 300], m.get("size"))
    check("logo lands in the upright image's top-right corner", m.get("red_tr", 0) > 0.8, m.get("red_tr"))

    call(admin, "/api/admin/files/moderation", {"id": fid, "status": "open"})
    set_watermark(enabled=False, position="top-right", size=20, opacity=100)
    c, _, _ = fetch(anon, url)
    check("watermark off -> reader gets the original again", c == photo)
finally:
    call(admin, "/api/admin/settings/set", orig_settings)
    call(admin, "/api/admin/edit-channel-info", {"name": orig_info["name"], "description": orig_info["description"], "logoUrl": orig_info["logoUrl"]})
    check("settings restored", (call(admin, "/api/admin/settings/get")[1] or []) == orig_settings)
    check("channel details restored", call(anon, "/api/channel/info")[1].get("logoUrl") == orig_info["logoUrl"])

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)

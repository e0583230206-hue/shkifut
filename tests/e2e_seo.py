"""End-to-end test of SEO / link previews against a local stack (http://localhost:18080 by default, BASE_URL to change; DEV_LOGIN on).

    python -I tests/e2e_seo.py
"""
import http.cookiejar
import json
import re
import struct
import os
import sys
import urllib.error
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


admin = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
admin.open(B + "/auth/dev-login").read()
anon = urllib.request.build_opener()


def get(path, op=anon):
    try:
        with op.open(B + path) as r:
            return r.status, r.read().decode("utf-8", "replace"), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), e.headers


def post(path, obj, op=admin, raw=None, headers=None):
    data = raw if raw is not None else json.dumps(obj).encode()
    r = urllib.request.Request(B + path, data=data, headers=headers or {"Content-Type": "application/json"})
    with op.open(r) as resp:
        return json.loads(resp.read())


def meta(html, prop):
    m = re.search(r'<meta (?:property|name)="%s" content="([^"]*)"' % re.escape(prop), html)
    return m.group(1) if m else None


def title(html):
    m = re.search(r"<title>([^<]*)</title>", html)
    return m.group(1) if m else None


def png():
    raw = b"".join(b"\x00" + bytes(range(0, 192, 4)) for _ in range(32))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 48, 32, 8, 0, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


_, info, _ = get("/api/channel/info")
channel = json.loads(info).get("name") or "שקיפות"
settings0 = json.loads(get("/api/admin/settings/get", admin)[1] or "[]") or []
created = []
try:
    st, html, _ = get("/")
    check("home: 200 with channel title", st == 200 and title(html) == channel, title(html))
    check("home: description + og tags + canonical", all([meta(html, "description"), meta(html, "og:title"),
          meta(html, "og:type") == "website", '<link rel="canonical"' in html]))
    check("home: page language is Hebrew / RTL", 'lang="he"' in html and 'dir="rtl"' in html)

    for path, word in (("/privacy", "מדיניות פרטיות"), ("/terms", "תנאי שימוש")):
        st, html, _ = get(path)
        check(f"{path}: 200 + title", st == 200 and (title(html) or "").startswith(word), title(html))

    st, html, _ = get("/no-such-page-" + uuid.uuid4().hex[:4])
    check("unknown page: real 404 + noindex", st == 404 and meta(html, "robots") == "noindex", st)

    # custom_title setting (the original code removed the <title> tag instead of filling it)
    post("/api/admin/settings/set", settings0 + [{"key": "custom_title", "value": "כותרת מותאמת"}])
    check("custom_title fills the <title> tag", title(get("/")[1]) == "כותרת מותאמת", title(get("/")[1]))
    post("/api/admin/settings/set", settings0)

    # message page with image and an injection attempt
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"seo.png\"\r\n"
            f"Content-Type: image/png\r\n\r\n").encode() + png() + f"\r\n--{bnd}--\r\n".encode()
    up = post("/api/admin/upload", None, raw=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
    text = f'**ידיעה חשובה** על "בדיקת SEO" <u>מודגש</u> <script>alert(1)</script>\n[image-embedded#]({up["url"]})'
    msg = post("/api/admin/new", {"type": "md", "text": text})
    created.append(msg["id"])
    st, html, _ = get(f"/m/{msg['id']}")
    check("message page: 200", st == 200, st)
    check("message page: title from text (markdown removed)", (title(html) or "").startswith("ידיעה חשובה על"), title(html))
    check("message page: og:type article", meta(html, "og:type") == "article")
    check("message page: og:image is the message image", (meta(html, "og:image") or "").endswith(up["url"]), meta(html, "og:image"))
    check("message page: text for crawlers without JS (<noscript>)", "<noscript><article>" in html)
    # HTML in a message never reaches the page: tags are stripped from the text (then the rest is escaped)
    check("message page: injected HTML never reaches the page", "<script>alert" not in html and "&lt;script" not in html)
    check("message page: formatting tags (<u>) do not leak into the title", "u&gt;" not in (title(html) or "") and "מודגש" in (title(html) or ""), title(html))

    st, sm, _ = get("/sitemap.xml")
    check("sitemap lists the message", st == 200 and f"/m/{msg['id']}</loc>" in sm)

    post_del = admin.open(B + f"/api/admin/delete-message/{msg['id']}").read()
    st, html, _ = get(f"/m/{msg['id']}")
    check("deleted message: 404", st == 404, st)
    st, sm, _ = get("/sitemap.xml")
    check("sitemap omits deleted messages", f"/m/{msg['id']}</loc>" not in sm)

    check("invalid message id: 404", get("/m/abc")[0] == 404)
    st, robots, _ = get("/robots.txt")
    check("robots.txt with sitemap, admin API blocked", st == 200 and "Sitemap:" in robots and "Disallow: /api/" in robots)
finally:
    post("/api/admin/settings/set", settings0)
    for mid in created:
        admin.open(B + f"/api/admin/delete-message/{mid}").read()

print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)

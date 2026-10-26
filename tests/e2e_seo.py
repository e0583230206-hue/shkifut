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
channel = json.loads(info).get("name") or "שקיפות - חדשות ועדכונים"  # no channel name set: the clearer default title
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
    # Files need a login (default): no page may mention the address of a file, so the preview has no image.
    check("message page: no og:image and no file address anywhere while files need a login", meta(html, "og:image") is None and "/api/files/" not in html, meta(html, "og:image"))
    # With public files the message image is the preview image (the earlier behaviour).
    post("/api/admin/settings/set", settings0 + [{"key": "require_auth_for_view_files", "value": False}])
    check("message page: og:image is the message image when files are public", (meta(get(f"/m/{msg['id']}")[1], "og:image") or "").split("?")[0].endswith(up["url"].split("?")[0]), meta(get(f"/m/{msg['id']}")[1], "og:image"))
    post("/api/admin/settings/set", settings0)
    check("message page: text for crawlers without JS (<noscript>)", "<noscript><article>" in html)
    # HTML in a message never reaches the page: tags are stripped from the text (then the rest is escaped)
    check("message page: injected HTML never reaches the page", "<script>alert" not in html and "&lt;script" not in html)
    check("message page: formatting tags (<u>) do not leak into the title", "u&gt;" not in (title(html) or "") and "מודגש" in (title(html) or ""), title(html))

    st, sm, _ = get("/sitemap.xml")
    check("sitemap lists the message", st == 200 and f"/m/{msg['id']}</loc>" in sm)

    # one message through the API (the page /m/<id> shows it instead of jumping to the channel)
    st, one, _ = get(f"/api/messages/{msg['id']}")
    j = json.loads(one) if st == 200 else {}
    check("API: one message by number (text, time, no author for a reader)", st == 200 and j.get("id") == msg["id"] and "בדיקת SEO" in j.get("text", "") and j.get("author") == "Anonymous", one[:120])
    st, one, _ = get(f"/api/messages/{msg['id']}", admin)
    check("API: the writer sees the author", st == 200 and json.loads(one).get("author") not in ("", "Anonymous", None), one[:120])
    check("API: a number that does not exist is a 404, a non-number too", get("/api/messages/987654321")[0] == 404 and get("/api/messages/abc")[0] == 404)
    check("API: /messages/search and /messages/pinned still work next to /messages/<id>", get("/api/messages/pinned")[0] == 200 and get("/api/messages/search?q=" + urllib.parse.quote("בדיקת"))[0] == 200)

    # HEAD must work where GET does (it used to be a 405)
    def head(path):
        try:
            with anon.open(urllib.request.Request(B + path, method="HEAD")) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code
    check("HEAD: message page, home, robots, sitemap -> 200", all(head(p) == 200 for p in (f"/m/{msg['id']}", "/", "/robots.txt", "/sitemap.xml")), [head(p) for p in (f"/m/{msg['id']}", "/", "/robots.txt")])
    check("HEAD: an unknown message and an unknown page -> 404", head("/m/987654321") == 404 and head("/no-such-page-xyz") == 404)
    check("HEAD on the live-update stream is refused (no stream nobody reads)", head("/api/events") == 405)

    post_del = admin.open(B + f"/api/admin/delete-message/{msg['id']}").read()
    st, html, _ = get(f"/m/{msg['id']}")
    check("deleted message: 410 (gone, so search engines forget it sooner) + noindex", st == 410 and meta(html, "robots") == "noindex", st)
    check("a message number that never existed: 404", get("/m/987654321")[0] == 404)
    check("API: a deleted message is a 404", get(f"/api/messages/{msg['id']}")[0] == 404)
    st, sm, _ = get("/sitemap.xml")
    check("sitemap omits deleted messages", f"/m/{msg['id']}</loc>" not in sm)

    check("invalid message id: 404", get("/m/abc")[0] == 404)
    st, robots, _ = get("/robots.txt")
    check("robots.txt: sitemap, files and admin API closed, the texts (/api/messages) and pages open", st == 200 and "Sitemap:" in robots and "Disallow: /api/files/" in robots
          and "Disallow: /api/admin/" in robots and "Disallow: /api/\n" not in robots and "Disallow: /\n" not in robots, robots)
    st, html, _ = get("/")
    check("home: no verification tag unless GOOGLE_SITE_VERIFICATION is set", (meta(html, "google-site-verification") is None) or bool(re.fullmatch(r"[A-Za-z0-9_-]+", meta(html, "google-site-verification"))))
    exp = os.environ.get("EXPECT_VERIFICATION")
    if exp:
        check("home: Google Search Console verification tag", meta(html, "google-site-verification") == exp, meta(html, "google-site-verification"))
    check("home: no file address anywhere in the page", "/api/files/" not in html)
finally:
    post("/api/admin/settings/set", settings0)
    for mid in created:
        admin.open(B + f"/api/admin/delete-message/{mid}").read()

print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)

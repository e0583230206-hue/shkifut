"""End-to-end test: texts are public, files (pictures, videos, audio) only for logged-in readers - also by their direct address.

    BASE_URL=http://localhost:18083 python -I tests/e2e_files_auth.py     # the UI test stack (tests/docker-compose.ui-test.yml) or the local stack

Needs tests/media/man_twain.jpg and short.mp4 (not in git). Changes the setting require_auth_for_view_files for a moment and restores
the settings afterwards. The default (setting absent) must be "files need a login".
"""
import http.cookiejar
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402

B = base_url()
MEDIA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "media")
JSON = {"Content-Type": "application/json"}
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def opener(email=None):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    if email is not None:
        op.open(B + "/auth/dev-login" + (f"?email={email}" if email else "")).read()
    return op


def get(op, path, headers=None, method="GET"):
    try:
        with op.open(urllib.request.Request(B + path, headers=headers or {}, method=method), timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def post(op, path, obj=None, raw=None, headers=None):
    data = raw if raw is not None else json.dumps(obj).encode()
    r = urllib.request.Request(B + path, data=data, headers=headers or JSON)
    with op.open(r, timeout=60) as resp:
        body = resp.read()
        return json.loads(body) if body[:1] in (b"{", b"[") else body


def upload(op, name, mime):
    data = open(os.path.join(MEDIA, name), "rb").read() + uuid.uuid4().bytes
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").encode() \
        + data + f"\r\n--{bnd}--\r\n".encode()
    up = post(op, "/api/admin/upload", raw=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
    fid = re.search(r"/api/files/([0-9a-f]{40})", up["url"]).group(1)
    post(op, "/api/admin/files/moderation", {"id": fid, "status": "open"})
    return up["url"], fid


admin = opener("")
anon = opener()
reader = opener("files-reader@example.com")
original = json.loads(get(admin, "/api/admin/settings/get")[1] or b"[]") or []
marker = "files-auth-" + uuid.uuid4().hex[:6]
msg_id = None
try:
    img_url, img_id = upload(admin, "man_twain.jpg", "image/jpeg")
    vid_url, vid_id = upload(admin, "short.mp4", "video/mp4")
    check("the upload address carries the display size (?w=&h=) of the picture and the video",
          bool(re.search(r"\?w=\d+&h=\d+$", img_url)) and bool(re.search(r"\?w=\d+&h=\d+$", vid_url)), f"{img_url} {vid_url}")
    msg_id = post(admin, "/api/admin/new", {"type": "md", "text": f"{marker} טקסט\n[image-embedded#]({img_url})\n[video-embedded#]({vid_url})"})["id"]

    # default: the setting is absent -> files need a login
    post(admin, "/api/admin/settings/set", [s for s in original if s["key"] != "require_auth_for_view_files"])
    st, body = get(anon, "/api/messages?offset=0&limit=20&direction=desc")
    check("texts are public: a visitor gets the messages", st == 200 and marker in body.decode("utf-8", "replace"), st)
    st, body = get(anon, "/api/channel/info")
    check("the channel info tells the page that files need a login", st == 200 and json.loads(body).get("require_auth_for_view_files") is True, st)

    for label, url in (("picture", img_url), ("video", vid_url)):
        base = url.split("?")[0]
        noext = re.sub(r"\.\w+$", "", base)
        for how, path in (("with the address from the message", url), ("without the size", base), ("without the extension", noext),
                          ("with ?view=public", base + "?view=public"), ("with the cache-buster of the page", base + "?m=open-original")):
            st, _ = get(anon, path)
            check(f"visitor, {label}, {how}: refused", st == 401, st)
        st, _ = get(anon, base, {"Range": "bytes=0-99"})
        check(f"visitor, {label}, Range request: refused", st == 401, st)
        st, _ = get(anon, base, method="HEAD")
        check(f"visitor, {label}, HEAD: no file (401, or 405: HEAD is not served at all)", st in (401, 405), st)
        st, body = get(reader, url)
        check(f"logged-in reader, {label}: gets the file", st == 200 and len(body) > 1000, f"{st} {len(body)}")
    # the status of a file reveals nothing about the file itself
    st, body = get(anon, f"/api/files/{img_id}/moderation")
    check("the status endpoint gives a visitor no file content", st in (200, 401) and b"JFIF" not in body, st)

    # an admin can turn it off: then the visitor gets the files again
    post(admin, "/api/admin/settings/set", [s for s in original if s["key"] != "require_auth_for_view_files"]
         + [{"key": "require_auth_for_view_files", "value": False}])
    st, _ = get(anon, img_url)
    check("with require_auth_for_view_files=false a visitor gets the picture", st == 200, st)
    st, body = get(anon, "/api/channel/info")
    check("and the page is told so", json.loads(body).get("require_auth_for_view_files") is False)
finally:
    post(admin, "/api/admin/settings/set", original)
    if msg_id:
        try:
            get(admin, f"/api/admin/delete-message/{msg_id}")
        except Exception:
            pass

print("\nFAILED: " + ", ".join(failures) if failures else "\nALL PASSED")
sys.exit(1 if failures else 0)

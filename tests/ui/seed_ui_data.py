"""Fills the LOCAL UI test stack (tests/docker-compose.ui-test.yml, http://localhost:18083) with messages for looking at the layout:
long text, a wide picture, a tall picture, a wide and a tall video, a gallery, an older message whose files have no size in the address,
reactions. Uses tests/media (not in git). Prints the ids. Run once on an empty stack:

    BASE_URL=http://localhost:18083 python -I tests/ui/seed_ui_data.py
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
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from _guard import base_url  # noqa: E402

B = base_url()
MEDIA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "media")
JSON = {"Content-Type": "application/json"}


def opener():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def call(op, path, obj=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
    r = urllib.request.Request(B + path, data=data, headers=headers or (JSON if data else {}))
    with op.open(r, timeout=60) as resp:
        body = resp.read()
        return json.loads(body) if body[:1] in (b"{", b"[") else body


def upload(op, name, mime):
    data = open(os.path.join(MEDIA, name), "rb").read() + uuid.uuid4().bytes  # unique content
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").encode() \
        + data + f"\r\n--{bnd}--\r\n".encode()
    up = call(op, "/api/admin/upload", raw=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
    fid = re.search(r"/api/files/([0-9a-f]{40})", up["url"]).group(1)
    call(op, "/api/admin/files/moderation", {"id": fid, "status": "open"})  # no moderation service here: open by hand
    return up["url"]


def post(op, text):
    return call(op, "/api/admin/new", {"type": "md", "text": text})["id"]


LONG = ("עדכון ארוך מהשטח: " + "זהו טקסט ארוך בכוונה כדי לבדוק שההודעה יורדת שורה ומתארכת בלי חיתוך ובלי כפתור 'הצג עוד'. " * 6
        + "\n\nפסקה שנייה, קצרה יותר, עם קישור: https://example.com/a/very/long/path/that/should/not/break/the/layout/of/the/message?x=1&y=2")

if __name__ == "__main__":
    admin = opener()
    admin.open(B + "/auth/dev-login").read()
    img_wide = upload(admin, "landscape_hermon.jpg", "image/jpeg")
    img_tall = upload(admin, "painting_starry.jpg", "image/jpeg")
    img_a, img_b, img_c = (upload(admin, n, "image/jpeg") for n in ("man_twain.jpg", "man_messi.jpg", "men_zidane.jpg"))
    vid_wide = upload(admin, "short.mp4", "video/mp4")
    vid_tall = upload(admin, "protest.mp4", "video/mp4")
    print("urls:", img_wide, img_tall, vid_wide, vid_tall, sep="\n  ")
    ids = {}
    ids["short"] = post(admin, "הודעה קצרה, רק טקסט.")
    ids["long"] = post(admin, LONG)
    ids["wide"] = post(admin, f"תמונה רחבה\n[image-embedded#]({img_wide})")
    ids["tall"] = post(admin, f"תמונה גבוהה עם טקסט ארוך. " + "עוד מילים. " * 12 + f"\n[image-embedded#]({img_tall})")
    ids["video"] = post(admin, f"סרטון רחב\n[video-embedded#]({vid_wide})")
    ids["video_tall"] = post(admin, f"סרטון עומד (טלפון)\n[video-embedded#]({vid_tall})")
    ids["gallery"] = post(admin, f"גלריה של שלוש תמונות\n[image-embedded#]({img_a})\n[image-embedded#]({img_b})\n[image-embedded#]({img_c})")
    old = re.sub(r"\?w=\d+&h=\d+", "", img_wide)
    ids["old"] = post(admin, f"הודעה ישנה: כתובת בלי מידות\n[image-embedded#]({old})")
    ids["reacted"] = post(admin, "הודעה עם תגובות")
    emojis = call(admin, "/api/emojis/list")
    if not emojis:  # a fresh stack has no reactions list: set one
        emojis = ["👍", "❤️", "😂", "🙏", "🔥", "👏", "😮", "😢", "🎉", "💯", "✅", "⭐", "🙌", "😍", "🤝"]
        call(admin, "/api/admin/set-emojis", {"emojis": emojis})
    for i, emoji in enumerate(emojis[:3]):
        for j in range(i + 1):
            u = opener()
            u.open(B + f"/auth/dev-login?email=reader{i}{j}@example.com").read()
            try:
                call(u, "/api/reactions/set-reactions", {"messageId": ids["reacted"], "emoji": emoji})
            except urllib.error.HTTPError:
                pass
    print(json.dumps(ids, ensure_ascii=False))

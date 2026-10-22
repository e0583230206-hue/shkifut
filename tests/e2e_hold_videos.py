"""End-to-end test of HOLD_VIDEOS_UNTIL_APPROVED (http://localhost:18080 by default, BASE_URL to change; DEV_LOGIN on).

    python -I tests/e2e_hold_videos.py off    # backend started normally (flag off): nothing changes; leaves one video behind
    python -I tests/e2e_hold_videos.py on     # backend started with tests/docker-compose.hold-test.yml (flag on)

Run "off" first: the video it uploads must still be visible to readers when "on" runs (videos from before the flag count as approved).
Uses tests/media/short.mp4 and man_twain.jpg (not in git). The uploaded test files stay in channel_data like other tests' uploads.
"""
import http.cookiejar
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.stdout.reconfigure(encoding="utf-8")
MODE = sys.argv[1] if len(sys.argv) > 1 else ""
assert MODE in ("on", "off"), "usage: e2e_hold_videos.py on|off"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402
B = base_url()
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
STATE = os.path.join(tempfile.gettempdir(), "hold_test_state.json")
APPROVER, MOD2 = "approver@example.com", "mod2@example.com"
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def login(email=None):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(B + "/auth/dev-login" + (f"?email={email}" if email else "")).read()
    return op


def call(op, path, obj=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
    r = urllib.request.Request(B + path, data=data, headers=headers or ({"Content-Type": "application/json"} if data else {}))
    try:
        with op.open(r) as resp:
            body = resp.read()
            return resp.status, resp.headers.get("Content-Type", ""), (json.loads(body) if body[:1] in (b"{", b"[") else body)
    except urllib.error.HTTPError as e:
        return e.code, "", None


def upload(op, name, data, mime):
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").encode() \
        + data + f"\r\n--{bnd}--\r\n".encode()
    _, _, up = call(op, "/api/admin/upload", raw=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
    return up["url"], up["url"].rsplit("/", 1)[1].split(".")[0]


def new_video(op):
    return upload(op, "hold-test.mp4", open(os.path.join(ROOT, "tests", "media", "short.mp4"), "rb").read() + uuid.uuid4().bytes, "video/mp4")


def wait_status(op, fid, timeout=300):
    s = None
    for _ in range(timeout // 2):
        _, _, s = call(op, f"/api/files/{fid}/moderation")
        if s and s["status"] != "pending":
            return s
        time.sleep(2)
    return s


def finish():
    print("\nFAILED: " + ", ".join(failures) if failures else "\nALL PASSED")
    sys.exit(1 if failures else 0)


admin = login()
reader = login(f"reader-{uuid.uuid4().hex[:6]}@example.com")
anon = urllib.request.build_opener()
_, _, users0 = call(admin, "/api/admin/privilegs-users/get-list")
users0 = users0 or []
two_moderators = users0 + [
    {"email": APPROVER, "username": "", "publicName": "", "privileges": {"moderator": True}},
    {"email": MOD2, "username": "", "publicName": "", "privileges": {"moderator": True}},
]

if MODE == "off":
    try:
        call(admin, "/api/admin/privilegs-users/set", {"list": two_moderators})
        url, fid = new_video(admin)
        s = wait_status(admin, fid)
        check("off: video processed", s["status"] in ("regional", "open", "blurred"), s["status"])
        check("off: no hold information anywhere", s.get("publicVariant") != "hidden" and not s.get("hold"), s)
        check("off: readers get the new video right away", call(reader, url)[0] == 200)
        json.dump({"legacy": url}, open(STATE, "w"))
        mod2 = login(MOD2)
        check("off: every moderator still opens the grid", call(mod2, f"/api/admin/files/{fid}/figures")[0] == 200)
        check("off: approve is refused (flag off)", call(admin, f"/api/admin/files/{fid}/approve", {})[0] == 400)
        _, _, info = call(mod2, f"/api/files/{fid}/moderation")
        check("off: moderator info says canReview", info.get("canReview") is True, info)
    finally:
        call(admin, "/api/admin/privilegs-users/set", {"list": users0})
    finish()

# ---------------------------------------------------------------- flag ON
received = []


class Sink(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        received.append({"path": self.path, "key": self.headers.get("X-Notify-Key"), "body": json.loads(self.rfile.read(n) or b"{}")})
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


sink = HTTPServer(("0.0.0.0", 18099), Sink)
threading.Thread(target=sink.serve_forever, daemon=True).start()

try:
    call(admin, "/api/admin/privilegs-users/set", {"list": two_moderators})
    approver, mod2 = login(APPROVER), login(MOD2)

    # videos from before the flag stay visible
    legacy = json.load(open(STATE))["legacy"] if os.path.exists(STATE) else None
    if legacy:
        check("legacy video (uploaded before the flag) is still served to readers", call(reader, legacy)[0] == 200)
    else:
        print("SKIP legacy check (run the 'off' mode first)")

    # images are not affected
    img_url, img_id = upload(admin, "hold-test.jpg", open(os.path.join(ROOT, "tests", "media", "man_twain.jpg"), "rb").read() + uuid.uuid4().bytes, "image/jpeg")
    s = wait_status(admin, img_id, 120)
    check("image: processed as usual", s["status"] in ("open", "regional", "blurred"), s["status"])
    check("image: readers get it (no hold)", call(reader, img_url)[0] == 200 and s.get("publicVariant") != "hidden")

    # a new video is held
    url, fid = new_video(admin)
    s = wait_status(admin, fid)
    check("video processed", s["status"] in ("regional", "open", "blurred"), s["status"])
    check("reader: 404 for the held video", call(reader, url)[0] == 404)
    _, _, rinfo = call(reader, f"/api/files/{fid}/moderation")
    check("reader: the page is told 'hidden' and gets no hold details", rinfo["publicVariant"] == "hidden" and "hold" not in rinfo, rinfo)
    check("admin sees the video as always", call(admin, url)[0] == 200)
    check("non-approver moderator sees the video as always", call(mod2, url)[0] == 200)
    _, _, ainfo = call(admin, f"/api/files/{fid}/moderation")
    check("moderator info: held, preview variant given", ainfo.get("hold", {}).get("held") is True and ainfo.get("previewVariant") in ("regional", "blurred", "original"), ainfo.get("hold"))
    check("a non-approver moderator cannot open the grid", call(mod2, f"/api/admin/files/{fid}/figures")[0] == 401)
    _, _, minfo = call(mod2, f"/api/files/{fid}/moderation")
    check("... and the page is told not to show the grid button", not minfo.get("canReview"), minfo.get("canReview"))
    check("a non-approver moderator cannot approve", call(mod2, f"/api/admin/files/{fid}/approve", {})[0] == 401)
    check("a reader cannot approve", call(reader, f"/api/admin/files/{fid}/approve", {})[0] == 401)
    check("the owner and the listed approver open the grid", call(admin, f"/api/admin/files/{fid}/figures")[0] == 200 and call(approver, f"/api/admin/files/{fid}/figures")[0] == 200)

    # notification: once, text only, with the key and a link
    time.sleep(2)
    mine = [x for x in received if fid in x["body"].get("text", "")]
    check("notification: exactly one for the new video", len(mine) == 1, len(mine))
    if mine:
        check("notification: key and path", mine[0]["key"] == "test-notify-key" and mine[0]["path"] == "/notify", mine[0])
        check("notification: text only, with the review link", set(mine[0]["body"].keys()) == {"text"} and f"/review/{fid}" in mine[0]["body"]["text"], mine[0]["body"])
    check("notification: none for the image", all(img_id not in x["body"].get("text", "") for x in received))

    # approval needs the "as readers see" view, per person and per check
    check("approve before viewing: refused", call(approver, f"/api/admin/files/{fid}/approve", {})[0] == 409)
    check("mod2 requesting ?view=public gets what readers get now (404)", call(mod2, url + "?view=public")[0] == 404)
    check("the owner previews the video with ?view=public", call(admin, url + "?view=public")[0] == 200)
    check("the preview of one approver does not count for another", call(approver, f"/api/admin/files/{fid}/approve", {})[0] == 409)
    _, _, g = call(approver, f"/api/admin/files/{fid}/figures")
    check("grid: not viewed yet for this approver", g["hold"]["held"] is True and g["hold"]["viewed"] is False, g["hold"])
    check("the listed approver previews the video", call(approver, url + "?view=public")[0] == 200)
    _, _, g = call(approver, f"/api/admin/files/{fid}/figures")
    check("grid: viewed, can approve", g["hold"]["viewed"] is True and g["hold"]["canApprove"] is True, g["hold"])
    check("readers still get nothing before the approval", call(reader, url)[0] == 404)

    st, _, r = call(approver, f"/api/admin/files/{fid}/approve", {})
    check("approve after viewing: 200", st == 200 and r.get("approvedBy") == APPROVER, (st, r))
    check("readers now get the video", call(reader, url)[0] == 200)
    _, _, ainfo = call(admin, f"/api/files/{fid}/moderation")
    check("approval stores who and when", ainfo["hold"]["held"] is False and ainfo["hold"]["approvedBy"] == APPROVER and ainfo["hold"]["approvedAt"], ainfo["hold"])
    _, _, rinfo = call(reader, f"/api/files/{fid}/moderation")
    check("reader info after the approval: not hidden", rinfo["publicVariant"] != "hidden", rinfo)

    # a saved correction ends the approval
    _, _, g = call(approver, f"/api/admin/files/{fid}/figures")
    figs = g.get("figures") or []
    check("figures available for the correction test", len(figs) > 0)
    if figs:
        f0 = figs[0]
        want = "blur" if f0["visible"] else "man"
        st, _, r = call(approver, f"/api/admin/files/{fid}/figures", {"overrides": {f0["key"]: want}})
        check("save a correction", st == 200 and r.get("changed") == 1, r)
        check("correction: approval reset, readers get nothing again", call(reader, url)[0] == 404)
        wait_status(admin, fid)
        _, _, g = call(approver, f"/api/admin/files/{fid}/figures")
        check("correction: held again and not viewed", g["hold"]["held"] is True and g["hold"]["viewed"] is False, g["hold"])
        check("correction: approve refused until the new version is viewed", call(approver, f"/api/admin/files/{fid}/approve", {})[0] == 409)
        call(approver, url + "?view=public")
        check("viewed again: approve works", call(approver, f"/api/admin/files/{fid}/approve", {})[0] == 200 and call(reader, url)[0] == 200)

    # check again resets
    call(admin, "/api/admin/files/reprocess", {"id": fid})
    check("check again: readers get nothing, approval reset", call(reader, url)[0] == 404)
    wait_status(admin, fid)
    check("check again: approve refused without a new view", call(approver, f"/api/admin/files/{fid}/approve", {})[0] == 409)
    call(approver, url + "?view=public")
    check("check again then viewed: approve works", call(approver, f"/api/admin/files/{fid}/approve", {})[0] == 200)

    # a manual decision resets; "open to everyone" does not publish a held video
    st, _, _ = call(admin, "/api/admin/files/moderation", {"id": fid, "status": "blurred"})
    check("manual decision: approval reset", st == 200 and call(reader, url)[0] == 404)
    st, _, _ = call(admin, "/api/admin/files/moderation", {"id": fid, "status": "open"})
    check("'open to everyone' does not publish a held video", st == 200 and call(reader, url)[0] == 404)
    _, _, ainfo = call(admin, f"/api/files/{fid}/moderation")
    check("... it stays held and shows as open for moderators", ainfo["hold"]["held"] is True and ainfo["status"] == "open", (ainfo["status"], ainfo["hold"]))
    call(approver, url + "?view=public")
    check("approve after 'open': readers get the video", call(approver, f"/api/admin/files/{fid}/approve", {})[0] == 200 and call(reader, url)[0] == 200)

    time.sleep(1)
    mine = [x for x in received if fid in x["body"].get("text", "")]
    check("notification: still exactly one after all the re-checks", len(mine) == 1, len(mine))

    # the review page is served by the app, junk is a real 404
    check("/review/<id> is a real page", call(anon, f"/review/{fid}")[0] == 200)
    check("/review/<junk> is a 404", call(anon, "/review/not-a-file")[0] == 404)
finally:
    call(admin, "/api/admin/privilegs-users/set", {"list": users0})
    sink.shutdown()

finish()

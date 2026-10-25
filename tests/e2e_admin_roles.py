"""End-to-end test of the two kinds of managers on the LOCAL UI test stack (default http://localhost:18083, DEV_LOGIN on), started with
tests/docker-compose.roles-test.yml (HOLD_VIDEOS_UNTIL_APPROVED on, no APPROVER_EMAILS: the managers come from the permissions screen):

    python -I tests/e2e_admin_roles.py http://localhost:18083

  owner       - the account of ADMIN_USERS (all flags)
  manager 1   - "moderator": opens / blurs / approves media (manual blur too), reads the contact messages, sees who is online, statistics ...
  manager 2   - "reviewer":  ONLY the media tools (open / blur / check again / review figures / approve / manual blur)
  nobody      - a logged-in reader

The users are added through the permissions API (as the owner does in the permissions screen) and the list is restored at the end.
Needs tests/media/short.mp4 and landscape_hermon.jpg (not in git).
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

B = base_url(sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18083")
MEDIA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "media")
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def opener(email=None):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(B + "/auth/dev-login" + (f"?email={email}" if email else "")).read()
    return op


def call(op, method, path, obj=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
    req = urllib.request.Request(B + path, data=data, method=method, headers=headers or ({"Content-Type": "application/json"} if data else {}))
    try:
        with op.open(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def upload(op, name, mime):
    with open(os.path.join(MEDIA, name), "rb") as fh:
        data = fh.read() + uuid.uuid4().bytes
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").encode() + data + f"\r\n--{bnd}--\r\n".encode()
    st, resp = call(op, "POST", "/api/admin/upload", raw=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
    return re.search(r"/api/files/([0-9a-f]{40})", json.loads(resp)["url"]).group(1)


M1, M2, RD = "manager-one@example.com", "manager-two@example.com", "just-a-reader@example.com"
owner = opener()
users0 = json.loads(call(owner, "GET", "/api/admin/privilegs-users/get-list")[1])


def set_users(extra):
    keep = [u for u in users0]
    call(owner, "POST", "/api/admin/privilegs-users/set", {"list": keep + extra})


def user(email, **flags):
    return {"id": "", "username": email.split("@")[0], "email": email, "publicName": email.split("@")[0], "privileges": flags}


try:
    set_users([user(M1, moderator=True), user(M2, reviewer=True)])
    one, two, rd = opener(M1), opener(M2), opener(RD)
    img = upload(owner, "landscape_hermon.jpg", "image/jpeg")
    vid = upload(owner, "short.mp4", "video/mp4")
    call(owner, "POST", "/api/admin/files/moderation", {"id": img, "status": "open"})
    call(owner, "POST", "/api/admin/files/moderation", {"id": vid, "status": "open"})

    def ok(op, method, path, obj=None):
        return call(op, method, path, obj)[0] not in (401, 403)

    # ---- who each one is ----
    for name, op, expect in (("manager 1", one, {"moderator": True}), ("manager 2", two, {"reviewer": True})):
        st, body = call(op, "GET", "/api/user-info")
        p = json.loads(body).get("privileges", {}) if st == 200 else {}
        check(f"{name}: the account has exactly the flags set in the permissions screen", all(p.get(k) for k in expect) and not p.get("admin"), p)

    # ---- what manager 1 may (the media tools AND contact / online / statistics) ----
    check("manager 1: reads the contact messages", ok(one, "GET", "/api/admin/contact"))
    check("manager 1: sees who is online", ok(one, "GET", "/api/admin/presence"))
    check("manager 1: statistics", ok(one, "GET", "/api/admin/statistics"))
    # ---- what manager 2 may NOT ----
    check("manager 2: cannot read the contact messages", not ok(two, "GET", "/api/admin/contact"))
    check("manager 2: cannot mark a contact message as handled", not ok(two, "POST", "/api/admin/contact/set", {"id": "x", "handled": True}))
    check("manager 2: cannot see who is online", not ok(two, "GET", "/api/admin/presence"))
    check("manager 2: no statistics", not ok(two, "GET", "/api/admin/statistics"))
    check("manager 2: no topics / channel info / emojis", not any(ok(two, "POST", p, {}) for p in ("/api/admin/topics", "/api/admin/edit-channel-info", "/api/admin/set-emojis")))
    # ---- what neither may (only the owner) ----
    for name, op in (("manager 1", one), ("manager 2", two), ("a reader", rd)):
        check(f"{name}: no settings, no permissions, no reports, no cleanup",
              not any(ok(op, m, p, {} if m == "POST" else None) for m, p in (("GET", "/api/admin/settings/get"), ("POST", "/api/admin/settings/set"), ("GET", "/api/admin/privilegs-users/get-list"),
                                                                             ("POST", "/api/admin/privilegs-users/set"), ("GET", "/api/admin/reports/get"), ("POST", "/api/admin/media/cleanup"))))
        check(f"{name}: cannot write messages (that is the 'writer' flag, not a manager's)", not ok(op, "POST", "/api/admin/new", {"type": "md", "text": "x"}))
    check("a reader: no contact, no presence", not ok(rd, "GET", "/api/admin/contact") and not ok(rd, "GET", "/api/admin/presence"))

    # ---- the media tools: both kinds ----
    for name, op in (("manager 1", one), ("manager 2", two)):
        check(f"{name}: sets a file open / regional / blurred", all(call(op, "POST", "/api/admin/files/moderation", {"id": img, "status": s})[0] == 200 for s in ("blurred", "regional", "open")))
        check(f"{name}: 'check again'", ok(op, "POST", "/api/admin/files/reprocess", {"id": img}))
        check(f"{name}: opens the review grid (figures), although the hold flag is on and APPROVER_EMAILS is empty", ok(op, "GET", f"/api/admin/files/{img}/figures"))
        check(f"{name}: may approve a video (the request is allowed; the video has to be viewed first)", ok(op, "POST", f"/api/admin/files/{vid}/approve", {}))
        check(f"{name}: the manual blur tool is there for pictures and for videos", call(op, "GET", f"/api/admin/files/{img}/manual-blur")[0] == 200 and call(op, "GET", f"/api/admin/files/{vid}/manual-blur")[0] == 200)
        st, body = call(op, "GET", f"/api/files/{img}/moderation")
        info = json.loads(body)
        check(f"{name}: the moderator details of a file (decision, review rights) are shown", info.get("canReview") is True and "autoDecision" in info or "reviewedBy" in info or info.get("canReview") is True, list(info))
        check(f"{name}: the moderator's view of the picture is the original (not the version readers get)", call(op, "GET", f"/api/files/{img}")[0] == 200)
        call(owner, "POST", "/api/admin/files/moderation", {"id": img, "status": "open"})
    # a reader does none of it
    check("a reader: none of the media tools", not any(ok(rd, m, p, o) for m, p, o in (
        ("POST", "/api/admin/files/moderation", {"id": img, "status": "blurred"}), ("POST", "/api/admin/files/reprocess", {"id": img}),
        ("GET", f"/api/admin/files/{img}/figures", None), ("POST", f"/api/admin/files/{vid}/approve", {}),
        ("GET", f"/api/admin/files/{img}/manual-blur", None), ("POST", f"/api/admin/files/{img}/manual-blur", {"shapes": []}))))
    st, body = call(rd, "GET", f"/api/files/{img}/moderation")
    check("a reader's file info has none of the moderator details", st == 200 and "canReview" not in json.loads(body) and "manualBlur" not in json.loads(body), list(json.loads(body)))

    # ---- removing a flag takes the rights away ----
    set_users([user(M1, moderator=True), user(M2, reviewer=False)])
    check("manager 2 after the owner un-ticks 'מנהל 2': no media tools any more", not ok(two, "POST", "/api/admin/files/moderation", {"id": img, "status": "blurred"}) and not ok(two, "GET", f"/api/admin/files/{img}/figures"))
    check("... and manager 1 is not affected", ok(one, "POST", "/api/admin/files/moderation", {"id": img, "status": "open"}))
finally:
    call(owner, "POST", "/api/admin/privilegs-users/set", {"list": users0})   # the users list as it was

print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)

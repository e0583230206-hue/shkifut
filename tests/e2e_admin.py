"""End-to-end test of channel administration against a local stack (http://localhost:18080 by default, BASE_URL to change; DEV_LOGIN on).

    python -I tests/e2e_admin.py

Covers channel details, settings, users & privileges (incl. revocation taking effect immediately), reports,
statistics, emojis, message edit/delete and scheduled messages. Everything changed is restored at the end.
"""
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

sys.stdout.reconfigure(encoding="utf-8")  # Hebrew / emoji output on Windows consoles
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402
B = base_url(sys.argv[1] if len(sys.argv) > 1 else None)
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def login(email=None):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(B + "/auth/dev-login" + (f"?email={email}" if email else "")).read()
    return op


def call(op, path, obj=None, method=None):
    data = json.dumps(obj).encode() if obj is not None else None
    r = urllib.request.Request(B + path, data=data, method=method,
                               headers={"Content-Type": "application/json"} if data else {})
    try:
        with op.open(r) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body[:1] in (b"{", b"[") else body)
    except urllib.error.HTTPError as e:
        return e.code, e.read()


admin = login()
anon = urllib.request.build_opener()
_, info0 = call(anon, "/api/channel/info")
_, settings0 = call(admin, "/api/admin/settings/get")
_, users0 = call(admin, "/api/admin/privilegs-users/get-list")
_, emojis0 = call(anon, "/api/emojis/list")
_, sched0 = call(admin, "/api/admin/scheduled-messages/get")
settings0, users0, emojis0, sched0 = settings0 or [], users0 or [], emojis0 or [], sched0 or []
test_email = f"writer-{uuid.uuid4().hex[:6]}@example.com"
created_ids = []

try:
    # --- channel details
    st, _ = call(admin, "/api/admin/edit-channel-info",
                 {"name": "שקיפות-בדיקה", "description": "תיאור בדיקה", "logoUrl": info0.get("logoUrl", "")})
    _, info = call(anon, "/api/channel/info")
    check("edit channel details", st == 200 and info.get("name") == "שקיפות-בדיקה", info.get("name"))
    st, _ = call(anon, "/api/admin/edit-channel-info", {"name": "x"})
    check("readers cannot edit channel", st == 401, st)

    # --- settings round trip
    st, _ = call(admin, "/api/admin/settings/set", settings0 + [{"key": "custom_title", "value": "בדיקה"}])
    _, s = call(admin, "/api/admin/settings/get")
    check("settings saved", st == 200 and any(x["key"] == "custom_title" for x in s or []))

    # --- users and privileges
    st, _ = call(admin, "/api/admin/privilegs-users/set", {"list": users0 + [{
        "email": test_email, "username": "", "publicName": "", "privileges": {"writer": True}}]})
    check("grant writer privilege", st == 200, st)
    writer = login(test_email)
    _, me = call(writer, "/api/user-info")
    check("writer sees own privilege", (me.get("privileges") or {}).get("writer") is True, me.get("privileges"))
    st, msg = call(writer, "/api/admin/new", {"type": "md", "text": "הודעת בדיקה של כותב"})
    check("writer can publish", st == 200 and isinstance(msg, dict), st)
    if isinstance(msg, dict):
        created_ids.append(msg["id"])
    st, _ = call(writer, "/api/admin/settings/get")
    check("writer cannot open admin settings", st == 401, st)

    call(admin, "/api/admin/privilegs-users/set", {"list": users0})
    st, _ = call(writer, "/api/admin/new", {"type": "md", "text": "should fail"})
    check("revoked writer is blocked immediately (same session)", st == 401, st)

    # --- message edit / delete
    st, m = call(admin, "/api/admin/new", {"type": "md", "text": "לפני עריכה"})
    created_ids.append(m["id"])
    m["text"] = "אחרי עריכה"
    st, r = call(admin, "/api/admin/edit-message", m)
    _, msgs = call(anon, "/api/messages?offset=0&limit=10")
    check("edit message", r.get("success") and any(x["id"] == m["id"] and x["text"] == "אחרי עריכה" for x in msgs))
    call(admin, f"/api/admin/delete-message/{m['id']}")
    _, msgs = call(anon, "/api/messages?offset=0&limit=10")
    _, amsgs = call(admin, "/api/messages?offset=0&limit=10")
    check("deleted message hidden from readers", all(x["id"] != m["id"] for x in msgs))
    check("deleted message visible (restorable) for writers",
          any(x["id"] == m["id"] and x["deleted"] for x in amsgs))

    # --- reports
    reader = login(f"reader-{uuid.uuid4().hex[:6]}@example.com")
    target = created_ids[0]
    st, _ = call(reader, "/api/messages/report", {"messageId": target, "reason": "בדיקת דיווח"})
    _, open_reports = call(admin, "/api/admin/reports/get?status=open")
    rep = next((x for x in open_reports or [] if x["messageId"] == target and x["reason"] == "בדיקת דיווח"), None)
    check("reader report reaches admin", st == 200 and rep is not None, st)
    if rep:
        rep["closed"] = True
        call(admin, "/api/admin/reports/set", rep)
        _, closed = call(admin, "/api/admin/reports/get?status=closed")
        check("close report", any(x["id"] == rep["id"] for x in closed or []))
    st, _ = call(anon, "/api/messages/report", {"messageId": target, "reason": "x"})
    check("anonymous cannot report", st == 401, st)

    # --- statistics
    st, stats = call(admin, "/api/admin/statistics")
    check("statistics", st == 200 and "usersAmount" in stats and "connectionsStatistics" in stats, st)

    # --- emojis
    st, _ = call(admin, "/api/admin/set-emojis", {"emojis": ["👍", "❤️"]})
    _, e = call(anon, "/api/emojis/list")
    check("set emojis", st == 200 and e == ["👍", "❤️"], e)

    # --- scheduled message (the scheduler runs once a minute)
    marker = "מתוזמנת-" + uuid.uuid4().hex[:6]
    when = (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat().replace("+00:00", "Z")
    st, _ = call(admin, "/api/admin/scheduled-messages/update", sched0 + [{"type": "md", "text": marker, "timestamp": when}])
    check("schedule a message", st == 200, st)
    published = None
    for _ in range(80):
        _, msgs = call(anon, "/api/messages?offset=0&limit=5")
        published = next((x for x in msgs if x["text"] == marker), None)
        if published:
            break
        time.sleep(2)
    check("scheduled message published", published is not None)
    if published:
        created_ids.append(published["id"])
finally:
    call(admin, "/api/admin/edit-channel-info", {"name": info0.get("name", ""), "description": info0.get("description", ""),
                                                  "logoUrl": info0.get("logoUrl", "")})
    call(admin, "/api/admin/settings/set", settings0)
    call(admin, "/api/admin/privilegs-users/set", {"list": users0})
    call(admin, "/api/admin/set-emojis", {"emojis": emojis0})
    _, sched = call(admin, "/api/admin/scheduled-messages/get")
    call(admin, "/api/admin/scheduled-messages/update", [x for x in sched or [] if "מתוזמנת-" not in x.get("text", "")])
    for mid in created_ids:
        call(admin, f"/api/admin/delete-message/{mid}")
    _, info = call(anon, "/api/channel/info")
    _, s = call(admin, "/api/admin/settings/get")
    _, u = call(admin, "/api/admin/privilegs-users/get-list")
    check("state restored", info.get("name") == info0.get("name") and (s or []) == settings0 and
          [x["email"] for x in u or []] == [x["email"] for x in users0])

print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)

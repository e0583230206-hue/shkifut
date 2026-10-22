"""End-to-end test of polls against a local stack (http://localhost:18080 by default, BASE_URL to change; DEV_LOGIN on).

    python -I tests/e2e_polls.py            # includes a scheduled poll (waits up to ~70s for the scheduler)
    python -I tests/e2e_polls.py --quick    # skips the scheduled poll

Uses three users (the admin and two readers via dev-login). Test messages are deleted at the end;
settings and scheduled messages are restored.
"""
import http.cookiejar
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402
B = base_url()
QUICK = "--quick" in sys.argv
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def login(email=None):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(B + "/auth/dev-login" + (f"?email={email}" if email else "")).read()
    return op


def call(op, path, obj=None, headers=None):
    data = json.dumps(obj).encode() if obj is not None else None
    h = {"Content-Type": "application/json"} if data else {}
    r = urllib.request.Request(B + path, data=data, headers={**h, **(headers or {})})
    try:
        with op.open(r) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body[:1] in (b"{", b"[") else body)
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def counts(poll):
    return [o["count"] for o in poll["options"]]


def poll_of(op, mid):
    st, msgs = call(op, "/api/messages?offset=0&limit=60&direction=desc")
    return next((m.get("poll") for m in msgs if m["id"] == mid), None)


admin = login()
alice = login(f"alice-{uuid.uuid4().hex[:6]}@example.com")
bob = login(f"bob-{uuid.uuid4().hex[:6]}@example.com")
anon = urllib.request.build_opener()
marker = "poll-" + uuid.uuid4().hex[:6]
created = []
orig_settings = call(admin, "/api/admin/settings/get")[1] or []
orig_sched = call(admin, "/api/admin/scheduled-messages/get")[1] or []


def new_poll(question, options, multiple=False, text=""):
    st, m = call(admin, "/api/admin/new", {"type": "md", "text": text, "poll": {"question": question, "options": [{"text": o} for o in options], "multiple": multiple}})
    if st == 200:
        created.append(m["id"])
    return st, m


try:
    st, m = new_poll(f"מה דעתך? {marker}", ["כן", "לא", "אולי"])
    pid = m["id"]
    check("writer creates a poll", st == 200 and m["poll"]["question"].startswith("מה דעתך") and counts(m["poll"]) == [0, 0, 0], st)
    check("a poll without text gets the question as its text", m["text"] == f"📊 מה דעתך? {marker}", m["text"])

    check("one option rejected (400)", new_poll("q", ["רק אחת"])[0] == 400)
    check("11 options rejected (400)", new_poll("q", [str(i) for i in range(11)])[0] == 400)
    check("duplicate options rejected (400)", new_poll("q", ["א", " א "])[0] == 400)
    check("empty question rejected (400)", new_poll("  ", ["א", "ב"])[0] == 400)

    check("anonymous reader cannot vote (401)", call(anon, "/api/polls/vote", {"messageId": pid, "options": [0]})[0] == 401)

    events = []

    def listen():
        try:
            with urllib.request.urlopen(B + "/api/events", timeout=8) as resp:
                for raw in resp:
                    if b'"type":"poll"' in raw:
                        events.append(json.loads(raw.decode().split("data:", 1)[1]))
                        return
        except Exception:
            pass
    t = threading.Thread(target=listen, daemon=True)
    t.start()
    time.sleep(1)

    st, r = call(alice, "/api/polls/vote", {"messageId": pid, "options": [1]})
    check("user votes", st == 200 and counts(r["poll"]) == [0, 1, 0] and r["mine"] == [1], r)
    t.join(8)
    check("viewers get live poll results", bool(events) and events[0]["messageId"] == pid and counts(events[0]["poll"]) == [0, 1, 0], events[:1])

    st, r = call(alice, "/api/polls/vote", {"messageId": pid, "options": [2]})
    check("changing a vote moves it (no double count)", counts(r["poll"]) == [0, 0, 1] and r["poll"]["voters"] == 1, r["poll"])
    call(bob, "/api/polls/vote", {"messageId": pid, "options": [2]})
    check("results are shared (2 voters)", counts(poll_of(anon, pid)) == [0, 0, 2] and poll_of(anon, pid)["voters"] == 2)

    check("single choice: two options rejected (400)", call(bob, "/api/polls/vote", {"messageId": pid, "options": [0, 1]})[0] == 400)
    check("out-of-range option rejected (400)", call(bob, "/api/polls/vote", {"messageId": pid, "options": [7]})[0] == 400)
    check("voting on a message without a poll -> 404", call(bob, "/api/polls/vote", {"messageId": 999999999, "options": [0]})[0] == 404)

    st, mine = call(alice, f"/api/polls/mine?ids={pid},999999")
    check("'my vote' per user", st == 200 and mine == {str(pid): [2]}, mine)
    check("another user's 'my vote' is their own", call(bob, f"/api/polls/mine?ids={pid}")[1] == {str(pid): [2]})

    st, r = call(alice, "/api/polls/vote", {"messageId": pid, "options": []})
    check("withdrawing a vote", counts(r["poll"]) == [0, 0, 1] and r["mine"] == [], r)

    st, mm = new_poll(f"מה לקנות? {marker}", ["לחם", "חלב", "ביצים"], multiple=True, text=f"רשימת קניות {marker}")
    st, r = call(alice, "/api/polls/vote", {"messageId": mm["id"], "options": [0, 2]})
    check("multiple choice: several options", st == 200 and counts(r["poll"]) == [1, 0, 1] and r["poll"]["voters"] == 1, r)
    check("multiple choice: duplicate indexes rejected (400)", call(bob, "/api/polls/vote", {"messageId": mm["id"], "options": [1, 1]})[0] == 400)

    check("reader cannot close a poll (401)", call(alice, "/api/admin/polls/close", {"messageId": pid, "closed": True})[0] == 401)
    st, r = call(admin, "/api/admin/polls/close", {"messageId": pid, "closed": True})
    check("writer closes the poll", st == 200 and r["poll"]["closed"])
    check("voting on a closed poll -> 409", call(bob, "/api/polls/vote", {"messageId": pid, "options": [0]})[0] == 409)
    call(admin, "/api/admin/polls/close", {"messageId": pid, "closed": False})
    check("reopened poll accepts votes", call(bob, "/api/polls/vote", {"messageId": pid, "options": [0]})[0] == 200)

    forged = {**m, "text": m["text"] + " (נערך)", "poll": {"question": "זויף", "options": [{"text": "כן", "count": 999}], "multiple": False}}
    call(admin, "/api/admin/edit-message", forged)
    p = poll_of(anon, pid)
    check("editing the message cannot change the poll or its results", p["question"].startswith("מה דעתך") and counts(p) == [1, 0, 0] and p["voters"] == 1, p)  # bob moved his vote to option 0

    key = uuid.uuid4().hex * 2
    call(admin, "/api/admin/settings/set", [s for s in orig_settings if s["key"] != "api_secret_key"] + [{"key": "api_secret_key", "value": key}])
    st, br = call(anon, "/api/import/post", {"poll": {"question": f"מהגשר {marker}", "options": [{"text": "א"}, {"text": "ב"}]}}, {"X-API-Key": key})
    if st == 200:
        created.append(br["id"])
    check("bridge can post a poll", st == 200 and br.get("poll", {}).get("question") == f"מהגשר {marker}", (st, br if st != 200 else ""))

    st, deleted_poll = new_poll(f"נמחק {marker}", ["א", "ב"])
    call(admin, f"/api/admin/delete-message/{deleted_poll['id']}")
    check("voting on a deleted message's poll -> 404", call(bob, "/api/polls/vote", {"messageId": deleted_poll["id"], "options": [0]})[0] == 404)

    if not QUICK:
        when = (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat()
        sched = orig_sched + [{"type": "md", "text": "", "timestamp": when,
                               "poll": {"question": f"מתוזמן {marker}", "options": [{"text": "א"}, {"text": "ב"}], "multiple": False}}]
        call(admin, "/api/admin/scheduled-messages/update", sched)
        found = None
        for _ in range(16):
            time.sleep(5)
            st, msgs = call(anon, "/api/messages?offset=0&limit=20&direction=desc")
            found = next((x for x in msgs if (x.get("poll") or {}).get("question") == f"מתוזמן {marker}"), None)
            if found:
                created.append(found["id"])
                break
        check("scheduled poll is published with its poll", bool(found) and counts(found["poll"]) == [0, 0], found and found.get("poll"))
finally:
    for mid in created:
        call(admin, f"/api/admin/delete-message/{mid}")
    call(admin, "/api/admin/settings/set", orig_settings)
    if not QUICK:
        call(admin, "/api/admin/scheduled-messages/update", orig_sched)
    check("settings restored", (call(admin, "/api/admin/settings/get")[1] or []) == orig_settings)

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)

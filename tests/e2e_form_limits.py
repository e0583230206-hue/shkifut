"""End-to-end test of the limits of the report form (logged-in accounts) and the contact form (anyone): length, rate, forged fields.

    BASE_URL=http://localhost:18083 python -I tests/e2e_form_limits.py     # a fresh local stack (tests/docker-compose.ui-test.yml)

The counters live in Redis for up to a day (per address: 30 reports a day, 15 contact messages a day), so run it on a fresh stack; running it a
second time on the same stack hits those limits. Needs at least 3 messages in the channel (tests/ui/seed_ui_data.py makes some).
"""
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402

B = base_url()
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


def call(op, path, obj=None, raw=None):
    data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
    r = urllib.request.Request(B + path, data=data, headers={"Content-Type": "application/json"} if data else {})
    try:
        with op.open(r, timeout=30) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body[:1] in (b"{", b"[") else body)
    except urllib.error.HTTPError as e:
        return e.code, e.read()


admin = opener("")
msgs = call(opener(), "/api/messages?offset=0&limit=10&direction=desc")[1]
ids = [m["id"] for m in msgs if m.get("text")]
assert len(ids) >= 3, "the stack needs at least 3 messages"
rep = lambda op, mid, reason: call(op, "/api/messages/report", {"messageId": mid, "reason": reason})


def fresh():
    return opener(f"limits-{uuid.uuid4().hex[:8]}@example.com")


# ---------------- report
print("== report")
check("a visitor (not logged in) cannot report", rep(opener(), ids[0], "בדיקה של דיווח")[0] == 401)
u = fresh()
check("a normal report is accepted", rep(u, ids[0], "ההודעה הזו מטעה, בדיקה")[0] == 200)
check("the same account reporting the same message again: refused (409)", rep(u, ids[0], "עוד פעם")[0] == 409)
check("reason too short: 400", rep(fresh(), ids[0], "ab")[0] == 400)
check("empty reason: 400", rep(fresh(), ids[0], "   ")[0] == 400)
check("reason of 501 characters: 400", rep(fresh(), ids[0], "א" * 501)[0] == 400)
check("reason of exactly 500 characters: accepted", rep(fresh(), ids[1], "א" * 500)[0] == 200)
check("unknown message: 404", rep(fresh(), 99999999, "הודעה שלא קיימת")[0] == 404)
check("message number 0: 400", rep(fresh(), 0, "מספר לא חוקי")[0] == 400)
check("a huge request (20 KB): 413", call(fresh(), "/api/messages/report", {"messageId": ids[0], "reason": "x" * 20000})[0] == 413)
check("not JSON: 400", call(fresh(), "/api/messages/report", raw=b"hello")[0] == 400)

forger = fresh()
st, _ = call(forger, "/api/messages/report", {"messageId": ids[2], "reason": "שדות מזויפים", "closed": True, "reporterId": "someone-else", "id": 1})
st2, reports = call(admin, "/api/admin/reports/get?status=open")
mine = [r for r in (reports if isinstance(reports, list) else []) if r.get("reason") == "שדות מזויפים"]
check("fields sent by the client (closed, reporterId, id) are ignored", st == 200 and len(mine) == 1 and not mine[0].get("closed") and mine[0].get("reporterId") != "someone-else" and mine[0].get("id") != 1, mine)

heavy = fresh()
codes = [rep(heavy, mid, f"דיווח מספר {i}")[0] for i, mid in enumerate([ids[0], ids[1], ids[2], ids[0]])]
check("one account: 3 reports in 10 minutes, the 4th is refused (429)", codes == [200, 200, 200, 429], codes)

# ---------------- contact form (public)
print("== contact form")
contact = lambda msg, op=None, **k: call(op or opener(), "/api/contact", {"name": "בודק", "email": "t@example.com", "message": msg, "elapsedMs": 9000, **k})
check("a message of 2001 characters: 400", contact("א" * 2001)[0] == 400)
check("a request of 20 KB: 413 or 400", contact("x" * 20000)[0] in (400, 413))
check("too short: 400", contact("abc")[0] == 400)
check("without e-mail or phone: 400", call(opener(), "/api/contact", {"name": "t", "message": "הודעה תקינה בלי דרך חזרה", "elapsedMs": 9000})[0] == 400)
codes = [contact(f"הודעה מספר {i} לבדיקת קצב")[0] for i in range(5)]
check("a visitor: 3 messages in 10 minutes, then 429", codes == [200, 200, 200, 429, 429], codes)
check("a message of exactly 2000 characters is within the length (the rate may refuse it now)", contact("א" * 2000)[0] in (200, 429))

print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)

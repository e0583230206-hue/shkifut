"""End-to-end test of the contact form against a local stack (http://localhost:8080, DEV_LOGIN on).

    python -I tests/e2e_contact.py

Test messages are marked handled at the end; the per-IP rate-limit counter is cleared via docker if available.
"""
import http.cookiejar
import json
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
B = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def login(email=None):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(B + "/auth/dev-login" + (f"?email={email}" if email else "")).read()
    return op


def call(op, path, obj=None):
    data = json.dumps(obj).encode() if obj is not None else None
    r = urllib.request.Request(B + path, data=data, headers={"Content-Type": "application/json"} if data else {})
    try:
        with op.open(r) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body[:1] in (b"{", b"[") else body)
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def clear_rate_limit():
    try:
        subprocess.run(["docker", "compose", "-f", "docker-compose.local.yml", "exec", "-T", "redis", "sh", "-c",
                        "for k in $(redis-cli -s /data/kvrocks.sock --scan --pattern 'contact:rate:*'); do "
                        "redis-cli -s /data/kvrocks.sock DEL $k >/dev/null; done"],
                       capture_output=True, timeout=30, env={"MSYS_NO_PATHCONV": "1", **__import__("os").environ})
    except Exception:
        pass


anon = urllib.request.build_opener()
admin = login()
marker = "contact-test-" + uuid.uuid4().hex[:6]
good = {"name": "בודק", "email": "test@example.com", "phone": "", "subject": marker, "message": "שלום, זו פנייה לבדיקה",
        "website": "", "elapsedMs": 8000}
clear_rate_limit()
try:
    st, r = call(anon, "/api/contact", good)
    check("valid message accepted", st == 200 and r.get("success"), st)

    st, _ = call(anon, "/api/contact", {**good, "message": "hi"})
    check("too short message -> 400", st == 400, st)
    st, _ = call(anon, "/api/contact", {**good, "email": "", "phone": ""})
    check("no email and no phone -> 400", st == 400, st)
    st, _ = call(anon, "/api/contact", {**good, "email": "not-an-email"})
    check("invalid email -> 400", st == 400, st)
    st, _ = call(anon, "/api/contact", {**good, "message": "buy http://a.x http://b.x http://c.x http://d.x"})
    check("more than 3 links -> 400", st == 400, st)

    st, r = call(anon, "/api/contact", {**good, "subject": marker + "-bot", "website": "http://spam"})
    check("honeypot filled -> silently ignored (200)", st == 200, st)
    st, r = call(anon, "/api/contact", {**good, "subject": marker + "-fast", "elapsedMs": 400})
    check("submitted too fast -> silently ignored (200)", st == 200, st)

    _, inbox = call(admin, "/api/admin/contact?status=open")
    mine = [m for m in inbox if m["subject"].startswith(marker)]
    check("only the real message reached the inbox", [m["subject"] for m in mine] == [marker], [m["subject"] for m in mine])

    st, _ = call(login(f"reader-{uuid.uuid4().hex[:6]}@example.com"), "/api/admin/contact?status=open")
    check("reader cannot read the inbox", st == 401, st)
    st, _ = call(anon, "/api/admin/contact?status=open")
    check("anonymous cannot read the inbox", st == 401, st)

    if mine:
        call(admin, "/api/admin/contact/set", {"id": mine[0]["id"], "handled": True})
        _, inbox = call(admin, "/api/admin/contact?status=open")
        _, allm = call(admin, "/api/admin/contact?status=all")
        check("mark handled", all(m["id"] != mine[0]["id"] for m in inbox) and
              any(m["id"] == mine[0]["id"] and m["handled"] for m in allm))

    # Rate limit: 5 accepted per IP per hour (one already used above).
    codes = [call(anon, "/api/contact", {**good, "subject": f"{marker}-rate{i}"})[0] for i in range(5)]
    check("6th message within the hour -> 429", codes == [200, 200, 200, 200, 429], codes)
finally:
    _, inbox = call(admin, "/api/admin/contact?status=open")
    for m in inbox or []:
        if m["subject"].startswith(marker):
            call(admin, "/api/admin/contact/set", {"id": m["id"], "handled": True})
    clear_rate_limit()

print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)

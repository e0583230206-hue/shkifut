"""End-to-end test of the admin "who is online" list (BASE_URL, default http://localhost:8080; the LOCAL stack, DEV_LOGIN on).

    BASE_URL=http://localhost:18080 python -I tests/e2e_presence.py

Needs docker only for the last check (the 30-day cleanup runs when the backend starts): container names thechannel-local-*.
"""
import http.cookiejar
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
B = os.environ.get("BASE_URL", "http://localhost:8080")
failures = []
RUN = uuid.uuid4().hex[:6]
READER, MOD, OLD = f"reader-{RUN}@example.com", f"mod-{RUN}@example.com", f"old-{RUN}@example.com"


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
        return e.code, None


def me(p, email):
    return next((u for u in (p or {}).get("users", []) if u["email"] == email), None)


admin = login()
_, users0 = call(admin, "/api/admin/privilegs-users/get-list")
users0 = users0 or []
try:
    call(admin, "/api/admin/privilegs-users/set", {"list": users0 + [{"email": MOD, "username": "", "publicName": "", "privileges": {"moderator": True}}]})
    reader, mod, anon = login(READER), login(MOD), urllib.request.build_opener()

    st, _ = call(anon, "/api/admin/presence")
    check("anonymous: 401", st == 401, st)
    check("reader cannot open the list", call(reader, "/api/admin/presence")[0] == 401)
    check("moderator cannot open the list (admins only)", call(mod, "/api/admin/presence")[0] == 401)

    # a reader opens the site
    call(reader, "/api/user-info")
    call(reader, "/api/messages")
    time.sleep(1.5)
    st, p = call(admin, "/api/admin/presence")
    u = me(p, READER)
    check("admin: 200 with the list", st == 200 and isinstance(p, dict), st)
    check("the reader appears, online (seen just now)", bool(u) and u["online"] is True, u)
    check("no connections yet", bool(u) and u["connections"] == 0, u)
    check("response carries retention and window", p["retentionDays"] == 30 and p["onlineWindowSec"] == 300, (p.get("retentionDays"), p.get("onlineWindowSec")))

    # an open live-update connection counts, and goes away when closed
    holder = []

    def stream():
        try:
            resp = reader.open(urllib.request.Request(B + "/api/events"), timeout=120)
            holder.append(resp)
            while resp.readline():
                pass
        except Exception:
            pass
    t = threading.Thread(target=stream, daemon=True)
    t.start()
    time.sleep(2)
    _, p = call(admin, "/api/admin/presence")
    u = me(p, READER)
    check("an open live connection is counted", bool(u) and u["connections"] >= 1 and u["online"], u)
    for resp in holder:  # the reader closes the tab
        try:
            resp.fp.raw._sock.shutdown(2)
        except Exception:
            pass
        resp.close()
    for _ in range(40):
        time.sleep(1)
        _, p = call(admin, "/api/admin/presence")
        u = me(p, READER)
        if u and u["connections"] == 0:
            break
    check("when the connection ends the count drops and last seen stays", bool(u) and u["connections"] == 0 and bool(u["lastSeen"]), u)

    # 30-day retention: an old record is deleted when the backend starts
    try:
        rd = "thechannel-local-redis-1"
        old_ts = int(time.time()) - 31 * 86400
        run = lambda *a: subprocess.run(["docker", "exec", rd, "redis-cli", "-s", "/data/kvrocks.sock", *a], capture_output=True, text=True)
        run("ZADD", "presence:seen", str(old_ts), OLD)
        run("HSET", "presence:names", OLD, "ישן")
        _, p = call(admin, "/api/admin/presence")
        check("an old record is listed before the cleanup", me(p, OLD) is not None)
        subprocess.run(["docker", "restart", "thechannel-local-backend-1"], capture_output=True)
        for _ in range(40):
            time.sleep(2)
            try:
                if urllib.request.urlopen(B + "/login", timeout=5).status == 200:
                    break
            except Exception:
                pass
        admin = login()
        _, p = call(admin, "/api/admin/presence")
        check("after a start: the 31-day-old record is deleted", me(p, OLD) is None)
        check("... and the recent one is kept", me(p, READER) is not None)
        check("... the old name is deleted too", run("HGET", "presence:names", OLD).stdout.strip() == "")
    except FileNotFoundError:
        print("SKIP retention check (docker not available)")
finally:
    _, u2 = call(admin, "/api/admin/privilegs-users/get-list")
    call(admin, "/api/admin/privilegs-users/set", {"list": users0})
    subprocess.run(["docker", "exec", "thechannel-local-redis-1", "redis-cli", "-s", "/data/kvrocks.sock", "ZREM", "presence:seen", READER, MOD, OLD], capture_output=True)
    subprocess.run(["docker", "exec", "thechannel-local-redis-1", "redis-cli", "-s", "/data/kvrocks.sock", "HDEL", "presence:names", READER, MOD, OLD], capture_output=True)

print("\nFAILED: " + ", ".join(failures) if failures else "\nALL PASSED")
sys.exit(1 if failures else 0)

"""End-to-end test of the private (invite-only) site mode.

    python -I tests/e2e_private.py

Starts a second backend from the local image on 127.0.0.1:8091 with ALLOWED_EMAILS set (same data as the
local stack), checks that only approved accounts get in, then removes it. localhost:8080 stays public.
"""
import http.cookiejar
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
P = "http://127.0.0.1:8091"
ALLOWED = "allowed-tester@example.com"
NAME = "thechannel-private-test"
ENV = {"MSYS_NO_PATHCONV": "1", **os.environ}
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def opener(jar=None):
    handlers = [NoRedirect()] + ([urllib.request.HTTPCookieProcessor(jar)] if jar is not None else [])
    return urllib.request.build_opener(*handlers)


def get(op, path, accept="application/json", method="GET", data=None):
    r = urllib.request.Request(P + path, data=data, method=method, headers={"Accept": accept, "Content-Type": "application/json"})
    try:
        with op.open(r, timeout=10) as resp:
            return resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def login_as(email):
    jar = http.cookiejar.CookieJar()
    op = opener(jar)
    st, body, h = get(op, f"/auth/dev-login?email={email}", accept="text/html")
    return op, st


subprocess.run(["docker", "rm", "-f", NAME], capture_output=True, env=ENV)
run = subprocess.run(["docker", "compose", "-f", "docker-compose.local.yml", "run", "-d", "--rm", "--no-deps", "--name", NAME,
                      "-p", "127.0.0.1:8091:3000", "-e", f"ALLOWED_EMAILS={ALLOWED}", "-e", "DEV_LOGIN=true", "backend"],
                     capture_output=True, text=True, env=ENV)
try:
    for _ in range(40):
        try:
            urllib.request.urlopen(P + "/login", timeout=2)
            break
        except Exception:
            time.sleep(1)
    anon = opener()

    st, _, h = get(anon, "/", accept="text/html")
    check("guest opening the site is sent to the login page", st == 302 and h.get("Location") == "/login", (st, h.get("Location")))
    for path in ["/api/messages?offset=0&limit=5", "/api/channel/info", "/api/messages/search?q=test", "/api/topics",
                 "/api/messages/pinned", "/api/events", "/sitemap.xml", "/api/files/0123456789012345678901234567890123456789"]:
        st, body, _ = get(anon, path)
        check(f"guest blocked: {path.split('?')[0]}", st == 401, st)
    st, _, h = get(anon, "/m/1", accept="text/html")
    check("guest blocked: message link page (no preview leak)", st == 302, st)

    st, body, h = get(anon, "/login", accept="text/html")
    check("login page is reachable", st == 200 and b"<app-root" in body, st)
    js = re.search(rb'src="(/assets/main-[^"]+\.js)"', body)
    check("login page scripts are reachable", bool(js) and get(anon, js.group(1).decode())[0] == 200)
    st, body, h = get(anon, "/robots.txt")
    check("robots.txt disallows everything", st == 200 and b"Disallow: /\n" in body, body[:60])
    check("pages carry X-Robots-Tag noindex", "noindex" in (h.get("X-Robots-Tag") or ""))
    st, body, _ = get(anon, "/api/import/post", method="POST", data=b'{"text":"x"}')
    check("bridge endpoint still reachable (its own API key decides)", st in (400, 401) and b"login required" not in body, (st, body[:40]))
    st, body, _ = get(anon, "/auth/login", method="POST", data=b'{"code":"x"}')
    check("Google login endpoint reachable", b"login required" not in body, (st, body[:40]))

    stranger, st = login_as("stranger@example.com")
    check("unapproved account cannot log in (403)", st == 403, st)
    check("...and still sees nothing", get(stranger, "/api/messages?offset=0&limit=5")[0] == 401)

    friend, st = login_as(ALLOWED)
    check("approved account logs in", st == 302, st)
    check("approved account reads messages", get(friend, "/api/messages?offset=0&limit=5")[0] == 200)
    check("approved account opens the site", get(friend, "/", accept="text/html")[0] == 200)

    admin_email = next((l.split("=", 1)[1].split(",")[0].strip() for l in open(".env", encoding="utf-8") if l.startswith("ADMIN_USERS=")), "")
    admin, st = login_as(admin_email)
    check("admins (ADMIN_USERS) are always allowed", st == 302 and get(admin, "/api/user-info")[0] == 200, (admin_email, st))

    pub = urllib.request.urlopen("http://localhost:8080/api/messages?offset=0&limit=1", timeout=10).status
    check("localhost:8080 (no ALLOWED_EMAILS) stays public", pub == 200, pub)
finally:
    subprocess.run(["docker", "rm", "-f", NAME], capture_output=True, env=ENV)

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)

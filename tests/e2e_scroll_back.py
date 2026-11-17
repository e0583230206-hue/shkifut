"""Scrolling back when a message released after being held sits on top (local stack, DEV_LOGIN on).

    python -I tests/e2e_scroll_back.py

A released held message keeps its low id but gets the newest time. The page used the lowest id on screen
as its bookmark, so scrolling back returned messages already shown, again and again, and never got
further (reported 17.11.2026: "brings back what I already saw", "stuck about two hours back").
Seeds 60 messages, moves the first one to the top, then runs tests/ui/scroll_back_check.mjs in Chrome.
"""
import http.cookiejar
import json
import os
import subprocess
import sys
import time
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402
B = base_url(sys.argv[1] if len(sys.argv) > 1 else None)
REDIS = os.environ.get("REDIS_CONTAINER", "thechannel-local-redis-1")

admin = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
admin.open(B + "/auth/dev-login").read()
marker = "scrollback-" + uuid.uuid4().hex[:6]
created = []
code = 1
try:
    for i in range(60):
        req = urllib.request.Request(B + "/api/admin/new", data=json.dumps({"type": "md", "text": f"{marker} {i}"}).encode(),
                                     headers={"Content-Type": "application/json"})
        created.append(json.loads(admin.open(req).read())["id"])
    released = created[0]  # approved now: low id, newest time
    subprocess.run(["docker", "exec", REDIS, "redis-cli", "-p", "6666", "ZADD", "m_times:1",
                    str(int(time.time()) + 5), f"messages:{released}"], check=True, capture_output=True)
    here = os.path.dirname(os.path.abspath(__file__))
    r = subprocess.run(["node", os.path.join(here, "ui", "scroll_back_check.mjs"), B, str(created[1]),
                        ",".join(map(str, created))], capture_output=True, text=True, timeout=180)
    print(r.stdout.strip() or r.stderr.strip())
    code = r.returncode
    print("PASS scrolling back: no repeats, reaches the oldest" if code == 0 else "FAIL scrolling back")
finally:
    for mid in created:
        admin.open(f"{B}/api/admin/delete-message/{mid}").read()
sys.exit(code)

"""The "participants" number of the header = the real number + PARTICIPANTS_OFFSET (the UI test stack sets 3500).

    BASE_URL=http://localhost:18083 python -I tests/e2e_participants.py
"""
import http.cookiejar
import json
import os
import sys
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402

B = base_url()
OFFSET = int(os.environ.get("EXPECT_OFFSET", "3500"))
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def views():
    return json.loads(urllib.request.urlopen(B + "/api/channel/info", timeout=20).read())["views"]


before = views()
check(f"the shown number is at least the offset ({OFFSET})", before >= OFFSET, before)
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
op.open(B + f"/auth/dev-login?email=count-{uuid.uuid4().hex[:6]}@example.com").read()
op.open(B + "/api/user-info").read()
after = views()
check("a new account raises the real part by 0 or 1, the offset stays", 0 <= after - before <= 1, f"{before} -> {after}")
print("\nALL PASSED" if not failures else f"\nFAILED: {failures}")
sys.exit(1 if failures else 0)

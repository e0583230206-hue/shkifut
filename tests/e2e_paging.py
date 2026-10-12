"""Regression test for message paging (http://localhost:8080, DEV_LOGIN on).

    python -I tests/e2e_paging.py

The paging script returned one message twice when a page had to skip deleted messages (inclusive
ZRANGE bounds). Creates 30 messages, deletes every other one, and pages through them as a reader.
"""
import http.cookiejar
import json
import sys
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
B = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def get(op, path):
    with op.open(B + path) as r:
        return json.loads(r.read())


admin = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
admin.open(B + "/auth/dev-login").read()
anon = urllib.request.build_opener()
marker = "page-" + uuid.uuid4().hex[:6]
created = []
try:
    for i in range(30):
        req = urllib.request.Request(B + "/api/admin/new", data=json.dumps({"type": "md", "text": f"{marker} {i}"}).encode(),
                                     headers={"Content-Type": "application/json"})
        created.append(json.loads(admin.open(req).read())["id"])
    for mid in created[1::2]:
        admin.open(f"{B}/api/admin/delete-message/{mid}").read()
    live = sorted(created[0::2], reverse=True)

    first = get(anon, "/api/messages?offset=0&limit=7&direction=desc")
    ids = [m["id"] for m in first]
    check("first page has exactly the requested number of messages", len(ids) == 7, ids)
    check("first page has no duplicates", len(ids) == len(set(ids)), ids)
    check("first page skips deleted messages, newest first", ids == live[:7], (ids, live[:7]))

    seen, offset = [], 0
    for _ in range(10):
        page = [m["id"] for m in get(anon, f"/api/messages?offset={offset}&limit=4&direction=desc")]
        page = [i for i in page if i in created]
        if not page:
            break
        seen += page
        offset = page[-1]
        if offset == live[-1]:
            break
    check("paging through all pages: every live message once, in order", seen == live, (seen, live))

    asc = [m["id"] for m in get(anon, f"/api/messages?offset={live[-1]}&limit=6&direction=asc")]
    check("ascending page has no duplicates and skips deleted", asc == sorted(live)[1:7], (asc, sorted(live)[1:7]))

    adm = [m["id"] for m in get(admin, "/api/messages?offset=0&limit=8&direction=desc")]
    check("writers see deleted messages too, without duplicates", len(adm) == 8 and len(set(adm)) == 8, adm)
finally:
    for mid in created:
        admin.open(f"{B}/api/admin/delete-message/{mid}").read()

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)

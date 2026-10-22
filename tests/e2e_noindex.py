"""Checks NOINDEX_SITE (http://localhost:18080 via BASE_URL, DEV_LOGIN on).

    BASE_URL=http://localhost:18080 python -I tests/e2e_noindex.py on     # backend started with tests/docker-compose.noindex-test.yml
    BASE_URL=http://localhost:18080 python -I tests/e2e_noindex.py off    # normal backend: nothing changes
"""
import os
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
MODE = sys.argv[1] if len(sys.argv) > 1 else ""
assert MODE in ("on", "off"), "usage: e2e_noindex.py on|off"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402
B = base_url()
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def get(path):
    try:
        with urllib.request.urlopen(urllib.request.Request(B + path, headers={"Accept": "text/html"})) as r:
            return r.status, r.headers, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")


on = MODE == "on"
for path in ("/", "/api/channel/info", "/robots.txt", "/privacy"):
    st, h, body = get(path)
    tag = h.get("X-Robots-Tag", "")
    check(f"{path}: X-Robots-Tag {'present' if on else 'absent'}", ("noindex" in tag) == on, tag)
st, h, body = get("/")
check("index: meta robots noindex " + ("present" if on else "absent"), ('name="robots" content="noindex, nofollow"' in body) == on)
check("index: still has the link preview tags", 'property="og:title"' in body)
st, h, body = get("/robots.txt")
check("robots.txt: " + ("Disallow: /" if on else "normal rules"), ("Disallow: /\n" in body and "Sitemap" not in body) if on else ("Sitemap:" in body), body[:80])
st, h, body = get("/sitemap.xml")
check("sitemap.xml: " + ("404" if on else "served"), (st == 404) if on else (st == 200), st)
print("\nFAILED: " + ", ".join(failures) if failures else "\nALL PASSED")
sys.exit(1 if failures else 0)

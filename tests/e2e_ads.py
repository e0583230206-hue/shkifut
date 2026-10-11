"""End-to-end test of the ads settings API (http://localhost:8080, DEV_LOGIN on). Restores settings at the end.

    python -I tests/e2e_ads.py
"""
import http.cookiejar
import json
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
B = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


admin = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
admin.open(B + "/auth/dev-login").read()
anon = urllib.request.build_opener()


def ads():
    return json.loads(anon.open(B + "/api/ads/settings").read())


def set_settings(lst):
    admin.open(urllib.request.Request(B + "/api/admin/settings/set", data=json.dumps(lst).encode(),
                                      headers={"Content-Type": "application/json"})).read()


original = json.loads(admin.open(B + "/api/admin/settings/get").read() or b"[]") or []
base = [s for s in original if not (s["key"].startswith("ads_") or s["key"].startswith("ad-iframe"))]
try:
    set_settings(base)
    a = ads()
    check("no ad configured -> disabled, no feed ads", a["enabled"] is False and a["feedEvery"] == 0, a)

    set_settings(base + [{"key": "ads_embed_code", "value": "<div>ad</div>"}, {"key": "ads_feed_every", "value": 3}])
    a = ads()
    check("embed code + every 3 -> enabled, feedEvery 3, default height 250",
          a["enabled"] and a["embedCode"] == "<div>ad</div>" and a["feedEvery"] == 3 and a["feedHeight"] == 250, a)

    set_settings(base + [{"key": "ads_embed_code", "value": "<div>ad</div>"}, {"key": "ads_feed_every", "value": 3},
                         {"key": "ads_enabled", "value": False}])
    a = ads()
    check("ads_enabled=false hides everything", not a["enabled"] and a["embedCode"] == "" and a["feedEvery"] == 0, a)

    set_settings(base + [{"key": "ad-iframe-src", "value": "https://example.com/ad"}])
    a = ads()
    check("legacy iframe setting still works (width defaults to 300)", a["enabled"] and a["src"] and a["width"] == 300, a)
finally:
    set_settings(original)
    restored = json.loads(admin.open(B + "/api/admin/settings/get").read() or b"[]") or []
    check("settings restored", restored == original)

print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)

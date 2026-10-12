"""End-to-end test of channel search against a local stack (http://localhost:8080, DEV_LOGIN on).

    python -I tests/e2e_search.py

Creates a few marked messages, checks the search API, and deletes them at the end.
"""
import http.cookiejar
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
B = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def call(op, path, obj=None):
    data = json.dumps(obj).encode() if obj is not None else None
    r = urllib.request.Request(B + path, data=data, headers={"Content-Type": "application/json"} if data else {})
    try:
        with op.open(r) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body[:1] in (b"{", b"[") else body)
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def search(op, q, **extra):
    return call(op, "/api/messages/search?" + urllib.parse.urlencode({"q": q, **extra}))


admin = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
admin.open(B + "/auth/dev-login").read()
anon = urllib.request.build_opener()

m = "srch" + uuid.uuid4().hex[:6]
texts = {
    "niqqud": f"הודעת בדיקה {m} עם **שָׁלוֹם** וניקוד",
    "plain": f"שלום עולם {m} בלי ניקוד, ועוד מילה ייחודית תפוז",
    "deleted": f"{m} הודעה שתימחק שלום",
    "embed_only": f"תמונה בלבד [image-embedded#](/api/files/{m}0000000000000000000000000000000000)",
}
ids = {}
try:
    for k, t in texts.items():
        st, r = call(admin, "/api/admin/new", {"type": "md", "text": t})
        ids[k] = r["id"]
    call(admin, f"/api/admin/delete-message/{ids['deleted']}")

    st, res = search(anon, m)
    found = [r["id"] for r in res] if st == 200 else res
    check("anonymous reader can search", st == 200, st)
    check("finds the two live messages, newest first", found == [ids["plain"], ids["niqqud"]], found)
    check("deleted message is never returned", ids["deleted"] not in found)
    check("text inside an embed address does not match", ids["embed_only"] not in found)

    st, res = search(anon, f"שלום {m}")
    check("niqqud-insensitive and all words required (AND)", st == 200 and sorted(r["id"] for r in res) == sorted([ids["plain"], ids["niqqud"]]), res)
    st, res = search(anon, f"{m} תפוז")
    check("multi-word query narrows the results", st == 200 and [r["id"] for r in res] == [ids["plain"]], res)

    st, res = search(anon, f"{m} שלום")
    snip = next((r["snippet"] for r in res if r["id"] == ids["niqqud"]), "")
    check("snippet is plain text (no markdown)", "**" not in snip and m in snip, snip)
    check("result has timestamp", all(r.get("timestamp", "").startswith("20") for r in res), res[:1])

    st, _ = search(anon, "a")
    check("one-character query rejected (400)", st == 400, st)
    st, _ = search(anon, "x" * 101)
    check("over-long query rejected (400)", st == 400, st)
    st, res = search(anon, m, limit=1)
    check("limit is honoured", st == 200 and len(res) == 1, len(res) if isinstance(res, list) else res)
finally:
    for k, i in ids.items():
        if k != "deleted":
            call(admin, f"/api/admin/delete-message/{i}")

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)

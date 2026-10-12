"""End-to-end test of pinned messages against a local stack (http://localhost:8080, DEV_LOGIN on).

    python -I tests/e2e_pins.py

Existing pins are saved first and restored at the end; test messages are deleted.
"""
import http.cookiejar
import json
import sys
import threading
import time
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


def call(op, path, obj=None):
    data = json.dumps(obj).encode() if obj is not None else None
    r = urllib.request.Request(B + path, data=data, headers={"Content-Type": "application/json"} if data else {})
    try:
        with op.open(r) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body[:1] in (b"{", b"[") else body)
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def pinned(op):
    return [p["id"] for p in call(op, "/api/messages/pinned")[1]]


def pin(op, mid, on=True):
    return call(op, "/api/admin/pin", {"id": mid, "pinned": on})[0]


admin = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
admin.open(B + "/auth/dev-login").read()
anon = urllib.request.build_opener()

original = pinned(anon)
for mid in original:
    pin(admin, mid, False)
marker = "pin-" + uuid.uuid4().hex[:6]
created = []


def new_message(text):
    mid = call(admin, "/api/admin/new", {"type": "md", "text": text})[1]["id"]
    created.append(mid)
    return mid


try:
    a = new_message(f"הודעה נעוצה ראשונה **{marker}** [image-embedded#](/api/files/0000000000000000000000000000000000000000)")
    b = new_message(f"הודעה נעוצה שנייה {marker}")

    # live update: listen to the event stream while pinning
    events = []

    def listen():
        try:
            with urllib.request.urlopen(B + "/api/events", timeout=8) as resp:
                for raw in resp:
                    line = raw.decode("utf-8", "replace").strip()
                    if line.startswith("data:") and '"pins"' in line:
                        events.append(line)
                        return
        except Exception:
            pass
    t = threading.Thread(target=listen, daemon=True)
    t.start()
    time.sleep(1)

    check("writer can pin", pin(admin, a) == 200)
    time.sleep(1.1)  # pins are ordered by pin time (seconds)
    pin(admin, b)
    t.join(8)
    check("viewers get a live 'pins' event", bool(events), events[:1])

    lst = call(anon, "/api/messages/pinned")[1]
    check("anyone can read pins, newest pin first", [p["id"] for p in lst] == [b, a], [p["id"] for p in lst])
    snip = next(p["snippet"] for p in lst if p["id"] == a)
    check("pin snippet is plain text without embeds", marker in snip and "**" not in snip and "embedded" not in snip, snip)
    check("pinning twice is harmless", pin(admin, a) == 200 and pinned(anon).count(a) == 1)

    check("reader cannot pin (401)", pin(anon, b, False) == 401)
    check("pinning a missing message -> 404", pin(admin, 999999999) == 404)

    check("writer can unpin", pin(admin, a, False) == 200 and pinned(anon) == [b], pinned(anon))
    call(admin, f"/api/admin/delete-message/{b}")
    check("deleting a pinned message unpins it", b not in pinned(anon), pinned(anon))
    check("a deleted message cannot be pinned (404)", pin(admin, b) == 404)

    extra = [new_message(f"{marker} מילוי {i}") for i in range(10)]
    codes = [pin(admin, m) for m in extra]
    check("at most 10 pins (the 11th -> 409)", codes[:10] == [200] * 10 and pin(admin, a) == 409, codes)
finally:
    for mid in pinned(anon):
        pin(admin, mid, False)
    for mid in reversed(original):
        pin(admin, mid)
        time.sleep(1.05)
    for mid in created:
        call(admin, f"/api/admin/delete-message/{mid}")
    check("original pins restored", pinned(anon) == original, (pinned(anon), original))

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)

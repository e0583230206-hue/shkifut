"""End-to-end test of topics against a local stack (http://localhost:8080, DEV_LOGIN on).

    python -I tests/e2e_topics.py

Saves the current topics and settings, restores them at the end, and deletes its test messages.
"""
import http.cookiejar
import json
import sys
import threading
import time
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


def call(op, path, obj=None, headers=None):
    data = json.dumps(obj).encode() if obj is not None else None
    h = {"Content-Type": "application/json"} if data else {}
    r = urllib.request.Request(B + path, data=data, headers={**h, **(headers or {})})
    try:
        with op.open(r) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body[:1] in (b"{", b"[") else body)
    except urllib.error.HTTPError as e:
        return e.code, e.read()


admin = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
admin.open(B + "/auth/dev-login").read()
anon = urllib.request.build_opener()

orig_topics = call(anon, "/api/topics")[1]
orig_settings = call(admin, "/api/admin/settings/get")[1] or []
marker = "topic-" + uuid.uuid4().hex[:6]
created = []


def new(text, topic=None):
    st, m = call(admin, "/api/admin/new", {"type": "md", "text": text, **({"topic": topic} if topic is not None else {})})
    created.append(m["id"])
    return m


def ids_in(topic):
    st, msgs = call(anon, f"/api/messages?offset=0&limit=50&direction=desc&topic={topic}")
    return [m["id"] for m in msgs if m["id"] in created] if st == 200 else msgs


try:
    events = []

    def listen():
        try:
            with urllib.request.urlopen(B + "/api/events", timeout=8) as resp:
                for raw in resp:
                    if b'"topics"' in raw:
                        events.append(raw)
                        return
        except Exception:
            pass
    t = threading.Thread(target=listen, daemon=True)
    t.start()
    time.sleep(1)

    st, topics = call(admin, "/api/admin/topics", [{"name": f"חדשות {marker}", "color": "#ff0000"}, {"name": f"ספורט {marker}", "color": "bad"}])
    check("moderator saves topics; ids are assigned", st == 200 and all(len(x["id"]) == 8 for x in topics), topics)
    t.join(8)
    check("viewers get a live 'topics' event", bool(events))
    news, sport = topics[0], topics[1]
    check("invalid color falls back to the default", sport["color"] == "#3366ff", sport["color"])
    check("anyone can read the topic list", [x["id"] for x in call(anon, "/api/topics")[1]] == [news["id"], sport["id"]])

    check("reader cannot change topics (401)", call(anon, "/api/admin/topics", [])[0] == 401)
    check("duplicate name rejected (400)", call(admin, "/api/admin/topics", topics + [{"name": news["name"].upper()}])[0] == 400)
    check("empty name rejected (400)", call(admin, "/api/admin/topics", topics + [{"name": "  "}])[0] == 400)
    check("more than 20 topics rejected (400)", call(admin, "/api/admin/topics", [{"name": f"t{i}"} for i in range(21)])[0] == 400)

    m1 = new(f"{marker} הודעת חדשות", news["id"])
    m2 = new(f"{marker} הודעת ספורט", sport["id"])
    m3 = new(f"{marker} בלי נושא")
    m4 = new(f"{marker} נושא לא קיים", "no-such-topic")
    check("message keeps its topic", m1.get("topic") == news["id"], m1.get("topic"))
    check("unknown topic is ignored", not m4.get("topic"), m4.get("topic"))

    check("filter: news topic shows only news", ids_in(news["id"]) == [m1["id"]], ids_in(news["id"]))
    check("filter: sport topic shows only sport", ids_in(sport["id"]) == [m2["id"]], ids_in(sport["id"]))
    st, allm = call(anon, "/api/messages?offset=0&limit=50&direction=desc")
    check("no filter: all messages", {m1["id"], m2["id"], m3["id"], m4["id"]} <= {m["id"] for m in allm})

    call(admin, "/api/admin/edit-message", {**m1, "topic": sport["id"]})
    check("editing moves a message to its new topic", ids_in(news["id"]) == [] and ids_in(sport["id"]) == [m2["id"], m1["id"]],  # newest first
          (ids_in(news["id"]), ids_in(sport["id"])))

    key = uuid.uuid4().hex * 2
    call(admin, "/api/admin/settings/set", [s for s in orig_settings if s["key"] != "api_secret_key"] + [{"key": "api_secret_key", "value": key}])
    st, br = call(anon, "/api/import/post", {"text": f"{marker} מהגשר", "topic": news["name"]}, {"X-API-Key": key})
    if st == 200:
        created.append(br["id"])
    check("bridge can set a topic by its name", st == 200 and br.get("topic") == news["id"], (st, br if st != 200 else br.get("topic")))

    st, res = call(anon, "/api/messages/search?" + urllib.parse.urlencode({"q": marker, "topic": sport["id"]}))
    check("search within a topic", st == 200 and sorted(r["id"] for r in res) == sorted([m1["id"], m2["id"]]), res)

    call(admin, "/api/admin/topics", [news])
    check("removing a topic empties its filter", ids_in(sport["id"]) == [], ids_in(sport["id"]))
    st, allm = call(anon, "/api/messages?offset=0&limit=50&direction=desc")
    check("...but its messages stay in the channel", m2["id"] in {m["id"] for m in allm})
finally:
    for mid in created:
        call(admin, f"/api/admin/delete-message/{mid}")
    call(admin, "/api/admin/settings/set", orig_settings)
    call(admin, "/api/admin/topics", orig_topics)
    check("topics restored", call(anon, "/api/topics")[1] == orig_topics)
    check("settings restored", (call(admin, "/api/admin/settings/get")[1] or []) == orig_settings)

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)

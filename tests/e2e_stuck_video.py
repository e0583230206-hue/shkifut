"""End-to-end test: one stuck video must not block the queue (MODERATION_MAX_ATTEMPTS / _ATTEMPT_TIMEOUT / _RETRY_DELAY).

A FAKE moderation service runs inside this test (port 18098) and behaves per video: "bad" answers 500 every time, "hang" never
answers (the backend must give up waiting and tell the service to /cancel), "ok" answers like a real check. The backend runs with
short limits (tests/docker-compose.stuck-test.yml: 2 attempts, 6 s attempt timeout, 3 s sweep):

    # needs a .env with DEV_LOGIN=true and ADMIN_USERS=admin@example.com (see sample.env) and tests/media/short.mp4
    docker compose -p tc-stuck -f docker-compose.local.yml -f tests/docker-compose.stuck-test.yml up -d --build --no-deps redis backend
    BASE_URL=http://localhost:18082 python -I tests/e2e_stuck_video.py
    docker compose -p tc-stuck -f docker-compose.local.yml -f tests/docker-compose.stuck-test.yml down -v

It never touches the real moderation service, only the local stack on the given (local) BASE_URL.
"""
import hashlib
import http.cookiejar
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402

B = base_url()
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FAKE_PORT = 18098
MAX_ATTEMPTS = 2
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


# ---------- fake moderation service
behaviour = {}   # hash path -> "bad" | "hang" | "ok"
calls = {}       # hash path -> number of /process calls
cancels = []     # hash paths the backend told us to stop
lock = threading.Lock()


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        path = body.get("path", "")
        if self.path == "/cancel":
            with lock:
                cancels.append(path)
            return self.reply(200, {"ok": True})
        with lock:
            calls[path] = calls.get(path, 0) + 1
            mode = behaviour.get(path, "ok")
        if mode == "bad":
            return self.reply(500, {"error": "simulated crash"})
        if mode == "hang":
            time.sleep(40)  # longer than the backend's 6 s attempt timeout
            return
        self.reply(200, {"decision": "regional", "reasons": ["woman"], "confidence": 1.0, "regions": 1, "full_frames": 0})


def start_fake():
    srv = ThreadingHTTPServer(("0.0.0.0", FAKE_PORT), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ---------- backend helpers
def login():
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(B + "/auth/dev-login").read()
    return op


def call(op, path, obj=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
    r = urllib.request.Request(B + path, data=data, headers=headers or ({"Content-Type": "application/json"} if data else {}))
    try:
        with op.open(r, timeout=30) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body[:1] in (b"{", b"[") else body)
    except urllib.error.HTTPError as e:
        return e.code, None


def new_video(op, mode):
    """Upload a unique video (short.mp4 + random tail) and register how the fake service treats it."""
    data = open(os.path.join(ROOT, "tests", "media", "short.mp4"), "rb").read() + uuid.uuid4().bytes
    h = hashlib.sha256(data).hexdigest()
    path = f"{h[:2]}/{h[2:4]}/{h}"
    behaviour[path] = mode
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"stuck-test.mp4\"\r\nContent-Type: video/mp4\r\n\r\n").encode() \
        + data + f"\r\n--{bnd}--\r\n".encode()
    _, up = call(op, "/api/admin/upload", raw=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
    return up["url"].rsplit("/", 1)[1].split(".")[0], path


def info(op, fid):
    return call(op, f"/api/files/{fid}/moderation")[1] or {}


def wait_for(op, fid, pred, timeout):
    end, s = time.time() + timeout, {}
    while time.time() < end:
        s = info(op, fid)
        if pred(s):
            return s, True
        time.sleep(1)
    return s, False


if __name__ == "__main__":
    start_fake()
    op = login()

    # --- 1. a video that always crashes the service: tried MAX_ATTEMPTS times, then given up and kept blurred for a moderator
    bad_id, bad_path = new_video(op, "bad")
    s, ok = wait_for(op, bad_id, lambda s: s.get("status") != "pending", 60)
    check("crashing video is given up (not pending any more)", ok, s.get("status"))
    check("given-up video stays fully blurred", s.get("status") == "blurred", s.get("status"))
    check("reason is analysis_error", "analysis_error" in (s.get("autoReasons") or []), s.get("autoReasons"))
    check("marked for a moderator (needsReview)", s.get("needsReview") is True, s.get("needsReview"))
    time.sleep(8)  # several sweeps pass: no further attempts
    check(f"tried exactly {MAX_ATTEMPTS} times, never again", calls.get(bad_path) == MAX_ATTEMPTS, calls.get(bad_path))

    # --- 2. a hanging video must not hold the queue: the video uploaded after it is checked within seconds, not 45 minutes
    hang_id, hang_path = new_video(op, "hang")
    ok_id, ok_path = new_video(op, "ok")
    t0 = time.time()
    s, ok = wait_for(op, ok_id, lambda s: s.get("status") == "regional", 60)
    check("video behind a hanging one is checked (queue not blocked)", ok, f"{time.time() - t0:.0f}s, status={s.get('status')}")
    check("checked well before the hanging service would answer", time.time() - t0 < 35, f"{time.time() - t0:.0f}s")
    s, ok = wait_for(op, hang_id, lambda s: s.get("status") != "pending", 60)
    check("hanging video is given up after the attempts", ok and s.get("status") == "blurred", s.get("status"))
    check("service was told to cancel the abandoned work", hang_path in cancels, len(cancels))
    check(f"hanging video tried exactly {MAX_ATTEMPTS} times", calls.get(hang_path) == MAX_ATTEMPTS, calls.get(hang_path))
    check("good video was checked once", calls.get(ok_path) == 1, calls.get(ok_path))

    # --- 3. "check again" by a moderator starts counting from zero (the service works now)
    behaviour[bad_path] = "ok"
    code, _ = call(op, "/api/admin/files/reprocess", {"id": bad_id})
    check("reprocess accepted", code == 200, code)
    s, ok = wait_for(op, bad_id, lambda s: s.get("status") == "regional", 30)
    check("after 'check again' the video is checked normally", ok, s.get("status"))
    check("needsReview cleared by the new result", not s.get("needsReview"), s.get("needsReview"))

    print("\nFAILED: " + ", ".join(failures) if failures else "\nALL PASSED")
    sys.exit(1 if failures else 0)

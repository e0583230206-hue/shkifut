"""End-to-end test of the moderator review grid and corrections (http://localhost:8080, DEV_LOGIN on).

    python -I tests/e2e_review.py

Uploads tests/media/short.mp4 (not in git), waits for the moderation, corrects one figure, checks the re-run and
the training data, then removes the correction and the test's training examples.
"""
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
B = "http://localhost:8080"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
TRAINING = os.path.join(ROOT, "training")
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def login(email=None):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(B + "/auth/dev-login" + (f"?email={email}" if email else "")).read()
    return op


def call(op, path, obj=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
    r = urllib.request.Request(B + path, data=data, headers=headers or ({"Content-Type": "application/json"} if data else {}))
    try:
        with op.open(r) as resp:
            body = resp.read()
            return resp.status, resp.headers.get("Content-Type", ""), (json.loads(body) if body[:1] in (b"{", b"[") else body)
    except urllib.error.HTTPError as e:
        return e.code, "", None


def wait_status(op, fid, timeout=300, not_status="pending"):
    for _ in range(timeout // 2):
        _, _, s = call(op, f"/api/files/{fid}/moderation")
        if s and s["status"] != not_status:
            return s
        time.sleep(2)
    return s


admin = login()
video = open(os.path.join(ROOT, "tests", "media", "short.mp4"), "rb").read() + uuid.uuid4().bytes  # new hash
bnd = uuid.uuid4().hex
body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"review-test.mp4\"\r\n"
        f"Content-Type: video/mp4\r\n\r\n").encode() + video + f"\r\n--{bnd}--\r\n".encode()
_, _, up = call(admin, "/api/admin/upload", raw=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
fid = up["url"].rsplit("/", 1)[1].split(".")[0]
try:
    s = wait_status(admin, fid)
    check("video processed", s["status"] in ("regional", "open", "blurred"), s["status"])

    st, _, res = call(admin, f"/api/admin/files/{fid}/figures")
    figs = (res or {}).get("figures") or []
    check("figures listed for moderators", st == 200 and len(figs) > 0, len(figs))
    st, ctype, _ = call(admin, figs[0]["cropUrl"]) if figs else (0, "", None)
    check("figure crop served as JPEG", st == 200 and ctype.startswith("image/jpeg"), (st, ctype))

    reader = login(f"reader-{uuid.uuid4().hex[:6]}@example.com")
    check("reader cannot list figures", call(reader, f"/api/admin/files/{fid}/figures")[0] == 401)
    check("reader cannot read crops", figs and call(reader, figs[0]["cropUrl"])[0] == 401)

    target = next((f for f in figs if not f["visible"]), None)
    if target:
        st, _, r = call(admin, f"/api/admin/files/{fid}/figures", {"overrides": {target["key"]: "man"}})
        check("save correction (blurred figure -> man)", st == 200 and r.get("changed") == 1, r)
        s = wait_status(admin, fid)
        check("file re-processed after the correction", s["status"] in ("regional", "open"), s["status"])
        _, _, res = call(admin, f"/api/admin/files/{fid}/figures")
        after = next((f for f in res["figures"] if f["key"] == target["key"]), None)
        check("corrected figure is now visible (override applied)", after and after["visible"] and after["override"] == "man",
              after and {k: after[k] for k in ("visible", "override", "decision")})
        labels = os.path.join(TRAINING, "labels.jsonl")
        lines = [json.loads(l) for l in open(labels, encoding="utf-8")] if os.path.exists(labels) else []
        mine = [l for l in lines if l["fileId"] == fid]
        check("training example saved (crop + label)", mine and mine[0]["label"] == "man" and
              os.path.exists(os.path.join(TRAINING, mine[0]["image"])), mine[:1])
        # undo the correction
        call(admin, f"/api/admin/files/{fid}/figures", {"overrides": {target["key"]: ""}})
        wait_status(admin, fid)
    else:
        check("a blurred figure exists to correct", False)
finally:
    # remove this test's training examples
    labels = os.path.join(TRAINING, "labels.jsonl")
    if os.path.exists(labels):
        keep = []
        for l in open(labels, encoding="utf-8"):
            rec = json.loads(l)
            if rec["fileId"] == fid:
                p = os.path.join(TRAINING, rec["image"])
                if os.path.exists(p):
                    os.remove(p)
            else:
                keep.append(l)
        open(labels, "w", encoding="utf-8").writelines(keep)

print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)

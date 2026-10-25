"""End-to-end test of the manual blur with the REAL moderation service (MANUAL_BLUR on): a picture is drawn on, readers get the manual
version, and the manual version stops being served when the automatic result changes.

    docker compose -p tc-mb -f docker-compose.local.yml -f tests/docker-compose.manual-blur-render.yml up -d --build
    python -I tests/e2e_manual_blur_render.py http://localhost:18084

Needs tests/media/*.jpg (not in git). The pixel checks need Pillow and numpy on the host (or PIXEL_LIBS=<folder with them>); without them they are skipped and say so.
"""
import http.cookiejar
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _guard import base_url  # noqa: E402

if os.environ.get("PIXEL_LIBS"):   # python -I ignores PYTHONPATH: a folder with Pillow and numpy can be named here
    sys.path.insert(0, os.environ["PIXEL_LIBS"])
try:
    from PIL import Image  # noqa: E402
    import numpy as np  # noqa: E402
except ImportError:
    Image = None

B = base_url(sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18084")
MEDIA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "media")
failures, skipped = [], []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""))
    if not cond:
        failures.append(name)


def skip(name, why):
    print(f"SKIP {name}  ({why})")
    skipped.append(name)


def opener():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def call(op, method, path, obj=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
    req = urllib.request.Request(B + path, data=data, method=method, headers=headers or ({"Content-Type": "application/json"} if data else {}))
    try:
        with op.open(req, timeout=120) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def jcall(op, method, path, obj=None):
    st, body, _ = call(op, method, path, obj)
    try:
        return st, json.loads(body)
    except ValueError:
        return st, None


def upload(op, name):
    with open(os.path.join(MEDIA, name), "rb") as fh:
        data = fh.read() + uuid.uuid4().bytes   # unique content, so each run starts a new check
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: image/jpeg\r\n\r\n").encode() \
        + data + f"\r\n--{bnd}--\r\n".encode()
    st, resp, _ = call(op, "POST", "/api/admin/upload", raw=body, headers={"Content-Type": "multipart/form-data; boundary=" + bnd})
    return re.search(r"/api/files/([0-9a-f]{40})", json.loads(resp)["url"]).group(1)


def wait_checked(op, fid, timeout=300):
    """Wait until the automatic check of the file has finished."""
    end = time.time() + timeout
    while time.time() < end:
        st, info = jcall(op, "GET", f"/api/files/{fid}/moderation")
        if st == 200 and info["status"] != "pending" and info.get("autoDecision"):
            return info
        time.sleep(2)
    raise SystemExit(f"timeout: the check of {fid} did not finish")


def pixels(data):
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGB")).astype(int)


def lap(a):
    g = a.mean(axis=2)
    return float(np.abs(g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]).mean())


admin = opener()
call(admin, "GET", "/auth/dev-login")
reader = opener()
call(reader, "GET", "/auth/dev-login?email=reader-render@example.com")
RECT = {"type": "rect", "x": 0.30, "y": 0.30, "w": 0.35, "h": 0.30}
ELL = {"type": "ellipse", "x": 0.05, "y": 0.05, "w": 0.2, "h": 0.25}

check("the stack is up", jcall(opener(), "GET", "/api/channel/info")[0] == 200)

# 1. a picture the automatic check opens (no people): the base is the original
fid = upload(admin, "landscape_hermon.jpg")
info = wait_checked(admin, fid)
print(f"     automatic result for the landscape: {info['status']} ({info.get('autoDecision')})")
URL = f"/api/admin/files/{fid}/manual-blur"
check("a picture without people is open", info["status"] == "open", info["status"])
st, state = jcall(admin, "GET", URL)
check("tool available, base = original", state["available"] and state["base"] == "original", state)

raw_orig = call(reader, "GET", f"/api/files/{fid}")[1]
st, body = jcall(admin, "POST", URL, {"shapes": [RECT, ELL]})
check("save two shapes: 200", st == 200 and body.get("active") is True, (st, body))
st, state = jcall(admin, "GET", URL)
check("saved shapes are returned, active", len(state["shapes"]) == 2 and state["active"] is True, state)
st, info = jcall(admin, "GET", f"/api/files/{fid}/moderation")
check("readers' variant is now manual", info["publicVariant"] == "manual" and info["manualBlur"]["active"], (info["publicVariant"], info.get("manualBlur")))
check("the picture has a version tag (rev) for the page", bool(info.get("rev")), info.get("rev"))

st, served, hdr = call(reader, "GET", f"/api/files/{fid}")
check("a reader gets a JPEG", st == 200 and hdr.get("Content-Type", "").startswith("image/jpeg"), (st, hdr.get("Content-Type")))
as_admin = call(admin, "GET", f"/api/files/{fid}")[1]
check("the owner without ?view=public still sees the original", as_admin == raw_orig and as_admin != served)
check("?view=public shows the owner what readers get", call(admin, "GET", f"/api/files/{fid}?view=public")[1] == served)
check("?view=base is the picture before the manual blur", call(admin, "GET", f"/api/files/{fid}?view=base")[1] == raw_orig)
check("a reader cannot use ?view=base: still the manual version", call(reader, "GET", f"/api/files/{fid}?view=base")[1] == served)

if Image is None:
    skip("pixel checks", "Pillow / numpy not installed on the host")
else:
    o, m = pixels(raw_orig), pixels(served)
    H, W = m.shape[:2]
    check("size: longest side within the 2560 limit, proportions kept", max(H, W) <= 2560 and abs(m.shape[1] / m.shape[0] - o.shape[1] / o.shape[0]) < 0.01, (o.shape, m.shape))
    o = np.asarray(Image.fromarray(o.astype("uint8")).resize((W, H), Image.LANCZOS)).astype(int)
    x1, y1, x2, y2 = int(.30 * W), int(.30 * H), int(.65 * W), int(.60 * H)
    check("inside the rectangle the detail is gone", lap(m[y1 + 4:y2 - 4, x1 + 4:x2 - 4]) < lap(o[y1 + 4:y2 - 4, x1 + 4:x2 - 4]) * 0.25,
          (lap(m[y1:y2, x1:x2]), lap(o[y1:y2, x1:x2])))
    mask = np.ones((H, W), bool)
    mask[int(.02 * H):int(.33 * H), int(.02 * W):int(.28 * W)] = False
    mask[int(.27 * H):int(.63 * H), int(.27 * W):int(.68 * W)] = False
    buf = io.BytesIO()   # the service re-encodes the picture (JPEG 88): outside the shapes it must equal a plain re-encode of the original
    Image.fromarray(o.astype("uint8")).save(buf, "JPEG", quality=88, optimize=True)
    diff = np.abs(m - pixels(buf.getvalue())).mean(axis=2)[mask].mean()
    check("outside the shapes the picture is unchanged (only re-encoded)", diff < 1.0, f"mean difference from a plain re-encode {diff:.2f}")

# 2. cleared by an empty save, and by DELETE
st, body = jcall(admin, "POST", URL, {"shapes": []})
check("an empty list clears the manual blur", st == 200 and body.get("active") is False)
check("readers get the original again", call(reader, "GET", f"/api/files/{fid}")[1] == raw_orig)
jcall(admin, "POST", URL, {"shapes": [RECT]})
check("DELETE clears it too", jcall(admin, "DELETE", URL)[1].get("active") is False and call(reader, "GET", f"/api/files/{fid}")[1] == raw_orig)

# 3. the automatic result is irrelevant to a manual blur drawn from scratch ("check again" does not touch it)
jcall(admin, "POST", URL, {"shapes": [RECT]})
before = call(reader, "GET", f"/api/files/{fid}")[1]
check("setup: manual version is served", before != raw_orig)
st, _ = jcall(admin, "POST", "/api/admin/files/reprocess", {"id": fid})
check("'check again' accepted", st == 200, st)
info = wait_checked(admin, fid)
st, state = jcall(admin, "GET", URL)
check("after 'check again' the manual version is still active (the automatic result does not matter)", state["active"] is True and info["publicVariant"] == "manual", (state.get("active"), info["publicVariant"]))
check("readers still get exactly the same picture", call(reader, "GET", f"/api/files/{fid}")[1] == before)
jcall(admin, "DELETE", URL)

# 4. a decision by hand made AFTER the manual blur wins; a fully blurred picture can be edited from scratch
jcall(admin, "POST", URL, {"shapes": [RECT]})
time.sleep(1.1)   # the decision gets a later time (seconds)
call(admin, "POST", "/api/admin/files/moderation", {"id": fid, "status": "blurred"})
st, state = jcall(admin, "GET", URL)
check("blurred by hand AFTER the manual blur: the manual version stops (the latest decision wins), the shapes are kept", state["active"] is False and len(state["shapes"]) == 1, state)
check("readers get the fully blurred picture", jcall(admin, "GET", f"/api/files/{fid}/moderation")[1]["publicVariant"] == "blurred")
check("the tool is still available (from scratch, on the original)", state["available"] is True and state["base"] == "original", state)
st, body = jcall(admin, "POST", URL, {"shapes": [RECT]})
check("saving again on the fully blurred picture works and is what readers get", st == 200 and body["active"] is True and jcall(admin, "GET", f"/api/files/{fid}/moderation")[1]["publicVariant"] == "manual", (st, body))
served_over_blurred = call(reader, "GET", f"/api/files/{fid}")[1]
check("... the original with only the shape blurred (not the fully blurred picture)", served_over_blurred != raw_orig and len(served_over_blurred) > 0 and Image is not None and pixels(served_over_blurred).std() > 20)
time.sleep(1.1)
call(admin, "POST", "/api/admin/files/moderation", {"id": fid, "status": "open"})
check("opened by hand AFTER it: readers get the original, the manual version does not come back", jcall(admin, "GET", f"/api/files/{fid}/moderation")[1]["publicVariant"] == "original")
jcall(admin, "DELETE", URL)

# 5. a picture with a regional result: from scratch the original is shown, with ONLY the manual shape blurred (the automatic blur is not there)
regional = None
for name in ("men_zidane.jpg", "man_messi.jpg", "man_twain.jpg"):
    f2 = upload(admin, name)
    i2 = wait_checked(admin, f2)
    print(f"     automatic result for {name}: {i2['status']} ({i2.get('autoDecision')}), regions={i2.get('autoRegions')}")
    if i2["status"] in ("regional", "blurred"):
        regional = (f2, name, i2["status"])
        break
if not regional:
    skip("manual blur from scratch on a picture the automatic check blurred", "none of the test pictures was blurred by the automatic check")
elif Image is not None:
    f2, name, status = regional
    U2 = f"/api/admin/files/{f2}/manual-blur"
    st, state = jcall(admin, "GET", U2)
    check(f"{name} ({status}): base = original, whatever the automatic result", state["available"] and state["base"] == "original", state)
    auto_bytes = call(reader, "GET", f"/api/files/{f2}")[1]
    orig_bytes = call(admin, "GET", f"/api/files/{f2}")[1]
    st, body = jcall(admin, "POST", U2, {"shapes": [{"type": "rect", "x": 0.0, "y": 0.0, "w": 0.2, "h": 0.2}]})
    check(f"{name}: save from scratch", st == 200, (st, body))
    served2 = call(reader, "GET", f"/api/files/{f2}")[1]
    m, o, a = pixels(served2), pixels(orig_bytes), pixels(auto_bytes)
    H, W = m.shape[:2]
    o = np.asarray(Image.fromarray(o.astype("uint8")).resize((W, H), Image.LANCZOS)).astype(int)
    a = np.asarray(Image.fromarray(a.astype("uint8")).resize((W, H), Image.LANCZOS)).astype(int)
    outside = np.ones((H, W), bool)
    outside[:int(.25 * H), :int(.25 * W)] = False
    d_orig, d_auto = np.abs(m - o).mean(axis=2)[outside].mean(), np.abs(m - a).mean(axis=2)[outside].mean()
    check(f"{name}: outside the shape readers get the ORIGINAL (the automatic blur is gone: that is what 'from scratch' means)", d_orig < 6 and d_orig < d_auto, f"vs original {d_orig:.1f}, vs automatic {d_auto:.1f}")
    jcall(admin, "DELETE", U2)

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED: ' + str(failures)}" + (f"  ({len(skipped)} skipped)" if skipped else ""))
sys.exit(1 if failures else 0)

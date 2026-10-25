"""Moderation HTTP service (internal network only).

POST /process {"path": "<relative to FILES_ROOT>", "kind": "image"|"video",
               "blurred_out": "<relative to BLURRED_ROOT>", "regional_out": "<relative to BLURRED_ROOT>"}
    -> writes the fully blurred JPEG / video poster to blurred_out (shown while checking),
       analyzes the file and, when only some figures must be hidden, writes the regional version to regional_out.
    <- {"decision": "open"|"regional"|"blurred", "reasons": [...], "confidence": float, "regions": n, "full_frames": n, ...}
POST /blur    same body, only writes the blurred version.
GET  /health
"""
import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps, ImageSequence

import manual_image
import regional
from analyzer import Analyzer, Thresholds, timed

FILES_ROOT = os.path.realpath(os.environ.get("FILES_ROOT", "/files"))  # originals (read-only mount)
BLURRED_ROOT = os.path.realpath(os.environ.get("BLURRED_ROOT", "/blurred"))  # blurred output
MODELS_DIR = os.environ.get("MODELS_DIR", "/models")
THREADS = int(os.environ.get("THREADS", "2"))
MAX_FRAMES = int(os.environ.get("MAX_FRAMES", "60"))
MAX_SIDE = int(os.environ.get("ANALYZE_MAX_SIDE", "1280"))
REGIONAL_IMAGE_MAX_SIDE = int(os.environ.get("REGIONAL_IMAGE_MAX_SIDE", "1600"))
FONT_PATH = os.environ.get("FONT_PATH", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
POSTER_CAPTION = "ממתין לאישור"

Image.MAX_IMAGE_PIXELS = 60_000_000
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("moderation")

analyzer = Analyzer(MODELS_DIR, THREADS, Thresholds())
# At most one video and one image at a time keeps CPU/RAM bounded, and images never wait for a video.
locks = {"video": threading.Lock(), "image": threading.Lock(), "blur": threading.Lock(), "manual": threading.Lock()}


def resolve(rel, root=FILES_ROOT):
    p = os.path.realpath(os.path.join(root, rel))
    if not p.startswith(root + os.sep):
        raise ValueError("path outside allowed root")
    return p


def pil_to_bgr(img):
    img = img.convert("RGB")
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE))
    return cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)


def blur_image(img, max_side=720):
    """Heavy pixelate + gaussian blur: nothing recognizable remains."""
    img = img.convert("RGB")
    img.thumbnail((max_side, max_side))
    w, h = img.size
    small_w = 10
    small = img.resize((small_w, max(1, round(h * small_w / w))), Image.BOX)
    return small.resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(radius=max(w, h) / 25))


def add_caption(img, text):
    img = img.convert("RGBA")
    w, h = img.size
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    size = max(18, w // 14)
    try:
        font = ImageFont.truetype(FONT_PATH, size, layout_engine=ImageFont.Layout.BASIC)
    except OSError:
        font = ImageFont.load_default()
    visual = text[::-1]  # BASIC layout has no bidi: reverse Hebrew for display
    x0, y0, x1, y1 = draw.textbbox((0, 0), visual, font=font)
    tw, th = x1 - x0, y1 - y0
    pad = size // 2
    bx0, by0 = (w - tw) // 2 - pad, (h - th) // 2 - pad
    draw.rounded_rectangle([bx0, by0, bx0 + tw + 2 * pad, by0 + th + 2 * pad], radius=pad, fill=(0, 0, 0, 150))
    draw.text(((w - tw) // 2 - x0, (h - th) // 2 - y0), visual, font=font, fill=(255, 255, 255, 255))
    return Image.alpha_composite(img, overlay).convert("RGB")


def save_jpeg(img, out_path):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    img.save(tmp, "JPEG", quality=80)
    os.replace(tmp, out_path)


def image_frames(path):
    """Yield PIL frames: one for still images, sampled frames for animated GIF/WebP."""
    with Image.open(path) as im:
        n = getattr(im, "n_frames", 1)
        if n <= 1:
            yield ImageOps.exif_transpose(im).copy()
            return
        step = max(1, n // MAX_FRAMES)
        for i, frame in enumerate(ImageSequence.Iterator(im)):
            if i % step == 0:
                yield frame.copy()


def probe_duration(path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=30)
        return float(out.stdout.strip())
    except (ValueError, subprocess.TimeoutExpired):
        return 0.0


def video_poster(path, duration, tmpdir):
    at = min(1.0, duration / 2) if duration > 0 else 0
    out = os.path.join(tmpdir, "poster.jpg")
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-ss", f"{at:.2f}", "-i", path, "-frames:v", "1", out],
                   check=False, timeout=120)
    if os.path.exists(out):
        with Image.open(out) as im:
            return im.copy()
    return Image.new("RGB", (640, 360), (60, 60, 60))


def make_blurred(src, kind, out_path, tmpdir):
    if kind == "video":
        poster = video_poster(src, probe_duration(src), tmpdir)
        save_jpeg(add_caption(blur_image(poster), POSTER_CAPTION), out_path)
    else:
        first = next(image_frames(src))
        save_jpeg(blur_image(first), out_path)


def process(body, analyze=True):
    src = resolve(body["path"])
    kind = body.get("kind", "image")
    out_path = resolve(body["blurred_out"], BLURRED_ROOT) if body.get("blurred_out") else None
    tmpdir = tempfile.mkdtemp(prefix="mod-")
    try:
        if out_path:
            make_blurred(src, kind, out_path, tmpdir)
        if not analyze:
            return {"ok": True}

        regional_out = resolve(body["regional_out"], BLURRED_ROOT) if body.get("regional_out") else None
        # Review grid (figure crops + figures.json, moderators only) and manual corrections {figure key: man|blur}
        review_dir = resolve(body["review_out"], BLURRED_ROOT) if body.get("review_out") else None
        overrides = body.get("overrides") or {}
        if kind == "video":
            if not regional_out:
                raise ValueError("regional_out required for video")
            return regional.regional_video(analyzer, src, regional_out, body.get("level"), overrides, review_dir)

        frames = list(image_frames(src))
        if len(frames) == 1 and regional_out:
            img = frames[0].convert("RGB")
            img.thumbnail((REGIONAL_IMAGE_MAX_SIDE, REGIONAL_IMAGE_MAX_SIDE))
            return regional.regional_still(analyzer, img, regional_out, save_jpeg, body.get("level"), overrides, review_dir)

        # Animated images: no regional version - open only if every sampled frame is clean.
        results = []
        for frame in frames:
            r = analyzer.analyze_frame(pil_to_bgr(frame))
            results.append(r)
            if r.blur:
                break
        summary = analyzer.summarize(results)
        summary["frames"] = len(results)
        return summary
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            t = analyzer.t
            return self._send(200, {"ok": True, "thresholds": t.__dict__, "models": analyzer.models})
        self._send(404, {"error": "not found"})

    def _manual_image(self):
        """POST /manual-image {"base","base_root":"files"|"blurred","out","shapes":[...],"max_side"}: draw the shapes an owner / approver placed
        on a picture (the backend's MANUAL_BLUR). Writes only <BLURRED_ROOT>/manual/xx/yy/<fileid>.jpg; no analysis, no models."""
        t0 = time.time()
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            manual_image.check_paths(body.get("base"), body.get("base_root"), body.get("out"))
            root = FILES_ROOT if body["base_root"] == "files" else BLURRED_ROOT
            src, out = resolve(body["base"], root), resolve(body["out"], BLURRED_ROOT)
            if not os.path.isfile(src):
                return self._send(404, {"error": "base picture not found"})
            with locks["manual"]:   # its own lock: a manual picture never waits behind a check of a video
                res = manual_image.render(src, out, body.get("shapes"), body.get("max_side", 2560))
        except manual_image.Rejected as e:
            return self._send(422, {"error": str(e)})
        except (ValueError, KeyError, TypeError) as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:  # undecodable picture, disk error ...
            log.exception("manual-image failed")
            return self._send(500, {"error": str(e)[:200]})
        log.info("/manual-image %s -> %s shapes=%d (%d ms)", body["base"], body["out"], res["shapes"], (time.time() - t0) * 1000)
        self._send(200, {"ok": True, **res})

    def _manual_files(self):
        """POST /manual-remove {"path"} and /manual-commit {"from","to"}: delete / promote a file of the manual blur. The backend sees the blurred
        folder read-only, so these are the only way it can clean up or publish a manual video."""
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if self.path == "/manual-remove":
                manual_image.check_removable(body.get("path"))
                gone = manual_image.remove(resolve(body["path"], BLURRED_ROOT))
                return self._send(200, {"ok": True, "removed": gone})
            manual_image.check_commit(body.get("from"), body.get("to"))
            manual_image.commit(resolve(body["from"], BLURRED_ROOT), resolve(body["to"], BLURRED_ROOT))
            log.info("/manual-commit %s", body["to"])
            return self._send(200, {"ok": True})
        except manual_image.Rejected as e:
            return self._send(422, {"error": str(e)})
        except (ValueError, KeyError, TypeError) as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:
            log.exception("manual file operation failed")
            return self._send(500, {"error": str(e)[:200]})

    def do_POST(self):
        if self.path == "/manual-image":
            return self._manual_image()
        if self.path in ("/manual-remove", "/manual-commit"):
            return self._manual_files()
        if self.path not in ("/process", "/blur", "/cancel"):
            return self._send(404, {"error": "not found"})
        arrived = time.time()
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            src = resolve(body["path"])
            if self.path == "/cancel":   # stop the analysis of this file (running now, or waiting for its turn)
                regional.request_cancel(src)
                log.info("/cancel %s", body.get("path"))
                return self._send(200, {"ok": True})
            if not os.path.isfile(src):
                return self._send(404, {"error": "file not found"})
        except (ValueError, KeyError) as e:
            return self._send(400, {"error": str(e)})

        with locks["blur" if self.path == "/blur" else ("video" if body.get("kind") == "video" else "image")]:   # the quick "blurred poster" must not wait behind an hour-long analysis
            regional.JOB.path, regional.JOB.started = src, arrived
            try:
                regional.check_cancel()   # cancelled while it was waiting for its turn
                res, ms = timed(process, body, self.path == "/process")
            except regional.Cancelled:
                res, ms = {"decision": "cancelled", "reasons": ["cancelled"], "confidence": 0.0}, 0
            except Exception as e:  # undecodable/corrupt media: strict -> blurred
                log.exception("processing failed for %s", body.get("path"))
                res, ms = {"decision": "blurred", "reasons": ["analysis_error"], "confidence": 0.0,
                           "error": str(e)[:200]}, 0
            finally:
                regional.JOB.started = None
        res["elapsed_ms"] = ms
        log.info("%s %s %s -> %s %s (%d ms)", self.path, body.get("kind"), body.get("path"),
                 res.get("decision", "ok"), res.get("reasons", ""), ms)
        self._send(200, res)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    log.info("moderation service on :%d thresholds=%s", port, analyzer.t.__dict__)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

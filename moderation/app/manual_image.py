"""Manual blur of one still image (the backend's MANUAL_BLUR): draws the blur shapes an owner / approver placed on a picture.

No models and no analysis: the picture is read, the shapes are pixelated (the same pixelation as the automatic regional blur,
`regional.blur_region`), and the result is written as JPEG. Kept apart from server.py (which loads the models when imported) so that it
can be tested anywhere.

Shapes are shares of the picture (0..1): x, y = top-left corner of the box, w, h = its size; an "ellipse" is the ellipse inside the box.
They are checked here again (the backend checked them first): this service is the one that writes the file.
"""
import math
import os
import re

import cv2
import numpy as np
from PIL import Image, ImageOps

MAX_SHAPES = 50
MAX_BRUSH_POINTS = 2000
MIN_BRUSH_R, MAX_BRUSH_R = 0.003, 0.25   # the radius of a brush: a share of the WIDTH of the picture
MIN_SIZE = 0.005
CELLS = 4                  # blocks across the shorter side of a shape, as in regional.blur_region (27.10.2026: was 6)
JPEG_QUALITY = 88
MIN_SIDE, MAX_SIDE = 512, 6000
SUPERSAMPLE = 4            # the ellipse mask is drawn 4x larger and averaged down: a smooth, anti-aliased edge

# The only files this endpoint may read or write (a request must not reach any other variant of a picture or any other folder).
OUT_RE = re.compile(r"^manual/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{40}\.jpg$")
BASE_RES = {
    "files": re.compile(r"^[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}$"),                           # an original
    "blurred": re.compile(r"^[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}\.regional\.jpg$"),         # the regional picture
}


# Manual blur of a video (MANUAL_BLUR_VIDEO): the renderer writes <fileid>.<job>.mp4; the backend renames it to <fileid>.mp4 (/manual-commit) only after it has
# checked that the picture readers get has not changed meanwhile. Only these names can be removed or renamed through the service: it is the one
# that can write to the blurred folder (the backend sees it read-only).
VIDEO_FINAL_RE = re.compile(r"^manual/([0-9a-f]{2})/([0-9a-f]{2})/([0-9a-f]{40}).mp4$")
VIDEO_TMP_RE = re.compile(r"^manual/([0-9a-f]{2})/([0-9a-f]{2})/([0-9a-f]{40}).([0-9a-f]{16}).mp4$")


class Rejected(ValueError):
    """The request cannot be done (bad shapes, an animated picture, a path that is not allowed): the caller gets a 422."""


def check_paths(base, base_root, out):
    if base_root not in BASE_RES or not BASE_RES[base_root].match(base or ""):
        raise Rejected("base picture not allowed")
    if not OUT_RE.match(out or ""):
        raise Rejected("output path not allowed")


def validate(shapes):
    if not isinstance(shapes, list) or not shapes:
        raise Rejected("no shapes")
    if len(shapes) > MAX_SHAPES:
        raise Rejected(f"at most {MAX_SHAPES} shapes")
    out = []
    for i, s in enumerate(shapes, 1):
        if isinstance(s, dict) and s.get("type") == "brush":
            out.append(_validate_brush(i, s))
            continue
        if not isinstance(s, dict) or s.get("type") not in ("rect", "ellipse"):
            raise Rejected(f"shape {i}: unknown type")
        try:
            x, y, w, h = (float(s[k]) for k in ("x", "y", "w", "h"))
        except (KeyError, TypeError, ValueError):
            raise Rejected(f"shape {i}: not a number")
        if not all(math.isfinite(v) for v in (x, y, w, h)):
            raise Rejected(f"shape {i}: not a number")
        x1, y1 = min(1.0, max(0.0, x)), min(1.0, max(0.0, y))
        x2, y2 = min(1.0, max(0.0, x + w)), min(1.0, max(0.0, y + h))
        if x2 - x1 < MIN_SIZE or y2 - y1 < MIN_SIZE:
            raise Rejected(f"shape {i}: too small or outside the picture")
        out.append((s["type"], x1, y1, x2, y2))
    return out


def _validate_brush(i, s):
    """A stroke of the brush: ("brush", radius, [(x, y), ...]) with the points clipped to the picture."""
    try:
        r = float(s["r"])
    except (KeyError, TypeError, ValueError):
        raise Rejected(f"shape {i}: no brush size")
    if not math.isfinite(r) or not MIN_BRUSH_R <= r <= MAX_BRUSH_R:
        raise Rejected(f"shape {i}: the brush size is out of range")
    raw = s.get("pts")
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_BRUSH_POINTS:
        raise Rejected(f"shape {i}: a stroke has between 1 and {MAX_BRUSH_POINTS} points")
    pts = []
    for p in raw:
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError, KeyError):
            raise Rejected(f"shape {i}: not a number")
        if not (math.isfinite(x) and math.isfinite(y)):
            raise Rejected(f"shape {i}: not a number")
        pts.append((min(1.0, max(0.0, x)), min(1.0, max(0.0, y))))
    return ("brush", r, pts)


def load(path, max_side):
    """The picture as a BGR array, upright (EXIF orientation applied, as a browser shows it), at most `max_side` on the longer side."""
    with Image.open(path) as im:
        if getattr(im, "n_frames", 1) > 1:
            raise Rejected("animated pictures are not supported")
        icc = im.info.get("icc_profile")
        if im.format == "JPEG":
            im.draft("RGB", (max_side, max_side))   # decode a big JPEG already reduced: faster, less memory
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
            rgba = im.convert("RGBA")
            flat = Image.new("RGB", rgba.size, (255, 255, 255))   # transparent areas: white, not whatever colour is stored under them
            flat.paste(rgba, mask=rgba.getchannel("A"))
            im = flat
        else:
            im = im.convert("RGB")
        if max(im.size) > max_side:
            im.thumbnail((max_side, max_side), Image.LANCZOS)
        return np.ascontiguousarray(np.asarray(im)[:, :, ::-1]), icc


def pixelate(roi, cells=CELLS):
    """Pixelate to `cells` blocks across the shorter side, then smooth: no detail survives (same as regional.blur_region)."""
    h, w = roi.shape[:2]
    scale = cells / min(w, h)
    small = cv2.resize(roi, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


def ellipse_alpha(w, h):
    """1.0 inside the ellipse that fills a w x h box, 0.0 outside, a smooth ramp of about one pixel on the edge."""
    big = np.zeros((h * SUPERSAMPLE, w * SUPERSAMPLE), np.uint8)
    cv2.ellipse(big, (w * SUPERSAMPLE // 2, h * SUPERSAMPLE // 2), (w * SUPERSAMPLE // 2, h * SUPERSAMPLE // 2), 0, 0, 360, 255, -1)
    return cv2.resize(big, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0


def apply_shapes(img, shapes):
    """Blur the shapes into `img` (BGR, in place). A box is widened to whole pixels, never narrowed: nothing of it stays uncovered."""
    H, W = img.shape[:2]
    for shape in shapes:
        if shape[0] == "brush":
            apply_brush(img, shape[1], shape[2])
            continue
        kind, x1, y1, x2, y2 = shape
        px1, py1 = max(0, int(math.floor(x1 * W))), max(0, int(math.floor(y1 * H)))
        px2, py2 = min(W, int(math.ceil(x2 * W))), min(H, int(math.ceil(y2 * H)))
        if px2 - px1 < 2 or py2 - py1 < 2:
            continue
        roi = img[py1:py2, px1:px2]
        blurred = pixelate(roi)
        if kind == "rect":
            img[py1:py2, px1:px2] = blurred
        else:
            a = ellipse_alpha(px2 - px1, py2 - py1)[:, :, None]
            img[py1:py2, px1:px2] = np.clip(blurred * a + roi * (1.0 - a), 0, 255).astype(np.uint8)


def apply_brush(img, r, pts):
    """Blur what a brush stroke covers: a thick line through the points with round ends (a dot for a single point). The inside is covered
    completely (the line is drawn a little thicker than the radius, never thinner), the edge is smooth. The blocks are a third of the brush
    diameter, so whatever is under the brush is unrecognisable whatever the size of the brush."""
    H, W = img.shape[:2]
    rad = max(1.0, r * W)
    P = [(x * W, y * H) for x, y in pts]
    x1, y1 = max(0, int(math.floor(min(p[0] for p in P) - rad - 2))), max(0, int(math.floor(min(p[1] for p in P) - rad - 2)))
    x2, y2 = min(W, int(math.ceil(max(p[0] for p in P) + rad + 2))), min(H, int(math.ceil(max(p[1] for p in P) + rad + 2)))
    bw, bh = x2 - x1, y2 - y1
    if bw < 2 or bh < 2:
        return
    ss = 4 if bw * bh <= 1_000_000 else 2 if bw * bh <= 4_000_000 else 1   # a smooth edge (a bigger mask only where it is cheap)
    mask = np.zeros((bh * ss, bw * ss), np.uint8)
    q = [(int(round((px - x1) * ss)), int(round((py - y1) * ss))) for px, py in P]
    radius, thick = int(math.ceil(rad * ss)), max(1, int(math.ceil(2 * rad * ss)))
    for a, b in zip(q, q[1:]):
        cv2.line(mask, a, b, 255, thick)
    for p in q:
        cv2.circle(mask, p, radius, 255, -1)
    alpha = (cv2.resize(mask, (bw, bh), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0)[:, :, None]
    roi = img[y1:y2, x1:x2]
    block = max(4, int(round(2 * rad / 3)))
    small = cv2.resize(roi, (max(1, bw // block), max(1, bh // block)), interpolation=cv2.INTER_AREA)
    pix = cv2.resize(small, (bw, bh), interpolation=cv2.INTER_LINEAR)
    img[y1:y2, x1:x2] = np.clip(pix * alpha + roi * (1.0 - alpha), 0, 255).astype(np.uint8)


def render(base_path, out_path, shapes, max_side=2560):
    """Draw `shapes` on the picture at `base_path` and write the JPEG to `out_path`. Returns its size."""
    boxes = validate(shapes)
    max_side = max(MIN_SIDE, min(MAX_SIDE, int(max_side)))
    img, icc = load(base_path, max_side)
    apply_shapes(img, boxes)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    try:
        kw = {"icc_profile": icc} if icc else {}
        Image.fromarray(img[:, :, ::-1]).save(tmp, "JPEG", quality=JPEG_QUALITY, optimize=True, **kw)
        os.replace(tmp, out_path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return {"width": img.shape[1], "height": img.shape[0], "shapes": len(boxes)}


def check_removable(path):
    """The files of the manual blur (a picture, a finished video, a video being made) - nothing else."""
    if not (OUT_RE.match(path or "") or VIDEO_FINAL_RE.match(path or "") or VIDEO_TMP_RE.match(path or "")):
        raise Rejected("path not allowed")


def check_commit(src, dst):
    m, f = VIDEO_TMP_RE.match(src or ""), VIDEO_FINAL_RE.match(dst or "")
    if not m or not f or m.group(1, 2, 3) != f.group(1, 2, 3):
        raise Rejected("rename not allowed")


def remove(path_abs):
    """Delete a manual file; a file that is not there is fine."""
    try:
        os.remove(path_abs)
        return True
    except FileNotFoundError:
        return False


def commit(src_abs, dst_abs):
    """Make a finished video the version of the file (atomic)."""
    if not os.path.isfile(src_abs):
        raise Rejected("the rendered video is not there")
    os.replace(src_abs, dst_abs)

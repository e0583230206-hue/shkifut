"""Regional blurring: blur only figures that are not confidently men (whole body), keep the rest.

Still images: one detection pass; blur the boxes of figures that are not confidently men.
Videos (two passes over the decoded stream):
  1. analysis - detect every K-th frame at reduced resolution, link detections into tracks and
     decide per track (a track is a man only if its face sightings are mostly confident men and never a woman);
  2. render   - for every frame blur the boxes of non-man tracks (interpolated between detections,
     with margins, a lead-in before the first detection and a hold after the last), re-encode, keep the audio.
Crowds are handled figure by figure. A dense cluster of overlapping figures is blurred as one box, and a frame is
blurred entirely only when the blurred area would cover most of it anyway (figures cannot be separated).

Strictness level (admin setting, sent per request): strict | normal | lenient - see LEVELS.
"""
import itertools
import json
import os
import subprocess
from collections import defaultdict
from dataclasses import dataclass, field

import cv2
import numpy as np

from analyzer import assign_faces


def _env_float(name, default):
    return float(os.environ.get(name, default))


DETECT_FPS = _env_float("DETECT_FPS", 5)
HOLD_SEC = _env_float("HOLD_SEC", 0.6)
TRACK_MAX_GAP_SEC = _env_float("TRACK_MAX_GAP_SEC", 1.5)
MAX_OUTPUT_FPS = _env_float("MAX_OUTPUT_FPS", 30)
OUTPUT_MAX_SIDE = int(_env_float("OUTPUT_MAX_SIDE", 1280))
ANALYSIS_MAX_SIDE = int(_env_float("ANALYSIS_MAX_SIDE", 960))
MAX_VIDEO_SEC = _env_float("MAX_VIDEO_SEC", 900)
FFMPEG_THREADS = os.environ.get("FFMPEG_THREADS", "2")


@dataclass(frozen=True)
class Level:
    name: str
    male_conf: float            # clearest faces: mean P(male) >= this -> man
    female_max_male: float      # clearest faces: P(male) <= this -> woman
    any_face_veto: bool         # a single clear "woman" face (among the clearest) rules the figure out
    body_male_conf: float       # clearest bodies: mean P(male) >= this -> man (when the face does not decide)
    body_female_max: float      # clearest bodies: mean P(male) <= this -> woman
    body_resolves_uncertain: bool  # a confident male body may settle an uncertain (not female) face
    weak_conf: float            # doubtful person detections from this score are blurred as regions (0 = ignored)
    split_on_overlap: bool      # end tracks when people overlap (prevents identity swaps, fragments crowds)
    faceless_min_height: float  # figures with no usable evidence shorter than this share of the frame stay visible
    unowned_face_blur: str      # faces without a detected body: "not_man" -> blur unless man, "woman" -> only women
    dense_cluster: int          # this many mutually overlapping figures are blurred as one box
    full_area: float            # blur the whole frame when the blurred boxes cover at least this share
    dense_person_step: int = 0  # also run person detection every N frames between samples (0 = off)


LEVELS = {
    "strict": Level("strict", male_conf=0.90, female_max_male=0.50, any_face_veto=True,
                    body_male_conf=0.92, body_female_max=0.40, body_resolves_uncertain=False,
                    weak_conf=0.15, split_on_overlap=True, faceless_min_height=0.0, unowned_face_blur="not_man",
                    dense_cluster=5, full_area=0.85, dense_person_step=2),
    "normal": Level("normal", male_conf=0.80, female_max_male=0.40, any_face_veto=False,
                    body_male_conf=0.85, body_female_max=0.30, body_resolves_uncertain=True,
                    weak_conf=0.20, split_on_overlap=True, faceless_min_height=0.0, unowned_face_blur="not_man",
                    dense_cluster=6, full_area=0.90),
    "lenient": Level("lenient", male_conf=0.70, female_max_male=0.30, any_face_veto=False,
                     body_male_conf=0.75, body_female_max=0.20, body_resolves_uncertain=True,
                     weak_conf=0.0, split_on_overlap=False, faceless_min_height=0.12, unowned_face_blur="woman",
                     dense_cluster=8, full_area=0.95),
}

BEST_K = int(_env_float("BEST_SIGHTINGS", 3))  # decide each figure by its K clearest sightings


def get_level(name):
    return LEVELS.get(name or "strict", LEVELS["strict"])


def verdict(face, lv):
    """Verdict of one face sighting (used for faces without a body and by the leak check)."""
    _, _, male, small = face
    if small:
        return "too_small"
    if male >= lv.male_conf:
        return "man"
    if male <= lv.female_max_male:
        return "woman"
    return "uncertain_gender"


# ---------- geometry ----------

def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def expand(box, margin, w, h):
    x1, y1, x2, y2 = box
    mx, my = (x2 - x1) * margin, (y2 - y1) * margin
    return [max(0, x1 - mx), max(0, y1 - my), min(w, x2 + mx), min(h, y2 + my)]


def union_box(a, b):
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def face_body_box(face, w, h):
    """Approximate the body of a person whose face was found but whose body was not detected."""
    x1, y1, x2, y2 = face
    fw, fh = x2 - x1, y2 - y1
    return [max(0, x1 - 1.5 * fw), max(0, y1 - 0.6 * fh), min(w, x2 + 1.5 * fw), min(h, y2 + 7 * fh)]


def clusters(boxes, min_size):
    """Groups (index lists) of >= min_size boxes connected by overlap (IoU >= 0.3)."""
    n = len(boxes)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i in range(n):
        for j in range(i + 1, n):
            if iou(boxes[i], boxes[j]) >= 0.3:
                parent[find(i)] = find(j)
    groups = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)
    return [g for g in groups.values() if len(g) >= min_size]


def coverage(boxes, w, h, grid=64):
    """Share of the frame covered by the union of boxes (rasterised on a small grid)."""
    gh = max(1, round(grid * h / w))
    mask = np.zeros((gh, grid), dtype=bool)
    for b in boxes:
        x1, y1 = int(b[0] / w * grid), int(b[1] / h * gh)
        x2, y2 = int(np.ceil(b[2] / w * grid)), int(np.ceil(b[3] / h * gh))
        mask[max(0, y1):y2, max(0, x1):x2] = True
    return float(mask.mean())


# ---------- blurring ----------

def blur_region(img, box, cells=6):
    """Pixelate to `cells` blocks across the shorter side, then smooth: no detail survives."""
    x1, y1, x2, y2 = [int(round(v)) for v in box]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(img.shape[1], x2), min(img.shape[0], y2)
    if x2 - x1 < 2 or y2 - y1 < 2:
        return
    roi = img[y1:y2, x1:x2]
    h, w = roi.shape[:2]
    scale = cells / min(w, h)
    small = cv2.resize(roi, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    img[y1:y2, x1:x2] = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


def blur_full(img):
    blur_region(img, [0, 0, img.shape[1], img.shape[0]], cells=10)


# ---------- figure decision ----------

@dataclass
class Figure:
    """Sightings of one figure (a track in video, a single detection in a still).
    The decision uses only its clearest sightings: the largest faces and the tallest bodies."""
    faces: list = field(default_factory=list)    # (face size px, P(male)) - judgeable faces only
    bodies: list = field(default_factory=list)   # (body height px, P(male) from the body model)
    small_faces: int = 0
    max_height: float = 0.0
    key: str = ""          # stable id for manual corrections: "<first frame>:<x1>,<y1>,<x2>,<y2>"
    override: str = ""     # manual correction: "man" (show) or "blur"
    crop: bytes = b""      # JPEG of the clearest sighting, for the moderator review grid
    crop_h: float = 0.0

    def add_face(self, face):
        box, _, male, small = face
        if small:
            self.small_faces += 1
        else:
            self.faces.append((min(box[2] - box[0], box[3] - box[1]), male))

    def add_body(self, height, male):
        if male is not None:
            self.bodies.append((height, male))

    def evidence(self):
        top_f = sorted(self.faces, reverse=True)[:BEST_K]
        top_b = sorted(self.bodies, reverse=True)[:BEST_K]
        f = sum(m for _, m in top_f) / len(top_f) if top_f else None
        b = sum(m for _, m in top_b) / len(top_b) if top_b else None
        return top_f, f, b

    def decide(self, lv):
        """man | woman | uncertain_gender | person_without_clear_face | manual_blur (cached per level)."""
        if self.override == "man":
            return "man"
        if self.override == "blur":
            return "manual_blur"
        cache = self.__dict__.setdefault("_decision", {})
        if lv.name in cache:
            return cache[lv.name]
        top_f, f, b = self.evidence()
        if top_f and (f <= lv.female_max_male or (lv.any_face_veto and min(m for _, m in top_f) <= lv.female_max_male)):
            d = "woman"
        elif b is not None and b <= lv.body_female_max:
            d = "woman"
        elif f is not None and f >= lv.male_conf and (b is None or b >= 0.5):
            d = "man"
        elif b is not None and b >= lv.body_male_conf and (f is None or lv.body_resolves_uncertain):
            d = "man"
        elif f is not None:
            d = "uncertain_gender"
        else:
            d = "person_without_clear_face"
        cache[lv.name] = d
        return d

    def is_man(self, lv):
        return self.decide(lv) == "man"

    def body_decided(self, lv):
        """Man by body evidence (face missing or not decisive)."""
        _, f, _ = self.evidence()
        return self.is_man(lv) and (f is None or f < lv.male_conf)

    def visible(self, lv, frame_h):
        """Stays visible: a man, or (lenient only) a small distant figure with no usable evidence at all."""
        d = self.decide(lv)
        if d == "man":
            return True
        return (d == "person_without_clear_face" and lv.faceless_min_height > 0
                and self.max_height < lv.faceless_min_height * frame_h)

    def reason(self, lv):
        return self.decide(lv)


# ---------- review grid and manual corrections ----------

MIN_REVIEW_PX = int(_env_float("MIN_REVIEW_PX", 40))  # smaller figures are not shown in the review grid
MAX_REVIEW_FIGURES = int(_env_float("MAX_REVIEW_FIGURES", 80))


def figure_key(frame, box):
    return f"{frame}:{int(box[0])},{int(box[1])},{int(box[2])},{int(box[3])}"


def take_crop(fig, img, box):
    """Keep a small JPEG of the figure's tallest sighting."""
    h = box[3] - box[1]
    if h <= fig.crop_h or h < MIN_REVIEW_PX:
        return
    H, W = img.shape[:2]
    x1, y1, x2, y2 = expand(box, 0.1, W, H)
    roi = img[int(y1):int(y2), int(x1):int(x2)]
    if roi.size == 0:
        return
    scale = min(1.0, 160 / roi.shape[0])
    if scale < 1.0:
        roi = cv2.resize(roi, (max(1, int(roi.shape[1] * scale)), 160), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", roi, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if ok:
        fig.crop, fig.crop_h = buf.tobytes(), h


def apply_overrides(figs, overrides):
    """Attach manual corrections; a key matches the same first frame and an overlapping first box."""
    applied = 0
    for key, value in (overrides or {}).items():
        if value not in ("man", "blur"):
            continue
        try:
            frame, coords = key.split(":")
            box = [float(v) for v in coords.split(",")]
        except ValueError:
            continue
        best = max((f for f in figs if f.key.split(":")[0] == frame),
                   key=lambda f: iou([float(v) for v in f.key.split(":")[1].split(",")], box), default=None)
        if best is not None and iou([float(v) for v in best.key.split(":")[1].split(",")], box) >= 0.5:
            best.override = value
            applied += 1
    return applied


def write_review(review_dir, figs, lv, frame_h, fps=None):
    """figures.json + one JPEG per figure, for the moderator review grid (moderators only)."""
    if not review_dir:
        return 0
    os.makedirs(review_dir, exist_ok=True)
    for name in os.listdir(review_dir):
        os.remove(os.path.join(review_dir, name))
    shown = [f for f in figs if f.crop]
    shown.sort(key=lambda f: (f.visible(lv, frame_h), -f.crop_h))  # hidden first, then by size
    items = []
    for n, f in enumerate(shown[:MAX_REVIEW_FIGURES]):
        _, fm, bm = f.evidence()
        name = f"{n}.jpg"
        with open(os.path.join(review_dir, name), "wb") as fh:
            fh.write(f.crop)
        item = {"key": f.key, "crop": name, "decision": f.decide(lv), "visible": f.visible(lv, frame_h),
                "override": f.override or None, "faceMale": None if fm is None else round(fm, 2),
                "bodyMale": None if bm is None else round(bm, 2), "smallFaces": f.small_faces}
        if fps and getattr(f, "obs", None):
            item["start"], item["end"] = round(min(f.obs) / fps, 2), round(max(f.obs) / fps, 2)
        items.append(item)
    tmp = os.path.join(review_dir, "figures.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"level": lv.name, "figures": items, "total": len(figs)}, fh, ensure_ascii=False)
    os.replace(tmp, os.path.join(review_dir, "figures.json"))
    return len(items)


# ---------- still images ----------

def plan_still(analyzer, bgr, lv, overrides=None):
    """Return (full, boxes, reasons, confidence, figures) for one image."""
    t = analyzer.t
    h, w = bgr.shape[:2]
    persons, weak, faces, bodies = analyzer.detect_all(bgr, weak_min=lv.weak_conf or t.person_min)
    verdicts = [verdict(f, lv) for f in faces]
    owners = assign_faces(persons, faces)
    reasons, boxes, conf = set(), [], []
    figures = [Figure(max_height=p[0][3] - p[0][1], key=figure_key(0, p[0])) for p in persons]
    for j, o in enumerate(owners):
        if o >= 0:
            figures[o].add_face(faces[j])
    for fig, (pb, _), bm in zip(figures, persons, bodies):
        fig.add_body(pb[3] - pb[1], bm)
        take_crop(fig, bgr, pb.tolist())
    apply_overrides(figures, overrides)
    for (pb, score), fig in zip(persons, figures):
        if fig.visible(lv, h):
            _, f, b = fig.evidence()
            conf.append(f if f is not None else (b if b is not None else 1.0))
            continue
        reasons.add(fig.reason(lv))
        boxes.append(expand(pb, t.box_margin, w, h))
    if lv.weak_conf:
        for pb, score in weak:
            reasons.add("low_confidence_person")
            boxes.append(expand(pb, t.box_margin, w, h))
    for j, f in enumerate(faces):
        v = verdicts[j]
        if owners[j] == -1 and (v == "woman" if lv.unowned_face_blur == "woman" else v != "man"):
            reasons.add(v)
            boxes.append(face_body_box(f[0], w, h))
    for g in clusters([p[0].tolist() for p in persons], lv.dense_cluster):
        if not all(figures[i].visible(lv, h) for i in g):
            reasons.add("dense_crowd")
            ub = persons[g[0]][0].tolist()
            for i in g[1:]:
                ub = union_box(ub, persons[i][0].tolist())
            boxes.append(expand(ub, t.box_margin, w, h))
    full = bool(boxes) and coverage(boxes, w, h) >= lv.full_area
    if full:
        reasons.add("inseparable")
    if not reasons:
        reasons.add("men_only" if persons or faces else "no_people")
    return full, boxes, sorted(reasons), round(min(conf) if conf else 1.0, 3), figures


def regional_still(analyzer, pil_img, out_path, save_jpeg, level=None, overrides=None, review_dir=None):
    """Analyze one still image; write the regional version when something must be hidden."""
    lv = get_level(level)
    rgb = np.asarray(pil_img.convert("RGB"))
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    full, boxes, reasons, confidence, figures = plan_still(analyzer, bgr, lv, overrides)
    reviewed = write_review(review_dir, figures, lv, bgr.shape[0])
    base = {"level": lv.name, "reasons": reasons, "confidence": confidence, "regions": len(boxes),
            "figures": reviewed, "overrides": sum(1 for f in figures if f.override)}
    if full:
        return {"decision": "blurred", "full_frames": 1, **base}
    if not boxes:
        return {"decision": "open", "full_frames": 0, **base}
    for b in boxes:
        blur_region(bgr, b)
    from PIL import Image
    save_jpeg(Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)), out_path)
    return {"decision": "regional", "full_frames": 0, **base}


# ---------- video ----------

def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:format=duration",
                          "-of", "json", path], capture_output=True, text=True, timeout=60)
    info = json.loads(out.stdout or "{}")
    st = (info.get("streams") or [{}])[0]
    w, h = int(st.get("width", 0)), int(st.get("height", 0))
    rot = 0
    for sd in st.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    if abs(rot) % 180 == 90:
        w, h = h, w

    def rate(s):
        try:
            n, d = s.split("/")
            return float(n) / float(d) if float(d) else 0.0
        except (ValueError, AttributeError):
            return 0.0
    fps = rate(st.get("avg_frame_rate")) or rate(st.get("r_frame_rate")) or 25.0
    duration = float(info.get("format", {}).get("duration", 0) or 0)
    return w, h, fps, duration


def has_audio(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                          "-of", "csv=p=0", path], capture_output=True, text=True, timeout=60)
    return bool(out.stdout.strip())


def fit(w, h, max_side):
    s = min(1.0, max_side / max(w, h))
    return max(2, int(w * s) // 2 * 2), max(2, int(h * s) // 2 * 2)


def read_frames(path, fps, w, h, extra_vf=""):
    vf = f"fps={fps:.5f},scale={w}:{h}" + (f",{extra_vf}" if extra_vf else "")
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-threads", FFMPEG_THREADS, "-i", path, "-vf", vf,
           "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = w * h * 3
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3).copy()
    finally:
        proc.stdout.close()
        proc.wait()


@dataclass
class Track(Figure):
    id: int = 0
    obs: dict = field(default_factory=dict)  # frame index -> box (analysis coordinates)

    @property
    def last_frame(self):
        return max(self.obs)


class VideoPlan:
    def __init__(self, level):
        self.level = level
        self.tracks = []
        self.events = []                # (frame, box): weak detections / faces without a body
        self.cluster_events = []        # (frame, union box, [tracks]) dense overlapping groups
        self.reasons = set()
        self.detections = 0


def analyze_video(analyzer, path, fps, aw, ah, step, lv):
    """Pass 1: detect on every `step`-th frame and build tracks."""
    plan = VideoPlan(lv)
    max_gap = max(step, int(TRACK_MAX_GAP_SEC * fps))
    active = []
    next_id = 0
    dense = lv.dense_person_step if 0 < lv.dense_person_step < step else 0
    if dense:  # decode each needed frame once: samples (every `step`) and person-only frames (every `dense`)
        vf = f"select='not(mod(n\\,{step}))+not(mod(n\\,{dense}))'"
        indices = (n for n in itertools.count() if n % step == 0 or n % dense == 0)
    else:
        vf = f"select='not(mod(n\\,{step}))'"
        indices = (n * step for n in itertools.count())
    weak_min = lv.weak_conf or analyzer.t.person_min
    for f, frame in zip(indices, read_frames(path, fps, aw, ah, vf)):
        if f % step:
            # Person-only frame between samples: a figure that flashes up and matches no known figure is blurred.
            for pb, _ in analyzer.persons.detect(frame, min(weak_min, analyzer.t.person_min)):
                b = pb.tolist()
                if not any(iou(tr.obs[tr.last_frame], b) >= 0.3 for tr in active):
                    plan.events.append((f, b))
                    plan.reasons.add("between_samples")
            continue
        plan.detections += 1
        persons, weak, faces, bodies = analyzer.detect_all(frame, weak_min=weak_min)
        if lv.weak_conf:
            for pb, _ in weak:
                plan.events.append((f, pb.tolist()))
                plan.reasons.add("low_confidence_person")

        # --- link detections to tracks (greedy IoU)
        active = [tr for tr in active if f - tr.last_frame <= max_gap]
        boxes = [p[0].tolist() for p in persons]
        m = [[iou(tr.obs[tr.last_frame], b) for b in boxes] for tr in active]
        amb_tracks, amb_dets, ended = set(), set(), set()
        if lv.split_on_overlap:  # ambiguous overlaps end the tracks involved (no identity swaps)
            amb_tracks = {ti for ti in range(len(active)) if sum(v >= 0.3 for v in m[ti]) > 1}
            amb_dets = {di for di in range(len(boxes)) if sum(m[ti][di] >= 0.3 for ti in range(len(active))) > 1}
            ended = {id(active[ti]) for ti in amb_tracks}
            for di in amb_dets:
                ended.update(id(active[ti]) for ti in range(len(active)) if m[ti][di] >= 0.3)
        pairs = sorted(((m[ti][di], ti, di) for ti in range(len(active)) for di in range(len(boxes))), reverse=True)
        det_track, used_t = {}, set()
        for v, ti, di in pairs:
            if v < 0.25 or ti in used_t or di in det_track or ti in amb_tracks or di in amb_dets:
                continue
            det_track[di] = active[ti]
            used_t.add(ti)
        if ended:
            plan.reasons.add("overlap_split")
            active = [tr for tr in active if id(tr) not in ended]
        for di, b in enumerate(boxes):
            tr = det_track.get(di)
            if tr is None or id(tr) in ended:
                tr = Track(id=next_id, key=figure_key(f, b))
                next_id += 1
                plan.tracks.append(tr)
                active.append(tr)
                det_track[di] = tr
            tr.obs[f] = b
            tr.max_height = max(tr.max_height, b[3] - b[1])
            tr.add_body(b[3] - b[1], bodies[di])
            take_crop(tr, frame, b)

        # --- face sightings
        owners = assign_faces(persons, faces)
        for fi, face in enumerate(faces):
            v = verdict(face, lv)
            if owners[fi] >= 0:
                det_track[owners[fi]].add_face(face)
            elif v == "woman" if lv.unowned_face_blur == "woman" else v != "man":
                plan.events.append((f, face_body_box(face[0], aw, ah)))
                plan.reasons.add(v)

        # --- dense overlapping groups: blurred as one box unless every member turns out to be visible
        for g in clusters(boxes, lv.dense_cluster):
            ub = boxes[g[0]]
            for i in g[1:]:
                ub = union_box(ub, boxes[i])
            plan.cluster_events.append((f, ub, [det_track[i] for i in g]))
    return plan


def frame_boxes(plan, t, step, fps, total, aw, ah, sx, sy, men=False):
    """Per output frame: boxes (render coordinates) to blur, or with men=True the visible figures."""
    lv = plan.level
    hold = max(step, int(HOLD_SEC * fps))
    lead = step + hold // 2
    out = defaultdict(list)

    def add(fr, box, margin):
        if 0 <= fr < total:
            b = expand(box, margin, aw, ah)
            out[fr].append([b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy])

    for tr in plan.tracks:
        if tr.visible(lv, ah) != men:
            continue
        frames = sorted(tr.obs)
        for a, b in zip(frames, frames[1:]):
            ba, bb = tr.obs[a], tr.obs[b]
            for fr in range(a, b):
                if b - a <= step:  # consecutive detections: interpolate
                    k = (fr - a) / (b - a)
                    add(fr, [ba[i] + (bb[i] - ba[i]) * k for i in range(4)], t.box_margin)
                else:              # detector missed in between: cover both positions
                    add(fr, union_box(ba, bb), t.box_margin)
        first, last = frames[0], frames[-1]
        for fr in range(first - lead, first):
            add(fr, tr.obs[first], t.box_margin + 0.15)
        for fr in range(last, last + hold + 1):
            add(fr, tr.obs[last], t.box_margin + 0.15)
    if not men:
        for f, box in plan.events:
            for fr in range(f - lead, f + hold + 1):
                add(fr, box, t.box_margin)
        for f, box, members in plan.cluster_events:
            if not all(tr.visible(lv, ah) for tr in members):
                for fr in range(f - step, f + step + 1):
                    add(fr, box, t.box_margin)
    return out


def regional_video(analyzer, path, out_path, level=None, overrides=None, review_dir=None):
    lv = get_level(level)
    w, h, src_fps, duration = probe(path)
    if not w or not h:
        raise ValueError("no video stream")
    if duration > MAX_VIDEO_SEC:
        return {"decision": "blurred", "level": lv.name, "reasons": ["video_too_long"], "confidence": 0.0,
                "regions": 0, "full_frames": 0}
    fps = min(src_fps, MAX_OUTPUT_FPS)
    step = max(1, round(fps / DETECT_FPS))
    aw, ah = fit(w, h, ANALYSIS_MAX_SIDE)
    rw, rh = fit(w, h, OUTPUT_MAX_SIDE)

    plan = analyze_video(analyzer, path, fps, aw, ah, step, lv)
    applied = apply_overrides(plan.tracks, overrides)
    reviewed = write_review(review_dir, plan.tracks, lv, ah, fps)
    hidden = [tr for tr in plan.tracks if not tr.visible(lv, ah)]
    visible = [tr for tr in plan.tracks if tr.visible(lv, ah)]
    reasons = set(plan.reasons)
    reasons.update(tr.reason(lv) for tr in hidden)
    summary = {
        "level": lv.name, "tracks": len(plan.tracks), "blurred_tracks": len(hidden),
        "visible_tracks": len(visible), "men_tracks": sum(tr.is_man(lv) for tr in plan.tracks),
        "men_by_body": sum(tr.body_decided(lv) for tr in plan.tracks), "body_model": analyzer.body is not None,
        "detections": plan.detections, "fps": round(fps, 2), "duration": round(duration, 2),
        "figures": reviewed, "overrides": applied,
    }
    total = int(duration * fps) + 2 * step + 10
    boxes = frame_boxes(plan, analyzer.t, step, fps, total, aw, ah, rw / aw, rh / ah)
    if not boxes:
        reasons.discard("overlap_split")
        reasons.add("men_only" if visible else "no_people")
        return {"decision": "open", "reasons": sorted(reasons), "confidence": 1.0, "regions": 0,
                "full_frames": 0, **summary}

    # Frames where the figures cannot be separated (blurred area covers most of the frame): blur entirely.
    full_frames = {fr for fr, bs in boxes.items() if coverage(bs, rw, rh) >= lv.full_area}
    if full_frames:
        reasons.add("inseparable")
    # Safety net: every frame of every hidden figure must be covered (detection, interpolation,
    # lead-in or hold). Should never trigger; if it does, that frame is blurred entirely.
    uncovered = set()
    for tr in hidden:
        uncovered.update(fr for fr in range(min(tr.obs), max(tr.obs) + 1) if fr < total and not boxes.get(fr))
    uncovered -= full_frames
    full_frames |= uncovered
    summary["uncovered_frames"] = len(uncovered)

    # Pass 2: render
    tmp = out_path + ".tmp.mp4"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    enc = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{rw}x{rh}",
           "-r", f"{fps:.5f}", "-i", "pipe:0"]
    if has_audio(path):
        enc += ["-i", path, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k", "-shortest"]
    enc += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-threads", FFMPEG_THREADS,
            "-movflags", "+faststart", tmp]
    proc = subprocess.Popen(enc, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    full_count = rendered = 0
    try:
        for fr, frame in enumerate(read_frames(path, fps, rw, rh)):
            rendered += 1
            if fr in full_frames:
                blur_full(frame)
                full_count += 1
            else:
                for b in boxes.get(fr, ()):
                    blur_region(frame, b)
            proc.stdin.write(frame.tobytes())
    finally:
        proc.stdin.close()
        rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"encoder failed ({rc})")
    os.replace(tmp, out_path)
    summary["rendered_frames"] = rendered
    summary["blurred_box_frames"] = sum(1 for fr in range(rendered) if boxes.get(fr) and fr not in full_frames)
    return {"decision": "regional", "reasons": sorted(reasons), "confidence": 1.0,
            "regions": len(hidden) + len(plan.events), "full_frames": full_count, **summary}

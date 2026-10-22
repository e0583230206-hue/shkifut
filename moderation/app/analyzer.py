"""Strict media moderation: a file is "open" only when it contains no people at all,
or every person in it is a confidently detected man. Anything else is "blurred".

Models (ONNX, CPU only, see Dockerfile.models):
  person.onnx    - YOLOv8 person detector (COCO class 0)
  face_det.onnx  - SCRFD face detector (InsightFace det_10g)
  genderage.onnx - InsightFace gender/age attribute model
"""
import os
import threading
import time
from dataclasses import dataclass, field

import cv2
import numpy as np
import onnxruntime as ort


def _env_float(name, default):
    return float(os.environ.get(name, default))


BODY_MODEL = os.environ.get("BODY_MODEL", "1") == "1"
MODEL_PROFILE = os.environ.get("MODEL_PROFILE", "auto")  # auto: commercial models when installed; research: originals
FACE_TILING = os.environ.get("FACE_TILING", "0") == "1"  # +~125% analysis time; helps only high-res video


def _iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def assign_faces(persons, faces):
    """Index of the owning person for each face (-1 if none): face centre in the upper part, smallest box wins."""
    owners = []
    for f in faces:
        fb = f[0]
        fx, fy = (fb[0] + fb[2]) / 2, (fb[1] + fb[3]) / 2
        best, best_area = -1, None
        for i, (pb, _) in enumerate(persons):
            ph = pb[3] - pb[1]
            if pb[0] <= fx <= pb[2] and pb[1] <= fy <= pb[1] + 0.65 * ph:
                area = (pb[2] - pb[0]) * ph
                if best_area is None or area < best_area:
                    best, best_area = i, area
        owners.append(best)
    return owners


@dataclass
class Thresholds:
    # Person detections below this score are ignored entirely.
    person_min: float = _env_float("PERSON_MIN_CONF", 0.30)
    # Face detections below this score are ignored entirely.
    face_min: float = _env_float("FACE_MIN_CONF", 0.50)
    # A face counts as "man" only if P(male) is at least this value.
    male_conf: float = _env_float("MALE_MIN_CONF", 0.90)
    # Faces smaller than this (shorter side, pixels) are too small to judge.
    min_face_px: float = _env_float("MIN_FACE_PX", 28)
    # Bodies shorter than this (pixels) are too small for the body attribute model.
    min_body_px: float = _env_float("MIN_BODY_PX", 64)
    # Person detections in [person_weak, person_min) are "doubtful": the whole frame gets blurred.
    person_weak: float = _env_float("PERSON_WEAK_CONF", 0.20)
    # This many people in one frame counts as a crowd: the whole frame gets blurred.
    crowd_persons: float = _env_float("CROWD_MIN_PERSONS", 6)
    # Extra margin around a blurred figure, as a fraction of its box size on each side.
    box_margin: float = _env_float("BOX_MARGIN", 0.15)


@dataclass
class FrameResult:
    blur: bool
    reasons: list = field(default_factory=list)
    confidence: float = 1.0
    persons: int = 0
    faces: list = field(default_factory=list)


def _session(path, threads):
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    opts.enable_cpu_mem_arena = False
    opts.enable_mem_pattern = False
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])


def _nms(boxes, scores, iou_thresh):
    if len(boxes) == 0:
        return []
    xywh = [[float(b[0]), float(b[1]), float(b[2] - b[0]), float(b[3] - b[1])] for b in boxes]
    idx = cv2.dnn.NMSBoxes(xywh, [float(s) for s in scores], 0.0, iou_thresh)
    return [int(i) for i in np.array(idx).reshape(-1)]


class PersonDetector:
    def __init__(self, path, threads):
        self.sess = _session(path, threads)
        self.input_name = self.sess.get_inputs()[0].name
        self.size = 640

    def detect(self, bgr, min_score):
        h, w = bgr.shape[:2]
        scale = min(self.size / w, self.size / h)
        nw, nh = int(round(w * scale)), int(round(h * scale))
        canvas = np.full((self.size, self.size, 3), 114, dtype=np.uint8)
        px, py = (self.size - nw) // 2, (self.size - nh) // 2
        canvas[py:py + nh, px:px + nw] = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
        blob = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0

        out = self.sess.run(None, {self.input_name: blob})[0][0]  # (84, 8400)
        scores = out[4]  # class 0 = person
        keep = scores >= min_score
        if not np.any(keep):
            return []
        cx, cy, bw, bh = out[0][keep], out[1][keep], out[2][keep], out[3][keep]
        scores = scores[keep]
        boxes = np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], axis=1)
        boxes[:, [0, 2]] = (boxes[:, [0, 2]] - px) / scale
        boxes[:, [1, 3]] = (boxes[:, [1, 3]] - py) / scale
        boxes[:, [0, 2]] = boxes[:, [0, 2]].clip(0, w)
        boxes[:, [1, 3]] = boxes[:, [1, 3]].clip(0, h)
        return [(boxes[i], float(scores[i])) for i in _nms(boxes, scores, 0.45)]


class FaceDetector:
    """SCRFD (InsightFace) decoder: 3 strides, 2 anchors per location."""

    def __init__(self, path, threads):
        self.sess = _session(path, threads)
        self.input_name = self.sess.get_inputs()[0].name
        self.size = 640
        self.strides = [8, 16, 32]
        self.num_anchors = 2
        self._centers = {}

    def _anchor_centers(self, fh, fw, stride):
        key = (fh, fw, stride)
        if key not in self._centers:
            c = np.stack(np.mgrid[:fh, :fw][::-1], axis=-1).astype(np.float32)
            c = (c * stride).reshape(-1, 2)
            c = np.stack([c] * self.num_anchors, axis=1).reshape(-1, 2)
            self._centers[key] = c
        return self._centers[key]

    def detect(self, bgr, min_score):
        h, w = bgr.shape[:2]
        scale = min(self.size / w, self.size / h)
        nw, nh = int(w * scale), int(h * scale)
        canvas = np.zeros((self.size, self.size, 3), dtype=np.uint8)
        canvas[:nh, :nw] = cv2.resize(bgr, (nw, nh))
        blob = cv2.dnn.blobFromImage(canvas, 1.0 / 128, (self.size, self.size), (127.5, 127.5, 127.5), swapRB=True)
        outs = self.sess.run(None, {self.input_name: blob})
        outs = [o[0] if o.ndim == 3 else o for o in outs]

        all_boxes, all_scores = [], []
        n = len(self.strides)
        for i, stride in enumerate(self.strides):
            scores = outs[i].reshape(-1)
            deltas = outs[i + n].reshape(-1, 4) * stride
            fh, fw = self.size // stride, self.size // stride
            centers = self._anchor_centers(fh, fw, stride)
            keep = np.where(scores >= min_score)[0]
            if len(keep) == 0:
                continue
            c, d = centers[keep], deltas[keep]
            boxes = np.stack([c[:, 0] - d[:, 0], c[:, 1] - d[:, 1], c[:, 0] + d[:, 2], c[:, 1] + d[:, 3]], axis=1)
            all_boxes.append(boxes / scale)
            all_scores.append(scores[keep])
        if not all_boxes:
            return []
        boxes = np.concatenate(all_boxes)
        scores = np.concatenate(all_scores)
        boxes[:, [0, 2]] = boxes[:, [0, 2]].clip(0, w)
        boxes[:, [1, 3]] = boxes[:, [1, 3]].clip(0, h)
        return [(boxes[i], float(scores[i])) for i in _nms(boxes, scores, 0.4)]


class GenderClassifier:
    """InsightFace genderage: output [female_logit, male_logit, age/100]."""

    def __init__(self, path, threads):
        self.sess = _session(path, threads)
        self.input_name = self.sess.get_inputs()[0].name
        self.size = 96
        # buffalo_l genderage.onnx normalizes internally (starts with bn_data)
        self.mean = _env_float("GENDER_INPUT_MEAN", 0.0)
        self.std = _env_float("GENDER_INPUT_STD", 1.0)

    def male_prob(self, bgr, box):
        x1, y1, x2, y2 = box
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        s = self.size / (max(x2 - x1, y2 - y1) * 1.5)
        m = np.array([[s, 0, self.size / 2 - cx * s], [0, s, self.size / 2 - cy * s]], dtype=np.float32)
        crop = cv2.warpAffine(bgr, m, (self.size, self.size), borderValue=0.0)
        blob = cv2.dnn.blobFromImage(crop, 1.0 / self.std, (self.size, self.size), (self.mean,) * 3, swapRB=True)
        pred = self.sess.run(None, {self.input_name: blob})[0][0]
        logits = pred[:2].astype(np.float64)
        e = np.exp(logits - logits.max())
        p = e / e.sum()
        return float(p[1]), int(round(float(pred[2]) * 100))


class YoloxPersonDetector:
    """YOLOX-s (Megvii, Apache-2.0) person detector - commercial-friendly replacement for YOLOv8."""

    def __init__(self, path, threads):
        self.sess = _session(path, threads)
        self.input_name = self.sess.get_inputs()[0].name
        self.size = 640
        grids, strides = [], []
        for stride in (8, 16, 32):
            n = self.size // stride
            yv, xv = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
            grids.append(np.stack((xv, yv), 2).reshape(-1, 2))
            strides.append(np.full((n * n, 1), stride))
        self.grids = np.concatenate(grids).astype(np.float32)
        self.strides = np.concatenate(strides).astype(np.float32)

    def detect(self, bgr, min_score):
        h, w = bgr.shape[:2]
        r = min(self.size / h, self.size / w)
        canvas = np.full((self.size, self.size, 3), 114, dtype=np.uint8)
        canvas[:int(h * r), :int(w * r)] = cv2.resize(bgr, (int(w * r), int(h * r)), interpolation=cv2.INTER_LINEAR)
        blob = canvas.transpose(2, 0, 1)[None].astype(np.float32)  # BGR, 0..255 (official ONNX export)
        out = self.sess.run(None, {self.input_name: blob})[0][0]    # (8400, 85)
        xy = (out[:, :2] + self.grids) * self.strides
        wh = np.exp(out[:, 2:4]) * self.strides
        scores = out[:, 4] * out[:, 5]  # objectness x class 0 (person)
        keep = scores >= min_score
        if not np.any(keep):
            return []
        xy, wh, scores = xy[keep], wh[keep], scores[keep]
        boxes = np.concatenate([xy - wh / 2, xy + wh / 2], axis=1) / r
        boxes[:, [0, 2]] = boxes[:, [0, 2]].clip(0, w)
        boxes[:, [1, 3]] = boxes[:, [1, 3]].clip(0, h)
        return [(boxes[i], float(scores[i])) for i in _nms(boxes, scores, 0.45)]


class YuNetFaceDetector:
    """YuNet (OpenCV Zoo, MIT) face detector via cv2.FaceDetectorYN - replacement for InsightFace SCRFD.
    FaceDetectorYN is not thread-safe, so each thread gets its own instance."""

    def __init__(self, path, threads):
        self.path = path
        self.size = 640
        self.local = threading.local()

    def _det(self):
        d = getattr(self.local, "det", None)
        if d is None:
            d = cv2.FaceDetectorYN.create(self.path, "", (self.size, self.size), 0.5, 0.3, 5000)
            self.local.det = d
        return d

    def detect(self, bgr, min_score):
        h, w = bgr.shape[:2]
        scale = min(self.size / w, self.size / h)
        nw, nh = int(w * scale), int(h * scale)
        canvas = np.zeros((self.size, self.size, 3), dtype=np.uint8)
        canvas[:nh, :nw] = cv2.resize(bgr, (nw, nh))
        det = self._det()
        det.setScoreThreshold(float(min_score))
        _, faces = det.detect(canvas)
        if faces is None:
            return []
        out = []
        for f in faces:
            x, y, fw, fh = f[:4] / scale
            box = np.array([max(0, x), max(0, y), min(w, x + fw), min(h, y + fh)], dtype=np.float32)
            out.append((box, float(f[-1])))
        return out


class _OvModel:
    """An OpenVINO model whose infer requests are per thread.

    `compiled_model(x)` runs on ONE shared infer request, and a request is not thread-safe: when the service handles an image and a
    video at the same time (separate locks, one thread per HTTP request) the second thread got RuntimeError "Infer Request is busy",
    which the server turns into a final "blurred / analysis_error" decision. Here every thread creates its own request on first use."""

    def __init__(self, xml_path, threads):
        import openvino as ov  # imported only when a model is present
        core = ov.Core()
        core.set_property("CPU", {"INFERENCE_NUM_THREADS": threads})
        self.model = core.compile_model(core.read_model(xml_path), "CPU")
        self.outputs = self.model.outputs
        self.local = threading.local()

    def __call__(self, blob):
        req = getattr(self.local, "req", None)
        if req is None:
            req = self.local.req = self.model.create_infer_request()
        return req.infer({0: blob})  # {output port: array}; read before this thread infers again


class OmzGenderClassifier:
    """OpenVINO Open Model Zoo age-gender-recognition-retail-0013 (Apache-2.0): 62x62 BGR face crop,
    outputs prob [female, male] and age/100. Commercial-friendly replacement for InsightFace genderage."""

    def __init__(self, xml_path, threads):
        self.model = _OvModel(xml_path, threads)
        self.prob = next(o for o in self.model.outputs if "prob" in o.get_any_name())
        self.age = next((o for o in self.model.outputs if "age" in o.get_any_name()), None)
        self.size = 62

    def male_prob(self, bgr, box):
        h, w = bgr.shape[:2]
        x1, y1, x2, y2 = box
        cx, cy, side = (x1 + x2) / 2, (y1 + y2) / 2, max(x2 - x1, y2 - y1) * 1.2  # enlarged like the OMZ demo
        a, b = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
        c, d = int(min(w, cx + side / 2)), int(min(h, cy + side / 2))
        if c - a < 4 or d - b < 4:
            return 0.5, 0
        crop = cv2.resize(bgr[b:d, a:c], (self.size, self.size))
        res = self.model(crop.transpose(2, 0, 1)[None].astype(np.float32))
        p = np.asarray(res[self.prob]).reshape(-1)
        age = int(round(float(np.asarray(res[self.age]).reshape(-1)[0]) * 100)) if self.age is not None else 0
        return float(p[1]), age


class UnknownGender:
    """Fallback when no gender model is installed: P(male) = 0.5 (uncertain) for every face."""

    def male_prob(self, bgr, box):
        return 0.5, 0


class BodyGenderClassifier:
    """Pedestrian attributes from the whole body (OpenVINO Open Model Zoo
    person-attributes-recognition-crossroad-0230, Apache-2.0). Gives P(male) for figures whose
    face is small, turned away or not visible. Optional: used only when par.xml/par.bin exist."""

    def __init__(self, xml_path, threads):
        self.model = _OvModel(xml_path, threads)
        self.output = self.model.outputs[0]  # "453": 8 attribute probabilities, is_male first

    def male_prob(self, bgr, box):
        h, w = bgr.shape[:2]
        x1, y1, x2, y2 = [int(round(v)) for v in box]
        x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
        if x2 - x1 < 4 or y2 - y1 < 8:
            return None
        crop = cv2.resize(bgr[y1:y2, x1:x2], (80, 160), interpolation=cv2.INTER_LINEAR)
        blob = crop.transpose(2, 0, 1)[None].astype(np.float32)  # BGR, NCHW, 0..255
        return float(np.asarray(self.model(blob)[self.output]).reshape(-1)[0])


class Analyzer:
    def __init__(self, models_dir, threads=2, thresholds=None):
        self.t = thresholds or Thresholds()
        # Each component uses the commercial-friendly model when it is installed (MODEL_PROFILE=research forces
        # the original research models). self.models records what is active, for /health and the reports.
        f = lambda name: os.path.join(models_dir, name)
        research = MODEL_PROFILE == "research"
        self.models = {}
        if not research and os.path.exists(f("person_yolox.onnx")):
            self.persons = YoloxPersonDetector(f("person_yolox.onnx"), threads)
            self.models["person"] = "YOLOX-s (Apache-2.0)"
        else:
            self.persons = PersonDetector(f("person.onnx"), threads)
            self.models["person"] = "YOLOv8s (AGPL-3.0)"
        if not research and os.path.exists(f("face_yunet.onnx")):
            self.faces = YuNetFaceDetector(f("face_yunet.onnx"), threads)
            self.models["face"] = "YuNet (MIT)"
        else:
            self.faces = FaceDetector(f("face_det.onnx"), threads)
            self.models["face"] = "SCRFD / InsightFace (non-commercial)"
        if not research and os.path.exists(f("gender_omz.xml")) and os.path.exists(f("gender_omz.bin")):
            self.gender = OmzGenderClassifier(f("gender_omz.xml"), threads)
            self.models["gender"] = "OMZ age-gender-recognition-retail-0013 (Apache-2.0)"
        elif os.path.exists(f("genderage.onnx")):
            self.gender = GenderClassifier(f("genderage.onnx"), threads)
            self.models["gender"] = "InsightFace genderage (non-commercial)"
        else:
            # No gender model installed: every face is "uncertain", so every figure with a face is blurred.
            self.gender = UnknownGender()
            self.models["gender"] = "none (all faces uncertain -> blurred)"
        par = os.path.join(models_dir, "par.xml")
        self.body = BodyGenderClassifier(par, threads) if os.path.exists(par) and BODY_MODEL else None
        self.models["body"] = "OMZ person-attributes-recognition-crossroad-0230 (Apache-2.0)" if self.body else "none"

    def detect_all(self, bgr, weak_min=None, tiling=FACE_TILING):
        """Raw detections for regional blurring (the verdict depends on the strictness level).

        Returns persons [(box, score)] with score >= person_min, weak persons [(box, score)] in
        [weak_min, person_min), faces [(box, score, male_prob or None, too_small)] and, per person,
        the body-based P(male) (None without the body model or for figures too small to judge).
        With tiling, face detection is repeated on enlarged tiles that contain a person whose face
        was not found (small faces in crowds), at extra cost only where it can help.
        """
        t = self.t
        weak_min = t.person_weak if weak_min is None else weak_min
        persons, weak = [], []
        for box, score in self.persons.detect(bgr, min(weak_min, t.person_min)):
            (persons if score >= t.person_min else weak).append((box, score))
        found = self.faces.detect(bgr, t.face_min)
        if tiling and persons:
            found += self._tile_faces(bgr, persons, found)
        faces = []
        for box, score in found:
            if min(box[2] - box[0], box[3] - box[1]) < t.min_face_px:
                faces.append((box, score, None, True))
            else:
                faces.append((box, score, self.gender.male_prob(bgr, box)[0], False))
        bodies = [None] * len(persons)
        if self.body is not None:
            bodies = [self.body.male_prob(bgr, pb) if pb[3] - pb[1] >= t.min_body_px else None for pb, _ in persons]
        return persons, weak, faces, bodies

    def _tile_faces(self, bgr, persons, faces):
        h, w = bgr.shape[:2]
        owners = assign_faces(persons, faces)
        owned = set(owners)
        heads = [[pb[0], pb[1], pb[2], pb[1] + 0.35 * (pb[3] - pb[1])]
                 for i, (pb, _) in enumerate(persons) if i not in owned]
        if not heads:
            return []
        tw, th = int(w * 0.6), int(h * 0.6)
        extra = []
        for y0 in (0, h - th):
            for x0 in (0, w - tw):
                if not any(hb[0] < x0 + tw and hb[2] > x0 and hb[1] < y0 + th and hb[3] > y0 for hb in heads):
                    continue
                for box, score in self.faces.detect(bgr[y0:y0 + th, x0:x0 + tw], self.t.face_min):
                    box = box + np.array([x0, y0, x0, y0], dtype=box.dtype)
                    if all(_iou(box, f[0]) < 0.4 for f in faces + extra):
                        extra.append((box, score))
        return extra

    def analyze_frame(self, bgr):
        """Return FrameResult. blur=True unless the frame is empty of people or contains only confident men."""
        t = self.t
        persons = self.persons.detect(bgr, t.person_min)
        faces = self.faces.detect(bgr, t.face_min)
        reasons = []
        face_info = []
        confidences = []

        # Judge every face on its own.
        for box, score in faces:
            fw, fh = box[2] - box[0], box[3] - box[1]
            info = {"box": [round(float(v)) for v in box], "score": round(score, 3)}
            if min(fw, fh) < t.min_face_px:
                info["verdict"] = "too_small"
                reasons.append("face_too_small")
            else:
                male, age = self.gender.male_prob(bgr, box)
                info.update({"male": round(male, 3), "age": age})
                if male >= t.male_conf:
                    info["verdict"] = "man"
                    confidences.append(male)
                elif male <= 0.5:
                    info["verdict"] = "woman"
                    reasons.append("woman")
                    confidences.append(1 - male)
                else:
                    info["verdict"] = "uncertain_gender"
                    reasons.append("uncertain_gender")
                    confidences.append(1 - male)
            face_info.append(info)

        # Every detected person must own at least one face (face centre in the upper part of its box).
        owned = [0] * len(persons)
        for box, _ in faces:
            fx, fy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            best, best_area = -1, None
            for i, (pb, _) in enumerate(persons):
                pw, ph = pb[2] - pb[0], pb[3] - pb[1]
                if pb[0] <= fx <= pb[2] and pb[1] <= fy <= pb[1] + 0.65 * ph:
                    area = pw * ph
                    if best_area is None or area < best_area:
                        best, best_area = i, area
            if best >= 0:
                owned[best] += 1
        for i, (pb, score) in enumerate(persons):
            if owned[i] == 0:
                reasons.append("person_without_clear_face")
                confidences.append(score)

        blur = len(reasons) > 0
        if blur:
            confidence = max(confidences) if confidences else 0.5
        elif face_info:
            confidence = min(f["male"] for f in face_info)
        else:
            confidence = 1.0
        return FrameResult(blur=blur, reasons=sorted(set(reasons)), confidence=round(confidence, 3),
                           persons=len(persons), faces=face_info)

    def summarize(self, frames):
        """Combine per-frame results (any blurred frame blurs the whole file)."""
        if not frames:
            return {"decision": "blurred", "reasons": ["no_frames"], "confidence": 0.0}
        bad = [f for f in frames if f.blur]
        if bad:
            reasons = sorted({r for f in bad for r in f.reasons})
            return {"decision": "blurred", "reasons": reasons, "confidence": max(f.confidence for f in bad)}
        has_people = any(f.persons or f.faces for f in frames)
        return {
            "decision": "open",
            "reasons": ["men_only"] if has_people else ["no_people"],
            "confidence": min(f.confidence for f in frames),
        }


def timed(fn, *args, **kwargs):
    start = time.monotonic()
    res = fn(*args, **kwargs)
    return res, int((time.monotonic() - start) * 1000)

"""Tests of the OpenVINO person detector (PERSON_BACKEND=ov): same YOLOX weights as the ONNX Runtime one, input shaped like the picture.
Run in the moderation image (needs the models; the picture tests also need tests/media/short.mp4 and protest.mp4, which are not in git):
    docker run --rm -u 0 --entrypoint python -v "$PWD/moderation_models:/models:ro" -v "$PWD/moderation/app:/app:ro" \
        -v "$PWD/moderation/tests:/t:ro" -v "$PWD/tests/media:/media:ro" thechannel-moderation /t/test_person_ov.py -v
"""
import os
import sys
import threading
import unittest

import cv2
import numpy as np

sys.path.insert(0, "/app")
import analyzer as A  # noqa: E402

MODELS = os.environ.get("MODELS_DIR", "/models")
MODEL = os.path.join(MODELS, "person_yolox.onnx")
HAVE_MODEL = os.path.exists(MODEL)


def frame_of(path, second):
    cap = cv2.VideoCapture(path)
    cap.set(cv2.CAP_PROP_POS_MSEC, second * 1000)
    ok, img = cap.read()
    cap.release()
    return img if ok else None


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


@unittest.skipUnless(HAVE_MODEL, "person_yolox.onnx not installed")
class OvPersonDetector(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ort = A.YoloxPersonDetector(MODEL, 2)
        cls.ov = A.YoloxOvPersonDetector(MODEL, 2)

    def pictures(self):
        out = []
        for name, secs in (("short.mp4", (1, 3, 5)), ("protest.mp4", (5, 20, 40)), ("long.mp4", (10, 60))):
            p = "/media/" + name
            if os.path.exists(p):
                out += [(f"{name}@{s}", img) for s in secs if (img := frame_of(p, s)) is not None]
        return out

    def test_same_detections_as_onnx_runtime(self):
        """Same scale and position as the 640x640 version, only the padding is cut: the same people with (nearly) the same scores (OV may add a borderline one)."""
        pics = self.pictures()
        if not pics:
            self.skipTest("no test pictures in /media")
        checked = 0
        for name, img in pics:
            a = self.ort.detect(img, 0.30)
            b = self.ov.detect(img, 0.30)
            # In a crowd a borderline person can appear or vanish (the network sees different padding): the new detector
            # may find one more (more blur, harmless) but must not lose a clearly visible one.
            self.assertGreaterEqual(len(b), len(a) - 0, f"{name}: {len(a)} persons (ORT) vs {len(b)} (OV): OV lost one")
            for box, score in a:
                best = max(((iou(box, bb), ss) for bb, ss in b), key=lambda t: t[0])
                self.assertGreater(best[0], 0.8, f"{name}: no matching box for {box.round()}")
                self.assertLess(abs(best[1] - score), 0.08, f"{name}: score {score:.3f} vs {best[1]:.3f}")
                checked += 1
        self.assertGreater(checked, 0, "the test pictures contain no people at all")

    def test_input_follows_the_picture(self):
        landscape = np.zeros((480, 848, 3), np.uint8)
        portrait = np.zeros((850, 478, 3), np.uint8)
        self.ov.detect(landscape, 0.3)
        self.ov.detect(portrait, 0.3)
        self.assertIn((384, 640), self.ov.compiled)   # 848x480 -> 640x360 -> 640x384 (instead of 640x640)
        self.assertIn((640, 384), self.ov.compiled)   # 478x850 -> 360x640 -> 640x384 turned

    def test_small_side_returns_full_size_coordinates(self):
        pics = [p for p in self.pictures() if p[0].startswith("long.mp4")]
        if not pics:
            self.skipTest("no test picture")
        _, img = pics[0]
        big = [b for b, s in self.ov.detect(img, 0.5) if (b[3] - b[1]) > 150]
        small = [b for b, s in self.ov.detect(img, 0.3, 416)]
        h, w = img.shape[:2]
        for b in small:
            self.assertTrue(0 <= b[0] <= w and 0 <= b[2] <= w and 0 <= b[1] <= h and 0 <= b[3] <= h)
        for b in big:   # clearly visible people are still found at the smaller scale, in picture coordinates
            self.assertTrue(any(iou(b, s) > 0.6 for s in small), f"big person {b.round()} missing at 416")

    def test_threads_do_not_collide(self):
        """An OpenVINO infer request is not thread-safe: every thread has its own (see test_infer_threads.py)."""
        img = (np.random.RandomState(7).rand(480, 848, 3) * 255).astype(np.uint8)
        errors = []

        def work():
            for _ in range(40):
                try:
                    self.ov.detect(img, 0.1)
                except Exception as e:  # noqa: BLE001
                    errors.append(str(e))

        threads = [threading.Thread(target=work) for _ in range(3)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()

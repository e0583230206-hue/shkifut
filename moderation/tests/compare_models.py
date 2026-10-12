"""Compare model profiles (research vs commercial) on the same media. Numbers only, no images written.

Run inside the moderation image (see moderation/tests/run_compare.sh):
    MODEL_PROFILE=research python compare_models.py /media/*.jpg /media/*.mp4
"""
import collections
import os
import sys
import time

sys.path.insert(0, "/app")
import cv2  # noqa: E402

import regional  # noqa: E402
from analyzer import Analyzer, Thresholds  # noqa: E402

LEVEL = os.environ.get("LEVEL", "strict")
an = Analyzer(os.environ.get("MODELS_DIR", "/models"), int(os.environ.get("THREADS", "2")), Thresholds())
lv = regional.get_level(LEVEL)
print(f"profile={os.environ.get('MODEL_PROFILE', 'auto')} level={LEVEL} models={an.models}", flush=True)

for path in sys.argv[1:]:
    name = os.path.basename(path)
    t0 = time.time()
    if path.endswith(".mp4"):
        w, h, fps, dur = regional.probe(path)
        fps = min(fps, regional.MAX_OUTPUT_FPS)
        step = max(1, round(fps / regional.DETECT_FPS))
        aw, ah = regional.fit(w, h, regional.ANALYSIS_MAX_SIDE)
        plan = regional.analyze_video(an, path, fps, aw, ah, step, lv)
        took = time.time() - t0
        total = int(dur * fps)
        boxes = regional.frame_boxes(plan, an.t, step, fps, total + 2 * step + 10, aw, ah, 1, 1)
        cov = [regional.coverage(boxes.get(fr, []), aw, ah) for fr in range(total)]
        full = sum(1 for c in cov if c >= lv.full_area)
        visible = 1 - sum(1.0 if c >= lv.full_area else c for c in cov) / max(total, 1)
        verdicts = collections.Counter(t.decide(lv) for t in plan.tracks)
        # raw detection density on the sampled frames
        pc = fc = n = 0
        for fr in regional.read_frames(path, fps, aw, ah, f"select='not(mod(n\\,{step * 5}))'"):
            p, _, f, _ = an.detect_all(fr)
            pc += len(p); fc += len(f); n += 1
        print(f"{name:14s} analysis={took:6.1f}s ({took / max(dur, 0.1):.2f}s/s) persons/frame={pc / max(n, 1):.1f} "
              f"faces/frame={fc / max(n, 1):.1f} tracks={len(plan.tracks)} men={verdicts['man']} "
              f"woman={verdicts['woman']} uncertain={verdicts['uncertain_gender']} noface={verdicts['person_without_clear_face']} "
              f"full_frames={full}/{total} visible={visible:.0%}", flush=True)
    else:
        bgr = cv2.imread(path)
        full, bxs, reasons, conf, _ = regional.plan_still(an, bgr, lv)
        p, _, f, _ = an.detect_all(bgr)
        decision = "blurred" if full else ("regional" if bxs else "open")
        print(f"{name:14s} {decision:8s} persons={len(p)} faces={len(f)} "
              f"male={[round(x[2], 2) for x in f if x[2] is not None]} reasons={reasons} {time.time() - t0:.2f}s", flush=True)

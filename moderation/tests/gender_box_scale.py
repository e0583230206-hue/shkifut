"""How the face box scale given to the gender model changes P(male) (commercial face detector). Numbers only.

    python gender_box_scale.py /media/long.mp4 /media/protest.mp4
"""
import os
import sys

sys.path.insert(0, "/app")
import numpy as np  # noqa: E402

import regional  # noqa: E402
from analyzer import Analyzer, Thresholds  # noqa: E402

an = Analyzer("/models", 2, Thresholds())
print("models:", an.models)
for path in sys.argv[1:]:
    w, h, fps, dur = regional.probe(path)
    aw, ah = regional.fit(w, h, regional.ANALYSIS_MAX_SIDE)
    res = {s: [] for s in (1.0, 1.15, 1.3, 1.5)}
    for fr in regional.read_frames(path, 1, aw, ah):  # one frame per second
        for box, score in an.faces.detect(fr, an.t.face_min):
            if min(box[2] - box[0], box[3] - box[1]) < an.t.min_face_px:
                continue
            cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            bw, bh = box[2] - box[0], box[3] - box[1]
            for s in res:
                b = np.array([cx - bw * s / 2, cy - bh * s / 2, cx + bw * s / 2, cy + bh * s / 2])
                res[s].append(an.gender.male_prob(fr, b)[0])
    for s, v in res.items():
        v = np.array(v)
        if len(v):
            print(f"{os.path.basename(path):12s} scale={s:<4} faces={len(v)} >=0.9: {np.mean(v >= .9):.0%}  "
                  f"0.5-0.9: {np.mean((v > .5) & (v < .9)):.0%}  <=0.5: {np.mean(v <= .5):.0%}", flush=True)

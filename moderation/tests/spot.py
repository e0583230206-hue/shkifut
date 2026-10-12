"""Person-detector score at given spots on every frame of a window (numbers only). Sampled frames marked '*'.

    python spot.py /media/protest.mp4 300 320 "299,5,324,29" "160,7,176,33"
"""
import sys

sys.path.insert(0, "/app")
import regional  # noqa: E402
from analyzer import Analyzer, Thresholds  # noqa: E402

an = Analyzer("/models", 2, Thresholds())
path, f0, f1 = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
spots = [[float(v) for v in s.split(",")] for s in sys.argv[4:]]
w, h, fps, dur = regional.probe(path)
fps = min(fps, regional.MAX_OUTPUT_FPS)
step = max(1, round(fps / regional.DETECT_FPS))
aw, ah = regional.fit(w, h, regional.ANALYSIS_MAX_SIDE)
print("models:", an.models["person"], "| step:", step)
rows = {i: [] for i in range(len(spots))}
for fr, frame in enumerate(regional.read_frames(path, fps, aw, ah)):
    if fr < f0:
        continue
    if fr > f1:
        break
    dets = an.persons.detect(frame, 0.05)
    for i, sp in enumerate(spots):
        best = max([s for b, s in dets if regional.iou(b.tolist(), sp) > 0.2] or [0.0])
        rows[i].append(f"{fr}{'*' if fr % step == 0 else ''}:{best:.2f}")
for i, sp in enumerate(spots):
    print(f"spot {[int(v) for v in sp]}: " + " ".join(rows[i]))

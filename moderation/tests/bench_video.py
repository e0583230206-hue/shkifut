"""Speed and quality benchmark of the regional video analysis. Numbers only: no frames, no crops are saved.

    python bench_video.py /media/clip60.mp4 --dump /media/base.json          # one run, saves the blur boxes per frame
    python bench_video.py /media/clip60.mp4 --dump /media/var.json --base /media/base.json   # + comparison to the baseline
    python bench_video.py --compare /media/base.json /media/var.json         # comparison only

Every knob is an environment variable (THREADS, DETECT_FPS, DENSE_PERSON_STEP, ...), so a variant is the same command with other env.

Quality is measured against the baseline run of the same video (its blur boxes are the reference):
  missed  = baseline blurred boxes that the variant does NOT cover (>= 50% of the box inside the variant's boxes): potential leaks
  extra   = variant boxes that cover no baseline box (more blur than the baseline; harmless for privacy)
  men     = tracks the variant decided to show (the baseline's number is in the dump)
The leak check (leak_check.py) is the independent check of the variant's output.
"""
import argparse
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.environ.get("APP_DIR", "/app"))
import regional  # noqa: E402
from analyzer import Analyzer, Thresholds  # noqa: E402


def covered(box, boxes, thr=0.5):
    area = max(1.0, (box[2] - box[0]) * (box[3] - box[1]))
    inside = 0.0
    for b in boxes:
        ix = max(0.0, min(box[2], b[2]) - max(box[0], b[0]))
        iy = max(0.0, min(box[3], b[3]) - max(box[1], b[1]))
        inside += ix * iy
    return inside / area >= thr


def compare(base, var):
    bb, vb = base["boxes"], var["boxes"]
    frames = sorted(set(bb) | set(vb), key=int)
    missed_boxes = missed_frames = extra_boxes = base_boxes = 0
    for fr in frames:
        b, v = bb.get(fr, []), vb.get(fr, [])
        base_boxes += len(b)
        miss = sum(1 for x in b if not covered(x, v))
        missed_boxes += miss
        missed_frames += 1 if miss else 0
        extra_boxes += sum(1 for x in v if not covered(x, b))
    return {"base_box_frames": base_boxes, "missed_box_frames": missed_boxes, "missed_frames": missed_frames,
            "extra_box_frames": extra_boxes, "base_men": base["summary"].get("men_tracks"),
            "var_men": var["summary"].get("men_tracks"), "base_tracks": base["summary"].get("tracks"),
            "var_tracks": var["summary"].get("tracks")}


class Timers:
    """Wraps the model calls to count them and add up their time."""

    def __init__(self, an):
        self.t, self.n = {}, {}
        for name, obj, meth in (("person", an.persons, "detect"), ("face", an.faces, "detect"),
                                ("gender", an.gender, "male_prob"), ("body", an.body, "male_prob")):
            if obj is not None:
                self._wrap(name, obj, meth)

    def _wrap(self, name, obj, meth):
        fn = getattr(obj, meth)

        def wrapper(*a, **k):
            t0 = time.perf_counter()
            try:
                return fn(*a, **k)
            finally:
                self.t[name] = self.t.get(name, 0.0) + time.perf_counter() - t0
                self.n[name] = self.n.get(name, 0) + 1
        setattr(obj, meth, wrapper)


def run(path, level):
    lv = regional.get_level(level)
    an = Analyzer(os.environ.get("MODELS_DIR", "/models"), int(os.environ.get("THREADS", "3")), Thresholds())
    timers = Timers(an)
    holder = {}
    orig = regional.analyze_video

    def traced(analyzer, p, fps, aw, ah, step, lv_):
        t0 = time.perf_counter()
        plan = orig(analyzer, p, fps, aw, ah, step, lv_)
        holder.update(plan=plan, pass1=time.perf_counter() - t0, fps=fps, aw=aw, ah=ah, step=step)
        return plan

    regional.analyze_video = traced
    out = os.path.join(tempfile.mkdtemp(), "out.mp4")
    t0 = time.perf_counter()
    res = regional.regional_video(an, path, out, level)
    wall = time.perf_counter() - t0
    w, h, sfps, dur = regional.probe(path)
    rw, rh = regional.fit(w, h, regional.OUTPUT_MAX_SIDE)
    plan = holder["plan"]
    total = int(dur * holder["fps"]) + 2 * holder["step"] + 10
    boxes = regional.frame_boxes(plan, an.t, holder["step"], holder["fps"], total, holder["aw"], holder["ah"],
                                 rw / holder["aw"], rh / holder["ah"])
    summary = {k: res.get(k) for k in ("decision", "tracks", "men_tracks", "blurred_tracks", "visible_tracks", "detections",
                                       "regions", "full_frames", "uncovered_frames", "duration")}
    summary["reasons"] = res.get("reasons")
    return {"video": os.path.basename(path), "wall_s": round(wall, 1), "pass1_s": round(holder["pass1"], 1),
            "pass2_s": round(wall - holder["pass1"], 1), "s_per_video_s": round(wall / max(dur, 0.1), 2),
            "calls": timers.n, "model_s": {k: round(v, 1) for k, v in timers.t.items()}, "summary": summary,
            "boxes": {str(fr): [[round(float(x), 1) for x in b] for b in bs] for fr, bs in boxes.items()}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", nargs="?")
    ap.add_argument("--level", default=os.environ.get("LEVEL", "strict"))
    ap.add_argument("--dump")
    ap.add_argument("--base")
    ap.add_argument("--compare", nargs=2)
    a = ap.parse_args()
    if a.compare:
        base, var = (json.load(open(p)) for p in a.compare)
        print(json.dumps(compare(base, var)))
        return
    r = run(a.video, a.level)
    if a.dump:
        json.dump(r, open(a.dump, "w"))
    line = {k: v for k, v in r.items() if k != "boxes"}
    if a.base:
        line["vs_base"] = compare(json.load(open(a.base)), r)
    print(json.dumps(line, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

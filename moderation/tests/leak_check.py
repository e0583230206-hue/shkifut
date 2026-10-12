"""Full leak check of the regional blur: every frame of the output is examined. Numbers only, no frames saved.

    LEVEL=strict MODEL_PROFILE=auto python leak_check.py /media/protest.mp4 ...

For each video: render the regional version, then for every output frame (frames blurred entirely skipped):
  - detect faces / persons in the OUTPUT;
  - ignore what lies inside a blurred box, or inside a figure that was decided to be a man;
  - a remaining candidate is a REAL leak only if the ORIGINAL frame has a person / face there too
    (otherwise it is a pixelation artifact next to a blurred area).
Exit code 1 when any real leak is found.
"""
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, "/app")
import regional  # noqa: E402
from analyzer import Analyzer, Thresholds  # noqa: E402

LEVEL = os.environ.get("LEVEL", "strict")
lv = regional.get_level(LEVEL)
STRICT = regional.LEVELS["strict"]
an = Analyzer(os.environ.get("MODELS_DIR", "/models"), int(os.environ.get("THREADS", "2")), Thresholds())
print(f"level={LEVEL} models={json.dumps(an.models)}", flush=True)


def covered(box, boxes, thr=0.5):
    area = max(1.0, (box[2] - box[0]) * (box[3] - box[1]))
    for b in boxes:
        ix = max(0.0, min(box[2], b[2]) - max(box[0], b[0]))
        iy = max(0.0, min(box[3], b[3]) - max(box[1], b[1]))
        if ix * iy / area >= thr:
            return True
    return False


def present_in_original(box, items, iou_min=0.3):
    return any(regional.iou(box, b.tolist()) >= iou_min for b in items)


real_leaks_total = 0
for path in sys.argv[1:]:
    name = os.path.basename(path)
    out = os.path.join(tempfile.mkdtemp(), name + ".regional.mp4")
    t0 = time.time()
    r = regional.regional_video(an, path, out, LEVEL)
    took = time.time() - t0
    print(f"== {name}: decision={r['decision']} processing={took:.1f}s ({took / max(r.get('duration', 1), 0.1):.2f}s per video-second) "
          f"tracks={r.get('tracks')} men={r.get('men_tracks')} full_frames={r.get('full_frames')} uncovered={r.get('uncovered_frames')}", flush=True)
    if not os.path.exists(out):
        print("   nothing to blur - output equals the original", flush=True)
        continue

    w, h, sfps, dur = regional.probe(path)
    fps = min(sfps, regional.MAX_OUTPUT_FPS)
    step = max(1, round(fps / regional.DETECT_FPS))
    aw, ah = regional.fit(w, h, regional.ANALYSIS_MAX_SIDE)
    ow, oh, _, _ = regional.probe(out)
    total = int(dur * fps) + 2 * step + 10
    plan = regional.analyze_video(an, path, fps, aw, ah, step, lv)  # deterministic: same plan as the render
    sx, sy = ow / aw, oh / ah
    blur = regional.frame_boxes(plan, an.t, step, fps, total, aw, ah, sx, sy)
    men = regional.frame_boxes(plan, an.t, step, fps, total, aw, ah, sx, sy, men=True)
    full = {fr for fr, bs in blur.items() if regional.coverage(bs, ow, oh) >= lv.full_area}

    checked = artifacts = by_decision = 0
    leaks = []
    t1 = time.time()
    originals = regional.read_frames(path, fps, ow, oh)
    for fr, frame in enumerate(regional.read_frames(out, fps, ow, oh)):
        orig = next(originals, None)
        if fr in full:
            continue
        checked += 1
        persons, _, faces, _ = an.detect_all(frame, tiling=False)
        bb, mb = blur.get(fr, []), men.get(fr, [])
        cand = []
        for f in faces:
            fb = f[0].tolist()
            if regional.verdict(f, STRICT) == "man" or covered(fb, bb):
                continue
            if covered(fb, mb):
                by_decision += 1
                continue
            cand.append(("face", fb))
        for p, score in persons:
            pb = p.tolist()
            if covered(pb, bb):
                continue
            if covered(pb, mb):
                by_decision += 1
                continue
            cand.append(("person", pb))
        if not cand or orig is None:
            continue
        op, ow_, of, _ = an.detect_all(orig, weak_min=0.15, tiling=False)
        o_persons = [b for b, _ in op + ow_]
        o_faces = [x[0] for x in of]
        for kind, box in cand:
            if present_in_original(box, o_persons if kind == "person" else o_faces):
                leaks.append((fr, kind, [int(v) for v in box]))
            else:
                artifacts += 1
    real_leaks_total += len(leaks)
    print(f"   checked {checked} frames (+{len(full)} fully blurred) in {time.time() - t1:.0f}s | "
          f"visible by decision (men): {by_decision} | blur artifacts: {artifacts} | REAL LEAKS: {len(leaks)}", flush=True)
    for fr, kind, box in leaks[:20]:
        print(f"     LEAK {kind} frame {fr} t={fr / fps:.2f}s box={box}", flush=True)
    os.remove(out)

print(f"\nTOTAL REAL LEAKS: {real_leaks_total}", flush=True)
sys.exit(1 if real_leaks_total else 0)

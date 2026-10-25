"""Makes tests/fixtures/pchip_vectors.json: the reference values of the PCHIP interpolation (the smooth movement of a manual video blur
between its keyframes), computed by scipy. The Go package (backend/manualblur), the Python renderer (moderation/app) and the page
(TypeScript) must all give these values; each has a test that reads this file.

    PYTHONPATH=<a folder with scipy and numpy> python moderation/../tests/fixtures/gen_pchip_vectors.py     (run once; the JSON is committed)
"""
import json
import os
import sys

import numpy as np
from scipy.interpolate import PchipInterpolator

CASES = {
    "two points (a straight line)": ([0.0, 2.0], [0.1, 0.5]),
    "three points, rising": ([0.0, 1.0, 3.0], [0.1, 0.2, 0.9]),
    "four points, a peak (no overshoot)": ([0.0, 1.0, 2.0, 5.0], [0.2, 0.8, 0.3, 0.35]),
    "flat then rising": ([0.0, 1.0, 2.0, 4.0], [0.3, 0.3, 0.3, 0.7]),
    "uneven spacing": ([0.0, 0.2, 5.0, 5.5, 9.0], [0.05, 0.1, 0.6, 0.62, 0.95]),
    "zigzag": ([0.0, 1.0, 2.0, 3.0, 4.0], [0.1, 0.7, 0.2, 0.8, 0.3]),
    "steep ends": ([0.0, 0.5, 6.0], [0.0, 0.5, 0.55]),
    "falling": ([1.0, 2.5, 4.0, 10.0], [0.9, 0.7, 0.2, 0.1]),
}


def main():
    out = []
    for name, (xs, ys) in CASES.items():
        f = PchipInterpolator(xs, ys)
        pts = sorted(set(list(np.linspace(xs[0], xs[-1], 41)) + xs))
        out.append({"name": name, "t": xs, "y": ys, "at": [float(p) for p in pts], "expect": [float(v) for v in f(pts)]})
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pchip_vectors.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"source": "scipy.interpolate.PchipInterpolator", "cases": out}, fh, indent=1)
    print("wrote", path, len(out), "cases")


if __name__ == "__main__":
    sys.exit(main())

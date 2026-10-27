"""Tests of the manual blur renderer (moderation/app/manual_image.py). No models needed. Run in the moderation image:
    docker run --rm -u 0 --entrypoint python -v "$PWD/moderation/app:/app:ro" -v "$PWD/moderation/tests:/t:ro" thechannel-moderation /t/test_manual_image.py -v
(or anywhere with numpy, opencv and pillow: python moderation/tests/test_manual_image.py -v)."""
import io
import os
import sys
import tempfile
import unittest

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.environ.get("APP_DIR", "/app" if os.path.isdir("/app") else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app")))
import manual_image as M  # noqa: E402


def noise_picture(w=400, h=300, seed=1):
    return (np.random.RandomState(seed).rand(h, w, 3) * 255).astype(np.uint8)   # RGB, full of detail


def laplacian_energy(a):
    return float(np.mean(np.abs(cv2.Laplacian(cv2.cvtColor(a, cv2.COLOR_RGB2GRAY), cv2.CV_32F))))


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="mi-")
        self.out = os.path.join(self.dir, "manual", "ab", "cd", "x.jpg")

    def save_source(self, arr, name="src.png", **kw):
        p = os.path.join(self.dir, name)
        Image.fromarray(arr).save(p, **kw)
        return p

    def render(self, arr, shapes, **kw):
        res = M.render(self.save_source(arr), self.out, shapes, **kw)
        return np.asarray(Image.open(self.out).convert("RGB")), res


class Shapes(Base):
    def test_rect_blurs_inside_and_leaves_the_rest_alone(self):
        src = noise_picture()
        out, res = self.render(src, [{"type": "rect", "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5}])
        self.assertEqual((res["width"], res["height"]), (400, 300))
        inside_src, inside_out = src[80:220, 120:280], out[80:220, 120:280]
        self.assertLess(laplacian_energy(inside_out), laplacian_energy(inside_src) * 0.05, "detail survives inside the rectangle")
        # outside the shape the picture is only re-encoded: equal to a plain JPEG round trip of the source (a margin of two 8x8 blocks is left out)
        buf = io.BytesIO()
        Image.fromarray(src).save(buf, "JPEG", quality=M.JPEG_QUALITY, optimize=True)
        reference = np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("RGB"))
        outside = np.ones(src.shape[:2], bool)
        outside[60:240, 100:300] = False
        self.assertLess(np.abs(out.astype(int) - reference.astype(int)).mean(axis=2)[outside].mean(), 0.5, "the area outside the rectangle changed")

    def test_ellipse_covers_its_inside_completely_and_not_the_corners(self):
        src = np.full((300, 400, 3), 0, np.uint8)
        src[:, ::2] = 255                                    # stripes: the finest detail there is
        box = (0.2, 0.2, 0.6, 0.6)                            # x, y, w, h
        out, _ = self.render(src, [{"type": "ellipse", "x": box[0], "y": box[1], "w": box[2], "h": box[3]}])
        x0, y0, x1, y1 = 80, 60, 320, 240                     # the box in pixels
        cx, cy, rx, ry = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
        yy, xx = np.mgrid[0:300, 0:400]
        r = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
        inside = r <= 0.97
        gray = out.mean(axis=2)
        # no stripe contrast is left anywhere inside the ellipse: look at pixel pairs next to each other
        horiz = np.abs(np.diff(gray, axis=1))
        self.assertLess(horiz[:, :][inside[:, 1:] & inside[:, :-1]].max(), 60, "stripes survive inside the ellipse")
        corners = (xx >= x0) & (xx < x1) & (yy >= y0) & (yy < y1) & (r >= 1.08)
        self.assertGreater(np.abs(np.diff(gray, axis=1))[corners[:, 1:] & corners[:, :-1]].mean(), 150, "the corners of the box were blurred")

    def test_ellipse_edge_is_smooth(self):
        a = M.ellipse_alpha(200, 120)
        self.assertEqual(a[60, 100], 1.0)
        self.assertEqual(a[0, 0], 0.0)
        edge = a[(a > 0) & (a < 1)]
        self.assertGreater(edge.size, 0, "no anti-aliased edge")
        self.assertGreater(len(np.unique(np.round(edge, 2))), 4, "the edge has no gradation")

    def test_shapes_are_clipped_to_the_picture_and_may_cover_all_of_it(self):
        src = noise_picture(120, 80)
        out, _ = self.render(src, [{"type": "rect", "x": -1, "y": -1, "w": 3, "h": 3}])
        self.assertLess(laplacian_energy(out), laplacian_energy(src) * 0.05)

    def test_a_box_is_never_narrowed(self):
        # a shape that starts in the middle of a pixel must blur that pixel too
        src = noise_picture(100, 100)
        boxes = M.validate([{"type": "rect", "x": 0.255, "y": 0.255, "w": 0.2, "h": 0.2}])
        img = np.ascontiguousarray(src[:, :, ::-1])
        before = img.copy()
        M.apply_shapes(img, boxes)
        changed = np.where((img != before).any(axis=2))
        self.assertEqual(changed[1].min(), 25)   # floor(25.5)
        self.assertGreaterEqual(changed[1].max(), 45)   # ceil(45.5) - 1


class Validation(Base):
    def bad(self, shapes):
        with self.assertRaises(M.Rejected):
            M.validate(shapes)

    def test_rejects(self):
        ok = {"type": "rect", "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}
        self.bad(None)
        self.bad([])
        self.bad("x")
        self.bad([dict(ok, type="star")])
        self.bad([dict(ok, x=float("nan"))])
        self.bad([dict(ok, w=float("inf"))])
        self.bad([dict(ok, w="a")])
        self.bad([{"type": "rect", "x": 0.1}])
        self.bad([dict(ok, w=0.001)])
        self.bad([dict(ok, x=1.4)])
        self.bad([ok] * (M.MAX_SHAPES + 1))
        self.assertEqual(len(M.validate([ok] * M.MAX_SHAPES)), M.MAX_SHAPES)

    def test_paths_only_the_allowed_files(self):
        h64, h40 = "a" * 64, "b" * 40
        M.check_paths(f"aa/aa/{h64}", "files", f"manual/bb/bb/{h40}.jpg")
        M.check_paths(f"aa/aa/{h64}.regional.jpg", "blurred", f"manual/bb/bb/{h40}.jpg")
        for base, root, out in [
            (f"aa/aa/{h64}", "files", f"aa/aa/{h64}.regional.jpg"),                 # would overwrite the regional picture
            (f"aa/aa/{h64}", "files", f"aa/aa/{h64}.jpg"),                          # ... or the fully blurred one
            (f"aa/aa/{h64}", "files", f"manual/bb/bb/{h40}.jpg/../../../x.jpg"),
            (f"aa/aa/{h64}", "files", f"manual/../{h40}.jpg"),
            ("../../etc/passwd", "files", f"manual/bb/bb/{h40}.jpg"),
            (f"aa/aa/{h64}.mp4", "files", f"manual/bb/bb/{h40}.jpg"),
            (f"aa/aa/{h64}", "blurred", f"manual/bb/bb/{h40}.jpg"),                 # an original is not in the blurred folder
            (f"aa/aa/{h64}.regional.jpg", "files", f"manual/bb/bb/{h40}.jpg"),
            (f"aa/aa/{h64}", "elsewhere", f"manual/bb/bb/{h40}.jpg"),
            (None, "files", f"manual/bb/bb/{h40}.jpg"),
            (f"aa/aa/{h64}", "files", None),
        ]:
            with self.assertRaises(M.Rejected, msg=f"{base} {root} {out}"):
                M.check_paths(base, root, out)


class Brush(Base):
    def stroke(self, pts, r=0.06):
        return {"type": "brush", "r": r, "pts": [list(p) for p in pts]}

    def test_a_stroke_blurs_what_the_brush_passed_over_and_nothing_else(self):
        src = np.full((300, 400, 3), 0, np.uint8)
        src[:, ::2] = 255                                              # the finest detail there is
        pts = [(0.1, 0.2), (0.5, 0.6), (0.9, 0.3)]
        out, _ = self.render(src, [self.stroke(pts, r=0.05)])
        gray = out.mean(axis=2)
        horiz = np.abs(np.diff(gray, axis=1))
        yy, xx = np.mgrid[0:300, 0:400]
        P = [(x * 400, y * 300) for x, y in pts]

        def seg(a, b):
            ax, ay = b[0] - a[0], b[1] - a[1]
            u = np.clip(((xx - a[0]) * ax + (yy - a[1]) * ay) / (ax * ax + ay * ay), 0, 1)
            return np.hypot(xx - (a[0] + u * ax), yy - (a[1] + u * ay))
        dist = np.minimum(seg(P[0], P[1]), seg(P[1], P[2]))
        rad = 0.05 * 400
        inside = dist <= rad * 0.93
        far = dist >= rad + 6
        self.assertLess(horiz[inside[:, 1:] & inside[:, :-1]].max(), 60, "stripes survive inside the stroke")
        self.assertGreater(horiz[far[:, 1:] & far[:, :-1]].mean(), 200, "the picture away from the stroke was blurred")

    def test_the_edge_is_smooth(self):
        src = np.full((200, 200, 3), 0, np.uint8)
        src[:, ::2] = 255
        out, _ = self.render(src, [self.stroke([(0.3, 0.5), (0.7, 0.5)], r=0.1)])
        col = out[100, :, :].mean(axis=1)
        self.assertTrue(((col > 20) & (col < 235)).sum() > 10, "no gradation at the edge")

    def test_a_dot(self):
        src = noise_picture(200, 200)
        out, _ = self.render(src, [self.stroke([(0.5, 0.5)], r=0.1)])
        self.assertLess(laplacian_energy(out[90:110, 90:110]), laplacian_energy(src[90:110, 90:110]) * 0.1)   # inside the dot (its box has corners the brush never touched)
        self.assertGreater(laplacian_energy(out[:40, :40]), laplacian_energy(src[:40, :40]) * 0.7)

    def test_whatever_the_size_of_the_brush_the_inside_is_unrecognisable(self):
        src = noise_picture(400, 300)
        for r, band in ((0.12, 30), (0.02, 4)):
            out, _ = self.render(src, [self.stroke([(0.2, 0.5), (0.8, 0.5)], r=r)])
            self.assertLess(laplacian_energy(out[150 - band:150 + band, 100:300]), laplacian_energy(src[150 - band:150 + band, 100:300]) * 0.25, f"r={r}")

    def test_strokes_work_beside_rectangles_and_ellipses(self):
        src = noise_picture(300, 300)
        out, res = self.render(src, [{"type": "rect", "x": 0.0, "y": 0.0, "w": 0.2, "h": 0.2}, self.stroke([(0.5, 0.5), (0.8, 0.8)], r=0.05),
                                     {"type": "ellipse", "x": 0.0, "y": 0.8, "w": 0.2, "h": 0.2}])
        self.assertEqual(res["shapes"], 3)
        self.assertLess(laplacian_energy(out[0:50, 0:50]), laplacian_energy(src[0:50, 0:50]) * 0.1)
        self.assertLess(laplacian_energy(out[190:200, 190:200]), laplacian_energy(src[190:200, 190:200]) * 0.2)   # on the diagonal stroke

    def test_a_stroke_at_the_edge_of_the_picture(self):
        src = noise_picture(200, 200)
        out, _ = self.render(src, [self.stroke([(0.0, 0.0), (1.0, 1.0)], r=0.1)])
        self.assertLess(laplacian_energy(out[0:20, 0:20]), laplacian_energy(src[0:20, 0:20]) * 0.3)
        self.assertLess(laplacian_energy(out[180:200, 180:200]), laplacian_energy(src[180:200, 180:200]) * 0.3)

    def test_validation(self):
        ok = self.stroke([(0.5, 0.5)])
        self.assertEqual(M.validate([dict(ok, pts=[[1.5, -0.2]])])[0][2], [(1.0, 0.0)], "points are clipped to the picture")
        for bad in (dict(ok, r=0.0001), dict(ok, r=0.9), dict(ok, r=float("nan")), dict(ok, r="big"), {"type": "brush", "pts": [[0.5, 0.5]]},
                    dict(ok, pts=[]), dict(ok, pts=None), dict(ok, pts=[[float("nan"), 0.5]]), dict(ok, pts=[["a", 0.5]]), dict(ok, pts=[[0.5]]),
                    dict(ok, pts=[[0.5, 0.5]] * (M.MAX_BRUSH_POINTS + 1))):
            with self.assertRaises(M.Rejected, msg=str(bad)[:60]):
                M.validate([bad])
        self.assertEqual(len(M.validate([dict(ok, pts=[[0.5, 0.5]] * M.MAX_BRUSH_POINTS)])[0][2]), M.MAX_BRUSH_POINTS)


class ManualFiles(Base):
    ID, JOB = "b" * 40, "0123456789abcdef"

    def test_what_can_be_removed(self):
        for ok in (f"manual/bb/bb/{self.ID}.jpg", f"manual/bb/bb/{self.ID}.mp4", f"manual/bb/bb/{self.ID}.{self.JOB}.mp4"):
            M.check_removable(ok)
        for bad in (f"aa/aa/{'a' * 64}", f"aa/aa/{'a' * 64}.regional.jpg", f"aa/aa/{'a' * 64}.regional.mp4", f"aa/aa/{'a' * 64}.jpg",
                    f"manual/bb/bb/{self.ID}.mp4/../x", f"manual/../{self.ID}.mp4", f"manual/bb/bb/{self.ID}.xyz.mp4", "manual/", "", None,
                    f"manual/bb/bb/{self.ID}.{self.JOB}.jpg", f"review/{'a' * 64}/figures.json"):
            with self.assertRaises(M.Rejected, msg=str(bad)):
                M.check_removable(bad)

    def test_commit_only_a_video_in_progress_to_its_own_final_name(self):
        tmp, final = f"manual/bb/bb/{self.ID}.{self.JOB}.mp4", f"manual/bb/bb/{self.ID}.mp4"
        M.check_commit(tmp, final)
        for src, dst in ((final, final), (tmp, tmp), (tmp, f"manual/bb/bb/{'c' * 40}.mp4"), (tmp, f"manual/bb/cc/{self.ID}.mp4"),
                         (f"aa/aa/{'a' * 64}.regional.mp4", final), (tmp, f"aa/aa/{'a' * 64}.regional.mp4"), (None, final), (tmp, None)):
            with self.assertRaises(M.Rejected, msg=f"{src} -> {dst}"):
                M.check_commit(src, dst)

    def test_remove_and_commit_work_on_files(self):
        tmp = os.path.join(self.dir, "t.mp4")
        final = os.path.join(self.dir, "f.mp4")
        with open(tmp, "wb") as fh:
            fh.write(b"video")
        with open(final, "wb") as fh:
            fh.write(b"old")
        M.commit(tmp, final)
        self.assertFalse(os.path.exists(tmp))
        with open(final, "rb") as fh:
            self.assertEqual(fh.read(), b"video")
        with self.assertRaises(M.Rejected):
            M.commit(tmp, final)             # the rendered video is not there: the old version must stay untouched
        with open(final, "rb") as fh:
            self.assertEqual(fh.read(), b"video")
        self.assertTrue(M.remove(final))
        self.assertFalse(M.remove(final))


class Pictures(Base):
    def shape(self):
        return [{"type": "rect", "x": 0.1, "y": 0.1, "w": 0.3, "h": 0.3}]

    def test_exif_orientation_is_applied_like_a_browser_does(self):
        im = Image.fromarray(noise_picture(300, 200))
        ex = Image.Exif()
        ex[0x0112] = 6                                       # rotate 90 clockwise when displayed: the upright picture is 200 x 300
        p = os.path.join(self.dir, "rot.jpg")
        im.save(p, "JPEG", exif=ex)
        res = M.render(p, self.out, self.shape())
        self.assertEqual((res["width"], res["height"]), (200, 300))
        with Image.open(self.out) as o:
            self.assertEqual(o.size, (200, 300))

    def test_large_pictures_are_reduced_small_ones_are_not_enlarged(self):
        res = M.render(self.save_source(noise_picture(3000, 2000)), self.out, self.shape(), max_side=1024)
        self.assertEqual((res["width"], res["height"]), (1024, 683))
        res = M.render(self.save_source(noise_picture(300, 200), "small.png"), self.out, self.shape(), max_side=2560)
        self.assertEqual((res["width"], res["height"]), (300, 200))
        res = M.render(self.save_source(noise_picture(300, 200), "small2.png"), self.out, self.shape(), max_side=10)   # clamped to the minimum
        self.assertEqual((res["width"], res["height"]), (300, 200))

    def test_transparent_png_is_flattened_on_white(self):
        rgba = np.zeros((100, 100, 4), np.uint8)
        rgba[..., :3] = 0                                    # black stored under full transparency
        p = os.path.join(self.dir, "t.png")
        Image.fromarray(rgba).save(p)
        M.render(p, self.out, [{"type": "rect", "x": 0.0, "y": 0.0, "w": 0.1, "h": 0.1}])
        out = np.asarray(Image.open(self.out).convert("RGB"))
        self.assertGreater(out[60:, 60:].mean(), 250, "transparent area is not white")

    def test_animated_picture_is_rejected(self):
        frames = [Image.fromarray(noise_picture(50, 50, s)) for s in (1, 2)]
        p = os.path.join(self.dir, "a.gif")
        frames[0].save(p, save_all=True, append_images=frames[1:], duration=100, loop=0)
        with self.assertRaises(M.Rejected):
            M.render(p, self.out, self.shape())
        self.assertFalse(os.path.exists(self.out))

    def test_not_a_picture_leaves_no_file(self):
        p = os.path.join(self.dir, "bad.jpg")
        with open(p, "wb") as fh:
            fh.write(b"not a picture")
        with self.assertRaises(Exception):
            M.render(p, self.out, self.shape())
        self.assertFalse(os.path.exists(self.out))
        self.assertFalse(os.path.exists(self.out + ".tmp"))

    def test_quality_outside_the_shapes_is_kept(self):
        yy, xx = np.mgrid[0:400, 0:600]
        smooth = np.stack([xx * 255 // 600, yy * 255 // 400, (xx + yy) * 255 // 1000], axis=2).astype(np.uint8)   # a photo-like gradient
        out, _ = self.render(smooth, [{"type": "ellipse", "x": 0.4, "y": 0.4, "w": 0.2, "h": 0.2}])
        mask = np.ones((400, 600), bool)
        mask[150:250, 220:380] = False
        mse = np.mean((out.astype(float) - smooth.astype(float))[mask] ** 2)
        psnr = 10 * np.log10(255 ** 2 / mse)
        self.assertGreater(psnr, 38, f"PSNR {psnr:.1f} dB outside the shape")

    def test_icc_profile_is_kept(self):
        im = Image.fromarray(noise_picture(100, 100))
        icc = b"\x00\x00\x02\x0cmntrRGB XYZ " + b"\x00" * 200   # not a usable profile, only bytes that must pass through untouched
        p = os.path.join(self.dir, "icc.jpg")
        im.save(p, "JPEG", icc_profile=icc)
        M.render(p, self.out, self.shape())
        with Image.open(self.out) as o:
            self.assertEqual(o.info.get("icc_profile"), icc)

    def test_output_is_written_atomically(self):
        M.render(self.save_source(noise_picture(80, 80)), self.out, self.shape())
        self.assertTrue(os.path.exists(self.out))
        self.assertFalse(os.path.exists(self.out + ".tmp"))
        os.chmod(os.path.dirname(self.out), 0o755)


if __name__ == "__main__":
    unittest.main()

"""Tests of the manual blur renderer for videos (moderation/app/manual_video.py). No models needed; needs ffmpeg. Run in the moderation image:
    docker run --rm -u 0 --entrypoint python -v "$PWD/moderation/app:/app:ro" -v "$PWD/moderation/tests:/t:ro" -v "$PWD/tests/fixtures:/fx:ro" \
        -e FIXTURES=/fx thechannel-moderation /t/test_manual_video.py -v
(The fixtures are the values scipy and the Go package compute: the smooth movement must be the same in all three places.)"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.environ.get("APP_DIR", "/app" if os.path.isdir("/app") else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app")))
import manual_image as MI  # noqa: E402
import manual_video as MV  # noqa: E402

FIXTURES = os.environ.get("FIXTURES", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tests", "fixtures"))
JOB = "0123456789abcdef"
ID = "b" * 40
W, H, FPS = 320, 240, 25


def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def make_video(path, secs=6, w=W, h=H, fps=FPS, audio="aac", sine=True):
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate={fps}:duration={secs}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={secs}", "-c:a", audio]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-shortest", path]
    run(cmd)


def streams(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,duration,r_frame_rate,width,height", "-of", "json", path],
                         capture_output=True, text=True)
    return {s["codec_type"]: s for s in json.loads(out.stdout)["streams"]}


def frames(path, w=W, h=H, fps=FPS, upto=None):
    out = []
    for i, f in enumerate(MV.read_frames(path, fps, w, h)):
        if upto is not None and i > upto:
            break
        out.append(f)
    return out


def detail(a):
    return MV._detail(a)


def box_px(box, w=W, h=H):
    return int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="mv-")
        self.src = os.path.join(self.dir, "src.mp4")
        make_video(self.src)
        self.out = os.path.join(self.dir, "manual", "bb", "bb", f"{ID}.{JOB}.mp4")
        self.job = MV.register(JOB)

    def render(self, tracks, **kw):
        return MV.render(self.src, self.out, tracks, self.job, **kw)

    def region_detail(self, path, frame_no, box, **kw):
        f = frames(path, upto=frame_no, **kw)[frame_no]
        x1, y1, x2, y2 = box_px(box)
        return detail(f[y1:y2, x1:x2])


def rect(keys, end=None, interp="pchip", kind="rect"):
    t = {"type": kind, "keys": [{"t": k[0], "x": k[1], "y": k[2], "w": k[3], "h": k[4]} for k in keys], "interp": interp}
    if end is not None:
        t["end"] = end
    return t


class Shared(unittest.TestCase):
    @unittest.skipUnless(os.path.exists(os.path.join(FIXTURES, "pchip_vectors.json")), "fixtures not mounted")
    def test_pchip_matches_scipy(self):
        with open(os.path.join(FIXTURES, "pchip_vectors.json"), encoding="utf-8") as fh:
            fx = json.load(fh)
        self.assertGreaterEqual(len(fx["cases"]), 8)
        for c in fx["cases"]:
            d = MV.pchip_derivatives(c["t"], c["y"])
            tr = MV.Track("rect", [(t, y, 0.1, 0.1, 0.1) for t, y in zip(c["t"], c["y"])], None, "pchip")
            tr.ders[0] = d
            for at, want in zip(c["at"], c["expect"]):
                got = tr._eval(0, at, c["t"][0], c["t"][-1])
                self.assertAlmostEqual(got, want, places=11, msg=f"{c['name']} at {at}")

    @unittest.skipUnless(os.path.exists(os.path.join(FIXTURES, "track_vectors.json")), "fixtures not mounted")
    def test_tracks_match_the_go_reference(self):
        with open(os.path.join(FIXTURES, "track_vectors.json"), encoding="utf-8") as fh:
            fx = json.load(fh)
        for c in fx["cases"]:
            tr = MV.validate_tracks([c["track"]], 1000)[0]
            for at, want in zip(c["at"], c["expect"]):
                got = tr.box_at(at, c["pad"])
                if want[0] == -1:
                    self.assertIsNone(got, f"{c['name']} at {at}")
                else:
                    self.assertIsNotNone(got, f"{c['name']} at {at}")
                    for a, b in zip(got, want):
                        self.assertAlmostEqual(a, b, places=9, msg=f"{c['name']} at {at}")


class Validation(unittest.TestCase):
    def bad(self, tracks, duration=10):
        with self.assertRaises(MI.Rejected):
            MV.validate_tracks(tracks, duration)

    def test_rejects(self):
        k = (1, 0.1, 0.1, 0.2, 0.2)
        self.bad(None)
        self.bad([])
        self.bad([rect([k], kind="star")])
        self.bad([rect([k], interp="bezier")])
        self.bad([rect([])])
        self.bad([rect([(3, 0.1, 0.1, 0.2, 0.2), (1, 0.1, 0.1, 0.2, 0.2)])])
        self.bad([rect([k, (1.0004, 0.1, 0.1, 0.2, 0.2)])])
        self.bad([rect([(-1, 0.1, 0.1, 0.2, 0.2)])])
        self.bad([rect([(11, 0.1, 0.1, 0.2, 0.2)])], duration=10)          # after the end of this video
        self.bad([rect([(1, 0.1, 0.1, 0.0001, 0.2)])])
        self.bad([rect([(1, 1.4, 0.1, 0.2, 0.2)])])
        self.bad([rect([(1, float("nan"), 0.1, 0.2, 0.2)])])
        self.bad([rect([k], end=0.5)])
        self.bad([rect([k])] * (MV.MAX_TRACKS + 1))
        self.bad([rect([(i * 0.01, 0.1, 0.1, 0.2, 0.2) for i in range(MV.MAX_KEYS + 1)])])
        self.assertEqual(len(MV.validate_tracks([rect([k])] * MV.MAX_TRACKS, 10)), MV.MAX_TRACKS)

    def test_an_end_after_the_video_is_cut_to_its_length(self):
        t = MV.validate_tracks([rect([(1, 0.1, 0.1, 0.2, 0.2)], end=99)], 6)[0]
        self.assertEqual(t.end, 6)

    def test_paths(self):
        h64, h40 = "a" * 64, "b" * 40
        MV.check_paths(f"aa/aa/{h64}", "files", f"manual/bb/bb/{h40}.{JOB}.mp4", JOB)
        MV.check_paths(f"aa/aa/{h64}.regional.mp4", "blurred", f"manual/bb/bb/{h40}.{JOB}.mp4", JOB)
        for base, root, out, job in [
            (f"aa/aa/{h64}", "files", f"manual/bb/bb/{h40}.mp4", JOB),                       # the final name: only the backend makes that
            (f"aa/aa/{h64}", "files", f"manual/bb/bb/{h40}.{JOB}.mp4", "ffffffffffffffff"),   # another job's name
            (f"aa/aa/{h64}", "files", f"aa/aa/{h64}.regional.mp4", JOB),                     # would overwrite the regional video
            (f"aa/aa/{h64}", "files", f"manual/../{h40}.{JOB}.mp4", JOB),
            (f"aa/aa/{h64}.regional.jpg", "blurred", f"manual/bb/bb/{h40}.{JOB}.mp4", JOB),  # a picture is not a base for a video
            ("../../etc/passwd", "files", f"manual/bb/bb/{h40}.{JOB}.mp4", JOB),
            (f"aa/aa/{h64}", "elsewhere", f"manual/bb/bb/{h40}.{JOB}.mp4", JOB),
            (None, "files", f"manual/bb/bb/{h40}.{JOB}.mp4", JOB),
            (f"aa/aa/{h64}", "files", None, JOB),
        ]:
            with self.assertRaises(MI.Rejected, msg=f"{base} {root} {out}"):
                MV.check_paths(base, root, out, job)


class Rendering(Base):
    def test_the_box_is_blurred_where_and_when_it_should_be(self):
        # a box on the left from second 1 to 3 (frames 25..75), nothing before, a hold after, to the end of the video
        box = (0.1, 0.1, 0.4, 0.5)   # x1, y1, x2, y2
        res = self.render([rect([(1, 0.1, 0.1, 0.3, 0.4), (3, 0.1, 0.1, 0.3, 0.4)])])
        self.assertEqual((res["width"], res["height"]), (W, H))
        self.assertAlmostEqual(res["duration"], 6.0, delta=0.1)
        self.assertGreater(res["samples_checked"], 0)
        base, out = frames(self.src), frames(self.out)
        x1, y1, x2, y2 = box_px(box)
        for fr in (30, 50, 70, 100, 140):
            self.assertLess(detail(out[fr][y1 + 4:y2 - 4, x1 + 4:x2 - 4]), detail(base[fr][y1 + 4:y2 - 4, x1 + 4:x2 - 4]) * 0.3, f"frame {fr} is not blurred")
        # before the start (minus the padding of 2 frames): the picture is only re-encoded
        for fr in (0, 10, 20):
            self.assertGreater(detail(out[fr][y1 + 4:y2 - 4, x1 + 4:x2 - 4]), detail(base[fr][y1 + 4:y2 - 4, x1 + 4:x2 - 4]) * 0.6, f"frame {fr} is blurred too early")
        # the padding: 2 frames before second 1 (frame 25) are blurred already
        for fr in (23, 24):
            self.assertLess(detail(out[fr][y1 + 4:y2 - 4, x1 + 4:x2 - 4]), detail(base[fr][y1 + 4:y2 - 4, x1 + 4:x2 - 4]) * 0.3, f"padding frame {fr}")
        # outside the box the video is the same
        diff = np.abs(out[60].astype(int) - base[60].astype(int)).mean(axis=2)
        self.assertLess(diff[:, 200:].mean(), 6)

    def test_the_end_second(self):
        self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)], end=2)])
        base, out = frames(self.src), frames(self.out)
        x1, y1, x2, y2 = box_px((0.1, 0.1, 0.4, 0.5))
        reg = lambda a, fr: detail(a[fr][y1 + 4:y2 - 4, x1 + 4:x2 - 4])   # noqa: E731
        self.assertLess(reg(out, 45), reg(base, 45) * 0.3, "still blurred at 1.8 s")
        self.assertLess(reg(out, 51), reg(base, 51) * 0.3, "the padding after the end (frames 50, 51, 52)")
        self.assertGreater(reg(out, 60), reg(base, 60) * 0.6, "still blurred after the end")
        self.assertGreater(reg(out, 140), reg(base, 140) * 0.6, "blurred at the end of the video")

    def test_the_box_moves_smoothly_between_keyframes(self):
        # from the left (x 0.05..0.25) at second 1 to the right (x 0.65..0.85) at second 4
        self.render([rect([(1, 0.05, 0.3, 0.2, 0.3), (4, 0.65, 0.3, 0.2, 0.3)])])
        base, out = frames(self.src), frames(self.out)
        mid = int(2.5 * FPS)
        tr = MV.validate_tracks([rect([(1, 0.05, 0.3, 0.2, 0.3), (4, 0.65, 0.3, 0.2, 0.3)])], 6)[0]
        b = tr.box_at(mid / FPS, 0)
        self.assertTrue(0.3 < b[0] < 0.45, f"the middle of the movement is in the middle: {b}")
        x1, y1, x2, y2 = box_px(b)
        self.assertLess(detail(out[mid][y1 + 3:y2 - 3, x1 + 3:x2 - 3]), detail(base[mid][y1 + 3:y2 - 3, x1 + 3:x2 - 3]) * 0.3)
        fx1, fy1, fx2, fy2 = box_px((0.05, 0.3, 0.25, 0.6))     # the first keyframe's place is not blurred any more
        self.assertGreater(detail(out[mid][fy1 + 3:fy2 - 3, fx1 + 3:fx2 - 3]), detail(base[mid][fy1 + 3:fy2 - 3, fx1 + 3:fx2 - 3]) * 0.6)

    def test_an_ellipse_leaves_the_corners_of_its_box(self):
        self.render([rect([(0, 0.2, 0.2, 0.6, 0.6)], kind="ellipse")])
        base, out = frames(self.src), frames(self.out)
        fr = 40
        cx1, cy1 = int(0.2 * W) + 2, int(0.2 * H) + 2                         # the top-left corner of the box, outside the ellipse
        # >= and not >: the corner of the synthetic test picture is flat (detail 0.0 in the source too), and a flat corner must not fail the test
        self.assertGreaterEqual(detail(out[fr][cy1:cy1 + 14, cx1:cx1 + 14]), detail(base[fr][cy1:cy1 + 14, cx1:cx1 + 14]) * 0.6)
        mx, my = int(0.5 * W), int(0.5 * H)
        self.assertLess(detail(out[fr][my - 20:my + 20, mx - 30:mx + 30]), detail(base[fr][my - 20:my + 20, mx - 30:mx + 30]) * 0.3)

    def test_the_audio_is_kept_and_in_step(self):
        res = self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)])])
        self.assertTrue(res["audio"])
        a, v = streams(self.out)["audio"], streams(self.out)["video"]
        self.assertEqual(a["codec_name"], "aac")
        self.assertAlmostEqual(float(a["duration"]), float(v["duration"]), delta=0.15)
        self.assertAlmostEqual(float(a["duration"]), 6.0, delta=0.15)

    def test_audio_that_is_not_aac_becomes_aac(self):
        make_video(self.src, audio="libmp3lame")
        self.assertEqual(streams(self.src)["audio"]["codec_name"], "mp3")
        self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)])])
        self.assertEqual(streams(self.out)["audio"]["codec_name"], "aac")

    def test_a_video_without_audio(self):
        make_video(self.src, audio=None)
        res = self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)])])
        self.assertFalse(res["audio"])
        self.assertNotIn("audio", streams(self.out))

    def test_a_60_fps_video_comes_out_at_30(self):
        make_video(self.src, secs=4, fps=60)
        res = self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)])])
        self.assertEqual(res["fps"], 30)
        self.assertAlmostEqual(res["duration"], 4.0, delta=0.1)
        self.assertEqual(streams(self.out)["video"]["r_frame_rate"], "30/1")

    def test_a_big_video_is_reduced_to_the_output_limit(self):
        make_video(self.src, secs=2, w=1920, h=1080)
        res = self.render([rect([(0, 0.1, 0.1, 0.3, 0.4)])])
        self.assertEqual((res["width"], res["height"]), (1280, 720))

    def test_progress_and_finish(self):
        make_video(self.src, secs=20)
        seen = []
        t = threading.Thread(target=lambda: self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)])]))
        t.start()
        while t.is_alive():
            seen.append(self.job.percent)
            time.sleep(0.05)
        t.join()
        self.assertEqual(self.job.percent, 100)
        self.assertEqual(MV.progress(JOB), {"percent": 100, "state": "done"})
        self.assertEqual(seen, sorted(seen), "the progress went backwards")
        self.assertTrue(any(0 < p < 100 for p in seen), f"no progress was seen: {seen[:10]}")

    def test_the_result_is_only_there_when_it_is_complete(self):
        self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)])])
        self.assertTrue(os.path.exists(self.out))
        self.assertFalse(os.path.exists(self.out + ".part"))


class Failures(Base):
    def assert_nothing_left(self):
        left = [f for _, _, fs in os.walk(os.path.join(self.dir, "manual")) for f in fs] if os.path.isdir(os.path.join(self.dir, "manual")) else []
        self.assertEqual(left, [], "files were left behind")

    def test_cancelled_in_the_middle(self):
        make_video(self.src, secs=60)
        errors = []

        def go():
            try:
                self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)])])
            except MV.Cancelled:
                errors.append("cancelled")
        t = threading.Thread(target=go)
        t.start()
        end = time.time() + 20
        while self.job.percent < 1 and time.time() < end:
            time.sleep(0.02)
        MV.cancel(JOB)
        t.join(30)
        self.assertEqual(errors, ["cancelled"])
        self.assertEqual(MV.progress(JOB)["state"], "cancelled")
        self.assertFalse(os.path.exists(self.out))
        self.assert_nothing_left()

    def test_a_cancel_that_arrives_before_the_request(self):
        MV.cancel("fedcba9876543210")
        job = MV.register("fedcba9876543210")
        self.assertTrue(job.cancel.is_set())
        with self.assertRaises(MV.Cancelled):
            MV.render(self.src, os.path.join(self.dir, "manual", "bb", "bb", f"{ID}.fedcba9876543210.mp4"), [rect([(1, 0.1, 0.1, 0.3, 0.4)])], job)

    def test_not_a_video(self):
        with open(self.src, "wb") as fh:
            fh.write(os.urandom(5000))
        with self.assertRaises(MI.Rejected):
            self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)])])
        self.assert_nothing_left()

    def test_a_video_that_is_too_long(self):
        old = MV.MAX_VIDEO_SEC
        MV.MAX_VIDEO_SEC = 3
        try:
            with self.assertRaises(MI.Rejected):
                self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)])])
        finally:
            MV.MAX_VIDEO_SEC = old
        self.assert_nothing_left()

    def test_a_time_after_the_end_of_the_video(self):
        with self.assertRaises(MI.Rejected):
            self.render([rect([(7, 0.1, 0.1, 0.3, 0.4)])])
        self.assert_nothing_left()

    def test_the_encoder_fails(self):
        old = MV.CRF
        MV.CRF = "not-a-number"
        try:
            with self.assertRaises(RuntimeError):
                self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)])])
        finally:
            MV.CRF = old
        self.assertEqual(MV.progress(JOB)["state"], "failed")
        self.assert_nothing_left()

    def test_a_render_that_misses_the_blur_is_not_handed_over(self):
        """The self-check: if the blur were not drawn (a bug), the result must not be published."""
        real = MI.apply_shapes
        MI.apply_shapes = lambda img, shapes: None
        try:
            with self.assertRaises(MV.SelfCheckFailed):
                self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)])])
        finally:
            MI.apply_shapes = real
        self.assertFalse(os.path.exists(self.out))
        self.assert_nothing_left()

    def test_a_render_that_changes_the_rest_of_the_picture_is_not_handed_over(self):
        real = MI.apply_shapes

        def wipe(img, shapes):
            real(img, shapes)
            img[:, int(img.shape[1] * 0.6):] = 0          # damages the right part of the frame
        MI.apply_shapes = wipe
        try:
            with self.assertRaises(MV.SelfCheckFailed):
                self.render([rect([(1, 0.1, 0.1, 0.3, 0.4)])])
        finally:
            MI.apply_shapes = real
        self.assertFalse(os.path.exists(self.out))

    def test_the_self_check_notices_a_truncated_result(self):
        info = MV.probe(self.src)
        with self.assertRaises(MV.SelfCheckFailed):
            MV.self_check(self.src, info, FPS, W, H, 400, {}, [])     # the plan says 16 s, the file is 6 s

    def test_the_stale_files_of_cut_off_renders_are_swept(self):
        d = os.path.join(self.dir, "manual", "cc", "cc")
        os.makedirs(d)
        old_job, new_job, final, part = (os.path.join(d, n) for n in (f"{'c' * 40}.{JOB}.mp4", f"{'c' * 40}.0000000000000001.mp4", f"{'c' * 40}.mp4", f"{'c' * 40}.{JOB}.mp4.part"))
        for p in (old_job, new_job, final, part):
            with open(p, "wb") as fh:
                fh.write(b"x")
        long_ago = time.time() - 7 * 3600
        for p in (old_job, final, part):
            os.utime(p, (long_ago, long_ago))
        removed = MV.sweep_stale(self.dir)
        self.assertEqual(removed, 2)
        self.assertFalse(os.path.exists(old_job) or os.path.exists(part))
        self.assertTrue(os.path.exists(new_job), "a render that may be running was removed")
        self.assertTrue(os.path.exists(final), "a finished manual video was removed")

    def test_it_runs_at_a_low_priority(self):
        if MV.shutil.which("nice"):
            self.assertEqual(MV._low(["ffmpeg"])[:3], ["nice", "-n", str(MV.NICE)])


if __name__ == "__main__":
    unittest.main()

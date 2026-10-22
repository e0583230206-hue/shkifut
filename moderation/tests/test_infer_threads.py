"""Regression test for RuntimeError "Infer Request is busy": the gender and body models (OpenVINO) used to share one infer request,
so two threads (an image check and a video check run at the same time by the service) collided. Run in the moderation image:
    docker run --rm -u 0 --entrypoint python -v "$PWD/moderation_models:/models:ro" -v "$PWD/moderation/app:/app:ro" \
        -v "$PWD/moderation/tests:/t:ro" thechannel-moderation /t/test_infer_threads.py -v
Needs the models in /models (the same files the service uses); the tests are skipped when they are missing."""
import os
import sys
import threading
import unittest

import numpy as np

sys.path.insert(0, "/app")
import analyzer as A  # noqa: E402

MODELS = os.environ.get("MODELS_DIR", "/models")
HAVE_OV = os.path.exists(os.path.join(MODELS, "gender_omz.xml")) and os.path.exists(os.path.join(MODELS, "par.xml"))


def picture(seed):
    return (np.random.RandomState(seed).rand(480, 848, 3) * 255).astype(np.uint8)


@unittest.skipUnless(HAVE_OV, "OpenVINO models not installed")
class InferRequestThreads(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.an = A.Analyzer(MODELS, 2, A.Thresholds())
        cls.img = picture(1)
        cls.face = (200, 100, 260, 170)
        cls.body = (100, 50, 300, 450)

    def hammer(self, calls, rounds=150):
        """Run every callable in its own thread, `rounds` times; return (results per callable, errors)."""
        results, errors = [[] for _ in calls], []

        def work(i, fn):
            for _ in range(rounds):
                try:
                    results[i].append(fn())
                except Exception as e:  # noqa: BLE001
                    errors.append(f"{type(e).__name__}: {e}")

        threads = [threading.Thread(target=work, args=(i, fn)) for i, fn in enumerate(calls)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        return results, errors

    def test_gender_and_body_from_several_threads(self):
        an = self.an
        results, errors = self.hammer([
            lambda: an.body.male_prob(self.img, self.body),
            lambda: an.gender.male_prob(self.img, self.face),
            lambda: an.body.male_prob(self.img, self.body),
            lambda: an.gender.male_prob(self.img, self.face),
        ])
        self.assertEqual(errors, [])
        # every thread must see the single-threaded answer (a shared request could also return another thread's output)
        want_body, want_gender = an.body.male_prob(self.img, self.body), an.gender.male_prob(self.img, self.face)
        for r in (results[0], results[2]):
            self.assertTrue(all(abs(v - want_body) < 1e-6 for v in r))
        for r in (results[1], results[3]):
            self.assertTrue(all(v == want_gender for v in r))

    def test_detect_all_from_two_threads(self):
        """What the service really does: an image and a video analysed at the same time."""
        an = self.an
        a, b = picture(2), picture(3)
        results, errors = self.hammer([lambda: len(an.detect_all(a)), lambda: len(an.detect_all(b))], rounds=40)
        self.assertEqual(errors, [])
        self.assertEqual(len(results[0]) + len(results[1]), 80)

    def test_each_thread_gets_its_own_request(self):
        m = self.an.body.model
        seen = []
        t = threading.Thread(target=lambda: (self.an.body.male_prob(self.img, self.body), seen.append(m.local.req)))
        t.start()
        t.join()
        self.an.body.male_prob(self.img, self.body)
        self.assertIsNot(seen[0], m.local.req)


if __name__ == "__main__":
    unittest.main()

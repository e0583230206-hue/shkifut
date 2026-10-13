"""Unit tests for the DECISION_V2 rules (Figure.decide). Run in the moderation image:
    docker run --rm --entrypoint python -v "$PWD/moderation/app:/app:ro" -v "$PWD/moderation/tests:/t:ro" thechannel-moderation /t/test_decision_v2.py -v
Automatic release must stay exactly as with the current rules; v2 only changes what stays blurred ("likely_man" goes to the queue)."""
import sys
import unittest

sys.path.insert(0, "/app")
import regional as R  # noqa: E402

LV = R.get_level("strict")


def fig(faces=(), body=(), small=0):
    f = R.Figure()
    for size, male in faces:
        f.add_face(([0, 0, size, size], 1.0, male, False))
    for _ in range(small):
        f.add_face(([0, 0, 20, 20], 1.0, None, True))
    for h, male in body:
        f.add_body(h, male)
    return f


def decide(f, v2):
    R.DECISION_V2 = v2
    f.__dict__.pop("_decision", None)
    try:
        return f.decide(LV)
    finally:
        R.DECISION_V2 = False


class DecisionV2(unittest.TestCase):
    def test_auto_release_is_unchanged(self):
        cases = [
            fig(faces=[(80, 0.97)] * 3, body=[(300, 0.8)]),        # confident man, body agrees
            fig(faces=[(40, 0.95)] * 3, body=[(300, 0.7)]),        # small faces, body agrees
            fig(body=[(300, 0.95)]),                               # very male body, no face
            fig(faces=[(80, 0.97)] * 3, body=[(300, 0.2)]),        # body says woman
            fig(faces=[(80, 0.3)] * 3),                            # face says woman
            fig(faces=[(70, 0.7)] * 2),                            # uncertain
            fig(),                                                 # nothing
        ]
        for c in cases:
            self.assertEqual(decide(c, True) == "man", decide(c, False) == "man")

    def test_clear_faces_over_several_sightings_are_a_likely_man(self):
        f = fig(faces=[(120, 1.0)] * 5, body=[(400, 0.30)])         # the body model alone calls this a woman
        self.assertEqual(decide(f, False), "woman")
        self.assertEqual(decide(f, True), "likely_man")

    def test_single_clear_sighting_is_not_enough(self):
        f = fig(faces=[(137, 0.99)], body=[(700, 0.225)])           # a woman the face model reads as male, one sighting
        self.assertEqual(decide(f, True), "uncertain_gender")

    def test_one_female_face_blocks_the_queue(self):
        f = fig(faces=[(120, 1.0)] * 5 + [(110, 0.2)], body=[(400, 0.44)])
        self.assertNotEqual(decide(f, True), "likely_man")

    def test_body_only_woman_needs_a_very_low_body_score(self):
        self.assertEqual(decide(fig(body=[(300, 0.10)]), True), "woman")
        self.assertEqual(decide(fig(body=[(300, 0.30)]), True), "uncertain_gender")
        self.assertEqual(decide(fig(), True), "person_without_clear_face")

    def test_faces_that_say_woman_stay_woman(self):
        self.assertEqual(decide(fig(faces=[(100, 0.1)] * 3, body=[(300, 0.9)]), True), "woman")

    def test_likely_man_is_never_visible(self):
        f = fig(faces=[(120, 1.0)] * 5, body=[(400, 0.44)])
        R.DECISION_V2 = True
        try:
            self.assertFalse(f.visible(LV, 1000))
        finally:
            R.DECISION_V2 = False

    def test_crowd_flag(self):
        crowd = [fig(small=2) for _ in range(12)] + [fig(faces=[(80, 0.95)] * 3)]
        self.assertEqual(R.review_flags(crowd, LV)["review_reasons"], ["crowd"])
        small_group = [fig(small=2) for _ in range(4)]
        self.assertFalse(R.review_flags(small_group, LV)["needs_review"])
        faces = [fig(faces=[(80, 0.95)] * 3) for _ in range(12)]
        self.assertFalse(R.review_flags(faces, LV)["needs_review"])


if __name__ == "__main__":
    unittest.main()

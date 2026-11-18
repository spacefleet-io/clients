"""@req INTG-SYNC-01 resume/watched thresholds and the op payloads the desktop reads."""
import json
import unittest

import _path  # noqa: F401
import progress as p


class ProgressRules(unittest.TestCase):
    def test_below_thresholds_writes_nothing(self):
        # @req INTG-SYNC-01: <2% and <15s keeps the previous resume
        r = p.evaluate_stop(10, 7200)
        self.assertFalse(r["write"])

    def test_keep_from_15_seconds(self):
        r = p.evaluate_stop(15, 7200)
        self.assertTrue(r["write"])
        self.assertFalse(r["completed"])

    def test_keep_from_2_percent(self):
        r = p.evaluate_stop(6, 200)  # 3% of a short clip
        self.assertTrue(r["write"])

    def test_completed_at_95_percent(self):
        r = p.evaluate_stop(950, 1000)
        self.assertTrue(r["completed"])
        self.assertTrue(p.is_completed(95, 950, 1000))
        self.assertFalse(p.is_completed(94.9, 949, 1000))

    def test_completed_past_credits_start(self):
        self.assertTrue(p.is_completed(86.7, 3120, 3600, credits_start=3100))
        self.assertFalse(p.is_completed(50, 1800, 3600, credits_start=3100))
        r = p.evaluate_stop(3120, 3600, credits_start=3100)
        self.assertTrue(r["completed"])

    def test_resume_candidate(self):
        self.assertIsNone(p.resume_candidate_seconds(0.0065, 1000))
        self.assertAlmostEqual(p.resume_candidate_seconds(1, 7200), 72.0)  # 1% of 2h = 72s
        self.assertIsNone(p.resume_candidate_seconds(96, 7200))
        self.assertIsNone(p.resume_candidate_seconds(50, 7200, credits_start=3000, position_seconds=3600))
        self.assertEqual(p.resume_candidate_seconds(50, 7200, position_seconds=3500), 3500)

    def test_bad_inputs(self):
        self.assertFalse(p.evaluate_stop(None, 100)["write"])
        self.assertFalse(p.evaluate_stop(5, 0)["write"])
        self.assertFalse(p.evaluate_stop(float("nan"), 100)["write"])

    def test_position_clamped_to_duration(self):
        r = p.evaluate_stop(1200, 1000)
        self.assertEqual(r["positionSeconds"], 1000)
        self.assertEqual(r["progressPct"], 100.0)


class PayloadShapes(unittest.TestCase):
    def test_episode_resume_setting_matches_desktop(self):
        s = p.episode_resume_setting("ep1", 42.5, "2026-01-01T00:00:00.000Z", 300.0, 700.0)
        self.assertEqual(s["key"], "episode_resume_v1:ep1")
        self.assertEqual(json.loads(s["value"]), {"progressPct": 42.5, "updatedAt": "2026-01-01T00:00:00.000Z", "positionSeconds": 300.0, "durationSeconds": 700.0})

    def test_movie_progress_payload(self):
        self.assertEqual(
            p.movie_progress_payload("m1", 10.0, "t"),
            {"mediaId": "m1", "progressPct": 10.0, "lastWatchedAt": "t", "updatedAt": "t"},
        )

    def test_show_aggregate_counts_every_aired_episode(self):
        # @req LIB-PROG-01: aired regular episodes decide; the special and the unaired episode never count
        episodes = [{"id": "e%d" % n, "season_number": 1, "air_date": "2020-01-%02d" % n} for n in range(1, 11)]
        episodes += [{"id": "sp", "season_number": 0, "air_date": "2020-02-01"}, {"id": "next", "season_number": 2, "air_date": "2099-01-01"}]
        resumes = {"e1": {"progressPct": 100, "updatedAt": "a"}, "e2": {"progressPct": 50, "updatedAt": "b"},
                   "sp": {"progressPct": 100, "updatedAt": "c"}}
        agg = p.show_aggregate(episodes, 11, resumes, today="2026-10-29")
        self.assertAlmostEqual(agg["progressPct"], 15.0)
        self.assertEqual((agg["total"], agg["source"], agg["lastWatchedAt"]), (10, "aired", "c"))

    def test_show_episode_total_fallbacks(self):
        # @req LIB-PROG-01: no air dates -> metadata count; nothing from the metadata -> the listed regular episodes
        undated = [(1, None), (1, None), (0, None)]
        self.assertEqual(p.show_episode_total(undated, 20, "2026-10-29"), (20, "metadata"))
        self.assertEqual(p.show_episode_total(undated, None, "2026-10-29"), (2, "episodes"))
        self.assertIsNone(p.show_episode_total([], None, "2026-10-29"))
        self.assertEqual(p.show_watched_pct([(1, 300)], 2), 50.0)


if __name__ == "__main__":
    unittest.main()

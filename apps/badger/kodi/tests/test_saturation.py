"""@req STOR-BW-07 @req STOR-BW-08 @req STOR-BW-09 @req PLAY-QUAL-07 what the addon does when a silo is saturated:
library reads open `library` sessions, a refusal / stop is a typed error, and the quality cap shapes the master."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _path  # noqa: E402,F401
import api
import hls
import library
import playback


def _traffic(**over):
    base = {"state": "high", "playbackBufferSeconds": 30, "saturated": True, "qualityCap": "480p", "playbackStopped": False}
    base.update(over)
    return base


def _body(error, traffic=None):
    return json.dumps({"error": error, "traffic": traffic or _traffic()}).encode("utf-8")


class RecordingApi:
    def __init__(self):
        self.downloads = []

    def download(self, key, purpose="playback"):
        self.downloads.append((key, purpose))
        return b"{}"


class LibraryReadsPurpose(unittest.TestCase):
    def test_op_payload_read_opens_a_library_session(self):
        recording = RecordingApi()
        library.LibraryStore._op_bytes(None, recording, {"objectKey": "library/ops/abc"})
        self.assertEqual(recording.downloads, [("library/ops/abc", "library")])


class TypedRefusals(unittest.TestCase):
    def test_free_playback_refused(self):
        with self.assertRaises(api.PlaybackRefusedError) as caught:
            api._raise_for(503, _body("free_playback_refused"))
        self.assertEqual(caught.exception.traffic, _traffic())
        self.assertIsInstance(caught.exception, api.PlaybackUnavailableError)

    def test_playback_stopped(self):
        with self.assertRaises(api.PlaybackStoppedError) as caught:
            api._raise_for(503, _body("playback_stopped", _traffic(playbackStopped=True)))
        self.assertTrue(caught.exception.traffic["playbackStopped"])

    def test_other_503_stays_a_plain_api_error(self):
        with self.assertRaises(api.ApiError) as caught:
            api._raise_for(503, json.dumps({"error": "storage_placement_unavailable"}).encode("utf-8"))
        self.assertNotIsInstance(caught.exception, api.PlaybackUnavailableError)

    def test_parse_traffic_rejects_malformed_reports(self):
        self.assertEqual(api.parse_traffic(_traffic(qualityCap=None, saturated=False))["qualityCap"], None)
        self.assertIsNone(api.parse_traffic(_traffic(qualityCap="720p")))
        self.assertIsNone(api.parse_traffic(_traffic(state="paused")))
        self.assertIsNone(api.parse_traffic(_traffic(saturated="yes")))
        self.assertIsNone(api.parse_traffic(None))

    def test_messages_do_not_promise_an_automatic_resume(self):
        stopped = playback.unavailable_message(api.PlaybackStoppedError(503, {"error": "playback_stopped"}))
        refused = playback.unavailable_message(api.PlaybackRefusedError(503, {"error": "free_playback_refused"}))
        self.assertIn("Press play again", stopped)
        self.assertIn("new playback is paused for free accounts", refused)
        for text in (stopped, refused):
            self.assertNotIn("resume", text.lower())
            self.assertNotIn("evening", text.lower())


class QualityCap(unittest.TestCase):
    FORMATS = [{"id": "f360", "quality": "360p"}, {"id": "f480", "quality": "480p"}, {"id": "f1080", "quality": "1080p"}, {"id": "f2160", "quality": "2160p"}]

    def ids(self, cap, formats=None):
        kept, stop = hls.apply_quality_cap(self.FORMATS if formats is None else formats, cap)
        return [f["id"] for f in kept], stop

    def test_free_cap_keeps_only_rungs_up_to_480p(self):
        self.assertEqual(self.ids("480p"), (["f360", "f480"], False))

    def test_free_cap_with_no_rung_that_low_stops(self):
        self.assertEqual(self.ids("480p", [{"id": "f720", "quality": "720p"}, {"id": "f1080", "quality": "1080p"}]), ([], True))

    def test_starter_and_standard_cap_keeps_rungs_up_to_1080p(self):
        self.assertEqual(self.ids("1080p"), (["f360", "f480", "f1080"], False))

    def test_paying_viewer_is_never_stopped_when_no_rung_is_low_enough(self):
        self.assertEqual(self.ids("1080p", [{"id": "f2160", "quality": "2160p"}]), (["f2160"], False))

    def test_no_cap_changes_nothing(self):
        self.assertEqual(self.ids(None), (["f360", "f480", "f1080", "f2160"], False))


if __name__ == "__main__":
    unittest.main()

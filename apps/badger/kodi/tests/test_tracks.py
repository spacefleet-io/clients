"""@req INTG-KODI-04 synced track preferences (track_prefs_v1 contract)."""
import json
import unittest

import _path  # noqa: F401
import tracks


class Tracks(unittest.TestCase):
    def test_language_variants_match(self):
        self.assertTrue(tracks.lang_equal("fre", "fra"))
        self.assertTrue(tracks.lang_equal("fr", "FRE"))
        self.assertTrue(tracks.lang_equal("eng", "en-US"))
        self.assertFalse(tracks.lang_equal("eng", "fre"))
        self.assertFalse(tracks.lang_equal("und", "und"))

    def test_find_stream(self):
        streams = [{"index": 0, "language": "eng"}, {"index": 1, "language": "fra"}]
        self.assertEqual(tracks.find_stream(streams, "fre"), 1)
        self.assertIsNone(tracks.find_stream(streams, "ger"))
        self.assertIsNone(tracks.find_stream(streams, None))

    def test_contract_language_table(self):
        for a, b in (("fre", "fra"), ("fr", "fra"), ("ger", "deu"), ("chi", "zh"), ("nob", "no"), ("rum", "ron"), ("per", "fa")):
            self.assertTrue(tracks.lang_equal(a, b), (a, b))
        self.assertEqual(tracks.norm_lang("fre"), "fr")
        self.assertEqual(tracks.norm_lang("xyz"), "xyz")
        self.assertEqual(tracks.norm_lang("und"), "")

    def test_parse_rejects_malformed(self):
        self.assertIsNone(tracks.parse("{"))
        self.assertIsNone(tracks.parse('{"audioLanguage": 3}'))
        self.assertIsNone(tracks.parse('{"subtitle": "on"}'))
        self.assertEqual(tracks.parse('{"audioLanguage":"fr","subtitle":"off","updatedAt":"x"}')["subtitle"], "off")

    def test_merge_is_read_modify_write_and_keeps_unknown_fields(self):
        cur = tracks.parse('{"audioLanguage":"en","subtitle":{"language":"en","forced":false},"extra":1,"updatedAt":"a"}')
        out = json.loads(tracks.merge(cur, audio="fre", updated_at="b"))
        self.assertEqual(out, {"audioLanguage": "fr", "subtitle": {"language": "en", "forced": False}, "extra": 1, "updatedAt": "b"})
        out = json.loads(tracks.merge(cur, subtitle="off", updated_at="c"))
        self.assertEqual(out["audioLanguage"], "en")
        self.assertEqual(out["subtitle"], "off")
        out = json.loads(tracks.merge(None, audio="eng", updated_at="d"))
        self.assertEqual(out, {"audioLanguage": "en", "subtitle": None, "updatedAt": "d"})

    def test_find_stream_prefers_forced_then_format(self):
        subs = [{"index": 0, "language": "eng", "isforced": True}, {"index": 1, "language": "eng", "isforced": False},
                {"index": 2, "language": "fre", "isforced": False, "format": "sup"}, {"index": 3, "language": "fre", "isforced": False, "format": "srt"}]
        self.assertEqual(tracks.find_stream(subs, "en", forced=False), 1)
        self.assertEqual(tracks.find_stream(subs, "en", forced=True), 0)
        self.assertEqual(tracks.find_stream(subs, "fr", forced=False, fmt="srt"), 3)
        self.assertEqual(tracks.find_stream(subs, "de"), None)


if __name__ == "__main__":
    unittest.main()

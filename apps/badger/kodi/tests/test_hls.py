"""@req INTG-QUAL-01 @req INTG-KODI-03 HLS playlist building and placement helpers."""
import unittest

import _path  # noqa: F401
import api
import hls


def _unit():
    chunks = [{"chunk_key": "media/p/c%d" % i, "start_seconds": i * 6.0, "size_bytes": 1000} for i in range(3)]
    return {
        "media": {"id": "M"},
        "ep": "_",
        "formats": [
            {"id": "f360", "quality": "360p", "init_key": "media/p/i360", "chunks": chunks, "duration_seconds": 18, "total_size": 9000, "codec_string": "avc1.4d401e"},
            {"id": "f1080", "quality": "1080p", "init_key": "media/p/i1080", "chunks": chunks, "duration_seconds": 18, "total_size": 90000, "codec_string": "avc1.640028"},
        ],
        "audio": [
            {"id": "aeng", "language": "eng", "label": "English", "is_default": 1, "init_key": "media/p/ia", "chunks": chunks, "codec_string": "mp4a.40.2"},
            {"id": "afre", "language": "fre", "label": "French", "is_default": 0, "init_key": "media/p/ia2", "chunks": chunks, "codec_string": "mp4a.40.2"},
        ],
    }


class Hls(unittest.TestCase):
    def test_master_has_every_quality_and_audio(self):
        # @req INTG-QUAL-01
        m = hls.build_master("http://h/s", _unit())
        self.assertEqual(m.count("#EXT-X-STREAM-INF"), 2)
        self.assertEqual(m.count("#EXT-X-MEDIA:TYPE=AUDIO"), 2)
        self.assertIn("video-f360.m3u8", m)
        self.assertIn("video-f1080.m3u8", m)
        self.assertIn('LANGUAGE="fre"', m)
        self.assertIn("DEFAULT=YES", m)

    def test_bandwidth_from_size_not_bogus_bitrate(self):
        self.assertEqual(hls.format_bandwidth({"total_size": 9000, "duration_seconds": 18, "bitrate_kbps": 8}), 4000)
        self.assertEqual(hls.format_bandwidth({"bitrate_kbps": 2000}), 2000000)

    def test_track_playlist_vod_with_map_and_durations(self):
        # @req INTG-KODI-03
        u = _unit()
        pl = hls.build_track_playlist("http://h/s", u["formats"][0]["init_key"], u["formats"][0]["chunks"], 18)
        self.assertIn("#EXT-X-PLAYLIST-TYPE:VOD", pl)
        self.assertIn("#EXT-X-ENDLIST", pl)
        self.assertEqual(pl.count("#EXTINF:6.000"), 3)
        self.assertIn('#EXT-X-MAP:URI="http://h/s/o/media%2Fp%2Fi360.mp4"', pl)
        self.assertIn("media%2Fp%2Fc2.m4s", pl)

    def test_implausible_last_segment_clamped(self):
        chunks = [{"start_seconds": i * 6.0} for i in range(3)]
        d = hls.segment_durations(chunks, 12015)
        self.assertEqual(d[:2], [6.0, 6.0])
        self.assertEqual(d[2], 6.0)

    def test_subtitle_filename(self):
        self.assertEqual(hls.subtitle_filename({"id": "s1", "language": "eng", "format": "srt"}), "sub-s1.eng.srt")
        self.assertIsNone(hls.subtitle_filename({"id": "s1", "language": "eng", "format": "weird"}))


class Placement(unittest.TestCase):
    def test_fnv1a64_vectors(self):
        self.assertEqual(api.fnv1a64(""), 0xcbf29ce484222325)
        self.assertEqual(api.fnv1a64("a"), 0xaf63dc4c8601ec8c)

    def test_pinned_and_rendezvous(self):
        policy = {"seed": "s", "epoch": 1, "shards": [{"id": "A", "status": "active"}, {"id": "B", "status": "active"}]}
        self.assertEqual(api.pick_placement_shard(policy, "shards/B/x")["id"], "B")
        a = api.pick_placement_shard(policy, "lib/object")
        self.assertEqual(a, api.pick_placement_shard(policy, "lib/object"))

    def test_keys(self):
        self.assertEqual(api.sharded_object_key("A", "k"), "shards/A/k")
        self.assertEqual(api.sharded_object_key("A", "shards/B/k"), "shards/B/k")

    def test_state_hash_chain(self):
        h1 = api.next_state_hash(None, "op", b"x")
        self.assertEqual(len(h1), 64)
        self.assertNotEqual(h1, api.next_state_hash(h1, "op", b"x"))


if __name__ == "__main__":
    unittest.main()

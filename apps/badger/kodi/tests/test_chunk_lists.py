"""@req LIB-FMT-11 Packed chunk lists: the Python codec passes every shared vector (test-vectors/chunk-lists.json).

@why Kodi reads the same packed rows and op-stream-4 JSON the TS, Kotlin and Swift codecs write; one byte off and a
title stops playing on Kodi only. The vectors are the contract, so this test reads them from the definition package,
never a copy.
"""
import binascii
import json
import os
import sqlite3
import sys
import unittest

import _path  # noqa: F401
import chunk_lists as cl

VECTORS = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "packages",
                                        "library-db-definition", "test-vectors", "chunk-lists.json"))


def load_vectors():
    with open(VECTORS) as fh:
        return json.load(fh)


def dump(label, **values):
    sys.stderr.write("[test_chunk_lists] %s %s\n" % (label, json.dumps(values, default=str)[:2000]))


def hexed(data):
    return None if data is None else binascii.hexlify(bytes(data)).decode("ascii")


class ChunkListVectors(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.v = load_vectors()
        dump("vectors", path=VECTORS, explicit=len(cls.v["explicit"]), seeded=len(cls.v["seeded"]),
             seedKeys=len(cls.v["seedKeys"]), invalid=len(cls.v["invalid"]))

    def assert_packed(self, name, packed, expected):
        actual = {"placementId": packed["placementId"], "keyMode": packed["keyMode"], "count": packed["count"],
                  "keyDataHex": hexed(packed["keyData"]), "sizesHex": hexed(packed["sizes"]), "startsHex": hexed(packed["starts"])}
        want = {k: expected[k] for k in actual}
        dump(name + ":packed", actual=actual, want=want)
        self.assertEqual(actual, want, name)
        self.assertEqual(cl.chunk_list_to_json(packed), expected["json"], name)
        self.assertEqual(cl.chunk_list_keys(packed), expected["keys"], name)

    def test_explicit_vectors_pack_decode_and_round_trip(self):
        for v in self.v["explicit"]:
            with self.subTest(v["name"]):
                expected = v["expected"]
                self.assert_packed(v["name"], cl.pack_chunk_list(v["input"]["chunks"]), expected)
                unpacked = cl.unpack_chunk_list(cl.chunk_list_from_json(expected["json"]))
                want = [dict(c, startSeconds=expected["decodedStarts"][i]) for i, c in enumerate(v["input"]["chunks"])]
                dump(v["name"] + ":unpacked", unpacked=unpacked, want=want)
                self.assertEqual(unpacked, want)
                for got, chunk in zip(unpacked, v["input"]["chunks"]):
                    if chunk["startSeconds"] is None:
                        self.assertIsNone(got["startSeconds"])
                    else:
                        self.assertLessEqual(abs(got["startSeconds"] - chunk["startSeconds"]), 0.0005)
                self.assertEqual(cl.chunk_list_to_json(cl.pack_chunk_list(unpacked)), expected["json"])

    def test_seeded_vectors_pack_and_derive_keys(self):
        for v in self.v["seeded"]:
            with self.subTest(v["name"]):
                inp = v["input"]
                packed = cl.pack_seeded_chunk_list(inp["placementId"], binascii.unhexlify(inp["seedHex"]), inp["sizes"], inp["starts"])
                self.assert_packed(v["name"], packed, v["expected"])
                unpacked = cl.unpack_chunk_list(cl.chunk_list_from_json(v["expected"]["json"]))
                self.assertEqual([c["sizeBytes"] for c in unpacked], inp["sizes"])
                self.assertEqual([c["startSeconds"] for c in unpacked], v["expected"]["decodedStarts"])

    def test_seed_keys(self):
        for v in self.v["seedKeys"]:
            key = cl.seed_chunk_key(binascii.unhexlify(v["seedHex"]), v["placementId"], v["index"])
            dump("seed-key", index=v["index"], key=key, want=v["key"])
            self.assertEqual(key, v["key"])

    def test_invalid_vectors_are_refused_never_skipped(self):
        for v in self.v["invalid"]:
            with self.subTest(v["name"]):
                with self.assertRaises(cl.ChunkListFormatError) as ctx:
                    cl.unpack_chunk_list(cl.chunk_list_from_json(v["json"]))
                dump(v["name"] + ":refused", note=v["note"], error=str(ctx.exception))
                self.assertTrue(str(ctx.exception).startswith("CHUNK_LIST_FORMAT:"))

    def test_writer_errors(self):
        with self.assertRaises(cl.ChunkListFormatError):
            cl.pack_seeded_chunk_list("p", b"\0" * 8, [1], [None])
        with self.assertRaises(cl.ChunkListFormatError):
            cl.pack_chunk_list([{"key": "a\nb", "sizeBytes": 1, "startSeconds": None}])


class PackedLayoutStep(unittest.TestCase):
    """@req LIB-FMT-12 The layout step packs every old chunk list and empties the old tables; readers see the same chunks."""

    def setUp(self):
        self.c = sqlite3.connect(":memory:")
        self.c.execute("CREATE TABLE media_format_chunks (id TEXT PRIMARY KEY, format_id TEXT, chunk_key TEXT, order_index INTEGER, size_bytes INTEGER, start_seconds REAL)")
        self.c.execute("CREATE TABLE media_audio_chunks (id TEXT PRIMARY KEY, track_id TEXT, chunk_key TEXT, order_index INTEGER, size_bytes INTEGER, start_seconds REAL)")
        placement = "0b9a3c52-6f1e-4d7a-9c11-2e5f8d3a7b40"
        for i in range(3):
            self.c.execute("INSERT INTO media_format_chunks VALUES (?, 'f1', ?, ?, ?, ?)",
                           ("c%d" % i, "media/%s/0000000%d-1d2e-4f30-8a41-5c6d7e8f9a00" % (placement, i), 2 - i, 100 + i, 6.006 * (2 - i)))
        self.c.execute("INSERT INTO media_format_chunks VALUES ('x', 'f2', 'shards/s1/legacy', 0, NULL, NULL)")
        self.c.execute("INSERT INTO media_audio_chunks VALUES ('a', 't1', 'media/p/k', 0, 7, 0)")

    def test_layout_step_packs_and_reads_back(self):
        before = {kind: cl.load_chunk_rows(self.c, kind, ids) for kind, ids in ((1, ["f1", "f2"]), (2, ["t1"]))}
        stats = cl.convert_to_packed_layout(self.c, "2026-11-21T00:00:00.000Z")
        after = {kind: cl.load_chunk_rows(self.c, kind, ids) for kind, ids in ((1, ["f1", "f2"]), (2, ["t1"]))}
        dump("layout", stats=stats, before=before, after=after)
        self.assertEqual(stats, {"lists": 3, "rows": 5})
        self.assertEqual(self.c.execute("SELECT count(*) FROM media_format_chunks").fetchone()[0], 0)
        self.assertEqual(self.c.execute("SELECT count(*) FROM media_audio_chunks").fetchone()[0], 0)
        self.assertEqual(self.c.execute("SELECT owner_id, key_mode FROM media_chunk_lists ORDER BY owner_id").fetchall(),
                         [("f1", 1), ("f2", 0), ("t1", 0)])
        self.assertEqual(after, before)
        self.assertEqual(cl.convert_to_packed_layout(self.c, "later"), {"lists": 0, "rows": 0})


if __name__ == "__main__":
    unittest.main()

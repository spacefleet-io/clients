"""@req LIB-FMT-11[badger-kodi] @req LIB-FMT-12[badger-kodi]
Op stream 4 in the Kodi op SQL port: media.file.playback.set/delete, media.episode.delete, the version-4
media.upsert, and the translation of an old media.upsert once this copy holds the packed playback layout.

Fidelity proof: a v3 library (old per-chunk rows) and the same titles applied as translated ops onto a packed copy
read back as the SAME details (details.build_media_details), so Kodi plays a switched library unchanged.
"""
import copy
import json
import os
import sqlite3
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _path  # noqa: E402,F401
import chunk_lists  # noqa: E402
import details as D  # noqa: E402
import legacy_format  # noqa: E402
import ops_sql  # noqa: E402
import test_details as TD  # noqa: E402

VECTORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "packages",
                       "library-db-definition", "test-vectors", "chunk-lists.json")
T1 = "2026-03-04T05:06:07.000Z"
T0 = "2026-03-01T00:00:00.000Z"
T2 = "2026-03-09T00:00:00.000Z"


def phase(msg, *args):
    print("[test_ops_sql_v4] " + (msg % args if args else msg))


_GEN = TD._ids()  # one id stream for every op, like the add-on's uuid4 (a fresh one per op would collide)


def apply(conn, op, packed=True):
    """Like LibraryStore._apply_op: a table this trimmed schema lacks (editions, offline copies) is skipped."""
    for sql, params in ops_sql.build_op_statements(op, _GEN, packed=packed):
        try:
            conn.execute(sql, params)
        except sqlite3.OperationalError as exc:
            if "no such table" not in str(exc):
                raise


def packed_db(detail_list=()):
    conn = TD.make_db([])
    chunk_lists.convert_to_packed_layout(conn, T0)
    for details in detail_list:
        apply(conn, {"id": "op-" + details["id"], "type": "media.upsert", "createdAt": T0, "payload": {"details": details}})
    return conn


def list_rows(conn):
    return [tuple(r) for r in conn.execute("SELECT owner_id, owner_kind, count FROM media_chunk_lists ORDER BY owner_id")]


def clocks(conn):
    return [tuple(r) for r in conn.execute("SELECT media_id, file_id, updated_at FROM media_file_playback ORDER BY media_id, file_id")]


def set_op(media_id, file_id, updated_at, formats=(), audio=(), subtitles=(), chapters=()):
    def packed(owner):
        out = dict((k, v) for k, v in owner.items() if k != "chunks")
        out["chunkList"] = chunk_lists.chunk_list_to_json(chunk_lists.pack_chunk_list(owner["chunks"]))
        return out
    return {"id": "set-%s-%s-%s" % (media_id, file_id, updated_at), "type": "media.file.playback.set", "createdAt": updated_at,
            "payload": {"mediaId": media_id, "fileId": file_id, "updatedAt": updated_at,
                        "formats": [packed(f) for f in formats], "audioTracks": [packed(a) for a in audio],
                        "subtitles": list(subtitles), "chapters": list(chapters)}}


class PackedReadsLikeOld(unittest.TestCase):
    def tearDown(self):
        while TD._OPEN:
            TD._OPEN.pop().close()

    def test_a_translated_library_reads_back_the_same_details(self):
        # @test-id kodi-v4-translated-fidelity
        # @why the add-on must play a switched library exactly as before: same formats, chunks, tracks, chapters
        fixtures = [TD.movie_fixture(), TD.tv_fixture()]
        old = TD.make_db(fixtures)
        new = packed_db(copy.deepcopy(fixtures))
        phase("packed lists=%s clocks=%s", list_rows(new), clocks(new))
        self.assertEqual(new.execute("SELECT COUNT(*) FROM media_format_chunks").fetchone()[0], 0)
        self.assertEqual(new.execute("SELECT COUNT(*) FROM media_audio_chunks").fetchone()[0], 0)
        for fixture in fixtures:
            self.assertEqual(D.build_media_details(new, fixture["id"]), D.build_media_details(old, fixture["id"]))
        # one clock per file plus the no-file group, all at the details' clock
        self.assertEqual(clocks(new), [("movie-1", "", T1), ("movie-1", "file-m1", T1),
                                       ("tv-1", "", T1), ("tv-1", "file-e1", T1), ("tv-1", "file-e2", T1)])

    def test_the_layout_step_packs_an_old_library_without_changing_what_it_reads(self):
        # @test-id kodi-v4-layout-step
        # @why LIB-FMT-12: the step converts in place; every read keeps its answer and the step is idempotent
        fixtures = [TD.movie_fixture(), TD.tv_fixture()]
        conn = TD.make_db(fixtures)
        before = [D.build_media_details(conn, f["id"]) for f in fixtures]
        stats = chunk_lists.convert_to_packed_layout(conn, T0)
        phase("layout step stats=%s", stats)
        self.assertEqual(stats["lists"], (3 + 2) + (2 + 4))  # formats (movie, show) + audio tracks (movie, show)
        self.assertEqual([D.build_media_details(conn, f["id"]) for f in fixtures], before)
        self.assertEqual(chunk_lists.convert_to_packed_layout(conn, T0), {"lists": 0, "rows": 0})


class FilePlayback(unittest.TestCase):
    def setUp(self):
        self.show = TD.tv_fixture()
        self.conn = packed_db([copy.deepcopy(self.show)])

    def tearDown(self):
        while TD._OPEN:
            TD._OPEN.pop().close()

    def _e1_format(self, quality, chunks):
        return TD._fmt("tv-1", "file-e1", "fmt-e1", quality, "h264", True, chunks)

    def formats(self, file_id):
        return [tuple(r) for r in self.conn.execute("SELECT id, quality FROM media_formats WHERE file_id IS ? ORDER BY id", [file_id])]

    def test_a_set_replaces_one_file_and_leaves_the_others(self):
        # @test-id kodi-v4-playback-set
        new = self._e1_format("1080p", TD._chunks("new", 5))
        apply(self.conn, set_op("tv-1", "file-e1", T2, formats=[new]))
        phase("formats e1=%s e2=%s lists=%s clocks=%s", self.formats("file-e1"), self.formats("file-e2"),
              list_rows(self.conn), clocks(self.conn))
        self.assertEqual(self.formats("file-e1"), [("fmt-e1", "1080p")])
        self.assertEqual(self.formats("file-e2"), [("fmt-e2", "720p")])
        # the set names no audio/subtitles/chapters for file-e1: they are gone, file-e2's stay
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM media_audio_tracks WHERE file_id = 'file-e1'").fetchone()[0], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM media_audio_tracks WHERE file_id = 'file-e2'").fetchone()[0], 2)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM media_chapters").fetchone()[0], 0)
        self.assertEqual(chunk_lists.load_chunk_rows(self.conn, chunk_lists.OWNER_KIND_FORMAT, ["fmt-e1"])["fmt-e1"][4]["chunk_key"], "new-4")
        self.assertIn(("tv-1", "file-e1", T2), clocks(self.conn))

    def test_an_older_set_changes_nothing_and_an_equal_one_applies(self):
        # @test-id kodi-v4-playback-clock
        # @why LIB-SYNC-08: per-file last writer wins; a tie goes to the later arrival
        apply(self.conn, set_op("tv-1", "file-e1", T2, formats=[self._e1_format("1080p", TD._chunks("a", 2))]))
        apply(self.conn, set_op("tv-1", "file-e1", T0, formats=[self._e1_format("480p", TD._chunks("old", 2))]))
        phase("after older set: %s clocks=%s", self.formats("file-e1"), clocks(self.conn))
        self.assertEqual(self.formats("file-e1"), [("fmt-e1", "1080p")])
        self.assertIn(("tv-1", "file-e1", T2), clocks(self.conn))
        apply(self.conn, set_op("tv-1", "file-e1", T2, formats=[self._e1_format("2160p", TD._chunks("tie", 2))]))
        phase("after equal set: %s", self.formats("file-e1"))
        self.assertEqual(self.formats("file-e1"), [("fmt-e1", "2160p")])

    def test_the_no_file_group_is_its_own_clock(self):
        # @test-id kodi-v4-null-file-group
        # @why rows that name no file (a title-wide audio track or subtitle) form their own group, keyed '' in the clock
        audio = TD._audio("tv-1", None, None, "aud-none", "de", "Deutsch", False)
        sub = TD._sub("tv-1", None, None, "sub-none", "de", "Deutsch", "srt", False)
        apply(self.conn, set_op("tv-1", None, T2, audio=[audio], subtitles=[sub]))
        rows = lambda table: [r[0] for r in self.conn.execute("SELECT id FROM %s WHERE file_id IS NULL" % table)]  # noqa: E731
        phase("no-file audio=%s subs=%s clocks=%s", rows("media_audio_tracks"), rows("media_subtitles"), clocks(self.conn))
        self.assertEqual(rows("media_audio_tracks"), ["aud-none"])
        self.assertEqual(rows("media_subtitles"), ["sub-none"])
        self.assertIn("aud-none", [r[0] for r in list_rows(self.conn)])
        self.assertIn(("tv-1", "", T2), clocks(self.conn))
        apply(self.conn, {"id": "d", "type": "media.file.playback.delete", "payload": {"mediaId": "tv-1", "fileId": None}})
        self.assertEqual(rows("media_audio_tracks"), [])
        self.assertEqual(rows("media_subtitles"), [])
        self.assertNotIn("aud-none", [r[0] for r in list_rows(self.conn)])
        self.assertEqual([c for c in clocks(self.conn) if c[1] == ""], [])
        self.assertEqual(self.formats("file-e1"), [("fmt-e1", "720p")])

    def test_a_playback_delete_drops_one_file(self):
        # @test-id kodi-v4-playback-delete
        apply(self.conn, {"id": "d", "type": "media.file.playback.delete", "payload": {"mediaId": "tv-1", "fileId": "file-e2"}})
        phase("after delete: lists=%s clocks=%s", list_rows(self.conn), clocks(self.conn))
        self.assertEqual(self.formats("file-e2"), [])
        self.assertNotIn("fmt-e2", [r[0] for r in list_rows(self.conn)])
        self.assertNotIn("aud-e2-en", [r[0] for r in list_rows(self.conn)])
        self.assertEqual([c for c in clocks(self.conn) if c[1] == "file-e2"], [])
        self.assertEqual(self.formats("file-e1"), [("fmt-e1", "720p")])

    def test_an_episode_delete_takes_only_that_episode(self):
        # @test-id kodi-v4-episode-delete
        apply(self.conn, {"id": "e", "type": "media.episode.delete", "payload": {
            "mediaId": "tv-1", "episodeId": "ep-1", "seasonNumber": 1, "episodeNumber": 1, "fileIds": ["file-e1"]}})
        built = D.build_media_details(self.conn, "tv-1")
        phase("episodes=%s files=%s formats=%s", [e["id"] for e in built["episodes"]], [f["id"] for f in built["files"]],
              [f["id"] for f in built["formats"]])
        self.assertEqual([e["id"] for e in built["episodes"]], ["ep-2", "ep-3"])
        self.assertEqual([f["id"] for f in built["files"]], ["file-e2"])
        self.assertEqual([f["id"] for f in built["formats"]], ["fmt-e2"])
        self.assertEqual(sorted(t["id"] for t in built["audioTracks"]), ["aud-e2-en", "aud-e2-ja"])
        self.assertEqual([s["id"] for s in built["subtitles"]], ["sub-e2-en"])
        self.assertEqual([m["id"] for m in built["skipMarkers"]], [])
        self.assertEqual(sorted(r[0] for r in list_rows(self.conn)), ["aud-e2-en", "aud-e2-ja", "fmt-e2"])

    def test_a_media_delete_takes_the_packed_rows_too(self):
        # @test-id kodi-v4-media-delete
        apply(self.conn, {"id": "x", "type": "media.delete", "payload": {"mediaId": "tv-1"}})
        phase("after media.delete: lists=%s clocks=%s", list_rows(self.conn), clocks(self.conn))
        self.assertEqual(list_rows(self.conn), [])
        self.assertEqual(clocks(self.conn), [])

    def test_a_version_4_upsert_never_touches_playback(self):
        # @test-id kodi-v4-upsert-core-only
        core = dict((k, v) for k, v in copy.deepcopy(self.show).items() if k not in ops_sql.PLAYBACK_KEYS)
        core["title"] = "Breaking Bad (renamed)"
        core["updatedAt"] = T2
        before = list_rows(self.conn)
        apply(self.conn, {"id": "u4", "type": "media.upsert", "createdAt": T2, "payload": {"details": core}})
        built = D.build_media_details(self.conn, "tv-1")
        phase("title=%s formats=%s", built["title"], [f["id"] for f in built["formats"]])
        self.assertEqual(built["title"], "Breaking Bad (renamed)")
        self.assertEqual([f["id"] for f in built["formats"]], ["fmt-e2", "fmt-e1"])
        self.assertEqual(list_rows(self.conn), before)

    def test_an_old_upsert_without_playback_keeps_its_catalog_id(self):
        # @test-id kodi-v4-upsert-legacy-catalog
        # @why an op of stream v1-v2 with no playback key has the v4 shape; its legacy catalog keys are still read
        core = dict((k, v) for k, v in copy.deepcopy(self.show).items() if k not in ops_sql.PLAYBACK_KEYS + ("catalogId",))
        core[legacy_format.LEGACY_EXTERNAL_IDS_KEY] = {legacy_format.LEGACY_CATALOG_ID_SOURCE: 1396, "other": "x1"}
        legacy_member = {legacy_format.LEGACY_CATALOG_ID_KEY: 17419}
        core["cast"] = [dict(m, **legacy_member) for m in core.get("cast") or []][:1] or [dict({"personId": "p-1", "name": "B. Cranston"}, **legacy_member)]
        for member in core["cast"]:
            member.pop("catalogId", None)
        core["updatedAt"] = T2
        op = {"id": "u-old", "type": "media.upsert", "createdAt": T2, "payload": {"details": core}}
        self.assertFalse(ops_sql.is_v3_media_upsert(op))
        apply(self.conn, op)
        built = D.build_media_details(self.conn, "tv-1")
        phase("catalogId=%s cast=%s", built.get("catalogId"), [(m.get("name"), m.get("catalogId")) for m in built.get("cast") or []])
        self.assertEqual(built.get("catalogId"), 1396)
        self.assertEqual([m.get("catalogId") for m in built["cast"]], [17419])

    def test_a_translated_upsert_prunes_files_it_no_longer_names_unless_newer(self):
        # @test-id kodi-v4-translated-prune
        apply(self.conn, set_op("tv-1", "file-e2", "2027-01-01T00:00:00.000Z",
                                formats=[TD._fmt("tv-1", "file-e2", "fmt-e2", "720p", "av1", True, TD._chunks("e2n", 1))]))
        old = copy.deepcopy(self.show)
        old["updatedAt"] = T2
        old["files"] = [f for f in old["files"] if f["id"] == "file-e1"]
        for key in ("formats", "audioTracks", "subtitles", "subtitleTracks"):
            old[key] = [r for r in old[key] if r["fileId"] == "file-e1"]
        old["formats"] = [r for r in old["formats"] if r["fileId"] == "file-e1"]
        apply(self.conn, {"id": "v3", "type": "media.upsert", "createdAt": T2, "payload": {"details": old}})
        phase("after v3 upsert: e1=%s e2=%s clocks=%s", self.formats("file-e1"), self.formats("file-e2"), clocks(self.conn))
        # file-e2's clock (2027) is newer than the upsert: kept
        self.assertEqual(self.formats("file-e2"), [("fmt-e2", "720p")])
        self.assertEqual(self.formats("file-e1"), [("fmt-e1", "720p")])
        older = copy.deepcopy(old)
        older["updatedAt"] = "2027-06-01T00:00:00.000Z"
        apply(self.conn, {"id": "v3b", "type": "media.upsert", "createdAt": T2, "payload": {"details": older}})
        phase("after newer v3 upsert: e2=%s clocks=%s", self.formats("file-e2"), clocks(self.conn))
        self.assertEqual(self.formats("file-e2"), [])
        self.assertEqual([c for c in clocks(self.conn) if c[1] == "file-e2"], [])


class Refusals(unittest.TestCase):
    def test_v4_ops_need_the_packed_layout(self):
        # @test-id kodi-v4-layout-error
        # @why LIB-FMT-13: no v4 op exists before the switch; applying one to the old layout is a bug, not a skip
        for op in (set_op("m", "f", T1), {"id": "d", "type": "media.file.playback.delete", "payload": {"mediaId": "m", "fileId": "f"}},
                   {"id": "e", "type": "media.episode.delete", "payload": {"mediaId": "m", "episodeId": "e", "seasonNumber": 1,
                                                                            "episodeNumber": 1, "fileIds": []}}):
            with self.assertRaises(ops_sql.PlaybackLayoutError) as ctx:
                ops_sql.build_op_statements(op, TD._ids(), packed=False)
            phase("%s -> %s", op["type"], ctx.exception)
            self.assertTrue(str(ctx.exception).startswith("PLAYBACK_LAYOUT: "))

    def test_bad_shapes_are_refused(self):
        # @test-id kodi-v4-shape-error
        # @why LIB-OPS-01: a known op type with a shape no writer produces is refused, never stored half-readable
        fmt = TD._fmt("m", "other-file", "f1", "720p", "h264", True, TD._chunks("x", 1))
        bad = [
            set_op("m", "f", T1, formats=[fmt]),
            set_op("m", "f", T1, chapters=[{"id": "c", "formatId": "nope", "title": "t", "startSeconds": 0}]),
        ]
        broken = set_op("m", "f", T1, formats=[TD._fmt("m", "f", "f1", "720p", "h264", True, TD._chunks("x", 1))])
        broken["payload"]["formats"][0]["chunkList"]["count"] = 7
        bad.append(broken)
        packed_upsert = {"id": "u", "type": "media.upsert", "payload": {"details": {"id": "m", "formats": [{"id": "f", "chunkList": {}}]}}}
        bad.append(packed_upsert)
        for op in bad:
            with self.assertRaises(ops_sql.LibraryOpShapeError) as ctx:
                ops_sql.build_op_statements(op, TD._ids(), packed=True)
            phase("%s -> %s", op["type"], ctx.exception)
            self.assertTrue(str(ctx.exception).startswith("LIBRARY_OP_SHAPE: "))

    def test_an_unknown_op_type_raises(self):
        # @test-id kodi-v4-unknown-op
        with self.assertRaises(ops_sql.UnknownOpTypeError):
            ops_sql.build_op_statements({"id": "z", "type": "media.hologram.set", "payload": {}}, TD._ids(), packed=True)


class OpStreamVersions(unittest.TestCase):
    def test_writes_declare_4_only_once_switched(self):
        # @test-id kodi-v4-write-version
        # @why LIB-FMT-13: nothing writes op stream 4 before the account is switched
        got = dict((t, ops_sql.write_op_stream_version(t)) for t in (None, 0, 3, 4, 5))
        phase("write_op_stream_version: %s", got)
        self.assertEqual(got, {None: 3, 0: 3, 3: 3, 4: 4, 5: 4})
        self.assertEqual(ops_sql.READ_OP_STREAM_VERSION, 4)


class TranslationVectors(unittest.TestCase):
    """The shared vectors of translateV3MediaUpsert (ops.ts): every port gives the same op set."""

    def test_translation_vectors(self):
        # @test-id kodi-v4-translation-vectors
        with open(VECTORS) as fh:
            vectors = json.load(fh)
        cases = vectors["translations"]
        self.assertGreaterEqual(len(cases), 3)
        for case in cases:
            got = ops_sql.translate_v3_media_upsert(case["input"])
            guard = (ops_sql.is_v3_media_upsert(case["input"]), ops_sql.is_v3_media_upsert(got["upsert"]))
            phase("%s: %d sets, isV3 input/upsert=%s", case["name"], len(got["playbackSets"]), guard)
            # isV3MediaUpsert: the payload decides; the translated upsert is the v4 shape and never translates again
            self.assertEqual(guard, (True, False), case["name"])
            self.assertEqual(got, case["expected"], case["name"])


if __name__ == "__main__":
    unittest.main()

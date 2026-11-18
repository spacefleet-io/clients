"""@req INTG-SYNC-01 @req INTG-DEL-01 op SQL port + deletion cascade."""
import json
import sqlite3
import unittest

import _path  # noqa: F401
import ops_sql


def _ids():
    n = [0]

    def gen():
        n[0] += 1
        return "id%d" % n[0]
    return gen


class OpSql(unittest.TestCase):
    def setUp(self):
        self.c = sqlite3.connect(":memory:")
        self.c.execute("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)")
        self.c.execute("CREATE TABLE media_items (id TEXT PRIMARY KEY, progress_pct REAL, last_watched_at TEXT, updated_at TEXT)")

    def apply(self, op):
        for sql, params in ops_sql.build_op_statements(op, _ids()):
            self.c.execute(sql, params)

    def test_setting_set_replaces(self):
        # @req INTG-SYNC-01
        for v in ("a", "b"):
            self.apply({"type": "setting.set", "payload": {"key": "episode_resume_v1:e", "value": v, "updatedAt": "t"}})
        self.assertEqual(self.c.execute("SELECT value FROM app_settings").fetchall(), [("b",)])

    def test_media_progress_updates_row(self):
        self.c.execute("INSERT INTO media_items (id) VALUES ('m')")
        self.apply({"type": "media.progress", "payload": {"mediaId": "m", "progressPct": 12.5, "lastWatchedAt": "L", "updatedAt": "U"}})
        # progress has its own clock (last_watched_at): updated_at stays the core metadata clock (LIB-SYNC-08)
        self.assertEqual(self.c.execute("SELECT progress_pct, last_watched_at, updated_at FROM media_items").fetchone(), (12.5, "L", None))

    def test_media_delete_cascades_every_table_group(self):
        # @req INTG-DEL-01: the media.delete op removes the item and all dependent rows
        stmts = ops_sql.build_op_statements({"type": "media.delete", "payload": {"mediaId": "M"}}, _ids())
        sql = " ".join(s for s, _ in stmts)
        for table in ("media_items", "media_files", "media_formats", "media_format_chunks", "media_audio_tracks",
                      "media_audio_chunks", "media_subtitles", "media_episodes", "media_seasons", "media_skip_markers"):
            self.assertIn("DELETE FROM " + table, sql)
        for _, params in stmts:
            self.assertEqual(params, ["M"])

    def test_media_upsert_writes_the_ocr_twin_link(self):
        # PLAY-TRACK-05 (OCR twins): the twin keeps its link to the picture track through a Kodi re-save
        details = {"id": "M", "updatedAt": "U", "subtitles": [
            {"id": "pic", "language": "fr", "label": "FR", "objectKey": "k1", "format": "dvd_subtitle", "source": "upload"},
            {"id": "twin", "language": "fr", "label": "FR", "objectKey": "k2", "format": "srt", "source": "ocr",
             "derivedFromSubtitleId": "pic"}]}
        stmts = ops_sql.build_op_statements({"type": "media.upsert", "payload": {"details": details}}, _ids())
        inserts = [p for s, p in stmts if s.startswith("INSERT OR REPLACE INTO media_subtitles")]
        self.assertEqual([(p[0], p[-1]) for p in inserts], [("pic", None), ("twin", "pic")])

    def test_media_upsert_keeps_the_episode_ids_it_is_sent(self):
        # @req LIB-SHOW-01[badger-kodi]: a refreshed show arrives with its stored episode ids plus the new
        # episodes; the add-on writes exactly those ids, so resume points keyed by episode id stay attached
        episodes = [
            {"id": "ep-s1e1", "seasonNumber": 1, "episodeNumber": 1, "name": "Pilot"},
            {"id": "ep-s1e2", "seasonNumber": 1, "episodeNumber": 2, "name": "Second"},
            {"id": "ep-s2e1", "seasonNumber": 2, "episodeNumber": 1, "name": "New season"},
        ]
        details = {"id": "M", "type": "tv", "updatedAt": "U", "episodes": episodes}
        stmts = ops_sql.build_op_statements({"type": "media.upsert", "payload": {"details": details}}, _ids())
        inserts = [p for s, p in stmts if s.startswith("INSERT OR REPLACE INTO media_episodes")]
        print("[LIB-SHOW-01] kodi episode inserts", inserts)
        self.assertEqual([(p[0], p[2], p[3]) for p in inserts], [("ep-s1e1", 1, 1), ("ep-s1e2", 1, 2), ("ep-s2e1", 2, 1)])

    def test_media_upsert_keeps_preview_sheets_a_writer_did_not_send(self):
        # MPV-PREV-01, mirrors ops.ts: a format without `previewSheets` keeps the stored record (by id, else by
        # file + quality); an explicit value (dict or None) wins; rows the payload drops are deleted.
        tag = "[KODI-OPS-PREV-SHEETS:%s]"
        self.c.execute("CREATE TABLE media_formats (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, file_id TEXT NOT NULL, "
                       "quality TEXT NOT NULL, codec TEXT NOT NULL, codec_string TEXT, bitrate_kbps INTEGER, init_key TEXT, "
                       "init_size INTEGER, duration_seconds REAL, total_size INTEGER, size_mb INTEGER NOT NULL, "
                       "is_source INTEGER NOT NULL DEFAULT 0, preview_sheets TEXT)")
        self.c.execute("CREATE TABLE media_format_chunks (id TEXT PRIMARY KEY, format_id TEXT, chunk_key TEXT, order_index INTEGER, "
                       "size_bytes INTEGER, start_seconds REAL)")
        self.c.execute("CREATE TABLE media_chapters (id TEXT PRIMARY KEY, format_id TEXT, title TEXT, start_seconds REAL)")
        previews = {"version": 1, "intervalSeconds": 5, "pictureWidth": 160, "pictureHeight": 90, "columns": 10, "rows": 10,
                    "pictureCount": 1, "sheets": [{"objectKey": "k/sheet-000", "sizeBytes": 9, "firstPicture": 0, "pictureCount": 1}]}

        def upsert(phase, source_previews, ids=("src", "low")):
            src = {"id": ids[0], "fileId": "f", "quality": "1080p", "codec": "h264", "sizeMb": 8, "isSource": True}
            if source_previews != "absent":
                src["previewSheets"] = source_previews
            low = {"id": ids[1], "fileId": "f", "quality": "360p", "codec": "h264", "sizeMb": 2}
            details = {"id": "M", "updatedAt": "U", "formats": [src, low]}
            for sql, params in ops_sql.build_op_statements({"type": "media.upsert", "payload": {"details": details}}, _ids()):
                if "media_formats" in sql:  # only the format statements: this DB has no other playback tables
                    self.c.execute(sql, params)
            rows = self.c.execute("SELECT id, preview_sheets FROM media_formats ORDER BY id").fetchall()
            print(tag % phase, rows)
            return {r[0]: None if r[1] is None else json.loads(r[1]) for r in rows}

        self.assertEqual(upsert("with", previews), {"src": previews, "low": None})
        self.assertEqual(upsert("absent", "absent"), {"src": previews, "low": None})
        self.assertEqual(upsert("renamed", "absent", ids=("src-2", "low-2")), {"src-2": previews, "low-2": None})
        self.assertEqual(upsert("null", None, ids=("src-2", "low-2")), {"src-2": None, "low-2": None})

    def test_unknown_type_raises(self):
        with self.assertRaises(ops_sql.UnknownOpTypeError):
            ops_sql.build_op_statements({"type": "nope", "payload": {}}, _ids())

    def _playlist_tables(self):
        self.c.execute("PRAGMA foreign_keys = ON")
        self.c.execute("CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT, is_system INTEGER NOT NULL DEFAULT 0, created_at TEXT)")
        self.c.execute("CREATE UNIQUE INDEX playlists_slug_idx ON playlists(slug)")
        self.c.execute("CREATE TABLE playlist_items (id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, "
                       "media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE, added_at TEXT, UNIQUE(playlist_id, media_id))")
        self.c.execute("INSERT INTO playlists VALUES ('favorites', 'Favorites', 'favorites', 1, 't')")
        self.c.execute("INSERT INTO media_items (id) VALUES ('m1')")
        self.c.execute("INSERT INTO playlist_items VALUES ('i1', 'favorites', 'm1', 't')")

    def test_item_add_for_an_unknown_playlist_is_dropped(self):
        # @bugfix @regression-proof @req LIB-SYNC-10[badger-kodi]: an older build's random-id Favorites must not stall sync
        self._playlist_tables()
        self.apply({"type": "playlist.item.add", "payload": {"id": "x", "playlistId": "63725383-desktop", "mediaId": "m1", "addedAt": "t"}})
        self.apply({"type": "playlist.item.add", "payload": {"id": "y", "playlistId": "favorites", "mediaId": "gone", "addedAt": "t"}})
        rows = self.c.execute("SELECT playlist_id, media_id FROM playlist_items").fetchall()
        print("[KODI-LIB-SYNC-10] items after unknown adds", rows)
        self.assertEqual(rows, [("favorites", "m1")])

    def test_system_playlist_create_keeps_the_existing_row_and_items(self):
        # @bugfix @regression-proof @req LIB-SYNC-10[badger-kodi]: a create under another id never replaces Favorites
        self._playlist_tables()
        self.apply({"type": "playlist.create", "payload": {"id": "rand", "name": "Favorites", "slug": "favorites", "isSystem": True, "createdAt": "t2"}})
        playlists = self.c.execute("SELECT id, slug FROM playlists").fetchall()
        items = self.c.execute("SELECT playlist_id, media_id FROM playlist_items").fetchall()
        print("[KODI-LIB-SYNC-10] after old-build create", playlists, items)
        self.assertEqual(playlists, [("favorites", "favorites")])
        self.assertEqual(items, [("favorites", "m1")])


if __name__ == "__main__":
    unittest.main()

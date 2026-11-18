"""Spec LIB-SYNC-08: an older change never overwrites a newer one (no @req tags: badger-kodi is not in that
rule's applies yet; the tests follow the rule anyway).

ops_sql mirrors the shared op builder (guarded media.upsert / media.progress / setting.set) and
LibraryStore._apply_op keeps an older media.upsert away from the metadata/playback tables too.
Each test prints phase markers prefixed with its id.
"""
import shutil
import sqlite3
import tempfile
import unittest

import _path  # noqa: F401
import library
import ops_sql

TEST_ID = "KODI-LIBRARY-UPDATED-AT-GUARDS-001"


def phase(msg, *args):
    print("[%s] %s" % (TEST_ID, msg % args if args else msg))


def _ids():
    n = [0]

    def gen():
        n[0] += 1
        return "id%d" % n[0]
    return gen


SCHEMA = (
    "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)",
    """CREATE TABLE media_items (
      id TEXT PRIMARY KEY, type TEXT, title TEXT, original_title TEXT, original_language TEXT, overview TEXT,
      year TEXT, rating REAL, poster_path TEXT, backdrop_path TEXT, added_at TEXT, updated_at TEXT NOT NULL,
      has_files INTEGER, progress_pct REAL, last_watched_at TEXT, total_episodes INTEGER,
      preferred_audio_language TEXT)""",
    "CREATE TABLE media_external_ids (id TEXT PRIMARY KEY, media_id TEXT, media_type TEXT, source TEXT, external_id TEXT)",
    "CREATE TABLE media_genres (id TEXT PRIMARY KEY, media_id TEXT, genre_id INTEGER)",
    "CREATE TABLE media_formats (id TEXT PRIMARY KEY, media_id TEXT, file_id TEXT, quality TEXT, codec TEXT, codec_string TEXT,"
    " bitrate_kbps INTEGER, size_mb REAL, init_key TEXT, init_size INTEGER, duration_seconds REAL, total_size INTEGER,"
    " is_source INTEGER)",
    "CREATE TABLE media_format_chunks (id TEXT PRIMARY KEY, format_id TEXT, chunk_key TEXT, order_index INTEGER,"
    " size_bytes INTEGER, start_seconds REAL)",
)


def upsert(updated_at, title="T", progress=0.0, last_watched=None, quality="1080p", genres=(28,), tmdb=120):
    return {
        "id": "op-" + updated_at,
        "type": "media.upsert",
        "payload": {"details": {
            "id": "m1", "type": "movie", "title": title, "originalTitle": None, "originalLanguage": None, "overview": None,
            "year": "2001", "rating": None, "posterPath": None, "backdropPath": None, "addedAt": "2026-10-01T00:00:00Z",
            "updatedAt": updated_at, "hasFiles": True, "progressPct": progress, "lastWatchedAt": last_watched,
            "totalEpisodes": None, "tmdbId": tmdb, "externalIds": {"tmdb": tmdb}, "genres": list(genres),
            "cast": [], "trailers": [], "seasons": [], "episodes": [], "files": [],
            "formats": [{"id": "f-" + quality, "fileId": None, "quality": quality, "codec": "h264", "chunks": []}],
            "audioTracks": [], "subtitles": [], "chapters": [], "skipMarkers": [],
        }},
    }


def progress_op(pct, at):
    return {"id": "p-" + at, "type": "media.progress",
            "payload": {"mediaId": "m1", "progressPct": pct, "lastWatchedAt": at, "updatedAt": at}}


def setting_op(value, at):
    return {"id": "s-" + at, "type": "setting.set", "payload": {"key": "k", "value": value, "updatedAt": at}}


class UpdatedAtGuards(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="sb-guards-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.store = library.LibraryStore(self.dir)
        self.addCleanup(self.store.close)
        self.c = self.store.conn()
        for ddl in SCHEMA:
            self.c.execute(ddl)

    def apply(self, op):
        self.store._apply_op(self.c, op)

    def media(self):
        return self.c.execute(
            "SELECT title, progress_pct, last_watched_at, updated_at, preferred_audio_language FROM media_items WHERE id = 'm1'"
        ).fetchone()

    def formats(self):
        return [r[0] for r in self.c.execute("SELECT quality FROM media_formats ORDER BY quality")]

    def test_older_upsert_is_ignored_in_every_table(self):
        phase("start: older upsert after a newer one")
        self.apply(upsert("2026-10-16T00:00:00Z", title="New", quality="2160p", genres=(35,)))
        self.apply(upsert("2026-10-15T00:00:00Z", title="Old", quality="720p", genres=(28,)))
        phase("state: media=%s formats=%s", tuple(self.media()), self.formats())
        self.assertEqual(self.media()["title"], "New")
        self.assertEqual(self.formats(), ["2160p"])
        self.assertEqual([r[0] for r in self.c.execute("SELECT genre_id FROM media_genres")], [35])

    def test_newer_and_equal_upserts_apply(self):
        self.apply(upsert("2026-10-15T00:00:00Z", title="A", quality="720p"))
        self.apply(upsert("2026-10-15T00:00:00Z", title="B", quality="1080p"))
        self.apply(upsert("2026-10-16T00:00:00Z", title="C", quality="2160p"))
        phase("state: media=%s formats=%s", tuple(self.media()), self.formats())
        self.assertEqual(self.media()["title"], "C")
        self.assertIn("2160p", self.formats())

    def test_resave_never_carries_progress_or_preferences(self):
        self.apply(upsert("2026-10-15T00:00:00Z"))
        self.c.execute("UPDATE media_items SET preferred_audio_language = 'fr' WHERE id = 'm1'")
        self.apply(progress_op(80.0, "2026-10-17T00:00:00Z"))
        # A newer details re-save that still carries the old progress value.
        self.apply(upsert("2026-10-18T00:00:00Z", title="Renamed", progress=0.0, last_watched=None))
        phase("state: media=%s", tuple(self.media()))
        self.assertEqual(tuple(self.media()), ("Renamed", 80.0, "2026-10-17T00:00:00Z", "2026-10-18T00:00:00Z", "fr"))

    def test_progress_has_its_own_clock_and_leaves_updated_at_alone(self):
        self.apply(upsert("2026-10-15T00:00:00Z"))
        self.apply(progress_op(50.0, "2026-10-17T00:00:00Z"))
        self.apply(progress_op(10.0, "2026-10-16T00:00:00Z"))  # older progress arrives late
        phase("state: media=%s", tuple(self.media()))
        self.assertEqual((self.media()["progress_pct"], self.media()["updated_at"]), (50.0, "2026-10-15T00:00:00Z"))
        self.apply(progress_op(60.0, "2026-10-17T00:00:00Z"))  # an equal clock applies: the later arrival wins the tie
        self.assertEqual(self.media()["progress_pct"], 60.0)

    def test_older_setting_is_ignored(self):
        self.apply(setting_op("new", "2026-10-19T00:00:00Z"))
        self.apply(setting_op("old", "2026-10-18T00:00:00Z"))
        rows = [tuple(r) for r in self.c.execute("SELECT value FROM app_settings WHERE key = 'k'")]
        self.assertEqual(rows, [("new",)])

    def test_ops_sql_alone_leaves_child_rows_of_a_newer_item_untouched(self):
        # Bypasses the _apply_op early skip: the SQL itself must keep an older upsert away from the child tables.
        self.apply(upsert("2026-10-16T00:00:00Z", title="New", genres=(35,), tmdb=5))
        for sql, params in ops_sql.build_op_statements(upsert("2026-10-15T00:00:00Z", title="Old", genres=(28,), tmdb=9), _ids()):
            try:
                self.c.execute(sql, params)
            except sqlite3.OperationalError as exc:
                if "no such table" not in str(exc):
                    raise
        genres = [r[0] for r in self.c.execute("SELECT genre_id FROM media_genres")]
        ext = [r[0] for r in self.c.execute("SELECT external_id FROM media_external_ids ORDER BY external_id")]
        phase("state: media=%s genres=%s external_ids=%s", tuple(self.media()), genres, ext)
        self.assertEqual(self.media()["title"], "New")
        self.assertEqual(genres, [35])
        self.assertEqual(set(ext), {"5"})

    def test_ops_sql_statements_carry_the_guards(self):
        sql = " ".join(s for s, _ in ops_sql.build_op_statements(upsert("2026-10-15T00:00:00Z"), _ids()))
        self.assertIn("ON CONFLICT(id) DO UPDATE", sql)
        self.assertIn("WHERE excluded.updated_at >= media_items.updated_at", sql)
        self.assertNotIn("progress_pct = excluded", sql)
        self.assertNotIn("INSERT OR REPLACE INTO media_items", sql)


if __name__ == "__main__":
    unittest.main()

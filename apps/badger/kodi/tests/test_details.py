"""@req INTG-DEL-01 an episode delete is written as the desktop-identical full media.upsert (without that episode's files).

Fidelity proof for resources/lib/details.py:
  fixture details --(ops_sql media.upsert)--> DB1 --build_media_details--> details'  (== fixture, modulo documented differences)
  details' --(ops_sql media.upsert)--> DB2, DB1 rows == DB2 rows (every table)
  with_track_defaults / without_episode_files == the desktop's SQL writes (setDefault*, deleteMediaFile) replayed on DB1.
"""
import copy
import json
import sqlite3
import unittest

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _path  # noqa: E402,F401
import details as D
import ops_sql

SCHEMA = """
CREATE TABLE media_items (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, original_title TEXT,
  original_language TEXT, overview TEXT, year TEXT, rating REAL, poster_path TEXT, backdrop_path TEXT,
  added_at TEXT NOT NULL, updated_at TEXT NOT NULL, has_files INTEGER NOT NULL DEFAULT 0,
  progress_pct REAL NOT NULL DEFAULT 0, last_watched_at TEXT, total_episodes INTEGER, preferred_audio_language TEXT);
CREATE TABLE media_genres (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, genre_id INTEGER NOT NULL);
CREATE INDEX media_genres_media_idx ON media_genres(media_id);
CREATE TABLE media_external_ids (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, media_type TEXT NOT NULL,
  source TEXT NOT NULL, external_id TEXT NOT NULL);
CREATE INDEX media_external_ids_media_idx ON media_external_ids(media_id);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT, is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL);
CREATE TABLE playlist_items (id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL, media_id TEXT NOT NULL,
  added_at TEXT NOT NULL, UNIQUE(playlist_id, media_id));
CREATE TABLE media_files (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, filename TEXT NOT NULL, season INTEGER,
  episode INTEGER, added_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'local', template_id TEXT);
CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, profile_path TEXT);
CREATE TABLE media_roles (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, person_id TEXT NOT NULL, role TEXT,
  order_index INTEGER);
CREATE TABLE people_external_ids (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, source TEXT NOT NULL,
  external_id TEXT NOT NULL);
CREATE TABLE media_file_desired_formats (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, file_id TEXT NOT NULL,
  quality TEXT NOT NULL, codec TEXT NOT NULL, bitrate_kbps INTEGER);
CREATE TABLE media_seasons (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, season_number INTEGER NOT NULL,
  title TEXT NOT NULL, overview TEXT, poster_path TEXT, episode_count INTEGER, air_date TEXT);
CREATE TABLE media_episodes (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, season_number INTEGER NOT NULL,
  episode_number INTEGER NOT NULL, title TEXT NOT NULL, overview TEXT, still_path TEXT, air_date TEXT);
CREATE TABLE media_trailers (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, provider TEXT NOT NULL, key TEXT NOT NULL,
  name TEXT, language TEXT);
CREATE TABLE media_skip_markers (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, episode_id TEXT, type TEXT NOT NULL,
  start_seconds REAL NOT NULL, end_seconds REAL NOT NULL, source TEXT NOT NULL, confidence REAL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE media_formats (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, file_id TEXT NOT NULL, quality TEXT NOT NULL,
  codec TEXT NOT NULL, codec_string TEXT, bitrate_kbps INTEGER, init_key TEXT, init_size INTEGER,
  duration_seconds REAL, total_size INTEGER, size_mb INTEGER NOT NULL, is_source INTEGER NOT NULL DEFAULT 0,
  preview_sheets TEXT);
CREATE TABLE media_format_chunks (id TEXT PRIMARY KEY, format_id TEXT NOT NULL, chunk_key TEXT NOT NULL,
  order_index INTEGER NOT NULL, size_bytes INTEGER, start_seconds REAL);
CREATE TABLE media_audio_tracks (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, file_id TEXT, episode_id TEXT,
  language TEXT NOT NULL, label TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
  codec TEXT, codec_string TEXT, init_key TEXT, init_size INTEGER, duration_seconds REAL, total_size INTEGER,
  created_at TEXT NOT NULL);
CREATE TABLE media_audio_chunks (id TEXT PRIMARY KEY, track_id TEXT NOT NULL, chunk_key TEXT NOT NULL,
  order_index INTEGER NOT NULL, size_bytes INTEGER, start_seconds REAL);
CREATE TABLE media_chapters (id TEXT PRIMARY KEY, format_id TEXT NOT NULL, title TEXT NOT NULL,
  start_seconds REAL NOT NULL);
CREATE TABLE media_subtitles (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, file_id TEXT, episode_id TEXT,
  language TEXT NOT NULL, label TEXT NOT NULL, object_key TEXT, format TEXT, is_default INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE media_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, signature TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE media_template_formats (id TEXT PRIMARY KEY, template_id TEXT NOT NULL, quality TEXT NOT NULL,
  codec TEXT NOT NULL, codec_string TEXT, bitrate_kbps INTEGER, init_key TEXT, init_size INTEGER,
  duration_seconds REAL, total_size INTEGER, size_mb INTEGER NOT NULL);
CREATE TABLE media_template_format_chunks (id TEXT PRIMARY KEY, format_id TEXT NOT NULL, chunk_key TEXT NOT NULL,
  order_index INTEGER NOT NULL, size_bytes INTEGER, start_seconds REAL);
CREATE TABLE media_template_audio_tracks (id TEXT PRIMARY KEY, template_id TEXT NOT NULL, language TEXT NOT NULL,
  label TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, codec TEXT, codec_string TEXT,
  init_key TEXT, init_size INTEGER, duration_seconds REAL, total_size INTEGER, created_at TEXT NOT NULL);
CREATE TABLE media_template_audio_chunks (id TEXT PRIMARY KEY, track_id TEXT NOT NULL, chunk_key TEXT NOT NULL,
  order_index INTEGER NOT NULL, size_bytes INTEGER, start_seconds REAL);
CREATE TABLE media_template_subtitles (id TEXT PRIMARY KEY, template_id TEXT NOT NULL, language TEXT NOT NULL,
  label TEXT NOT NULL, object_key TEXT, format TEXT, is_default INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE TABLE media_template_chapters (id TEXT PRIMARY KEY, format_id TEXT NOT NULL, title TEXT NOT NULL,
  start_seconds REAL NOT NULL);
CREATE TABLE media_skip_analysis (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, episode_id TEXT, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
"""

UPDATED = "2026-03-04T05:06:07.000Z"
ADDED = "2026-01-02T03:04:05.000Z"


def _ids():
    n = [0]

    def gen():
        n[0] += 1
        return "gen-%d" % n[0]
    return gen


def _chunks(prefix, count, start=0.0):
    return [{"key": "%s-%d" % (prefix, i), "sizeBytes": 1000 * (i + 1), "startSeconds": start + 4.5 * i} for i in range(count)]


def _fmt(media_id, file_id, fid, quality, codec, source, chunks):
    return {"id": fid, "mediaId": media_id, "fileId": file_id, "quality": quality, "codec": codec,
            "codecString": "%s.x" % codec, "bitrateKbps": 4000 if source else 1500, "initKey": fid + "-init",
            "initSize": 812, "durationSeconds": 7200.25, "totalSize": 9000000, "sizeMb": 8, "isSource": source,
            "chunks": chunks}


def _audio(media_id, file_id, episode_id, tid, lang, label, default, codec="aac"):
    return {"id": tid, "mediaId": media_id, "fileId": file_id, "episodeId": episode_id, "language": lang,
            "label": label, "isDefault": default, "source": "embedded", "codec": codec, "codecString": "mp4a.40.2",
            "initKey": tid + "-init", "initSize": 700, "durationSeconds": 7200.25, "totalSize": 5000000,
            "chunks": _chunks(tid, 2)}


def _sub(media_id, file_id, episode_id, tid, lang, label, fmt, default):
    return {"id": tid, "mediaId": media_id, "fileId": file_id, "episodeId": episode_id, "language": lang,
            "label": label, "objectKey": "subs/" + tid + "." + fmt, "format": fmt, "isDefault": default,
            "source": "embedded", "createdAt": ADDED}


def _base(media_id, kind, title):
    return {"id": media_id, "type": kind, "externalIds": {"tmdb": 27205, "imdb": "tt1375666"}, "tmdbId": 27205,
            "title": title, "originalTitle": title + " (orig)", "originalLanguage": "en", "overview": "Overview text",
            "year": "2010", "rating": 8.8, "posterPath": "/poster.jpg", "backdropPath": "/backdrop.jpg",
            "genres": [28, 878], "addedAt": ADDED, "updatedAt": UPDATED}


def movie_fixture():
    m, f = "movie-1", "file-m1"
    d = _base(m, "movie", "Inception")
    f720a = _fmt(m, f, "fmt-720-av1", "720p", "av1", False, _chunks("c720a", 3))
    f720h = _fmt(m, f, "fmt-720-h264", "720p", "h264", False, _chunks("c720h", 2))
    f1080 = _fmt(m, f, "fmt-1080-h264", "1080p", "h264", True, _chunks("c1080", 4, 1.0))
    subs = [_sub(m, f, None, "sub-fr", "fr", "Francais (PGS)", "sup", True), _sub(m, f, None, "sub-en", "en", "English", "srt", False)]
    d.update({
        "progressPct": 12.5, "lastWatchedAt": "2026-02-02T02:02:02.000Z", "hasFiles": True,
        "preferredAudioLanguage": None, "totalEpisodes": 0, "episodeCount": 0,
        "cast": [
            {"id": "role-1", "personId": "person-1", "tmdbId": 6193, "name": "Leonardo DiCaprio", "role": "Cobb", "profilePath": "/leo.jpg"},
            {"id": "role-2", "personId": "person-2", "tmdbId": None, "name": "Elliot Page", "role": None, "profilePath": None}],
        "trailers": [{"provider": "youtube", "key": "YoHD9XEInc0", "name": "Trailer", "language": "en"},
                     {"provider": "youtube", "key": "abc", "name": None, "language": "und"}],
        "playlistIds": [], "seasons": [], "episodes": [],
        "files": [{"id": f, "filename": "Inception.mkv", "season": None, "episode": None, "desiredFormats": [
            {"quality": "1080p", "codec": "h264", "bitrateKbps": 5000}, {"quality": "720p", "codec": "h264", "bitrateKbps": None}]}],
        "formats": [f720a, f720h, f1080],
        "audioTracks": [_audio(m, f, None, "aud-en", "en", "English", True), _audio(m, f, None, "aud-fr", "fr", "Francais", False, "ac3")],
        "subtitleTracks": subs, "subtitles": subs,
        "chapters": [{"id": "ch-1", "formatId": "fmt-1080-h264", "title": "Start", "startSeconds": 0},
                     {"id": "ch-2", "formatId": "fmt-1080-h264", "title": "Dream", "startSeconds": 600.5}],
        "skipMarkers": [{"id": "sk-1", "mediaId": m, "episodeId": None, "type": "credits", "startSeconds": 7000.5,
                         "endSeconds": 7200.25, "source": "auto", "confidence": None, "createdAt": ADDED, "updatedAt": UPDATED}],
        "hasLocalFiles": True,
    })
    return d


def _previews(fid):
    return {"version": 1, "intervalSeconds": 5, "pictureWidth": 160, "pictureHeight": 90, "columns": 10, "rows": 10,
            "pictureCount": 101, "sheets": [
                {"objectKey": "media/%s/previews/sheet-000" % fid, "sizeBytes": 61000, "firstPicture": 0, "pictureCount": 100},
                {"objectKey": "media/%s/previews/sheet-001" % fid, "sizeBytes": 900, "firstPicture": 100, "pictureCount": 1}]}


def tv_fixture():
    m = "tv-1"
    d = _base(m, "tv", "Breaking Bad")
    d["externalIds"] = {"tmdb": 1396}
    d["tmdbId"] = 1396
    e1, e2, e3 = "ep-1", "ep-2", "ep-3"
    fa, fb = "file-e1", "file-e2"
    subs = [_sub(m, fa, e1, "sub-e1-en", "en", "English", "srt", True), _sub(m, fa, e1, "sub-e1-fr", "fr", "Francais", "sup", False),
            _sub(m, fb, e2, "sub-e2-en", "en", "English", "srt", False)]
    # default-first, then language (ties impossible in this fixture)
    subs = [subs[0], subs[2], subs[1]]
    audio = [_audio(m, fb, e2, "aud-e2-en", "en", "English", True), _audio(m, fa, e1, "aud-e1-ja", "ja", "Japanese", True),
             _audio(m, fa, e1, "aud-e1-en", "en", "English", False), _audio(m, fb, e2, "aud-e2-ja", "ja", "Japanese", False)]
    audio = [audio[0], audio[1], audio[2], audio[3]]
    d.update({
        "progressPct": 50, "lastWatchedAt": "2026-02-03T00:00:00.000Z", "hasFiles": True, "preferredAudioLanguage": None,
        "totalEpisodes": 3, "episodeCount": 3,
        "cast": [{"id": "role-t1", "personId": "person-3", "tmdbId": 17419, "name": "Bryan Cranston", "role": "Walter White", "profilePath": "/bc.jpg"}],
        "trailers": [], "playlistIds": [],
        "seasons": [{"id": "season-1", "seasonNumber": 1, "name": "Season 1", "overview": None, "posterPath": "/s1.jpg",
                     "episodeCount": 3, "airDate": "2008-01-20"}],
        "episodes": [
            {"id": e1, "seasonNumber": 1, "episodeNumber": 1, "name": "Pilot", "overview": "o1", "stillPath": "/e1.jpg", "airDate": "2008-01-20"},
            {"id": e2, "seasonNumber": 1, "episodeNumber": 2, "name": "Cat's in the Bag", "overview": None, "stillPath": None, "airDate": "2008-01-27"},
            {"id": e3, "seasonNumber": 1, "episodeNumber": 3, "name": "And the Bag's in the River", "overview": None, "stillPath": None, "airDate": "2008-02-10"}],
        "files": [{"id": fa, "filename": "S01E01.mkv", "season": 1, "episode": 1, "desiredFormats": []},
                  {"id": fb, "filename": "S01E02.mkv", "season": 1, "episode": 2, "desiredFormats": [{"quality": "720p", "codec": "h264", "bitrateKbps": 2500}]}],
        # quality DESC then codec ASC: av1 before h264
        "formats": [_fmt(m, fb, "fmt-e2", "720p", "av1", True, _chunks("e2c", 2)), _fmt(m, fa, "fmt-e1", "720p", "h264", True, _chunks("e1c", 3))],
        "audioTracks": audio, "subtitleTracks": subs, "subtitles": subs,
        "chapters": [{"id": "ch-e1", "formatId": "fmt-e1", "title": "Cold open", "startSeconds": 0}],
        "skipMarkers": [
            {"id": "sk-e1-intro", "mediaId": m, "episodeId": e1, "type": "intro", "startSeconds": 5, "endSeconds": 65.5,
             "source": "manual", "confidence": 0.9, "createdAt": ADDED, "updatedAt": UPDATED},
            {"id": "sk-e1-credits", "mediaId": m, "episodeId": e1, "type": "credits", "startSeconds": 2400, "endSeconds": 2500,
             "source": "auto", "confidence": None, "createdAt": ADDED, "updatedAt": UPDATED}],
        "hasLocalFiles": True,
    })
    return d


RESUME_SETTINGS = [
    ("episode_resume_v1:ep-1", json.dumps({"progressPct": 50, "updatedAt": "2026-02-01T00:00:00.000Z"}, separators=(",", ":"))),
    ("episode_resume_v1:ep-2", json.dumps({"progressPct": 100, "updatedAt": "2026-02-03T00:00:00.000Z"}, separators=(",", ":"))),
    ("episode_resume_v1:unrelated-episode", json.dumps({"progressPct": 77, "updatedAt": "2027-01-01T00:00:00.000Z"}, separators=(",", ":"))),
]


_OPEN = []


def make_db(detail_list):
    conn = sqlite3.connect(":memory:", isolation_level=None)
    _OPEN.append(conn)
    conn.row_factory = sqlite3.Row  # the addon's LibraryStore connection uses Row
    conn.executescript(SCHEMA)
    gen = _ids()
    for key, value in RESUME_SETTINGS:
        for sql, params in ops_sql.build_op_statements(
                {"type": "setting.set", "payload": {"key": key, "value": value, "updatedAt": "2026-02-01T00:00:00.000Z"}}, gen):
            conn.execute(sql, params)
    for details in detail_list:
        for sql, params in ops_sql.build_op_statements({"type": "media.upsert", "payload": {"details": details}}, gen):
            conn.execute(sql, params)
    return conn


def dump(conn):
    out = {}
    for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").fetchall():
        out[name] = sorted((tuple(r) for r in conn.execute("SELECT * FROM %s" % name).fetchall()), key=repr)
    return out


class Details(unittest.TestCase):
    def setUp(self):
        self.fixtures = [movie_fixture(), tv_fixture()]
        self.db1 = make_db(self.fixtures)

    def tearDown(self):
        while _OPEN:
            _OPEN.pop().close()

    def test_build_equals_fixture(self):
        # @req INTG-KODI-04
        for fixture in self.fixtures:
            built = D.build_media_details(self.db1, fixture["id"])
            self.assertEqual(built, fixture)
            # same key set / JSON-serialisable exactly like the op payload
            self.assertEqual(json.loads(json.dumps(built)), fixture)

    def test_upsert_of_built_details_reproduces_every_row(self):
        # @req INTG-KODI-04
        rebuilt = [D.build_media_details(self.db1, f["id"]) for f in self.fixtures]
        db2 = make_db(rebuilt)
        self.assertEqual(dump(self.db1), dump(db2))

    def test_unknown_media_is_none(self):
        self.assertIsNone(D.build_media_details(self.db1, "nope"))

    def test_is_source_is_healed_like_the_desktop_open_time_backfill(self):
        # Formats replayed from older op streams carry is_source = 0; the desktop re-flags the highest quality of each
        # file (lowest id on ties) every time it opens the playback DB, so its getMediaDetails reports that flag.
        self.db1.execute("UPDATE media_formats SET is_source = 0 WHERE media_id = 'movie-1'")
        healed = D.build_media_details(self.db1, "movie-1")
        self.assertEqual([(f["id"], f["isSource"]) for f in healed["formats"]],
                         [("fmt-720-av1", False), ("fmt-720-h264", False), ("fmt-1080-h264", True)])
        raw = D.build_media_details(self.db1, "movie-1", heal_is_source=False)
        self.assertEqual([f["isSource"] for f in raw["formats"]], [False, False, False])
        # a file that already has a flagged row is never touched
        self.db1.execute("UPDATE media_formats SET is_source = 1 WHERE id = 'fmt-720-av1'")
        flagged = D.build_media_details(self.db1, "movie-1")
        self.assertEqual([f["isSource"] for f in flagged["formats"]], [True, False, False])

    def test_preferred_audio_language_is_not_persisted_by_media_upsert(self):
        # Documented difference: ops.ts media.upsert does not write media_items.preferred_audio_language (INSERT OR REPLACE
        # resets it), so a desktop-queued upsert carrying 'fr' reads back as null on every device that applies it.
        fixture = movie_fixture()
        fixture["preferredAudioLanguage"] = "fr"
        conn = make_db([fixture])
        self.assertIsNone(D.build_media_details(conn, "movie-1")["preferredAudioLanguage"])
        conn.execute("UPDATE media_items SET preferred_audio_language = 'fr' WHERE id = 'movie-1'")
        self.assertEqual(D.build_media_details(conn, "movie-1")["preferredAudioLanguage"], "fr")

    # ------------------------------------------------------------------ with_track_defaults vs desktop SQL
    def _desktop_set_default(self, conn, table, media_id, episode_id, track_id, fallback_audio=False):
        scope = "episode_id = ?" if episode_id else "episode_id IS NULL"
        params = [media_id] + ([episode_id] if episode_id else [])
        conn.execute("UPDATE %s SET is_default = 0 WHERE media_id = ? AND %s" % (table, scope), params)
        if track_id:
            conn.execute("UPDATE %s SET is_default = 1 WHERE id = ?" % table, (track_id,))

    def test_audio_default_matches_setDefaultAudioTrack(self):
        # @req INTG-KODI-04
        for media_id, episode_id, language, track_id in (("movie-1", None, "fr", "aud-fr"),
                                                         ("tv-1", "ep-1", "en", "aud-e1-en"),
                                                         ("tv-1", "ep-2", "ja", "aud-e2-ja")):
            before = D.build_media_details(self.db1, media_id)
            conn = make_db(self.fixtures)
            self._desktop_set_default(conn, "media_audio_tracks", media_id, episode_id, track_id)
            desktop = D.build_media_details(conn, media_id)
            mine = D.with_track_defaults(before, episode_id, audio_language=language, now="2030-01-01T00:00:00.000Z")
            self.assertEqual(mine["updatedAt"], "2030-01-01T00:00:00.000Z")
            self.assertEqual(mine["preferredAudioLanguage"], language)
            for k in ("updatedAt", "preferredAudioLanguage"):
                mine.pop(k), desktop.pop(k)
            self.assertEqual(mine, desktop)
            self.assertNotEqual(mine["audioTracks"], before["audioTracks"])

    def test_subtitle_choice_and_off_match_setDefaultSubtitleTrack(self):
        # @req INTG-KODI-04
        cases = (("movie-1", None, "en", "sub-en"), ("movie-1", None, None, None),
                 ("tv-1", "ep-1", "fr", "sub-e1-fr"), ("tv-1", "ep-1", None, None), ("tv-1", "ep-2", "en", "sub-e2-en"))
        for media_id, episode_id, language, track_id in cases:
            before = D.build_media_details(self.db1, media_id)
            conn = make_db(self.fixtures)
            self._desktop_set_default(conn, "media_subtitles", media_id, episode_id, track_id)
            desktop = D.build_media_details(conn, media_id)
            mine = D.with_track_defaults(before, episode_id, subtitle=language, now="2030-01-01T00:00:00.000Z")
            mine.pop("updatedAt"), desktop.pop("updatedAt")
            self.assertEqual(mine, desktop, (media_id, episode_id, language))
            self.assertEqual(mine["subtitles"], mine["subtitleTracks"])

    def test_subtitle_unchanged_by_default_and_audio_by_id(self):
        before = D.build_media_details(self.db1, "movie-1")
        mine = D.with_track_defaults(before, None, audio_language="fr")
        self.assertEqual(mine["subtitleTracks"], before["subtitleTracks"])
        by_id = D.with_track_defaults(before, None, audio_track_id="aud-fr", now="x")
        self.assertEqual(by_id["audioTracks"], mine["audioTracks"])
        self.assertEqual(before, D.build_media_details(self.db1, "movie-1"), "input must not be mutated")
        exact = D.with_track_defaults(before, None, audio_language="fr", bump_updated_at=False)
        self.assertEqual(exact["updatedAt"], before["updatedAt"])

    def test_unknown_language_changes_nothing(self):
        before = D.build_media_details(self.db1, "movie-1")
        mine = D.with_track_defaults(before, None, audio_language="xx", bump_updated_at=False)
        self.assertEqual(mine["audioTracks"], before["audioTracks"])

    def test_defaults_survive_upsert_round_trip(self):
        # the op the addon would send, applied by another device
        before = D.build_media_details(self.db1, "tv-1")
        mine = D.with_track_defaults(before, "ep-1", audio_language="en", subtitle=None)
        conn = make_db([self.fixtures[0], mine])
        flags = dict(conn.execute("SELECT id, is_default FROM media_audio_tracks WHERE media_id = 'tv-1'").fetchall())
        self.assertEqual(flags, {"aud-e2-en": 1, "aud-e1-ja": 0, "aud-e1-en": 1, "aud-e2-ja": 0})
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM media_subtitles WHERE media_id = 'tv-1' AND episode_id = 'ep-1' "
                                      "AND is_default = 1").fetchone()[0], 0)

    # ------------------------------------------------------------------ without_episode_files vs deleteMediaFile
    def _desktop_delete_file(self, conn, file_id):
        media_id, season, episode = conn.execute("SELECT media_id, season, episode FROM media_files WHERE id = ?", (file_id,)).fetchone()
        row = conn.execute("SELECT id FROM media_episodes WHERE media_id = ? AND season_number = ? AND episode_number = ? LIMIT 1",
                           (media_id, season, episode)).fetchone() if season is not None and episode is not None else None
        episode_id = row[0] if row else None
        scope = "episode_id = ?" if episode_id else "episode_id IS NULL"
        params = [media_id] + ([episode_id] if episode_id else [])
        # FK cascades of the real schema, spelled out
        conn.execute("DELETE FROM media_format_chunks WHERE format_id IN (SELECT id FROM media_formats WHERE file_id = ?)", (file_id,))
        conn.execute("DELETE FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE file_id = ?)", (file_id,))
        conn.execute("DELETE FROM media_formats WHERE file_id = ?", (file_id,))
        conn.execute("DELETE FROM media_audio_chunks WHERE track_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ? AND %s)" % scope, params)
        conn.execute("DELETE FROM media_audio_tracks WHERE media_id = ? AND %s" % scope, params)
        conn.execute("DELETE FROM media_subtitles WHERE media_id = ? AND %s" % scope, params)
        conn.execute("DELETE FROM media_file_desired_formats WHERE file_id = ?", (file_id,))
        conn.execute("DELETE FROM media_files WHERE id = ?", (file_id,))
        conn.execute("UPDATE media_items SET has_files = CASE WHEN EXISTS (SELECT 1 FROM media_files WHERE media_id = media_items.id) "
                     "THEN 1 ELSE 0 END")
        return media_id

    def test_without_episode_files_matches_deleteMediaFile(self):
        # @req INTG-KODI-04
        for media_id, episode_id, file_id in (("tv-1", "ep-1", "file-e1"), ("tv-1", "ep-2", "file-e2"), ("movie-1", None, "file-m1")):
            before = D.build_media_details(self.db1, media_id)
            conn = make_db(self.fixtures)
            self._desktop_delete_file(conn, file_id)
            desktop = D.build_media_details(conn, media_id)
            mine = D.without_episode_files(before, episode_id)
            self.assertEqual(mine, desktop, file_id)
            self.assertEqual(mine["updatedAt"], before["updatedAt"])
            # and the upsert of the result is what the desktop DB looks like after the delete
            self.assertEqual(dump(make_db([self.fixtures[0], mine] if media_id == "tv-1" else [mine, self.fixtures[1]]))
                             ["media_audio_tracks"], dump(conn)["media_audio_tracks"])

    def test_episode_storage_keys_are_the_episodes_own_objects(self):
        # @req INTG-DEL-01
        details = D.build_media_details(self.db1, "tv-1")
        keys = D.episode_storage_keys(details, "ep-1")
        self.assertTrue(keys)
        other = D.episode_storage_keys(details, "ep-2")
        self.assertFalse(set(keys) & set(other), "two episodes must never share a storage key")
        # every key of ep-1 disappears from the details once its files are removed; ep-2's keys all stay
        rest = D.without_episode_files(details, "ep-1")
        left = set()
        for f in rest["formats"]:
            left.add(f.get("initKey"))
            left.update(c["key"] for c in f.get("chunks") or [])
        for t in rest["audioTracks"]:
            left.add(t.get("initKey"))
            left.update(c["key"] for c in t.get("chunks") or [])
        left.update(t.get("objectKey") for t in rest["subtitleTracks"])
        self.assertFalse(set(keys) & left)
        self.assertTrue(set(other) <= left)
        self.assertEqual(D.episode_storage_keys(details, "no-such-episode"), [])

    def test_deleting_an_episode_releases_its_preview_sheets_and_keeps_the_others(self):
        # MPV-PREV-01 record half: Kodi's delete_episode publishes a media.upsert built from its own DB. The deleted
        # episode's sheets are storage objects of that episode; the other episodes' sheets must ride the upsert so the
        # desktop keeps them (and its storage GC does not delete them).
        tag = "[KODI-PREV-SHEETS:delete-episode]"
        fixture = tv_fixture()
        sheets = {}
        for fmt in fixture["formats"]:
            sheets[fmt["id"]] = _previews(fmt["id"])
            fmt["previewSheets"] = sheets[fmt["id"]]
        conn = make_db([fixture])
        stored = conn.execute("SELECT id, preview_sheets FROM media_formats ORDER BY id").fetchall()
        print(tag, "stored", [(r[0], None if r[1] is None else len(r[1])) for r in stored])
        details = D.build_media_details(conn, "tv-1")
        print(tag, "built", [(f["id"], "previewSheets" in f) for f in details["formats"]])
        self.assertEqual({f["id"]: f.get("previewSheets") for f in details["formats"]}, sheets)

        keys = D.episode_storage_keys(details, "ep-1")
        mine = [s["objectKey"] for s in sheets["fmt-e1"]["sheets"]]
        theirs = [s["objectKey"] for s in sheets["fmt-e2"]["sheets"]]
        print(tag, "ep-1 keys", keys)
        self.assertTrue(set(mine) <= set(keys), "the deleted episode's sheets must be deleted from storage")
        self.assertFalse(set(theirs) & set(keys), "another episode's sheets must never be deleted")

        op = D.make_upsert_op(D.without_episode_files(details, "ep-1"), now="T", op_id="op-1")
        published = json.loads(json.dumps(op))["payload"]["details"]["formats"]
        print(tag, "published", [(f["id"], f.get("previewSheets") is not None) for f in published])
        self.assertEqual([(f["id"], f.get("previewSheets")) for f in published], [("fmt-e2", sheets["fmt-e2"])])

        # a receiver holding both episodes applies the upsert: ep-2 keeps its record, ep-1's row is gone
        receiver = make_db([fixture])
        for sql, params in ops_sql.build_op_statements(op, _ids()):
            receiver.execute(sql, params)
        rows = receiver.execute("SELECT id, preview_sheets FROM media_formats ORDER BY id").fetchall()
        print(tag, "receiver", [(r[0], r[1] is not None) for r in rows])
        self.assertEqual([(r[0], json.loads(r[1])) for r in rows], [("fmt-e2", sheets["fmt-e2"])])

    def test_a_db_without_the_preview_column_builds_formats_without_the_field(self):
        # A snapshot from before MPV-PREV-01 has no media_formats.preview_sheets: the field stays absent (not null),
        # so the desktop applying a Kodi upsert keeps the record it holds.
        conn = make_db([tv_fixture()])
        conn.execute("ALTER TABLE media_formats DROP COLUMN preview_sheets")
        details = D.build_media_details(conn, "tv-1")
        print("[KODI-PREV-SHEETS:no-column] built", [sorted(f) for f in details["formats"]][:1])
        self.assertTrue(all("previewSheets" not in f for f in details["formats"]))

    def test_deleting_the_last_file_clears_has_files(self):
        before = D.build_media_details(self.db1, "tv-1")
        one = D.without_episode_files(before, "ep-1")
        self.assertTrue(one["hasFiles"])
        none = D.without_episode_files(one, "ep-2")
        self.assertFalse(none["hasFiles"])
        self.assertFalse(none["hasLocalFiles"])
        self.assertEqual(none["formats"], [])
        self.assertEqual(none["audioTracks"], [])
        self.assertEqual(len(none["skipMarkers"]), 2)  # skip markers stay, like the desktop

    def test_make_upsert_op_shape(self):
        details = D.build_media_details(self.db1, "movie-1")
        op = D.make_upsert_op(details, now="T", op_id="id-1")
        self.assertEqual(op, {"id": "id-1", "type": "media.upsert", "createdAt": "T", "payload": {"details": details}})
        self.assertEqual(list(op), ["id", "type", "createdAt", "payload"])
        self.assertEqual(len(D.make_upsert_op(details)["id"]), 36)

    # ------------------------------------------------------------------ OCR twins (PLAY-TRACK-05)
    def test_ocr_twin_round_trips_and_is_never_the_language_pick(self):
        # PLAY-TRACK-05 (OCR twins); Kodi is outside that rule's apps, so no tag
        conn = make_db([movie_fixture()])
        conn.execute("ALTER TABLE media_subtitles ADD COLUMN derived_from_subtitle_id TEXT")
        conn.execute("INSERT INTO media_subtitles VALUES ('sub-fr-ocr', 'movie-1', 'file-m1', NULL, 'fr', 'Francais (PGS)', "
                     "'fre.ocr.srt', 'srt', 0, 'ocr', '2026-10-29T00:00:00.000Z', 'sub-fr')")
        built = D.build_media_details(conn, "movie-1")
        by_id = {t["id"]: t for t in built["subtitleTracks"]}
        print("[test_details:ocr-twin] built subtitles=%s" % json.dumps(built["subtitleTracks"]))
        self.assertEqual(by_id["sub-fr-ocr"]["derivedFromSubtitleId"], "sub-fr")
        self.assertIsNone(by_id["sub-fr"]["derivedFromSubtitleId"])
        self.assertTrue(D.is_ocr_twin(by_id["sub-fr-ocr"]))
        self.assertFalse(D.is_ocr_twin(by_id["sub-fr"]))
        picked = D.with_track_defaults(built, None, subtitle="fr", now="2030-01-01T00:00:00.000Z")
        defaults = [t["id"] for t in picked["subtitleTracks"] if t["isDefault"]]
        print("[test_details:ocr-twin] defaults after fr pick=%s" % defaults)
        self.assertEqual(defaults, ["sub-fr"])

    def test_db_without_the_column_keeps_the_old_payload_shape(self):
        built = D.build_media_details(make_db([movie_fixture()]), "movie-1")
        print("[test_details:ocr-twin] keys=%s" % sorted(built["subtitleTracks"][0]))
        self.assertNotIn("derivedFromSubtitleId", built["subtitleTracks"][0])

    # ------------------------------------------------------------------ template projection
    def test_template_files_project_virtual_rows_like_the_desktop(self):
        conn = make_db([movie_fixture()])
        conn.execute("UPDATE media_files SET template_id = 'tpl-1' WHERE id = 'file-m1'")
        conn.execute("INSERT INTO media_templates VALUES ('tpl-1', 'n', 's', 'sig', 'c', 'u')")
        conn.execute("INSERT INTO media_template_formats VALUES ('tf-1', 'tpl-1', '480p', 'h264', 'avc', 900, 'init', 10, 60.5, 5000, 3)")
        conn.execute("INSERT INTO media_template_format_chunks VALUES ('tfc-1', 'tf-1', 'ck', 0, 77, 0.0)")
        conn.execute("INSERT INTO media_template_chapters VALUES ('tch-1', 'tf-1', 'Intro', 3.5)")
        conn.execute("INSERT INTO media_template_audio_tracks VALUES ('ta-1', 'tpl-1', 'de', 'Deutsch', 0, 'embedded', 'aac', NULL, NULL, NULL, NULL, NULL, 'c')")
        conn.execute("INSERT INTO media_template_audio_chunks VALUES ('tac-1', 'ta-1', 'ak', 0, 5, NULL)")
        conn.execute("INSERT INTO media_template_subtitles VALUES ('ts-1', 'tpl-1', 'de', 'Deutsch', 'k.srt', 'srt', 0, 'embedded', 'c')")
        built = D.build_media_details(conn, "movie-1")
        fmt = built["formats"][-1]
        self.assertEqual(fmt["id"], "tmpl-format:tf-1:file-m1")
        self.assertEqual((fmt["fileId"], fmt["quality"], fmt["sizeMb"], fmt["isSource"], fmt["chunks"]),
                         ("file-m1", "480p", 3, False, [{"key": "ck", "sizeBytes": 77, "startSeconds": 0}]))
        self.assertEqual(built["chapters"][-1], {"id": "tmpl-format:tf-1:file-m1:0", "formatId": "tmpl-format:tf-1:file-m1",
                                                 "title": "Intro", "startSeconds": 3.5})
        audio = built["audioTracks"][-1]
        self.assertEqual((audio["id"], audio["episodeId"], audio["language"], audio["chunks"]),
                         ("tmpl-audio:ta-1:file-m1", None, "de", [{"key": "ak", "sizeBytes": 5, "startSeconds": None}]))
        self.assertEqual(built["subtitleTracks"][-1]["id"], "tmpl-sub:ts-1:file-m1")
        self.assertEqual(built["subtitles"], built["subtitleTracks"])
        # the projected rows are removed together with their file
        gone = D.without_episode_files(built, None)
        self.assertEqual((gone["formats"], gone["chapters"], gone["audioTracks"], gone["subtitleTracks"]), ([], [], [], []))

    def test_tv_aggregate_ignores_unparsable_and_foreign_resume_rows(self):
        conn = make_db(self.fixtures)
        conn.execute("INSERT OR REPLACE INTO app_settings VALUES ('episode_resume_v1:ep-3', 'not json', 'u')")
        built = D.build_media_details(conn, "tv-1")
        self.assertEqual(built["progressPct"], 50)
        self.assertEqual(built["lastWatchedAt"], "2026-02-03T00:00:00.000Z")
        conn.execute("UPDATE media_items SET total_episodes = NULL WHERE id = 'tv-1'")
        # no configured total: the 3 aired episodes still decide -> 150 / 3
        self.assertEqual(D.build_media_details(conn, "tv-1")["progressPct"], 50)
        self.assertEqual(D.build_media_details(conn, "tv-1")["totalEpisodes"], 0)

    def test_tv_aggregate_counts_every_aired_episode(self):
        # @req LIB-PROG-01 Chris 2026-10-29: the show's watched % is out of all its aired episodes, not the vault's.
        conn = make_db(self.fixtures)
        rows = [("sp-1", 0, 1, "2008-06-01"), ("ep-4", 1, 4, "2008-02-17"), ("ep-5", 1, 5, "2008-02-24"),
                ("ep-6", 1, 6, "2008-03-02"), ("ep-7", 2, 1, "2099-01-01")]
        for episode_id, season, number, air_date in rows:
            conn.execute("INSERT INTO media_episodes (id, media_id, season_number, episode_number, title, air_date) "
                         "VALUES (?, 'tv-1', ?, ?, 't', ?)", (episode_id, season, number, air_date))
        conn.execute("INSERT INTO app_settings VALUES ('episode_resume_v1:sp-1', ?, 'u')",
                     (json.dumps({"progressPct": 100, "updatedAt": "2026-01-01T00:00:00.000Z"}),))
        conn.execute("UPDATE media_items SET total_episodes = 7 WHERE id = 'tv-1'")
        # 6 aired regular episodes; the special and the 2099 episode never count -> (50 + 100) / 6
        self.assertEqual(D._tv_progress_aggregate(conn, "tv-1", today="2026-10-29")["progressPct"], 25)
        # no air dates at all: the metadata's count decides -> 150 / 7
        conn.execute("UPDATE media_episodes SET air_date = NULL WHERE media_id = 'tv-1'")
        self.assertAlmostEqual(D._tv_progress_aggregate(conn, "tv-1", today="2026-10-29")["progressPct"], 150 / 7)
        # nothing from the metadata: the 7 listed regular episodes -> 150 / 7
        conn.execute("UPDATE media_items SET total_episodes = NULL WHERE id = 'tv-1'")
        self.assertAlmostEqual(D._tv_progress_aggregate(conn, "tv-1", today="2026-10-29")["progressPct"], 150 / 7)


if __name__ == "__main__":
    unittest.main()

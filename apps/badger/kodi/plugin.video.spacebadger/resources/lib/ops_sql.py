# -*- coding: utf-8 -*-
"""Python port of packages/library-db-definition/src/ops.ts (OP_STREAM_VERSION 3).

``build_op_statements(op, id_gen)`` returns the ordered ``[(sql, params), ...]`` that the TypeScript
``buildOpStatements`` would run, flattened across its groups (the addon keeps ONE combined SQLite, so
group routing is irrelevant). Order inside a group is preserved; groups are emitted core, metadata,
playback, ingest, templates, matching the TS ``finalize`` order.

An unknown op type raises UnknownOpTypeError; the caller logs and skips it (v0 policy).
"""
import json

from legacy_format import LEGACY_CATALOG_ID_SOURCE, catalog_id

OP_STREAM_VERSION = 3
MIN_SUPPORTED_OP_STREAM_VERSION = 1

# The source a catalog id row is written under (library-db-definition/src/catalogId.ts); readers also accept the
# source older libraries used.
CATALOG_ID_SOURCE = "catalog"
CATALOG_ID_SOURCES = (CATALOG_ID_SOURCE, LEGACY_CATALOG_ID_SOURCE)
CATALOG_ID_SOURCES_SQL = ", ".join("'%s'" % source for source in CATALOG_ID_SOURCES)

TERMINAL_INGEST_STATUSES = ("completed", "failed", "cancelled")


class UnknownOpTypeError(Exception):
    pass


def _js_str(value):
    """String(value) for JSON scalars (ints stay ints, whole floats lose the '.0')."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    return str(value)


def _flag(value):
    return 1 if value else 0


# LIB-SYNC-10: slug -> (fixed id, name, is_system); mirrors packages/library-db-definition/src/systemPlaylists.ts.
SYSTEM_PLAYLISTS = {
    "favorites": ("favorites", "Favorites", 1),
    "watchlist": ("watchlist", "Watchlist", 0),
}


def _clamp_progress_pct(raw):
    try:
        num = float(raw)
    except (TypeError, ValueError):
        num = 0.0
    if num != num:  # NaN
        num = 0.0
    # JS Math.round rounds half up
    import math
    return int(max(0, min(100, math.floor(num + 0.5))))


def _meta_json(meta):
    return json.dumps(meta, separators=(",", ":")) if isinstance(meta, dict) else None


class _Builders(object):
    GROUPS = ("core", "metadata", "playback", "ingest", "templates")

    def __init__(self):
        self.lists = {g: [] for g in self.GROUPS}

    def add(self, group, sql, params):
        self.lists[group].append((sql, list(params)))

    def flatten(self):
        out = []
        for g in self.GROUPS:
            out.extend(self.lists[g])
        return out


def _g(d, key, default=None):
    value = d.get(key, default) if isinstance(d, dict) else default
    return default if value is None and default is not None else value


def _append_media_core(b, details, new_id):
    media_id = details["id"]
    # An UPSERT guarded by the details clock (LIB-SYNC-08): an older upsert is ignored, the progress columns
    # are written only when the row is first created (a re-save of the details never carries viewing
    # progress; it travels in media.progress), and columns this op does not carry survive.
    b.add("core", """INSERT INTO media_items (
      id, type, title, original_title, original_language, overview, year, rating, poster_path, backdrop_path,
      added_at, updated_at, has_files, progress_pct, last_watched_at, total_episodes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      title = excluded.title,
      original_title = excluded.original_title,
      original_language = excluded.original_language,
      overview = excluded.overview,
      year = excluded.year,
      rating = excluded.rating,
      poster_path = excluded.poster_path,
      backdrop_path = excluded.backdrop_path,
      added_at = excluded.added_at,
      updated_at = excluded.updated_at,
      has_files = excluded.has_files,
      total_episodes = excluded.total_episodes
    WHERE excluded.updated_at >= media_items.updated_at;""", [
        media_id,
        details.get("type"),
        details.get("title"),
        details.get("originalTitle"),
        details.get("originalLanguage"),
        details.get("overview"),
        details.get("year"),
        details.get("rating"),
        details.get("posterPath"),
        details.get("backdropPath"),
        details.get("addedAt"),
        details.get("updatedAt"),
        _flag(details.get("hasFiles")),
        details.get("progressPct"),
        details.get("lastWatchedAt"),
        details.get("totalEpisodes"),
    ])
    # A stale upsert (rejected above) must not rewrite the children either: every statement below runs only
    # while the row carries this op's updated_at.
    row_is_this_upsert = "EXISTS (SELECT 1 FROM media_items WHERE id = ? AND updated_at = ?)"
    row_params = [media_id, details.get("updatedAt")]
    b.add("core", "DELETE FROM media_external_ids WHERE media_id = ? AND %s;" % row_is_this_upsert, [media_id] + row_params)
    media_catalog_id = catalog_id(details)
    if media_catalog_id is not None:
        b.add("core", """INSERT OR IGNORE INTO media_external_ids (id, media_id, media_type, source, external_id)
       SELECT ?, ?, ?, ?, ? WHERE %s;""" % row_is_this_upsert,
              [new_id(), media_id, details.get("type"), CATALOG_ID_SOURCE, _js_str(media_catalog_id)] + row_params)
    b.add("core", "DELETE FROM media_genres WHERE media_id = ? AND %s;" % row_is_this_upsert, [media_id] + row_params)
    for genre_id in details.get("genres") or []:
        b.add("core", """INSERT OR IGNORE INTO media_genres (id, media_id, genre_id)
       SELECT ?, ?, ? WHERE %s;""" % row_is_this_upsert, [new_id(), media_id, genre_id] + row_params)


def _append_media_metadata(b, details, new_id):
    media_id = details["id"]
    cast = details.get("cast") or []
    trailers = details.get("trailers") or []
    seasons = details.get("seasons") or []
    episodes = details.get("episodes") or []
    files = details.get("files") or []
    skip_markers = details.get("skipMarkers") if isinstance(details.get("skipMarkers"), list) else []

    b.add("metadata", "DELETE FROM media_roles WHERE media_id = ?;", [media_id])
    for index, member in enumerate(cast):
        b.add("metadata", "INSERT OR REPLACE INTO people (id, name, profile_path) VALUES (?, ?, ?);",
              [member.get("personId"), member.get("name"), member.get("profilePath")])
        member_catalog_id = catalog_id(member)
        if member_catalog_id is not None:
            b.add("metadata", "INSERT OR IGNORE INTO people_external_ids (id, person_id, source, external_id) VALUES (?, ?, ?, ?);",
                  [new_id(), member.get("personId"), CATALOG_ID_SOURCE, _js_str(member_catalog_id)])
        b.add("metadata", "INSERT OR REPLACE INTO media_roles (id, media_id, person_id, role, order_index) VALUES (?, ?, ?, ?, ?);",
              [member.get("id"), media_id, member.get("personId"), member.get("role"), index])

    b.add("metadata", "DELETE FROM media_trailers WHERE media_id = ?;", [media_id])
    for trailer in trailers:
        b.add("metadata", "INSERT INTO media_trailers (id, media_id, provider, key, name, language) VALUES (?, ?, ?, ?, ?, ?);",
              [new_id(), media_id, trailer.get("provider"), trailer.get("key"), trailer.get("name"), trailer.get("language")])

    b.add("metadata", "DELETE FROM media_seasons WHERE media_id = ?;", [media_id])
    for season in seasons:
        b.add("metadata", "INSERT OR REPLACE INTO media_seasons (id, media_id, season_number, title, overview, poster_path, episode_count, air_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
              [season.get("id"), media_id, season.get("seasonNumber"), season.get("name"), season.get("overview"),
               season.get("posterPath"), season.get("episodeCount"), season.get("airDate")])

    b.add("metadata", "DELETE FROM media_episodes WHERE media_id = ?;", [media_id])
    for episode in episodes:
        b.add("metadata", "INSERT OR REPLACE INTO media_episodes (id, media_id, season_number, episode_number, title, overview, still_path, air_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
              [episode.get("id"), media_id, episode.get("seasonNumber"), episode.get("episodeNumber"), episode.get("name"),
               episode.get("overview"), episode.get("stillPath"), episode.get("airDate")])

    b.add("metadata", "DELETE FROM media_file_desired_formats WHERE media_id = ?;", [media_id])
    b.add("metadata", "DELETE FROM media_files WHERE media_id = ?;", [media_id])
    for f in files:
        b.add("metadata", "INSERT OR REPLACE INTO media_files (id, media_id, filename, season, episode, added_at, status) VALUES (?, ?, ?, ?, ?, ?, ?);",
              [f.get("id"), media_id, f.get("filename"), f.get("season"), f.get("episode"), details.get("updatedAt"), "local"])
        for fmt in f.get("desiredFormats") or []:
            b.add("metadata", "INSERT OR IGNORE INTO media_file_desired_formats (id, media_id, file_id, quality, codec, bitrate_kbps) VALUES (?, ?, ?, ?, ?, ?);",
                  [new_id(), media_id, f.get("id"), fmt.get("quality"), fmt.get("codec"), fmt.get("bitrateKbps")])

    b.add("metadata", "DELETE FROM media_skip_markers WHERE media_id = ?;", [media_id])
    for m in skip_markers:
        b.add("metadata", """INSERT OR REPLACE INTO media_skip_markers (
        id, media_id, episode_id, type, start_seconds, end_seconds, source, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);""",
              [m.get("id"), media_id, m.get("episodeId"), m.get("type"), m.get("startSeconds"), m.get("endSeconds"),
               m.get("source"), m.get("confidence"), m.get("createdAt"), m.get("updatedAt")])


def _append_media_playback(b, details, new_id):
    media_id = details["id"]
    formats = details.get("formats") or []
    audio_tracks = details.get("audioTracks") or []
    subtitles = details.get("subtitles") or []
    chapters = details.get("chapters") or []

    b.add("playback", "DELETE FROM media_format_chunks WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);", [media_id])
    b.add("playback", "DELETE FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);", [media_id])
    # media_formats rows are not deleted up front: an insert may need the stored preview sheets of its row, so the
    # stale rows go after the inserts.
    b.add("playback", "DELETE FROM media_audio_chunks WHERE track_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ?);", [media_id])
    b.add("playback", "DELETE FROM media_audio_tracks WHERE media_id = ?;", [media_id])
    b.add("playback", "DELETE FROM media_subtitles WHERE media_id = ?;", [media_id])

    for fmt in formats:
        # MPV-PREV-01: a format without `previewSheets` (writer that does not know the field) keeps the record stored
        # for its row (by id, else same file + quality); an explicit value (dict or None) wins. Mirrors ops.ts.
        keep_previews = "previewSheets" not in fmt
        if keep_previews:
            previews_sql = ("(SELECT preview_sheets FROM media_formats WHERE media_id = ? AND (id = ? OR (file_id = ? AND quality = ?)) "
                            "ORDER BY id = ? DESC LIMIT 1)")
            previews_params = [media_id, fmt.get("id"), fmt.get("fileId"), fmt.get("quality"), fmt.get("id")]
        else:
            previews_sql = "?"
            previews_params = [json.dumps(fmt["previewSheets"], separators=(",", ":")) if fmt["previewSheets"] else None]
        b.add("playback", """INSERT OR REPLACE INTO media_formats (
        id, media_id, file_id, quality, codec, codec_string, bitrate_kbps, init_key, init_size, duration_seconds, total_size, size_mb, is_source,
        preview_sheets
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, %s);""" % previews_sql,
              [fmt.get("id"), media_id, fmt.get("fileId"), fmt.get("quality"), fmt.get("codec"), fmt.get("codecString"),
               fmt.get("bitrateKbps"), fmt.get("initKey"), fmt.get("initSize"), fmt.get("durationSeconds"),
               fmt.get("totalSize"), fmt.get("sizeMb"), _flag(fmt.get("isSource"))] + previews_params)
        for i, chunk in enumerate(fmt.get("chunks") or []):
            b.add("playback", "INSERT OR REPLACE INTO media_format_chunks (id, format_id, chunk_key, order_index, size_bytes, start_seconds) VALUES (?, ?, ?, ?, ?, ?);",
                  [new_id(), fmt.get("id"), chunk.get("key"), i, chunk.get("sizeBytes"), chunk.get("startSeconds")])
    # Format rows the payload no longer carries (their chunks and chapters were deleted above).
    if formats:
        b.add("playback", "DELETE FROM media_formats WHERE media_id = ? AND id NOT IN (%s);" % ", ".join("?" for _ in formats),
              [media_id] + [fmt.get("id") for fmt in formats])
    else:
        b.add("playback", "DELETE FROM media_formats WHERE media_id = ?;", [media_id])

    for chapter in chapters:
        b.add("playback", "INSERT OR REPLACE INTO media_chapters (id, format_id, title, start_seconds) VALUES (?, ?, ?, ?);",
              [chapter.get("id"), chapter.get("formatId"), chapter.get("title"), chapter.get("startSeconds")])

    for track in audio_tracks:
        b.add("playback", """INSERT OR REPLACE INTO media_audio_tracks (
        id, media_id, file_id, episode_id, language, label, is_default, source, codec, codec_string, init_key, init_size, duration_seconds, total_size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);""",
              [track.get("id"), media_id, track.get("fileId"), track.get("episodeId"), track.get("language"), track.get("label"),
               _flag(track.get("isDefault")), track.get("source"), track.get("codec"), track.get("codecString"), track.get("initKey"),
               track.get("initSize"), track.get("durationSeconds"), track.get("totalSize"), details.get("updatedAt")])
        for i, chunk in enumerate(track.get("chunks") or []):
            b.add("playback", "INSERT OR REPLACE INTO media_audio_chunks (id, track_id, chunk_key, order_index, size_bytes, start_seconds) VALUES (?, ?, ?, ?, ?, ?);",
                  [new_id(), track.get("id"), chunk.get("key"), i, chunk.get("sizeBytes"), chunk.get("startSeconds")])

    # PLAY-TRACK-05: payloads from before OCR twins carry no `derivedFromSubtitleId`; their insert keeps the old column
    # list, so it still applies to a DB from before the column (library.py adds the column for a payload that has it).
    twin_aware = any("derivedFromSubtitleId" in sub for sub in subtitles)
    for sub in subtitles:
        if twin_aware:
            b.add("playback", """INSERT OR REPLACE INTO media_subtitles (
        id, media_id, file_id, episode_id, language, label, object_key, format, is_default, source, created_at,
        derived_from_subtitle_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);""",
                  [sub.get("id"), media_id, sub.get("fileId"), sub.get("episodeId"), sub.get("language"), sub.get("label"),
                   sub.get("objectKey"), sub.get("format"), _flag(sub.get("isDefault")), sub.get("source"),
                   sub.get("createdAt") or details.get("updatedAt"), sub.get("derivedFromSubtitleId")])
            continue
        b.add("playback", """INSERT OR REPLACE INTO media_subtitles (
        id, media_id, file_id, episode_id, language, label, object_key, format, is_default, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);""",
              [sub.get("id"), media_id, sub.get("fileId"), sub.get("episodeId"), sub.get("language"), sub.get("label"),
               sub.get("objectKey"), sub.get("format"), _flag(sub.get("isDefault")), sub.get("source"),
               sub.get("createdAt") or details.get("updatedAt")])


def _append_media_delete(b, media_id):
    p = [media_id]
    b.add("core", "DELETE FROM media_external_ids WHERE media_id = ?;", p)
    b.add("core", "DELETE FROM media_genres WHERE media_id = ?;", p)
    b.add("core", "DELETE FROM playlist_items WHERE media_id = ?;", p)
    b.add("core", "DELETE FROM media_items WHERE id = ?;", p)
    b.add("metadata", "DELETE FROM media_roles WHERE media_id = ?;", p)
    b.add("metadata", "DELETE FROM media_trailers WHERE media_id = ?;", p)
    b.add("metadata", "DELETE FROM media_seasons WHERE media_id = ?;", p)
    b.add("metadata", "DELETE FROM media_episodes WHERE media_id = ?;", p)
    b.add("metadata", "DELETE FROM media_skip_markers WHERE media_id = ?;", p)
    b.add("metadata", "DELETE FROM media_file_desired_formats WHERE media_id = ?;", p)
    b.add("metadata", "DELETE FROM media_files WHERE media_id = ?;", p)
    b.add("playback", "DELETE FROM media_format_chunks WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);", p)
    b.add("playback", "DELETE FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);", p)
    b.add("playback", "DELETE FROM media_formats WHERE media_id = ?;", p)
    b.add("playback", "DELETE FROM media_audio_chunks WHERE track_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ?);", p)
    b.add("playback", "DELETE FROM media_audio_tracks WHERE media_id = ?;", p)
    b.add("playback", "DELETE FROM media_subtitles WHERE media_id = ?;", p)
    b.add("playback", "DELETE FROM media_local_downloads WHERE media_id = ?;", p)
    b.add("ingest", "DELETE FROM ingest_job_events WHERE job_id IN (SELECT id FROM ingest_jobs WHERE media_id = ?);", p)
    b.add("ingest", "DELETE FROM ingest_jobs WHERE media_id = ?;", p)
    b.add("templates", "DELETE FROM media_skip_analysis WHERE media_id = ?;", p)


def build_op_statements(op, id_gen):
    b = _Builders()
    kind = op.get("type")
    p = op.get("payload") or {}
    if kind == "playlist.create":
        system = SYSTEM_PLAYLISTS.get(p.get("slug"))
        if system:
            # LIB-SYNC-10: one id everywhere; a create naming another id (older build) never replaces the row.
            b.add("core", "INSERT OR IGNORE INTO playlists (id, name, slug, is_system, created_at) VALUES (?, ?, ?, ?, ?);",
                  [system[0], system[1], p.get("slug"), system[2], p.get("createdAt")])
        else:
            b.add("core", "INSERT OR REPLACE INTO playlists (id, name, slug, is_system, created_at) VALUES (?, ?, ?, ?, ?);",
                  [p.get("id"), p.get("name"), p.get("slug"), _flag(p.get("isSystem")), p.get("createdAt")])
    elif kind == "playlist.delete":
        b.add("core", "DELETE FROM playlists WHERE id = ? AND is_system = 0;", [p.get("id")])
    elif kind == "playlist.item.add":
        # LIB-SYNC-10: an item naming a playlist (or title) this library does not hold is dropped.
        b.add("core", "INSERT OR IGNORE INTO playlist_items (id, playlist_id, media_id, added_at) "
                      "SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM playlists WHERE id = ?) "
                      "AND EXISTS (SELECT 1 FROM media_items WHERE id = ?);",
              [p.get("id"), p.get("playlistId"), p.get("mediaId"), p.get("addedAt"), p.get("playlistId"), p.get("mediaId")])
    elif kind == "playlist.item.remove":
        b.add("core", "DELETE FROM playlist_items WHERE playlist_id = ? AND media_id = ?;", [p.get("playlistId"), p.get("mediaId")])
    elif kind == "media.upsert":
        details = p["details"]
        _append_media_core(b, details, id_gen)
        _append_media_metadata(b, details, id_gen)
        _append_media_playback(b, details, id_gen)
        b.add("templates", "DELETE FROM media_skip_analysis WHERE media_id = ?;", [details["id"]])
    elif kind == "media.delete":
        _append_media_delete(b, p.get("mediaId"))
    elif kind == "media.progress":
        # Progress has its own clock, the row's last_watched_at: an older progress op is ignored, an equal one
        # applies. updated_at is the clock of the media's details and is left alone (LIB-SYNC-08).
        b.add("core", """UPDATE media_items SET progress_pct = ?, last_watched_at = ?
     WHERE id = ? AND (last_watched_at IS NULL OR last_watched_at <= ?);""",
              [p.get("progressPct"), p.get("lastWatchedAt"), p.get("mediaId"), p.get("updatedAt")])
    elif kind == "setting.set":
        b.add("core", """INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= app_settings.updated_at;""",
              [p.get("key"), p.get("value"), p.get("updatedAt")])
    elif kind == "ingest.job.upsert":
        job = p["job"]
        b.add("ingest", """INSERT INTO ingest_jobs (
      id, media_id, file_id, worker_peer_id, owner_client_id, kind, status, progress_pct,
      error_code, error_message, meta_json, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      media_id = excluded.media_id,
      file_id = excluded.file_id,
      worker_peer_id = excluded.worker_peer_id,
      owner_client_id = excluded.owner_client_id,
      kind = excluded.kind,
      status = excluded.status,
      progress_pct = excluded.progress_pct,
      error_code = excluded.error_code,
      error_message = excluded.error_message,
      meta_json = excluded.meta_json,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at;""",
              [job.get("id"), job.get("mediaId"), job.get("fileId"), job.get("workerPeerId"), job.get("ownerClientId"),
               job.get("kind"), job.get("status"), _clamp_progress_pct(job.get("progressPct")), job.get("errorCode"),
               job.get("errorMessage"), _meta_json(job.get("meta")), job.get("createdAt"), job.get("updatedAt"),
               job.get("completedAt")])
    elif kind == "ingest.job.delete":
        b.add("ingest", "DELETE FROM ingest_job_events WHERE job_id = ?;", [p.get("jobId")])
        b.add("ingest", "DELETE FROM ingest_jobs WHERE id = ?;", [p.get("jobId")])
    elif kind == "ingest.job.event.add":
        e = p["event"]
        b.add("ingest", """INSERT OR IGNORE INTO ingest_job_events (id, job_id, level, message, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?);""",
              [e.get("id"), e.get("jobId"), e.get("level"), e.get("message"), _meta_json(e.get("meta")), e.get("createdAt")])
    elif kind == "ingest.job.history.clear":
        media_id = p.get("mediaId")
        ph = ", ".join("?" for _ in TERMINAL_INGEST_STATUSES)
        b.add("ingest", """DELETE FROM ingest_job_events
     WHERE job_id IN (
       SELECT id FROM ingest_jobs WHERE media_id = ? AND status IN (%s)
     );""" % ph, [media_id] + list(TERMINAL_INGEST_STATUSES))
        b.add("ingest", "DELETE FROM ingest_jobs WHERE media_id = ? AND status IN (%s);" % ph, [media_id] + list(TERMINAL_INGEST_STATUSES))
    else:
        raise UnknownOpTypeError(str(kind))
    return b.flatten()

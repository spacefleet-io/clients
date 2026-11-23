# -*- coding: utf-8 -*-
"""Build the `MediaDetails` JSON of one title from the addon's combined library database.

Python port of `LibraryDb.getMediaDetails` (packages/library-db-runtime/src/libraryDb.ts) plus the
detail-level equivalents of the desktop writes that end in `queueMediaUpsert`:

* `with_track_defaults`   -> setDefaultAudioTrack / setDefaultSubtitleTrack / setPreferredAudioLanguage
* `without_episode_files` -> deleteMediaFile
* `make_upsert_op`        -> the `media.upsert` op the desktop queues (`{details}` payload)

The result of `build_media_details` is exactly what `ops_sql.build_op_statements` consumes for a
`media.upsert`: applying the op to an empty database reproduces the same rows.

Known, deliberate differences from the TS implementation are listed per function.
"""
import copy
import json
import math
import time
import uuid

import progress as prog
from ops_sql import CATALOG_ID_SOURCES_SQL

# Same prefixes as libraryDb.ts (buildTemplateFormatId / AudioId / SubtitleId).
TEMPLATE_FORMAT_PREFIX = "tmpl-format:"
TEMPLATE_AUDIO_PREFIX = "tmpl-audio:"
TEMPLATE_SUBTITLE_PREFIX = "tmpl-sub:"
EPISODE_RESUME_KEY_PREFIX = "episode_resume_v1:"

#: Sentinel: "leave the subtitle choice as it is" (None means "subtitles off").
UNCHANGED = object()

_IN_CHUNK = 400  # stay far below SQLite's historical 999 variable limit


def now_iso():
    t = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".%03dZ" % int((t % 1) * 1000)


# ---------------------------------------------------------------------------- value coercion (JS Number/String)
def _num(value):
    """JS `Number(x)` result as it would look after a JSON round trip: whole floats become ints."""
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, float):
        if math.isfinite(value) and value == int(value):
            return int(value)
        return value
    if isinstance(value, int):
        return value
    try:
        text = str(value).strip()
        if "_" in text:
            return None
        return _num(float(text) if text else 0)
    except (TypeError, ValueError):
        return None


def _finite(value):
    n = _num(value)
    return n if (n is not None and math.isfinite(n)) else None


def _s(value):
    """JS `String(x)`."""
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    return str(value)


def _opt_s(value):
    """`row.x ? String(row.x) : null`."""
    return _s(value) if value else None


def _opt_n(value):
    """`row.x === null || undefined ? null : Number(row.x)`."""
    return None if value is None else _num(value)


def _rows(conn, sql, params=()):
    return [tuple(r) for r in conn.execute(sql, params).fetchall()]


def _has_table(conn, name):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone() is not None


def _has_column(conn, table, column):
    return any(r[1] == column for r in conn.execute("PRAGMA table_info(%s)" % table).fetchall())


def _chunks(items):
    items = list(items)
    for i in range(0, len(items), _IN_CHUNK):
        yield items[i:i + _IN_CHUNK]


def _marks(n):
    return ",".join("?" * n)


# ---------------------------------------------------------------------------- loaders
def _load_chunks(conn, table, owner_col, owner_sql, owner_params):
    """{owner id: [{key, sizeBytes, startSeconds}]} ordered by owner id then order_index."""
    out = {}
    sql = ("SELECT %s, chunk_key, order_index, size_bytes, start_seconds FROM %s WHERE %s IN (%s) "
           "ORDER BY %s ASC, order_index ASC" % (owner_col, table, owner_col, owner_sql, owner_col))
    for owner, key, _order, size, start in _rows(conn, sql, owner_params):
        out.setdefault(_s(owner), []).append({"key": _s(key), "sizeBytes": _opt_n(size), "startSeconds": _opt_n(start)})
    return out


def _load_template_chunks(conn, table, owner_col, ids):
    out = {}
    for part in _chunks(ids):
        for owner, chunk_list in _load_chunks(conn, table, owner_col, _marks(len(part)), part).items():
            out[owner] = chunk_list
    return out


def _template_data(conn, template_ids):
    """Everything the projection of template-backed files needs; empty when the templates tables are absent."""
    data = {"formats": {}, "format_chunks": {}, "chapters": {}, "audio": {}, "audio_chunks": {}, "subs": {}}
    if not template_ids or not _has_table(conn, "media_template_formats"):
        return data
    ids = list(template_ids)
    for part in _chunks(ids):
        m = _marks(len(part))
        for r in _rows(conn, "SELECT id, template_id, quality, codec, codec_string, bitrate_kbps, init_key, init_size, "
                             "duration_seconds, total_size, size_mb FROM media_template_formats WHERE template_id IN (%s) "
                             "ORDER BY quality DESC, codec ASC" % m, part):
            data["formats"].setdefault(_s(r[1]), []).append({
                "id": _s(r[0]), "quality": _s(r[2]), "codec": _s(r[3]), "codecString": _opt_s(r[4]),
                "bitrateKbps": _opt_n(r[5]), "initKey": _opt_s(r[6]), "initSize": _opt_n(r[7]),
                "durationSeconds": _opt_n(r[8]), "totalSize": _opt_n(r[9]), "sizeMb": _num(r[10])})
        for r in _rows(conn, "SELECT id, template_id, language, label, is_default, source, codec, codec_string, init_key, "
                             "init_size, duration_seconds, total_size FROM media_template_audio_tracks WHERE template_id IN (%s) "
                             "ORDER BY is_default DESC, language ASC" % m, part):
            data["audio"].setdefault(_s(r[1]), []).append({
                "id": _s(r[0]), "language": _s(r[2]), "label": _s(r[3]), "isDefault": bool(r[4]), "source": _s(r[5]),
                "codec": _opt_s(r[6]), "codecString": _opt_s(r[7]), "initKey": _opt_s(r[8]), "initSize": _opt_n(r[9]),
                "durationSeconds": _opt_n(r[10]), "totalSize": _opt_n(r[11])})
        for r in _rows(conn, "SELECT id, template_id, language, label, object_key, format, is_default, source "
                             "FROM media_template_subtitles WHERE template_id IN (%s) "
                             "ORDER BY is_default DESC, language ASC" % m, part):
            data["subs"].setdefault(_s(r[1]), []).append({
                "id": _s(r[0]), "language": _s(r[2]), "label": _s(r[3]), "objectKey": _opt_s(r[4]),
                "format": _opt_s(r[5]), "isDefault": bool(r[6]), "source": _s(r[7])})
    format_ids = [f["id"] for fs in data["formats"].values() for f in fs]
    audio_ids = [a["id"] for al in data["audio"].values() for a in al]
    data["format_chunks"] = _load_template_chunks(conn, "media_template_format_chunks", "format_id", format_ids)
    data["audio_chunks"] = _load_template_chunks(conn, "media_template_audio_chunks", "track_id", audio_ids)
    for part in _chunks(format_ids):
        for fid, title, start in _rows(conn, "SELECT format_id, title, start_seconds FROM media_template_chapters "
                                             "WHERE format_id IN (%s) ORDER BY format_id ASC, start_seconds ASC" % _marks(len(part)), part):
            data["chapters"].setdefault(_s(fid), []).append({"title": _s(title), "startSeconds": _num(start)})
    return data


def _tv_progress_aggregate(conn, media_id, today=None):
    """libraryDb.getTvProgressAggregate (LIB-PROG-01): the regular episodes' resume pct over every aired episode."""
    media = conn.execute("SELECT total_episodes FROM media_items WHERE id = ?", (media_id,)).fetchone()
    episode_rows = _rows(conn, "SELECT id, season_number, air_date FROM media_episodes WHERE media_id = ?", (media_id,))
    if not episode_rows:
        return None
    season_by_key = dict((EPISODE_RESUME_KEY_PREFIX + _s(r[0]), r[1]) for r in episode_rows)
    # Range scan in key order == the order SQLite yields rows for the desktop's `key IN (...)` lookup.
    rows = _rows(conn, "SELECT key, value FROM app_settings WHERE key >= ? AND key < ? ORDER BY key",
                 (EPISODE_RESUME_KEY_PREFIX, EPISODE_RESUME_KEY_PREFIX[:-1] + ";"))
    watched = []
    latest = None
    for key, value in rows:
        if key not in season_by_key or not value:
            continue
        try:
            parsed = json.loads(value)
            if not isinstance(parsed, dict) or "progressPct" not in parsed:
                continue
            raw = parsed["progressPct"]
            pct = 0 if raw is None else _finite(raw)  # JS Number(null) === 0
        except ValueError:
            pct = None
        if pct is None:
            continue
        watched.append((season_by_key[key], pct))
        updated = parsed.get("updatedAt")
        if isinstance(updated, str) and updated and (latest is None or updated > latest):
            latest = updated
    configured = _finite(media[0]) if media is not None and media[0] is not None else None
    total = prog.show_episode_total([(r[1], r[2]) for r in episode_rows], configured, today or prog.air_date_today())
    if total is None:
        return None
    return {"progressPct": _num(prog.show_watched_pct(watched, total[0])), "lastWatchedAt": latest}


def _resolve_episode_id(conn, media_id, season, episode):
    season, episode = _finite(season), _finite(episode)
    if season is None or episode is None:
        return None
    row = conn.execute("SELECT id FROM media_episodes WHERE media_id = ? AND season_number = ? AND episode_number = ? LIMIT 1",
                       (media_id, season, episode)).fetchone()
    return _s(row[0]) if row and row[0] else None


# Mirrors QUALITY_RANK / backfillMissingIsSourceFlags in packages/library-db-definition/src/migrations.ts.
_QUALITY_RANK = {"2160p": 0, "1080p": 1, "720p": 2, "480p": 3, "360p": 4, "240p": 5, "144p": 6}


def _heal_source_flags(formats):
    """The desktop re-flags `is_source` on EVERY playback-DB open: a file with no `is_source = 1` format gets its
    highest-resolution format flagged (ties: lowest id). Rows replayed from older op streams (and everything the
    addon receives from them) carry 0, and an upsert that echoed 0 back would reset the flag on other devices, so
    the details apply the same rule the desktop's own getMediaDetails would see after its open-time heal."""
    flagged = set(f["fileId"] for f in formats if f["isSource"])
    winners = {}
    for f in formats:
        if f["isSource"]:
            continue
        rank = _QUALITY_RANK.get(f["quality"], float("inf"))
        current = winners.get(f["fileId"])
        if current is None or rank < current[0] or (rank == current[0] and f["id"] < current[1]["id"]):
            winners[f["fileId"]] = (rank, f)
    for file_id, (_rank, fmt) in winners.items():
        if file_id not in flagged:
            fmt["isSource"] = True


def _preview_sheets(raw):
    """`media_formats.preview_sheets` (JSON MediaPreviewSheets) as a dict, or None when absent or unreadable."""
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


# ---------------------------------------------------------------------------- build_media_details
def build_media_details(conn, media_id, heal_is_source=True):
    """`LibraryDb.getMediaDetails(mediaId)`: the full MediaDetails dict, or None when the media does not exist.

    Differences from the TS runtime: whole-valued floats are emitted as ints (JSON has a single number type; JS
    never prints `1.0`); with `heal_is_source` (default) the desktop's open-time `is_source` backfill is applied
    to the result (see `_heal_source_flags`). Template-projected rows (files with `template_id`) get
    `createdAt = now` like the desktop, so those are the only non-deterministic values.
    """
    row = conn.execute(
        "SELECT id, type, title, original_title, original_language, overview, year, rating, poster_path, backdrop_path, "
        "added_at, updated_at, has_files, progress_pct, last_watched_at, preferred_audio_language, total_episodes, "
        "COALESCE(total_episodes, 0) FROM media_items WHERE id = ? LIMIT 1", (media_id,)).fetchone()
    if row is None:
        return None
    (mid, mtype, title, original_title, original_language, overview, year, rating, poster, backdrop, added_at,
     updated_at, has_files, progress_pct, last_watched_at, preferred, total_episodes, episode_count) = tuple(row)
    mid = _s(mid)
    progress = _num(progress_pct) if _finite(progress_pct) is not None else 0
    if _s(mtype) == "tv":
        aggregate = _tv_progress_aggregate(conn, mid)
        if aggregate:
            progress = aggregate["progressPct"]
            if aggregate["lastWatchedAt"]:
                last_watched_at = aggregate["lastWatchedAt"]

    catalog_row = conn.execute("SELECT external_id FROM media_external_ids WHERE media_id = ? AND source IN (%s) LIMIT 1;"
                               % CATALOG_ID_SOURCES_SQL, (mid,)).fetchone()
    catalog_id = _finite(_s(catalog_row[0])) if catalog_row else None
    genres = []
    for (genre_id,) in _rows(conn, "SELECT genre_id FROM media_genres WHERE media_id IN (?)", (mid,)):
        g = _finite(genre_id)
        if g is not None:
            genres.append(g)

    media = {
        "id": mid,
        "type": "tv" if _s(mtype) == "tv" else "movie",
        "catalogId": catalog_id,
        "title": _s(title),
        "originalTitle": _opt_s(original_title),
        "originalLanguage": _opt_s(original_language),
        "overview": _opt_s(overview),
        "year": _opt_s(year),
        "rating": _num(rating) if (isinstance(rating, (int, float)) or rating) else None,
        "posterPath": _opt_s(poster),
        "backdropPath": _opt_s(backdrop),
        "genres": genres,
        "addedAt": _s(added_at),
        "updatedAt": _s(updated_at),
        "hasFiles": _num(has_files) == 1,
        "progressPct": progress,
        "lastWatchedAt": _opt_s(last_watched_at),
        "preferredAudioLanguage": _opt_s(preferred),
        "totalEpisodes": _num(total_episodes) if _finite(total_episodes) is not None else (0 if total_episodes is None else None),
        "episodeCount": _num(episode_count) if _finite(episode_count) is not None else 0,
    }

    # cast
    cast_rows = _rows(conn, "SELECT media_roles.id, media_roles.person_id, people.name, media_roles.role, people.profile_path "
                            "FROM media_roles INNER JOIN people ON media_roles.person_id = people.id "
                            "WHERE media_roles.media_id = ? ORDER BY media_roles.order_index ASC, people.name ASC", (mid,))
    person_catalog_ids = {}
    person_ids = [_s(r[1]) for r in cast_rows]
    for part in _chunks(person_ids):
        for person_id, external_id in _rows(
                conn, "SELECT person_id, external_id FROM people_external_ids WHERE person_id IN (%s) AND source IN (%s)"
                % (_marks(len(part)), CATALOG_ID_SOURCES_SQL), part):
            person_catalog_ids[_s(person_id)] = _finite(_s(external_id))
    cast = []
    for cid, person_id, name, role, profile_path in cast_rows:
        cast.append({
            "id": _s(cid), "personId": _s(person_id),
            "catalogId": person_catalog_ids.get(_s(person_id)),
            "name": _s(name), "role": _opt_s(role), "profilePath": _opt_s(profile_path)})

    trailers = [{"provider": "youtube", "key": _s(k), "name": _opt_s(n), "language": _s(lang) if lang else "und"}
                for k, n, lang in _rows(conn, "SELECT key, name, language FROM media_trailers WHERE media_id = ?", (mid,))]

    seasons = []
    for sid, number, name, overview_s, poster_s, count, air in _rows(
            conn, "SELECT id, season_number, title, overview, poster_path, episode_count, air_date FROM media_seasons "
                  "WHERE media_id = ? ORDER BY season_number ASC", (mid,)):
        seasons.append({"id": _s(sid), "seasonNumber": _num(number), "name": _s(name), "overview": _opt_s(overview_s),
                        "posterPath": _opt_s(poster_s),
                        "episodeCount": _num(count) if _finite(count) is not None else 0,
                        "airDate": _opt_s(air)})

    episodes = [{"id": _s(eid), "seasonNumber": _num(sn), "episodeNumber": _num(en), "name": _s(name),
                 "overview": _opt_s(ov), "stillPath": _opt_s(still), "airDate": _opt_s(air)}
                for eid, sn, en, name, ov, still, air in _rows(
                    conn, "SELECT id, season_number, episode_number, title, overview, still_path, air_date FROM media_episodes "
                          "WHERE media_id = ? ORDER BY season_number ASC, episode_number ASC", (mid,))]

    has_template_col = _has_column(conn, "media_files", "template_id")
    file_rows = _rows(conn, "SELECT id, filename, season, episode, %s FROM media_files WHERE media_id = ?"
                      % ("template_id" if has_template_col else "NULL"), (mid,))
    desired = {}
    for fid, quality, codec, bitrate in _rows(
            conn, "SELECT file_id, quality, codec, bitrate_kbps FROM media_file_desired_formats "
                  "WHERE file_id IN (SELECT id FROM media_files WHERE media_id = ?) ORDER BY quality ASC, codec ASC", (mid,)):
        desired.setdefault(_s(fid), []).append({"quality": _s(quality), "codec": _s(codec), "bitrateKbps": _opt_n(bitrate)})
    files = [{"id": _s(fid), "filename": _s(fn), "season": None if s is None else _num(s),
              "episode": None if e is None else _num(e), "desiredFormats": desired.get(_s(fid), [])}
             for fid, fn, s, e, _t in file_rows]
    template_files = [r for r in file_rows if r[4]]
    tmpl = _template_data(conn, sorted(set(_s(r[4]) for r in template_files)))

    # formats
    has_previews_col = _has_column(conn, "media_formats", "preview_sheets")
    format_rows = _rows(conn, "SELECT id, media_id, file_id, quality, codec, codec_string, bitrate_kbps, init_key, init_size, "
                              "duration_seconds, total_size, size_mb, is_source, %s FROM media_formats WHERE media_id = ? "
                              "ORDER BY quality DESC, codec ASC" % ("preview_sheets" if has_previews_col else "NULL"), (mid,))
    format_chunks = _load_chunks(conn, "media_format_chunks", "format_id", "SELECT id FROM media_formats WHERE media_id = ?", (mid,))
    formats = [{
        "id": _s(r[0]), "mediaId": _s(r[1]), "fileId": _s(r[2]), "quality": _s(r[3]), "codec": _s(r[4]),
        "codecString": _opt_s(r[5]), "bitrateKbps": _opt_n(r[6]), "initKey": _opt_s(r[7]), "initSize": _opt_n(r[8]),
        "durationSeconds": _opt_n(r[9]), "totalSize": _opt_n(r[10]), "sizeMb": _num(r[11]),
        "isSource": (_num(r[12]) if r[12] is not None else 0) == 1,
        "chunks": format_chunks.get(_s(r[0]), [])} for r in format_rows]
    # Seek-bar preview sheets (MPV-PREV-01). Documented difference: the desktop emits `previewSheets: null` for a
    # format without them; the add-on leaves the field out instead, so an upsert it publishes never clears a record
    # its own DB missed (ops.ts keeps the stored value for a format without the field).
    for fmt, r in zip(formats, format_rows):
        previews = _preview_sheets(r[13])
        if previews is not None:
            fmt["previewSheets"] = previews
    if heal_is_source:
        _heal_source_flags(formats)
    for f in template_files:
        template_id, file_id = _s(f[4]), _s(f[0])
        for fmt in tmpl["formats"].get(template_id, []):
            formats.append({
                "id": "%s%s:%s" % (TEMPLATE_FORMAT_PREFIX, fmt["id"], file_id), "mediaId": mid, "fileId": file_id,
                "quality": fmt["quality"], "codec": fmt["codec"], "codecString": fmt["codecString"],
                "bitrateKbps": fmt["bitrateKbps"], "initKey": fmt["initKey"], "initSize": fmt["initSize"],
                "durationSeconds": fmt["durationSeconds"], "totalSize": fmt["totalSize"], "sizeMb": fmt["sizeMb"],
                "isSource": False, "chunks": tmpl["format_chunks"].get(fmt["id"], [])})

    # audio tracks
    audio_rows = _rows(conn, "SELECT id, media_id, file_id, episode_id, language, label, is_default, source, codec, codec_string, "
                             "init_key, init_size, duration_seconds, total_size FROM media_audio_tracks WHERE media_id = ? "
                             "ORDER BY is_default DESC, language ASC", (mid,))
    audio_chunks = _load_chunks(conn, "media_audio_chunks", "track_id", "SELECT id FROM media_audio_tracks WHERE media_id = ?", (mid,))
    audio_tracks = [{
        "id": _s(r[0]), "mediaId": _s(r[1]), "fileId": _opt_s(r[2]), "episodeId": _opt_s(r[3]), "language": _s(r[4]),
        "label": _s(r[5]), "isDefault": bool(r[6]), "source": _s(r[7]), "codec": _opt_s(r[8]), "codecString": _opt_s(r[9]),
        "initKey": _opt_s(r[10]), "initSize": _opt_n(r[11]), "durationSeconds": _opt_n(r[12]), "totalSize": _opt_n(r[13]),
        "chunks": audio_chunks.get(_s(r[0]), [])} for r in audio_rows]
    for f in template_files:
        template_id, file_id = _s(f[4]), _s(f[0])
        episode_id = _resolve_episode_id(conn, mid, f[2], f[3])
        for track in tmpl["audio"].get(template_id, []):
            audio_tracks.append({
                "id": "%s%s:%s" % (TEMPLATE_AUDIO_PREFIX, track["id"], file_id), "mediaId": mid, "fileId": file_id,
                "episodeId": episode_id, "language": track["language"], "label": track["label"],
                "isDefault": track["isDefault"], "source": track["source"], "codec": track["codec"],
                "codecString": track["codecString"], "initKey": track["initKey"], "initSize": track["initSize"],
                "durationSeconds": track["durationSeconds"], "totalSize": track["totalSize"],
                "chunks": tmpl["audio_chunks"].get(track["id"], [])})

    # subtitles (OCR twins included: the upsert replaces every row, so the twin and its link must round-trip)
    # A DB from before the column carries no twin: its payload keeps the old shape (no `derivedFromSubtitleId` key).
    has_derived = _has_column(conn, "media_subtitles", "derived_from_subtitle_id")
    subtitle_tracks = [{
        "id": _s(r[0]), "mediaId": _s(r[1]), "fileId": _opt_s(r[2]), "episodeId": _opt_s(r[3]), "language": _s(r[4]),
        "label": _s(r[5]), "objectKey": _opt_s(r[6]), "format": _opt_s(r[7]), "isDefault": bool(r[8]), "source": _s(r[9]),
        "createdAt": _s(r[10]) if r[10] else now_iso(),
        **({"derivedFromSubtitleId": _opt_s(r[11])} if has_derived else {})}
        for r in _rows(conn, "SELECT id, media_id, file_id, episode_id, language, label, object_key, format, is_default, source, "
                             "created_at%s FROM media_subtitles WHERE media_id = ? ORDER BY is_default DESC, language ASC"
                             % (", derived_from_subtitle_id" if has_derived else ""),
                       (mid,))]
    for f in template_files:
        template_id, file_id = _s(f[4]), _s(f[0])
        episode_id = _resolve_episode_id(conn, mid, f[2], f[3])
        for track in tmpl["subs"].get(template_id, []):
            subtitle_tracks.append({
                "id": "%s%s:%s" % (TEMPLATE_SUBTITLE_PREFIX, track["id"], file_id), "mediaId": mid, "fileId": file_id,
                "episodeId": episode_id, "language": track["language"], "label": track["label"],
                "objectKey": track["objectKey"], "format": track["format"], "isDefault": track["isDefault"],
                "source": track["source"], "createdAt": now_iso()})

    playlist_ids = [_s(r[0]) for r in _rows(conn, "SELECT playlist_id FROM playlist_items WHERE media_id = ?", (mid,))]

    chapters = [{"id": _s(cid), "formatId": _s(fid), "title": _s(t), "startSeconds": _num(s)}
                for cid, fid, t, s in _rows(
                    conn, "SELECT id, format_id, title, start_seconds FROM media_chapters WHERE format_id IN "
                          "(SELECT id FROM media_formats WHERE media_id = ?) ORDER BY start_seconds ASC", (mid,))]
    for f in template_files:
        template_id, file_id = _s(f[4]), _s(f[0])
        for fmt in tmpl["formats"].get(template_id, []):
            virtual_id = "%s%s:%s" % (TEMPLATE_FORMAT_PREFIX, fmt["id"], file_id)
            for index, chapter in enumerate(tmpl["chapters"].get(fmt["id"], [])):
                chapters.append({"id": "%s:%d" % (virtual_id, index), "formatId": virtual_id,
                                 "title": chapter["title"], "startSeconds": chapter["startSeconds"]})

    skip_markers = [{
        "id": _s(r[0]), "mediaId": _s(r[1]), "episodeId": _opt_s(r[2]), "type": _s(r[3]), "startSeconds": _num(r[4]),
        "endSeconds": _num(r[5]), "source": _s(r[6]), "confidence": _opt_n(r[7]), "createdAt": _s(r[8]), "updatedAt": _s(r[9])}
        for r in _rows(conn, "SELECT id, media_id, episode_id, type, start_seconds, end_seconds, source, confidence, created_at, "
                             "updated_at FROM media_skip_markers WHERE media_id = ? ORDER BY start_seconds ASC, type ASC", (mid,))]

    details = dict(media)
    details.update({
        "cast": cast, "trailers": trailers, "playlistIds": playlist_ids, "seasons": seasons, "episodes": episodes,
        "files": files, "formats": formats, "audioTracks": audio_tracks, "subtitleTracks": subtitle_tracks,
        "subtitles": subtitle_tracks, "chapters": chapters, "skipMarkers": skip_markers,
        "hasLocalFiles": bool(media["hasFiles"]),
    })
    return details


# ---------------------------------------------------------------------------- detail-level desktop writes
def _in_scope(track, episode_id):
    return (track.get("episodeId") or None) == (episode_id or None)


def is_ocr_twin(track):
    """OCR twin of a picture subtitle (PLAY-TRACK-05): text for the Android TV only, never a Kodi track."""
    return bool(track.get("derivedFromSubtitleId")) or track.get("source") == "ocr"


def _resort_defaults_first(tracks):
    """Order the DB query gives: `ORDER BY is_default DESC, language ASC`; template-projected rows stay appended."""
    direct = [t for t in tracks if not (t["id"].startswith(TEMPLATE_AUDIO_PREFIX) or t["id"].startswith(TEMPLATE_SUBTITLE_PREFIX))]
    projected = [t for t in tracks if t not in direct]
    direct.sort(key=lambda t: (0 if t["isDefault"] else 1, t["language"]))
    return direct + projected


def with_track_defaults(details, episode_id, audio_language=None, subtitle=UNCHANGED, audio_track_id=None,
                        subtitle_track_id=None, bump_updated_at=True, now=None):
    """Return a copy of `details` after the user picked an audio/subtitle track in Kodi.

    Mirrors LibraryDb.setDefaultAudioTrack / setDefaultSubtitleTrack / setPreferredAudioLanguage. The scope is
    the episode (`episode_id`) or, for movies, the tracks with no episode (`episode_id=None`): within it every
    `isDefault` is cleared and the chosen track is set. Tracks of other episodes are untouched.

    * `audio_language`: language code (case-insensitive, compared to `track.language`) of the audio track to
      make default; None leaves the audio choice alone. The first matching in-scope track in details order wins
      (default-first). `preferredAudioLanguage` is set to the trimmed language, as setPreferredAudioLanguage.
      A language with no in-scope track changes nothing (the desktop has no language-based setter; the renderer
      always passes a concrete track id).
    * `subtitle`: `UNCHANGED` (default) leaves subtitles alone; `None` means subtitles off (scope cleared, no
      default); a string selects the in-scope subtitle track with that language (case-insensitive).
    * `audio_track_id` / `subtitle_track_id`: select by track id instead of language (unknown id -> scope is
      cleared, like the desktop update that matches no row).
    * `updatedAt` is bumped to `now` (default: current time). The desktop's setDefault* do NOT touch
      media_items.updated_at; the bump is requested for the addon so remote devices see a changed row. Pass
      `bump_updated_at=False` for the exact desktop behaviour.
    * Differences from the desktop: template-projected tracks (`tmpl-audio:`/`tmpl-sub:` ids) are treated like
      direct ones (the desktop `UPDATE ... WHERE id = ?` cannot match a projected id).
    The tracks keep the DB ordering (defaults first, then language).
    """
    out = copy.deepcopy(details)
    if audio_language is not None and not str(audio_language).strip():
        audio_language = None
    if audio_language is not None or audio_track_id is not None:
        tracks = out.get("audioTracks") or []
        target = None
        if audio_track_id is not None:
            target = next((t for t in tracks if t["id"] == audio_track_id), None)
        else:
            wanted = str(audio_language).strip().lower()
            target = next((t for t in tracks if _in_scope(t, episode_id) and (t.get("language") or "").lower() == wanted), None)
        if target is not None or audio_track_id is not None:
            for t in tracks:
                if _in_scope(t, episode_id):
                    t["isDefault"] = False
            if target is not None:
                target["isDefault"] = True
            out["audioTracks"] = _resort_defaults_first(tracks)
        if audio_language is not None:
            out["preferredAudioLanguage"] = str(audio_language).strip()
    if subtitle is not UNCHANGED or subtitle_track_id is not None:
        tracks = out.get("subtitleTracks") or out.get("subtitles") or []
        target = None
        if subtitle_track_id is not None:
            target = next((t for t in tracks if t["id"] == subtitle_track_id), None)
        elif subtitle is not None:
            wanted = str(subtitle).strip().lower()
            target = next((t for t in tracks if _in_scope(t, episode_id) and not is_ocr_twin(t)
                           and (t.get("language") or "").lower() == wanted), None)
        for t in tracks:
            if _in_scope(t, episode_id):
                t["isDefault"] = False
        if target is not None:
            target["isDefault"] = True
        tracks = _resort_defaults_first(tracks)
        out["subtitleTracks"] = tracks
        out["subtitles"] = tracks
    if bump_updated_at:
        out["updatedAt"] = now or now_iso()
    return out


def without_episode_files(details, episode_id):
    """Return a copy of `details` as it is after LibraryDb.deleteMediaFile of the file(s) of `episode_id`.

    Files whose (season, episode) resolves to `episode_id` (None: files that resolve to no episode, i.e. a
    movie's files) are removed with their desired formats, formats (+ chunks, chapters) and any format/track
    projected from them. Like the desktop, ALL audio/subtitle tracks of that episode scope are deleted (not just
    those of the file), skip markers stay, `updatedAt` is not touched, and `hasFiles` / `hasLocalFiles` become
    "any file left".
    """
    out = copy.deepcopy(details)
    by_key = {}
    for ep in out.get("episodes") or []:
        by_key.setdefault((ep["seasonNumber"], ep["episodeNumber"]), ep["id"])

    def resolved(f):
        if f.get("season") is None or f.get("episode") is None:
            return None
        return by_key.get((f["season"], f["episode"]))

    gone = set(f["id"] for f in out.get("files") or [] if resolved(f) == (episode_id or None))
    out["files"] = [f for f in out.get("files") or [] if f["id"] not in gone]
    gone_formats = set(f["id"] for f in out.get("formats") or [] if f["fileId"] in gone)
    out["formats"] = [f for f in out.get("formats") or [] if f["id"] not in gone_formats]
    out["chapters"] = [c for c in out.get("chapters") or [] if c["formatId"] not in gone_formats]
    # Only touch the scope when a file was really removed (deleteMediaFile returns early for unknown files).
    if gone:
        out["audioTracks"] = [t for t in out.get("audioTracks") or [] if not _in_scope(t, episode_id) and t.get("fileId") not in gone]
        subs = [t for t in out.get("subtitleTracks") or [] if not _in_scope(t, episode_id) and t.get("fileId") not in gone]
        out["subtitleTracks"] = subs
        out["subtitles"] = subs
    out["hasFiles"] = bool(out["files"])
    out["hasLocalFiles"] = bool(out["files"])
    return out


def make_upsert_op(details, now=None, op_id=None):
    """The op the desktop queues (queueMediaUpsert) and library.write_op builds for ("media.upsert", {details})."""
    return {"id": op_id or str(uuid.uuid4()), "type": "media.upsert", "createdAt": now or now_iso(),
            "payload": {"details": details}}


def episode_storage_keys(details, episode_id):
    """Storage keys owned by one episode: LibraryDb.deleteEpisode's key set (formats + chunks + preview sheets of the
    episode's file, audio tracks of that file or episode with their chunks, subtitle objects of that file or episode).

    Returns [] when the episode or its file is unknown (nothing to delete)."""
    episode = next((e for e in details.get("episodes") or [] if e["id"] == episode_id), None)
    if not episode:
        return []
    file = next((f for f in details.get("files") or []
                 if f.get("season") == episode["seasonNumber"] and f.get("episode") == episode["episodeNumber"]), None)
    if not file:
        return []
    seen = {}

    def add(value):
        if isinstance(value, str) and value:
            seen[value] = True

    for fmt in details.get("formats") or []:
        if fmt.get("fileId") != file["id"]:
            continue
        add(fmt.get("initKey"))
        for sheet in (fmt.get("previewSheets") or {}).get("sheets") or []:
            add(sheet.get("objectKey"))
        for chunk in fmt.get("chunks") or []:
            add(chunk.get("key"))
    for track in details.get("audioTracks") or []:
        if track.get("fileId") != file["id"] and track.get("episodeId") != episode_id:
            continue
        add(track.get("initKey"))
        for chunk in track.get("chunks") or []:
            add(chunk.get("key"))
    for sub in details.get("subtitleTracks") or []:
        if sub.get("fileId") == file["id"] or sub.get("episodeId") == episode_id:
            add(sub.get("objectKey"))
    return list(seen)

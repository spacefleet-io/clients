# -*- coding: utf-8 -*-
"""INTG-KODI-02: export the Badger library as .strm/.nfo/artwork so Kodi's own library scanner imports it.

Layout (under <addon_data>/library/):
  movies/<Title (Year)>/<Title (Year)>.strm|.nfo|-poster.jpg|-fanart.jpg
  tvshows/<Show (Year)>/tvshow.nfo|poster.jpg|fanart.jpg
  tvshows/<Show (Year)>/Season NN/<Show> - SxxEyy - <Title>.strm|.nfo|-thumb.jpg
The .strm content is a plugin:// URL, so every library item plays through this addon (HLS + inputstream.adaptive).
We NEVER write Kodi's MyVideos.db: items reach the library through VideoLibrary.Scan, and watch state is pushed
with VideoLibrary.SetMovieDetails/SetEpisodeDetails.
"""
import json
import os
import re
import shutil
from xml.sax.saxutils import escape

import images
import localized_texts
import kodi_rpc
from compat import ADDON_ID, HAVE_KODI, data_dir, log
import core
from core import export_dir
import progress as prog

INDEX_FILE = "export_index.json"
_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_name(text, fallback="Untitled"):
    cleaned = _BAD.sub("", text or "").strip(" .")
    return cleaned or fallback


def strm_url(media_id, episode_id=None):
    url = "plugin://%s/play?media=%s" % (ADDON_ID, media_id)
    if episode_id:
        url += "&episode=%s" % episode_id
    return url + "&lib=1"


def movie_dir_name(media):
    year = media.get("year")
    base = safe_name(media.get("title"))
    return "%s (%s)" % (base, year) if year else base


def episode_basename(show_title, season, episode, title):
    return "%s - S%02dE%02d - %s" % (safe_name(show_title), season, episode, safe_name(title, "Episode %d" % episode))


def _x(tag, value):
    if value is None or value == "":
        return ""
    return "  <%s>%s</%s>\n" % (tag, escape(str(value)), tag)


def movie_nfo(media):
    out = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<movie>\n'
    out += _x("title", media.get("title")) + _x("originaltitle", media.get("original_title")) + _x("year", media.get("year"))
    out += _x("plot", media.get("overview"))
    if media.get("tmdb_id"):
        out += '  <uniqueid type="tmdb" default="true">%s</uniqueid>\n' % escape(str(media["tmdb_id"]))
    out += "  <spacebadger>%s</spacebadger>\n" % escape(media["id"])
    return out + "</movie>\n"


def tvshow_nfo(media):
    out = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<tvshow>\n'
    out += _x("title", media.get("title")) + _x("originaltitle", media.get("original_title")) + _x("year", media.get("year"))
    out += _x("plot", media.get("overview"))
    if media.get("tmdb_id"):
        out += '  <uniqueid type="tmdb" default="true">%s</uniqueid>\n' % escape(str(media["tmdb_id"]))
    return out + "</tvshow>\n"


def episode_nfo(show_title, ep):
    out = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<episodedetails>\n'
    out += _x("title", ep.get("title")) + _x("showtitle", show_title)
    out += _x("season", ep["season_number"]) + _x("episode", ep["episode_number"])
    out += _x("plot", ep.get("overview")) + _x("aired", ep.get("air_date"))
    return out + "</episodedetails>\n"


def _write_text(path, text):
    folder = os.path.dirname(path)
    if not os.path.isdir(folder):
        os.makedirs(folder)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            if fh.read() == text:
                return False
    except (IOError, OSError):
        pass
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return True


def _copy_art(src, dest):
    if not src or os.path.exists(dest):
        return False
    shutil.copyfile(src, dest)
    return True


def _art_dest(base_path_noext, src, suffix):
    ext = os.path.splitext(src)[1] if src else ".jpg"
    return "%s%s%s" % (base_path_noext, suffix, ext)


def kodi_paths():
    """special:// roots Kodi should use as video sources (Movies / TV shows)."""
    root = "special://profile/addon_data/%s/library/" % ADDON_ID
    return root + "movies/", root + "tvshows/"


def pending_art(want, art):
    """Vault pictures the export has no local file for yet (a failed download): a later export retries them. A provider
    path (its vault copy is not made yet) is not counted, so syncs do not re-export for it; the sync that brings its
    asset ref changes the library and exports again (META-ART-02)."""
    return sum(1 for w in dict.fromkeys(want) if images.display_source(w[1]) == "vault" and not art.get(w))


def export_library(ctx, with_art=True, language=None):
    """Write/refresh the export tree; remove entries no longer in the library. Returns stats dict: counts, plus
    `written` (files created or changed), `removed` (files/folders deleted) and `art_pending` (pictures not there yet,
    left for a later export). Synopses and episode names are the kept texts of `language` (Kodi's interface language
    by default, LIB-LANG-01); file names keep the stored episode names, so a language change renames nothing."""
    root = export_dir()
    lib = ctx.lib
    texts = localized_texts.Localizer(lib, language or localized_texts.kodi_language())
    index = {}
    stats = {"movies": 0, "shows": 0, "episodes": 0, "removed": 0, "written": 0, "art_pending": 0}
    wanted_dirs = set()

    movies = lib.list_media("movie")
    shows = lib.list_media("tv")
    want = []
    if with_art:
        for m in movies + shows:
            want.append(("poster", m.get("poster_path")))
            want.append(("backdrop", m.get("backdrop_path")))
        for show in shows:
            for ep in lib.episodes(show["id"]):
                if ep.get("still_path"):
                    want.append(("still", ep["still_path"]))
    art = images.fetch_many(ctx, want) if with_art else {}
    stats["art_pending"] = pending_art(want, art)

    def write(path, text):
        stats["written"] += _write_text(path, text)

    def copy_art(src, dest):
        stats["written"] += _copy_art(src, dest)

    for m in movies:
        folder = movie_dir_name(m)
        base = os.path.join(root, "movies", folder, folder)
        wanted_dirs.add(os.path.join("movies", folder))
        write(base + ".strm", strm_url(m["id"]) + "\n")
        write(base + ".nfo", movie_nfo(texts.media(m)))
        poster, back = art.get(("poster", m.get("poster_path"))), art.get(("backdrop", m.get("backdrop_path")))
        if poster:
            copy_art(poster, _art_dest(base, poster, "-poster"))
        if back:
            copy_art(back, _art_dest(base, back, "-fanart"))
        index["movies/%s/%s.strm" % (folder, folder)] = {"mediaId": m["id"], "episodeId": None}
        stats["movies"] += 1

    for show in shows:
        files = lib.episode_has_files(show["id"])
        playable = [e for e in lib.episodes(show["id"]) if (int(e["season_number"]), int(e["episode_number"])) in files]
        if not playable:
            continue
        folder = movie_dir_name(show)
        show_root = os.path.join(root, "tvshows", folder)
        wanted_dirs.add(os.path.join("tvshows", folder))
        write(os.path.join(show_root, "tvshow.nfo"), tvshow_nfo(texts.media(show)))
        poster, back = art.get(("poster", show.get("poster_path"))), art.get(("backdrop", show.get("backdrop_path")))
        if poster:
            copy_art(poster, _art_dest(os.path.join(show_root, "poster"), poster, ""))
        if back:
            copy_art(back, _art_dest(os.path.join(show_root, "fanart"), back, ""))
        wanted_names = set()
        for ep in playable:
            season_dir = "Season %02d" % int(ep["season_number"])
            name = episode_basename(show["title"], int(ep["season_number"]), int(ep["episode_number"]), ep.get("title"))
            base = os.path.join(show_root, season_dir, name)
            wanted_names.add((season_dir, name))
            write(base + ".strm", strm_url(show["id"], ep["id"]) + "\n")
            write(base + ".nfo", episode_nfo(show["title"], texts.episode(show, ep)))
            still = art.get(("still", ep.get("still_path")))
            if still:
                copy_art(still, _art_dest(base, still, "-thumb"))
            index["tvshows/%s/%s/%s.strm" % (folder, season_dir, name)] = {"mediaId": show["id"], "episodeId": ep["id"]}
            stats["episodes"] += 1
        _prune_episode_files(show_root, wanted_names, stats)
        stats["shows"] += 1

    for top in ("movies", "tvshows"):
        top_path = os.path.join(root, top)
        if not os.path.isdir(top_path):
            continue
        for name in os.listdir(top_path):
            rel = os.path.join(top, name)
            if rel not in wanted_dirs:
                shutil.rmtree(os.path.join(top_path, name), ignore_errors=True)
                stats["removed"] += 1
                log("export: removed stale %s" % rel)
    _save_index(index)
    log("export done: %s" % stats)
    return stats


def _prune_episode_files(show_root, wanted_names, stats):
    """Delete the .strm/.nfo/-thumb files of episodes that are no longer playable (a deleted episode keeps its show
    folder, so the stale-folder sweep never sees it and Kodi would re-add it on the next scan)."""
    if not os.path.isdir(show_root):
        return
    for season_dir in os.listdir(show_root):
        season_path = os.path.join(show_root, season_dir)
        if not os.path.isdir(season_path):
            continue
        for fname in os.listdir(season_path):
            stem = os.path.splitext(fname)[0]
            if stem.endswith("-thumb"):
                stem = stem[: -len("-thumb")]
            if (season_dir, stem) not in wanted_names:
                try:
                    os.remove(os.path.join(season_path, fname))
                    stats["removed"] += 1
                    log("export: removed stale episode file %s/%s" % (season_dir, fname))
                except OSError:
                    pass
        if not os.listdir(season_path):
            shutil.rmtree(season_path, ignore_errors=True)


def load_index():
    try:
        with open(os.path.join(data_dir(), INDEX_FILE)) as fh:
            return json.load(fh)
    except (IOError, OSError, ValueError):
        return {}


def _save_index(index):
    with open(os.path.join(data_dir(), INDEX_FILE), "w") as fh:
        json.dump(index, fh)


def remove_exported(media_id, episode_id=None):
    """INTG-DEL-01 after a delete: remove the exported files and index entries of that one title (or that one episode)
    instead of re-exporting the whole library. A show whose last exported episode goes loses its folder, as the full
    export would drop it. Returns the number of files/folders removed."""
    index = load_index()
    gone = [rel for rel, ids in index.items()
            if ids.get("mediaId") == media_id and (not episode_id or ids.get("episodeId") == episode_id)]
    if not gone:
        return 0
    root = export_dir()
    removed = 0
    for rel in gone:
        del index[rel]
        parts = rel.split("/")
        if not episode_id or parts[0] == "movies":
            folder = os.path.join(root, parts[0], parts[1])
            if os.path.isdir(folder):
                shutil.rmtree(folder, ignore_errors=True)
                removed += 1
            continue
        season_path = os.path.join(root, *parts[:-1])
        stem = os.path.splitext(parts[-1])[0]
        if not os.path.isdir(season_path):
            continue
        for fname in os.listdir(season_path):
            if os.path.splitext(fname)[0] in (stem, stem + "-thumb"):
                try:
                    os.remove(os.path.join(season_path, fname))
                    removed += 1
                except OSError:
                    pass
        if not os.listdir(season_path):
            shutil.rmtree(season_path, ignore_errors=True)
        if not any(ids.get("mediaId") == media_id for ids in index.values()):
            show_path = os.path.join(root, parts[0], parts[1])
            if os.path.isdir(show_path):
                shutil.rmtree(show_path, ignore_errors=True)
                removed += 1
    _save_index(index)
    log("export: removed %s%s only (%d files/folders)" % (media_id, " episode %s" % episode_id if episode_id else "", removed))
    return removed


def has_index():
    """True once an export wrote its index (a wipe or a fresh install has none)."""
    return os.path.isfile(os.path.join(data_dir(), INDEX_FILE))


def _our_fragment():
    return "plugin.video.spacebadger/library/"


def _rel_from_kodi_file(path):
    marker = "library/"
    i = path.find(_our_fragment())
    return path[i + len(_our_fragment()):] if i >= 0 else None


def scan_into_kodi():
    """Ask Kodi to scan our export folders (works for paths that are sources with content set)."""
    movies, tv = kodi_paths()
    for path in (movies, tv):
        try:
            kodi_rpc.scan(path)
            log("VideoLibrary.Scan requested for %s" % path)
        except kodi_rpc.RpcError as exc:
            log("VideoLibrary.Scan %s failed: %s" % (path, exc), "warning")


def kodi_items():
    """{relative strm path: kodi item dict + 'kind'} for our exported items currently in Kodi's library."""
    out = {}
    for m in kodi_rpc.library_movies_under(_our_fragment()):
        rel = _rel_from_kodi_file(m["file"])
        if rel:
            m["kind"] = "movie"
            out[rel] = m
    for e in kodi_rpc.library_episodes_under(_our_fragment()):
        rel = _rel_from_kodi_file(e["file"])
        if rel:
            e["kind"] = "episode"
            out[rel] = e
    return out


def push_watch_state(ctx, language=None):
    """Mirror our resume/watched state into Kodi's library (SetMovieDetails / SetEpisodeDetails), and the kept texts of
    Kodi's interface language where Kodi shows another synopsis or episode name (LIB-LANG-01): a scan reads an .nfo only
    when it adds the item, so an export with new texts reaches items Kodi already has through these calls."""
    index = load_index()
    items = kodi_items()
    texts = localized_texts.Localizer(ctx.lib, language or localized_texts.kodi_language())
    pushed = 0
    shows = {}
    for rel, item in items.items():
        ids = index.get(rel)
        if not ids:
            continue
        resume = None
        completed = False
        if item["kind"] == "movie":
            media = ctx.lib.get_media(ids["mediaId"]) or {}
            shown = texts.media(media) if media else {}
            pct = media.get("progress_pct") or 0
            completed = prog.is_completed(pct)
            seconds = None
            total = None
        else:
            stored = ctx.lib.episode_resume(ids["episodeId"]) or {}
            pct = stored.get("progressPct") or 0
            seconds = stored.get("positionSeconds")
            total = stored.get("durationSeconds")
            completed = prog.is_completed(pct, seconds, total)
            if ids["mediaId"] not in shows:
                shows[ids["mediaId"]] = ctx.lib.get_media(ids["mediaId"])
            episode = ctx.lib.get_episode(ids["episodeId"])
            shown = texts.episode(shows[ids["mediaId"]], episode) if shows[ids["mediaId"]] and episode else {}
        candidate = None if completed else prog.resume_candidate_seconds(pct, total, None, seconds) if total else None
        if item["kind"] == "movie" and not total:
            # movies carry only a percentage; Kodi needs absolute seconds: prefer the locally
            # remembered real position/duration (library duration can be wrong), else stream duration
            local = core.load_prefs().get(ids["mediaId"], {})
            local_pos, local_dur = local.get("resumeSeconds"), local.get("resumeDuration")
            if local_pos is not None and local_dur and abs(local_pos / local_dur * 100.0 - pct) < 0.5:
                total = local_dur
                candidate = None if completed else prog.resume_candidate_seconds(pct, local_dur, None, local_pos)
            else:
                unit = ctx.lib.playable_unit(ids["mediaId"])
                duration = max([f.get("duration_seconds") or 0 for f in unit["formats"]] or [0]) if unit else 0
                if duration:
                    total = duration
                    candidate = None if completed else prog.resume_candidate_seconds(pct, duration)
        params = {"playcount": 1 if completed else 0}
        if candidate and total:
            params["resume"] = {"position": float(candidate), "total": float(total)}
        else:
            params["resume"] = {"position": 0.0, "total": 0.0}
        params.update(_text_changes(item, shown))
        try:
            if item["kind"] == "movie":
                params["movieid"] = item["movieid"]
                kodi_rpc.call("VideoLibrary.SetMovieDetails", params)
            else:
                params["episodeid"] = item["episodeid"]
                kodi_rpc.call("VideoLibrary.SetEpisodeDetails", params)
            pushed += 1
        except kodi_rpc.RpcError:
            pass
    log("pushed watch state for %d Kodi library items" % pushed)
    _push_show_texts(index, texts, ctx.lib)
    return pushed


def _text_changes(item, shown):
    """The synopsis and episode name Kodi should show, where they differ from what it shows now."""
    changes = {}
    if shown.get("overview") and shown["overview"] != item.get("plot"):
        changes["plot"] = shown["overview"]
    if item["kind"] == "episode" and shown.get("title") and shown["title"] != item.get("title"):
        changes["title"] = shown["title"]
    return changes


def _push_show_texts(index, texts, lib):
    """A show's synopsis in the interface language, for shows Kodi already has (SetTVShowDetails)."""
    folders = {}
    for rel, ids in index.items():
        parts = rel.split("/")
        if parts[0] == "tvshows" and len(parts) > 2:
            folders.setdefault(parts[1], ids["mediaId"])
    if not folders:
        return
    try:
        kodi_shows = kodi_rpc.library_tvshows()
    except kodi_rpc.RpcError:
        return
    for show in kodi_shows:
        rel = _rel_from_kodi_file(show.get("file") or "")
        parts = (rel or "").strip("/").split("/")
        media_id = folders.get(parts[1]) if len(parts) > 1 and parts[0] == "tvshows" else None
        media = lib.get_media(media_id) if media_id else None
        if not media:
            continue
        plot = texts.media(media).get("overview")
        if plot and plot != show.get("plot"):
            try:
                kodi_rpc.call("VideoLibrary.SetTVShowDetails", {"tvshowid": show["tvshowid"], "plot": plot})
            except kodi_rpc.RpcError:
                pass


def remove_from_kodi(media_id, episode_id=None):
    """Targeted removal (RemoveMovie / RemoveEpisode) of everything exported for media_id, or only for one episode."""
    index = load_index()
    items = kodi_items()
    removed = 0
    for rel, item in items.items():
        ids = index.get(rel)
        if not ids or ids["mediaId"] != media_id:
            continue
        if episode_id and ids.get("episodeId") != episode_id:
            continue
        try:
            if item["kind"] == "movie":
                kodi_rpc.call("VideoLibrary.RemoveMovie", {"movieid": item["movieid"]})
            else:
                kodi_rpc.call("VideoLibrary.RemoveEpisode", {"episodeid": item["episodeid"]})
            removed += 1
        except kodi_rpc.RpcError:
            pass
    return removed


def remove_tvshow_from_kodi(media_id, title):
    for show in kodi_rpc.library_tvshows():
        if _our_fragment() in show.get("file", "") and show.get("title") == title:
            try:
                kodi_rpc.call("VideoLibrary.RemoveTVShow", {"tvshowid": show["tvshowid"]})
                return True
            except kodi_rpc.RpcError:
                pass
    return False


def remove_export_files_for(media):
    """Delete the export folder of one media item (media row dict)."""
    top = "movies" if media["type"] == "movie" else "tvshows"
    path = os.path.join(export_dir(), top, movie_dir_name(media))
    shutil.rmtree(path, ignore_errors=True)
    return True


def remove_all_from_kodi():
    """ACCT-DEV-01: remove every movie, episode and show that came from our export folder from Kodi's video library
    (official VideoLibrary.Remove* JSON-RPC only). Returns the number of removed items; 0 outside Kodi."""
    if not HAVE_KODI:
        return 0
    removed = 0
    for movie in kodi_rpc.library_movies_under(_our_fragment()):
        try:
            kodi_rpc.call("VideoLibrary.RemoveMovie", {"movieid": movie["movieid"]})
            removed += 1
        except kodi_rpc.RpcError:
            pass
    for ep in kodi_rpc.library_episodes_under(_our_fragment()):
        try:
            kodi_rpc.call("VideoLibrary.RemoveEpisode", {"episodeid": ep["episodeid"]})
            removed += 1
        except kodi_rpc.RpcError:
            pass
    for show in kodi_rpc.library_tvshows():
        if _our_fragment() in show.get("file", ""):
            try:
                kodi_rpc.call("VideoLibrary.RemoveTVShow", {"tvshowid": show["tvshowid"]})
                removed += 1
            except kodi_rpc.RpcError:
                pass
    return removed

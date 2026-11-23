# -*- coding: utf-8 -*-
"""Play flow (resolve to the local HLS server), unpaid notices and permanent delete (INTG-DEL-01)."""
import json
import urllib.parse

import details as details_mod
import export
import hls
import images
import localized_texts
import progress as prog
import profiles
import stream_slot
from api import ApiError, PlaybackStoppedError, PlaybackUnavailableError, UnauthorizedError, UnpaidError
from compat import ADDON_ID, RENEW_URL, HAVE_KODI, get_prop, log, notify, ok_dialog, set_prop, yes_no
import core

if HAVE_KODI:
    import xbmc
    import xbmcgui
    import xbmcplugin

TEXT_SUB_FORMATS = ("srt", "ass", "ssa", "vtt", "sub", "sup")


def fmt_clock(seconds):
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return "%d:%02d:%02d" % (h, m, s) if h else "%d:%02d" % (m, s)


def human_date(iso):
    """'2026-11-30T00:00:00.000Z' -> '30 November 2026' (plain English for the unpaid notice); unparsable input is returned as is."""
    months = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
    try:
        year, month, day = (int(p) for p in str(iso)[:10].split("-"))
        return "%d %s %d" % (day, months[month - 1], year)
    except (ValueError, IndexError):
        return str(iso)


def unpaid_message(wipe_at):
    text = "Your Badger subscription is unpaid, so playback is paused."
    if wipe_at:
        text += " Your library data will be removed on %s unless you renew." % human_date(wipe_at)
    return text + "\nRenew at %s" % RENEW_URL


def show_unpaid(wipe_at):
    ok_dialog("Badger: subscription unpaid", unpaid_message(wipe_at))


def unavailable_message(error):
    """STOR-BW-07 / STOR-BW-08: a saturated silo refused or stopped a free viewer's playback. Nothing resumes by itself."""
    if isinstance(error, PlaybackStoppedError):
        text = "Playback was stopped: the Badger server holding this title is saturated. Press play again once traffic has eased."
    else:
        text = "Playback is unavailable right now: the Badger server holding this title is saturated and new playback is paused for free accounts. Try again in a few minutes."
    return text + "\nPaid plans keep playing: %s" % RENEW_URL


def next_episode(lib, media_id, episode_id):
    """Next episode (by season/episode order) that has a playable file, or None."""
    files = lib.episode_has_files(media_id)
    ordered = [e for e in lib.episodes(media_id) if (int(e["season_number"]), int(e["episode_number"])) in files and int(e["season_number"]) > 0]
    for i, ep in enumerate(ordered):
        if ep["id"] == episode_id and i + 1 < len(ordered):
            return ordered[i + 1]
    return None


def resume_seconds(ctx, unit):
    """Resume point (seconds) for the unit, or None (INTG-SYNC-01 thresholds)."""
    media = unit["media"]
    markers = unit.get("markers") or []
    credits = next((m["start_seconds"] for m in markers if m["type"] == "credits"), None)
    duration = max([f.get("duration_seconds") or 0 for f in unit["formats"]] or [0])
    if unit.get("episode"):
        stored = ctx.lib.episode_resume(unit["episode"]["id"])
        if not stored:
            return None
        return prog.resume_candidate_seconds(stored.get("progressPct"), stored.get("durationSeconds") or duration, credits, stored.get("positionSeconds"))
    pct = media.get("progress_pct") or 0
    if not pct:
        return None
    local = core.load_prefs().get(media["id"], {})
    position, local_dur = local.get("resumeSeconds"), local.get("resumeDuration")
    if position is not None and local_dur and abs(position / local_dur * 100.0 - pct) < 0.5:
        return prog.resume_candidate_seconds(pct, local_dur, credits, position)
    return prog.resume_candidate_seconds(pct, duration, credits)


def build_play_item(ctx, base, unit, start_offset=None):
    media, ep = unit["media"], unit["episode"]
    ep_id = ep["id"] if ep else "_"
    url = "%s/m/%s/%s/master.m3u8" % (base, media["id"], ep_id)
    texts = localized_texts.Localizer(ctx.lib, localized_texts.kodi_language())
    shown = texts.episode(media, ep) if ep else texts.media(media)
    title = shown["title"] if ep and shown.get("title") else media["title"]
    li = xbmcgui.ListItem(title, path=url)
    li.setPath(url)
    li.setProperty("inputstream", "inputstream.adaptive")
    li.setProperty("inputstream.adaptive.manifest_type", "hls")
    li.setMimeType("application/vnd.apple.mpegurl")
    li.setContentLookup(False)
    tag = li.getVideoInfoTag()
    tag.setTitle(title)
    tag.setPlot(shown.get("overview") or "")
    tag.setMediaType("episode" if ep else "movie")
    if ep:
        tag.setTvShowTitle(media["title"])
        tag.setSeason(int(ep["season_number"]))
        tag.setEpisode(int(ep["episode_number"]))
    subs = []
    for sub in unit["subtitles"]:
        name = hls.subtitle_filename(sub)
        if name and (sub.get("format") or "").lower() in TEXT_SUB_FORMATS:
            subs.append("%s/m/%s/%s/%s" % (base, media["id"], ep_id, name))
    if subs:
        li.setSubtitles(subs)
    poster = images.cached_path(media.get("poster_path"))
    if poster:
        li.setArt({"thumb": poster, "poster": poster})
    if start_offset:
        li.setProperty("StartOffset", str(float(start_offset)))
    return li, url


def now_playing_info(ctx, unit):
    media, ep = unit["media"], unit["episode"]
    markers = {"intro": None, "credits": None}
    for m in unit.get("markers") or []:
        if m["type"] in markers and markers[m["type"]] is None:
            markers[m["type"]] = [m["start_seconds"], m["end_seconds"]]
    nxt = next_episode(ctx.lib, media["id"], ep["id"]) if ep else None
    return {
        "mediaId": media["id"],
        "episodeId": ep["id"] if ep else None,
        "type": media["type"],
        "title": media["title"],
        "episodeTitle": ep.get("title") if ep else None,
        "season": ep["season_number"] if ep else None,
        "episode": ep["episode_number"] if ep else None,
        "intro": markers["intro"],
        "credits": markers["credits"],
        "audioLanguages": [t.get("language") for t in unit["audio"]],
        "nextEpisodeId": nxt["id"] if nxt else None,
        "totalEpisodesConfigured": media.get("total_episodes"),
    }


def kodi_language():
    """Kodi's interface language as ISO 639-1 (the stream-limit texts fall back to English)."""
    return xbmc.getLanguage(xbmc.ISO_639_1) if HAVE_KODI else "en"


def _ask_play_here(question, play_here, cancel):
    return yes_no("Badger", question, yes=play_here, no=cancel)


def _preflight(base, unit):
    """Cheap check that playback is allowed (402 subscription_unpaid -> notice instead of a silent failure). Runs through
    the service's HLS server, whose API client is already warm, and leaves the init segment in its cache for the player."""
    fmt = next((f for f in unit["formats"] if f.get("init_key")), None)
    if not fmt:
        raise ApiError(404, {"error": "no_playable_format"}, "no playable format")
    hls.preflight_object(base, fmt["init_key"])


def play(ctx, handle, media_id, episode_id=None, from_library=False):
    """Resolve a plugin://.../play URL. Always calls setResolvedUrl exactly once."""
    base = get_prop("server")
    if not ctx.ready:
        ok_dialog("Badger", "Not set up yet: sign in and enter your library key in the addon settings.")
        xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
        return
    if not base:
        ok_dialog("Badger", "The Badger background service is not running. Restart Kodi or re-enable the addon.")
        xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
        return
    unit = ctx.lib.playable_unit(media_id, episode_id)
    if not unit:
        log("play: nothing playable for media=%s episode=%s" % (media_id, episode_id), "warning")
        ok_dialog("Badger", "This item has no playable file in your library.")
        xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
        return
    try:
        _preflight(base, unit)
    except UnpaidError as exc:
        log("play blocked: subscription unpaid wipeAt=%s" % exc.wipe_at, "warning")
        show_unpaid(exc.wipe_at)
        xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
        return
    except PlaybackUnavailableError as exc:
        log("play blocked: silo saturated (%s)" % exc.code, "warning")
        ok_dialog("Badger: playback unavailable", unavailable_message(exc))
        xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
        return
    except UnauthorizedError:
        core.wipe_everything("401 during play preflight")
        ok_dialog("Badger", "This device was signed out. Sign in again in the addon settings.")
        xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
        return
    except Exception as exc:  # noqa: BLE001
        if profiles.is_gone_error(exc):
            ok_dialog("Badger", profiles.mark_gone(core.load_state(), core.save_state))
            xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
            return
        log("play preflight failed: %s" % exc, "error")
        ok_dialog("Badger", "Could not reach Badger storage: %s" % exc)
        xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
        return

    start = None
    resume = resume_seconds(ctx, unit)
    if resume and from_library:
        # Kodi's own library launch already asked "Resume from X / Play from beginning" against the bookmark that
        # export.push_watch_state keeps in sync with our position: asking again here would show two prompts in a row.
        log("play: resume %.0fs left to Kodi's own resume prompt (library launch)" % resume)
    elif resume:
        # A plugin launch (Kodi has no prompt of its own for these): ask exactly like Kodi's resume prompt does.
        choice = xbmcgui.Dialog().select(
            unit["media"]["title"], ["Resume from %s" % fmt_clock(resume), "Play from beginning"]
        )
        if choice < 0:
            xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
            return
        start = resume if choice == 0 else None
    # ACCT-STREAM-01/02: the profile's one place in Badger, asked for before anything plays; the service keeps it.
    language = kodi_language()
    outcome, stream_id = stream_slot.acquire(ctx.api, ctx.profile_id, language, _ask_play_here)
    if outcome == "cancel":
        xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
        return
    set_prop("stream", json.dumps({"streamId": stream_id, "profileId": ctx.profile_id, "language": language}) if stream_id else "")
    li, url = build_play_item(ctx, base, unit, start)
    info = now_playing_info(ctx, unit)
    info["resume"] = start  # the service seeks there after AV start when Kodi did not honour StartOffset
    set_prop("nowplaying", json.dumps(info))
    log("play: media=%s episode=%s url=%s start=%s lib=%s" % (media_id, episode_id, url, start, from_library))
    xbmcplugin.setResolvedUrl(handle, True, li)


# ------------------------------------------------------------------ delete (INTG-DEL-01)


def delete_media(ctx, media_id):
    """Permanent delete: every owned storage key, then the media.delete op, then Kodi library + export cleanup of this
    title only (no full re-export)."""
    media = ctx.lib.get_media(media_id)
    if not media:
        notify("Badger", "Item not found in your library")
        return False
    msg = (
        "Delete [B]%s[/B] permanently?\n\n"
        "This removes it from Badger everywhere: all your devices and your cloud storage. It cannot be undone."
    ) % media["title"]
    if not yes_no("Delete from Badger", msg, yes="Delete permanently", no="Cancel"):
        log("delete cancelled by user: %s" % media_id)
        return False
    keys = ctx.lib.collect_storage_keys(media_id)
    log("delete %s '%s': %d storage keys" % (media_id, media["title"], len(keys)))
    try:
        for i in range(0, len(keys), 200):
            res = ctx.api.delete_objects(keys[i:i + 200])
            log("delete batch %d: %s" % (i // 200, res))
        ctx.lib.write_op(ctx.api, ctx.key, "media.delete", {"mediaId": media_id})
    except UnpaidError as exc:
        show_unpaid(exc.wipe_at)
        return False
    except Exception as exc:  # noqa: BLE001
        log("delete failed: %s" % exc, "error")
        ok_dialog("Badger", "Delete failed: %s" % exc)
        return False
    export.remove_from_kodi(media_id)
    if media["type"] == "tv":
        export.remove_tvshow_from_kodi(media_id, media["title"])
    export.remove_exported(media_id)
    export.remove_export_files_for(media)  # its title's folder, should the index not list it (index wiped)
    notify("Badger", "Deleted %s" % media["title"])
    return True


def delete_episode(ctx, media_id, episode_id):
    """Permanent delete of ONE episode (INTG-DEL-01): its storage objects, then a media.upsert of the show's details
    without that episode's file/formats/tracks (what the desktop's deleteEpisode + deleteMediaFile leave behind),
    then Kodi library + export cleanup. The episode's metadata row and the other episodes stay."""
    media = ctx.lib.get_media(media_id)
    details = ctx.lib.media_details(media_id)
    episode = next((e for e in (details or {}).get("episodes") or [] if e["id"] == episode_id), None)
    if not media or not episode:
        notify("Badger", "Episode not found in your library")
        return False
    keys = details_mod.episode_storage_keys(details, episode_id)
    if not keys:
        notify("Badger", "This episode has no stored file to delete")
        return False
    label = "%s S%02dE%02d" % (media["title"], int(episode["seasonNumber"]), int(episode["episodeNumber"]))
    msg = (
        "Delete [B]%s[/B] permanently?\n\n"
        "This removes the episode from Badger everywhere: all your devices and your cloud storage. It cannot be undone."
    ) % label
    if not yes_no("Delete from Badger", msg, yes="Delete permanently", no="Cancel"):
        log("delete cancelled by user: %s episode %s" % (media_id, episode_id))
        return False
    log("delete episode %s %s: %d storage keys" % (media_id, label, len(keys)))
    try:
        for i in range(0, len(keys), 200):
            res = ctx.api.delete_objects(keys[i:i + 200])
            log("delete episode batch %d: %s" % (i // 200, res))
        remaining = details_mod.without_episode_files(details, episode_id)
        ctx.lib.write_op(ctx.api, ctx.key, "media.upsert", {"details": remaining})
    except UnpaidError as exc:
        show_unpaid(exc.wipe_at)
        return False
    except Exception as exc:  # noqa: BLE001
        log("delete episode failed: %s" % exc, "error")
        ok_dialog("Badger", "Delete failed: %s" % exc)
        return False
    export.remove_from_kodi(media_id, episode_id)
    export.remove_exported(media_id, episode_id)
    notify("Badger", "Deleted %s" % label)
    return True

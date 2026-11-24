# -*- coding: utf-8 -*-
"""plugin:// directory listings and actions. One Python process per invocation (Kodi plugin model)."""
import time
import urllib.parse

import core
import export
import images
import library_setup
import localized_texts
import playback
import progress as prog
import syncer
from compat import (
    ADDON_ID,
    HAVE_KODI,
    KEY_DOCS_URL,
    RENEW_URL,
    get_prop,
    get_setting,
    localized,
    log,
    notify,
    ok_dialog,
    set_prop,
    yes_no,
)

if HAVE_KODI:
    import xbmc
    import xbmcgui
    import xbmcplugin
    import xbmcaddon


def url_for(**params):
    return "plugin://%s/?%s" % (ADDON_ID, urllib.parse.urlencode(params))


def _progress_tags(tag, pct, position=None, duration=None):
    completed = prog.is_completed(pct or 0, position, duration)
    tag.setPlaycount(1 if completed else 0)
    if not completed:
        cand = prog.resume_candidate_seconds(pct or 0, duration, None, position) if duration else None
        if cand and duration:
            tag.setResumePoint(float(cand), float(duration))


def _unpaid_item(handle):
    wipe = get_prop("wipe_at")
    label = "[COLOR red]Subscription unpaid[/COLOR] - playback paused"
    if wipe:
        label += ", data removed %s" % playback.human_date(wipe)
    label += " (press for details)"
    li = xbmcgui.ListItem(label)
    li.setArt({"icon": "DefaultIconWarning.png"})
    return (url_for(action="unpaid_notice"), li, False)


def _setup_needed(ctx, handle):
    if ctx.ready:
        return False
    items = []
    if not ctx.signed_in or not ctx.key:
        li = xbmcgui.ListItem("[B]Pair with your phone[/B]")
        li.setArt({"icon": "DefaultAddonService.png"})
        items.append((url_for(action="pair"), li, False))
        adv = xbmcgui.ListItem("[COLOR gray]Advanced: sign in with email and password, or type the media library key[/COLOR]")
        items.append((url_for(action="advanced"), adv, False))
        if not core.load_state().get("pairPrompted"):
            # first run: open the pairing dialog once on its own
            core.save_state(pairPrompted=True)
            xbmc.executebuiltin("RunPlugin(%s)" % url_for(action="pair"))
    else:
        li = xbmcgui.ListItem("Library not synced yet: select to sync now")
        items.append((url_for(action="sync"), li, False))
    xbmcplugin.addDirectoryItems(handle, items)
    xbmcplugin.endOfDirectory(handle)
    return True


def root(handle):
    ctx = core.Context()
    if _setup_needed(ctx, handle):
        return
    items = []
    if get_prop("access") == "unpaid":
        items.append(_unpaid_item(handle))
    if library_setup.needs_setup():
        li = xbmcgui.ListItem("[B]Add your library to Kodi[/B] (one time)")
        li.setArt({"icon": "DefaultAddSource.png"})
        items.append((url_for(action="setup"), li, False))
    for label, kwargs in (("Movies", {"action": "movies"}), ("TV shows", {"action": "shows"})):
        li = xbmcgui.ListItem(label)
        items.append((url_for(**kwargs), li, True))
    for label, kwargs in (("Sync now", {"action": "sync"}), ("Export to Kodi library", {"action": "export"}), ("Settings", {"action": "settings"})):
        li = xbmcgui.ListItem("[COLOR gray]%s[/COLOR]" % label)
        items.append((url_for(**kwargs), li, False))
    xbmcplugin.addDirectoryItems(handle, items)
    xbmcplugin.endOfDirectory(handle)


def _media_item(media, art, is_folder):
    li = xbmcgui.ListItem(media["title"])
    tag = li.getVideoInfoTag()
    tag.setTitle(media["title"])
    tag.setOriginalTitle(media.get("original_title") or media["title"])
    tag.setPlot(media.get("overview") or "")
    tag.setMediaType("tvshow" if is_folder else "movie")
    if media.get("year") and str(media["year"]).isdigit():
        tag.setYear(int(media["year"]))
    if not is_folder:
        _progress_tags(tag, media.get("progress_pct"))
        li.setProperty("IsPlayable", "true")
    poster = art.get(("poster", media.get("poster_path")))
    back = art.get(("backdrop", media.get("backdrop_path")))
    arts = {}
    if poster:
        arts.update({"poster": poster, "thumb": poster})
    if back:
        arts["fanart"] = back
    li.setArt(arts)
    return li


def list_movies(handle):
    ctx = core.Context()
    movies = ctx.lib.list_media("movie")
    art = images.fetch_many(ctx, [("poster", m.get("poster_path")) for m in movies] + [("backdrop", m.get("backdrop_path")) for m in movies])
    items = []
    texts = localized_texts.Localizer(ctx.lib, localized_texts.kodi_language())
    for m in movies:
        li = _media_item(texts.media(m), art, False)
        items.append((url_for(action="play", media=m["id"]), li, False))
    xbmcplugin.setContent(handle, "movies")
    xbmcplugin.addDirectoryItems(handle, items)
    xbmcplugin.endOfDirectory(handle)


def list_shows(handle):
    ctx = core.Context()
    shows = [s for s in ctx.lib.list_media("tv") if ctx.lib.episode_has_files(s["id"])]
    art = images.fetch_many(ctx, [("poster", m.get("poster_path")) for m in shows] + [("backdrop", m.get("backdrop_path")) for m in shows])
    items = []
    texts = localized_texts.Localizer(ctx.lib, localized_texts.kodi_language())
    for s in shows:
        li = _media_item(texts.media(s), art, True)
        items.append((url_for(action="seasons", media=s["id"]), li, True))
    xbmcplugin.setContent(handle, "tvshows")
    xbmcplugin.addDirectoryItems(handle, items)
    xbmcplugin.endOfDirectory(handle)


def list_seasons(handle, media_id):
    ctx = core.Context()
    show = ctx.lib.get_media(media_id)
    files = ctx.lib.episode_has_files(media_id)
    seasons_with_files = sorted({s for (s, _e) in files})
    seasons = {r["season_number"]: r for r in ctx.lib.seasons(media_id)}
    art = images.fetch_many(ctx, [("poster", s.get("poster_path")) for s in seasons.values()] + [("poster", show.get("poster_path"))])
    items = []
    for number in seasons_with_files:
        row = seasons.get(number) or {}
        name = "Specials" if number == 0 else (row.get("title") or "Season %d" % number)
        li = xbmcgui.ListItem(name)
        tag = li.getVideoInfoTag()
        tag.setTitle(name)
        tag.setSeason(number)
        tag.setTvShowTitle(show["title"])
        tag.setMediaType("season")
        poster = art.get(("poster", row.get("poster_path"))) or art.get(("poster", show.get("poster_path")))
        if poster:
            li.setArt({"poster": poster, "thumb": poster})
        items.append((url_for(action="episodes", media=media_id, season=number), li, True))
    xbmcplugin.setContent(handle, "seasons")
    xbmcplugin.addDirectoryItems(handle, items)
    xbmcplugin.endOfDirectory(handle)


def list_episodes(handle, media_id, season):
    ctx = core.Context()
    show = ctx.lib.get_media(media_id)
    files = ctx.lib.episode_has_files(media_id)
    episodes = [e for e in ctx.lib.episodes(media_id, season) if (int(e["season_number"]), int(e["episode_number"])) in files]
    art = images.fetch_many(ctx, [("still", e.get("still_path")) for e in episodes] + [("backdrop", show.get("backdrop_path"))])
    items = []
    texts = localized_texts.Localizer(ctx.lib, localized_texts.kodi_language())
    for ep in episodes:
        ep = texts.episode(show, ep)
        name = "%dx%02d. %s" % (ep["season_number"], ep["episode_number"], ep.get("title") or "Episode %d" % ep["episode_number"])
        li = xbmcgui.ListItem(name)
        tag = li.getVideoInfoTag()
        tag.setTitle(ep.get("title") or name)
        tag.setPlot(ep.get("overview") or "")
        tag.setTvShowTitle(show["title"])
        tag.setSeason(int(ep["season_number"]))
        tag.setEpisode(int(ep["episode_number"]))
        tag.setFirstAired(ep.get("air_date") or "")
        tag.setMediaType("episode")
        stored = ctx.lib.episode_resume(ep["id"]) or {}
        _progress_tags(tag, stored.get("progressPct"), stored.get("positionSeconds"), stored.get("durationSeconds"))
        li.setProperty("IsPlayable", "true")
        still = art.get(("still", ep.get("still_path")))
        arts = {}
        if still:
            arts.update({"thumb": still})
        back = art.get(("backdrop", show.get("backdrop_path")))
        if back:
            arts["fanart"] = back
        li.setArt(arts)
        items.append((url_for(action="play", media=media_id, episode=ep["id"]), li, False))
    xbmcplugin.setContent(handle, "episodes")
    xbmcplugin.addDirectoryItems(handle, items)
    xbmcplugin.endOfDirectory(handle)


# ------------------------------------------------------------------ actions


def action_pair():
    """'Pair with your phone' (ACCT-PAIR-01): dialog, then first sync."""
    import pair_ui
    result = pair_ui.run()
    log("pair action result: %s" % result)
    if result == pair_ui.RESULT_PAIRED:
        action_sync()
    elif result == pair_ui.RESULT_ADVANCED:
        xbmcaddon.Addon(ADDON_ID).openSettings()


def action_signin():
    import pair_ui
    status = core.apply_settings_credentials(choose=pair_ui.choose_profile)
    log("signin action: %s" % status)
    ctx = core.Context()
    if not ctx.signed_in:
        ok_dialog("Badger", "Not signed in (%s). Enter email and password in the settings first." % (status or "no credentials"))
        return
    if not ctx.key:
        ok_dialog("Badger", "Signed in. Now enter your media library key in the settings (see %s)." % KEY_DOCS_URL)
        return
    action_sync(ctx)


def action_sync(ctx=None):
    ctx = ctx or core.Context()
    dialog = xbmcgui.DialogProgressBG() if HAVE_KODI else None
    if dialog:
        dialog.create("Badger", "Syncing your library...")
    ok, message = syncer.run_sync(ctx, interactive=True)
    if dialog:
        dialog.close()
    set_prop("server_reset", str(time.time()))
    if ok:
        notify("Badger", message)
        if HAVE_KODI:
            xbmc.executebuiltin("Container.Refresh")
        if library_setup.needs_setup() and not core.load_state().get("setupAsked"):
            core.save_state(setupAsked=True)
            action_library_setup()
    else:
        ok_dialog("Badger sync", message)


def action_profile():
    """Settings 'Change profile' (INTG-PROF-01): follow another profile; the synced media stays, viewing state re-syncs."""
    import pair_ui
    ctx = core.Context()
    if not ctx.ready:
        ok_dialog("Badger", "Pair this Kodi with your phone first.")
        return
    try:
        chosen = syncer.change_profile(ctx, pair_ui.choose_profile)
    except Exception as exc:  # noqa: BLE001
        log("profile change failed: %s" % exc, "error")
        ok_dialog("Badger", "Could not change profile (%s)." % exc)
        return
    set_prop("server_reset", str(time.time()))
    if chosen:
        notify("Badger", "Now following %s" % (chosen.get("name") or chosen["id"]))
        if HAVE_KODI:
            xbmc.executebuiltin("Container.Refresh")


def action_export():
    """Settings 'Export library': re-check every exported file (repairs a file removed by hand) and ask Kodi to scan
    only when a file was written or removed, like the export after a sync: an unchanged library costs no rescan."""
    ctx = core.Context()
    if not ctx.ready:
        ok_dialog("Badger", "Sync your library first.")
        return
    needs_setup = library_setup.needs_setup()
    stats = syncer.export_after_sync(ctx, force=True, scan=(lambda: None) if needs_setup else None)
    done = "Exported %(movies)d movies, %(episodes)d episodes" % stats
    if needs_setup:
        notify("Badger", done)
        action_library_setup()
    elif stats.get("written") or stats.get("removed"):
        notify("Badger", done + "; Kodi is scanning")
    else:
        notify("Badger", done + "; nothing changed")


MANUAL_SETUP_HELP = (
    "Kodi needs to be told once that these folders hold your movies and TV shows:\n"
    "Videos > Files > browse to the Badger library folder, open the menu on 'movies' > Set content > Movies, "
    "information provider 'Local information only', switch on 'Scan recursively'. Do the same for 'tvshows' with TV shows.\n"
    "Folder: %s"
)


def action_library_setup():
    """Add our exported folders to Kodi's library (INTG-KODI-02): Kodi's own Set content screens, pressed for the user."""
    movies_path, _tv = export.kodi_paths()
    root = movies_path.rsplit("movies/", 1)[0]
    if not library_setup.needs_setup():
        export.scan_into_kodi()
        notify("Badger", "Your library is already in Kodi")
        return
    if not yes_no(
        "Add your library to Kodi",
        "Kodi must be told once where your Badger movies and shows are. "
        "I can fill in Kodi's own screens for you; it takes about 30 seconds. "
        "Please don't press any button meanwhile.",
        yes="Set it up now", no="Not now",
    ):
        log("library setup: user chose not now")
        return
    result = library_setup.run()
    status = library_setup.library_status()
    log("library setup result: %s status: %s" % (result, status))
    if result["failed"] or library_setup.needs_setup():
        ok_dialog("Badger: finish the Kodi setup", "Kodi did not let Badger finish.\n" + MANUAL_SETUP_HELP % root)
        return
    set_prop("library_setup_done", "1")
    notify("Badger", "Your library is now in Kodi")
    if HAVE_KODI:
        xbmc.executebuiltin("ActivateWindow(Videos,plugin://%s/,return)" % ADDON_ID)


def action_delete(media_id):
    ctx = core.Context()
    if playback.delete_media(ctx, media_id) and HAVE_KODI:
        xbmc.executebuiltin("Container.Refresh")


def dispatch(argv):
    handle = int(argv[1]) if len(argv) > 1 and argv[1].lstrip("-").isdigit() else -1
    query = urllib.parse.parse_qs((argv[2] if len(argv) > 2 else "").lstrip("?"))
    q = {k: v[0] for k, v in query.items()}
    action = q.get("action")
    log("router: %s" % ({"argv": argv[1:], "action": action}))
    if q.get("media") and (action in (None, "play") and "media" in q):
        ctx = core.Context()
        playback.play(ctx, handle, q["media"], q.get("episode"), q.get("lib") == "1")
        return
    if action == "pair":
        action_pair()
        return
    if action == "setup":
        if handle >= 0:  # clicked in a listing: finish that listing, run the setup outside it so Kodi's screens take input
            xbmcplugin.endOfDirectory(handle, succeeded=False)
            xbmc.executebuiltin("RunPlugin(%s)" % url_for(action="setup"))
            return
        action_library_setup()
        return
    if action == "setup_remove":  # undo: set our folders' content back to None (used when removing the add-on)
        log("library setup remove: %s" % library_setup.run(remove=True))
        return
    if action == "advanced":
        xbmcaddon.Addon(ADDON_ID).openSettings()
        return
    if action is None:
        root(handle)
    elif action == "movies":
        list_movies(handle)
    elif action == "shows":
        list_shows(handle)
    elif action == "seasons":
        list_seasons(handle, q["media"])
    elif action == "episodes":
        list_episodes(handle, q["media"], int(q["season"]))
    elif action == "signin":
        action_signin()
    elif action == "sync":
        action_sync()
    elif action == "profile":
        action_profile()
    elif action == "export":
        action_export()
    elif action == "signout":
        action_signout()
    elif action == "unpaid_notice":
        playback.show_unpaid(get_prop("wipe_at"))
    elif action == "settings":
        xbmcaddon.Addon(ADDON_ID).openSettings()
    elif action == "keywarning":
        ok_dialog(
            "Badger: media library key storage",
            "Your media library key is stored in a private file (owner-only permissions) in this addon's data folder. "
            "Anyone who can read this device's files can decrypt your library. Only enter it on devices you trust.\n%s" % KEY_DOCS_URL,
        )
    elif action == "delete":
        action_delete(q["media"])
    else:
        log("unknown action %s" % action, "warning")


# The saved-key question at sign-out (ACCT-DEV-03); strings.po ids 30160-30163, English defaults for runs outside Kodi.
SIGNOUT_KEY_TITLE = (30160, "Have you saved your media library key?")
SIGNOUT_KEY_BODY = (
    30161,
    "Signing out removes your media library key, the cached library and the exported folder from this device. To sign "
    "back in you will have to type the key, because signing in with a QR code only works while another of your devices "
    "still has it. Without the key, your media library can't be opened.",
)
SIGNOUT_KEY_CANCEL = (30162, "Cancel")
SIGNOUT_KEY_CONFIRM = (30163, "I saved it, sign out")


def confirm_signout():
    """Ask before signing out. Holding the key: the saved-key question, Cancel focused (ACCT-DEV-03). No key: the plain
    yes/no about removing the cached library and the exported folder."""
    if core.holds_library_key():
        ok = yes_no(
            localized(*SIGNOUT_KEY_TITLE),
            localized(*SIGNOUT_KEY_BODY),
            yes=localized(*SIGNOUT_KEY_CONFIRM),
            no=localized(*SIGNOUT_KEY_CANCEL),
            default_no=True,
        )
        log("signout: saved-key question answered %s" % ("sign out" if ok else "cancel"))
        return bool(ok)
    ok = yes_no("Badger", "Sign out and remove the cached library and the exported folder from this device?")
    log("signout: no key held; plain question answered %s" % ("yes" if ok else "no"))
    return bool(ok)


def action_signout():
    if not confirm_signout():
        return
    ctx = core.Context()
    try:
        ctx.api.logout()
    except Exception as exc:  # noqa: BLE001
        log("logout call failed: %s" % exc, "warning")
    core.wipe_everything("user sign-out")
    set_prop("access", "signedout")
    set_prop("server_reset", str(time.time()))
    notify("Badger", "Signed out; local data removed")

# -*- coding: utf-8 -*-
"""Context menu 'Delete from Badger' (INTG-DEL-01): permanent delete of a movie, one episode or a whole show."""
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "resources", "lib"))

import xbmc  # noqa: E402

import core  # noqa: E402
import export  # noqa: E402
import playback  # noqa: E402
from compat import ADDON_ID, log, ok_dialog  # noqa: E402


def resolve_target():
    """-> (mediaId, episodeId or None) for the focused list item, or (None, None)."""
    full = xbmc.getInfoLabel("ListItem.FileNameAndPath") or ""
    folder = xbmc.getInfoLabel("ListItem.Path") or ""
    log("context delete: FileNameAndPath=%r Path=%r DBTYPE=%s" % (full, folder, xbmc.getInfoLabel("ListItem.DBTYPE")))
    for candidate in (full, folder):
        if candidate.startswith("plugin://%s/" % ADDON_ID):
            q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(candidate).query).items()}
            if q.get("media"):
                return q["media"], q.get("episode")
    index = export.load_index()
    marker = "plugin.video.spacebadger/library/"
    for candidate in (full, folder):
        i = candidate.find(marker)
        if i < 0:
            continue
        rel = candidate[i + len(marker):]
        if rel in index:
            return index[rel]["mediaId"], index[rel]["episodeId"]
        # folder (show or season): the show folder is the first two path components
        parts = [p for p in rel.split("/") if p]
        if len(parts) >= 2:
            prefix = "/".join(parts[:2]) + "/"
            for key, ids in index.items():
                if key.startswith(prefix):
                    return ids["mediaId"], None
    return None, None


media_id, episode_id = resolve_target()
if not media_id:
    ok_dialog("Badger", "Could not tell which Badger item this is.")
elif episode_id:
    ctx = core.Context()
    if ctx.ready:
        if playback.delete_episode(ctx, media_id, episode_id):
            xbmc.executebuiltin("Container.Refresh")
    else:
        ok_dialog("Badger", "Sign in and sync first.")
else:
    ctx = core.Context()
    if ctx.ready:
        if playback.delete_media(ctx, media_id):
            xbmc.executebuiltin("Container.Refresh")
    else:
        ok_dialog("Badger", "Sign in and sync first.")

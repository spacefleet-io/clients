# -*- coding: utf-8 -*-
"""Kodi JSON-RPC helpers. The addon only ever talks to Kodi's video library through these calls
(never by writing MyVideos.db)."""
import json

from compat import HAVE_KODI, log

if HAVE_KODI:
    import xbmc


class RpcError(Exception):
    pass


def call(method, params=None, quiet=False):
    if not HAVE_KODI:
        raise RpcError("not running inside Kodi")
    request = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        request["params"] = params
    response = json.loads(xbmc.executeJSONRPC(json.dumps(request)))
    if "error" in response:
        if not quiet:
            log("rpc %s failed: %s" % (method, response["error"]), "warning")
        raise RpcError("%s: %s" % (method, response["error"].get("message")))
    return response.get("result")


def addon_installed(addon_id):
    try:
        res = call("Addons.GetAddonDetails", {"addonid": addon_id, "properties": ["enabled"]}, quiet=True)
        return bool(res and res["addon"].get("enabled"))
    except RpcError:
        return False


def scan(directory):
    return call("VideoLibrary.Scan", {"directory": directory, "showdialogs": False})


def library_movies_under(fragment):
    res = call("VideoLibrary.GetMovies", {"properties": ["file", "resume", "playcount", "title", "plot"]}) or {}
    return [m for m in res.get("movies", []) if fragment in m.get("file", "")]


def library_episodes_under(fragment):
    res = call("VideoLibrary.GetEpisodes", {"properties": ["file", "resume", "playcount", "tvshowid", "title", "season", "episode", "plot"]}) or {}
    return [e for e in res.get("episodes", []) if fragment in e.get("file", "")]


def library_tvshows():
    res = call("VideoLibrary.GetTVShows", {"properties": ["file", "title", "plot"]}) or {}
    return res.get("tvshows", [])

# -*- coding: utf-8 -*-
"""Thin layer over the Kodi Python modules so every other module also runs (and is testable) outside Kodi.

Outside Kodi (dev CLI, unit tests):
  SB_DATA_DIR       addon data directory (default ~/.cache/spacebadger-kodi-dev)
  SB_SETTINGS_JSON  JSON object overriding settings, or a settings.json file in SB_DATA_DIR
"""
import json
import os
import re
import sys
import threading
import time

try:  # pragma: no cover - only inside Kodi
    import xbmc
    import xbmcaddon
    import xbmcgui
    import xbmcvfs
    HAVE_KODI = True
except ImportError:  # dev / tests
    xbmc = xbmcaddon = xbmcgui = xbmcvfs = None
    HAVE_KODI = False

ADDON_ID = "plugin.video.spacebadger"
CLIENT_TYPE = "badger-kodi"


def _addon_version():
    """The installed add-on's version, read from its addon.xml (the release build stamps the zip's copy), so the
    x-space-client header can never drift from what Kodi installed (REL-CD-29)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, os.pardir, "addon.xml")
    try:
        with open(path, "rb") as fh:
            head = fh.read(4096).decode("utf-8", "replace")
    except (IOError, OSError):
        return "0.0.0"
    match = re.search(r'<addon\b[^>]*\bversion="([^"]+)"', head)
    return match.group(1) if match else "0.0.0"


CLIENT_VERSION = _addon_version()
# REL-CD-29 platform id of the Kodi add-on in `x-space-client: badger/kodi/<version>`.
CLIENT_PLATFORM = "kodi"
# LIB-FMT-13: the one string the add-on shows when the API refuses it (426 app_update_required) or the library holds
# an op it does not know. Kodi has no in-app updater: the user updates from the add-on repository.
UPDATE_REQUIRED_MESSAGE = "SpaceFleet has been updated. Update the add-on to keep watching your library."
RENEW_URL = "https://spacebadger.io/"
KEY_DOCS_URL = "https://spacebadger.io/docs/privacy/key-storage"

_log_lock = threading.Lock()


def log(message, level="info"):
    """Generous diagnostics: one line per event, prefixed so `grep SpaceBadger kodi.log` finds everything."""
    line = "[SpaceBadger] %s" % message
    if HAVE_KODI:
        lvl = {
            "debug": xbmc.LOGDEBUG,
            "info": xbmc.LOGINFO,
            "warning": xbmc.LOGWARNING,
            "error": xbmc.LOGERROR,
        }.get(level, xbmc.LOGINFO)
        # LOGDEBUG lines are dropped unless debug logging is on; keep our diagnostics visible at info.
        xbmc.log(line, xbmc.LOGINFO if lvl == xbmc.LOGDEBUG else lvl)
    else:
        with _log_lock:
            sys.stderr.write("%s %s %s\n" % (time.strftime("%H:%M:%S"), level.upper(), line))
            sys.stderr.flush()


def data_dir():
    if HAVE_KODI:
        path = xbmcvfs.translatePath("special://profile/addon_data/%s/" % ADDON_ID)
    else:
        path = os.environ.get("SB_DATA_DIR") or os.path.join(os.path.expanduser("~"), ".cache", "spacebadger-kodi-dev")
    if not os.path.isdir(path):
        os.makedirs(path)
    return path


def addon_path():
    if HAVE_KODI:
        return xbmcvfs.translatePath("special://home/addons/%s/" % ADDON_ID)
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


# ------------------------------------------------------------------ settings


def _dev_settings():
    raw = os.environ.get("SB_SETTINGS_JSON")
    if raw:
        return json.loads(raw)
    path = os.path.join(data_dir(), "settings.json")
    if os.path.exists(path):
        with open(path) as fh:
            return json.load(fh)
    return {}


DEFAULT_SETTINGS = {
    "api_url": "https://api.spacefleet.io",
    "email": "",
    "password": "",
    "library_key": "",
    "sync_interval_minutes": "30",
    "auto_export": "true",
    "setup_hint_shown": "false",
    "dev_mode": "false",
}


def get_setting(key):
    if HAVE_KODI:
        value = xbmcaddon.Addon(ADDON_ID).getSetting(key)
        return value if value != "" else DEFAULT_SETTINGS.get(key, "")
    value = _dev_settings().get(key)
    return value if value not in (None, "") else DEFAULT_SETTINGS.get(key, "")


def set_setting(key, value):
    if HAVE_KODI:
        xbmcaddon.Addon(ADDON_ID).setSetting(key, value)
        return
    path = os.path.join(data_dir(), "settings.json")
    current = _dev_settings() if not os.environ.get("SB_SETTINGS_JSON") else {}
    current[key] = value
    with open(path, "w") as fh:
        json.dump(current, fh)


def localized(string_id, default=""):
    if HAVE_KODI:
        text = xbmcaddon.Addon(ADDON_ID).getLocalizedString(string_id)
        return text or default
    return default


# ------------------------------------------------------------------ UI helpers (no-ops outside Kodi)


def notify(title, message, icon=None, ms=5000):
    log("notify: %s: %s" % (title, message))
    if HAVE_KODI:
        xbmcgui.Dialog().notification(title, message, icon or xbmcgui.NOTIFICATION_INFO, ms)


def ok_dialog(title, message):
    log("dialog: %s: %s" % (title, message))
    if HAVE_KODI:
        xbmcgui.Dialog().ok(title, message)


def yes_no(title, message, yes="Yes", no="No", default_no=False):
    """Kodi's yes/no dialog: True for `yes`. `default_no` puts the focus on `no` (Kodi 20+; older Kodi ignores it)."""
    log("yes_no: %s: %s [%s / %s, default %s]" % (title, message, no, yes, "no" if default_no else "yes"))
    if HAVE_KODI:
        dialog = xbmcgui.Dialog()
        no_btn = getattr(xbmcgui, "DLG_YESNO_NO_BTN", None)
        if default_no and no_btn is not None:
            try:
                return dialog.yesno(title, message, nolabel=no, yeslabel=yes, defaultbutton=no_btn)
            except TypeError:  # Kodi 19 has no defaultbutton
                log("yes_no: defaultbutton unsupported; Kodi focuses its own default", "warning")
        return dialog.yesno(title, message, nolabel=no, yeslabel=yes)
    return False


def select(heading, labels, preselect=-1):
    """Kodi's list dialog: index of the chosen label, -1 when cancelled (always -1 outside Kodi)."""
    log("select: %s: %s (preselect %s)" % (heading, labels, preselect))
    if HAVE_KODI:
        return xbmcgui.Dialog().select(heading, list(labels), preselect=preselect)
    return -1


# ------------------------------------------------------------------ cross-process properties
# Kodi runs the service and every plugin invocation in separate Python interpreters. Home-window
# properties are the cheap shared store (used for the local HLS server base URL).
_props = {}


def set_prop(name, value):
    if HAVE_KODI:
        xbmcgui.Window(10000).setProperty("spacebadger.%s" % name, value)
    else:
        _props[name] = value


def get_prop(name):
    if HAVE_KODI:
        return xbmcgui.Window(10000).getProperty("spacebadger.%s" % name)
    return _props.get(name, "")

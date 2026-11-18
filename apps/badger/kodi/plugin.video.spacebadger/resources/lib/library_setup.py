# -*- coding: utf-8 -*-
"""One-time Kodi library setup (INTG-KODI-02) with no manual steps, using only Kodi's own screens.

Kodi has no API that makes a folder a Movies / TV shows library path: JSON-RPC, builtins, add-on API, .nfo/.strm and
advancedsettings cannot do it, and writing MyVideos.db ourselves is off limits. The only official route is the
"Set content" screen. So this module opens that screen on our export folders and presses its buttons for the user
(arrow keys, Select, and a click on OK), exactly the way a person would. Kodi itself writes its database.

Nothing here touches MyVideos.db or sources.xml. The GUI is reached through a small `Gui` object so the walk is unit
tested with a fake screen (tests/test_library_setup.py).
"""
import time

import core
import export
import kodi_rpc
from compat import ADDON_ID, HAVE_KODI, localized, log

if HAVE_KODI:
    import xbmc
    import xbmcaddon

# Kodi core string ids (xbmc/guilib strings.po)
STR_MOVIES = 20342
STR_TVSHOWS = 20343
STR_NONE = 231
STR_SET_CONTENT = 20333
STR_CHANGE_CONTENT = 20442

# Control ids of Kodi's Set content dialog (window 10132) and the Yes/No dialog
CTRL_OK = 28
CTRL_YES = 11

KINDS = ("movies", "tvshows")


class SetupError(Exception):
    pass


class KodiGui(object):
    """The real screen. Every call is a thin xbmc wrapper so a fake can stand in for it."""

    def builtin(self, command):
        # never wait: opening a dialog (context menu, Set content) blocks a waiting builtin until the dialog closes
        xbmc.executebuiltin(command, False)

    def visible(self, condition):
        return bool(xbmc.getCondVisibility(condition))

    def info(self, label):
        return xbmc.getInfoLabel(label)

    def sleep(self, ms):
        xbmc.sleep(ms)

    def addon_name(self, addon_id):
        try:
            return xbmcaddon.Addon(addon_id).getAddonInfo("name")
        except Exception:  # noqa: BLE001
            return ""

    def string(self, string_id):
        return xbmc.getLocalizedString(string_id)


def _norm(text):
    """Compare focused-row labels: Kodi shows folder rows as '[name]'."""
    text = " ".join((text or "").split())
    if len(text) > 2 and text[0] == "[" and text[-1] == "]":
        text = text[1:-1]
    return text.casefold()


def wait_until(gui, condition, timeout=8.0, step_ms=100):
    """Poll a Kodi boolean condition until it is true; False on timeout."""
    deadline = time.time() + timeout
    while True:
        if gui.visible(condition):
            return True
        if time.time() >= deadline:
            return False
        gui.sleep(step_ms)


def focused_label(gui):
    return gui.info("System.CurrentControl")


def move_to_label(gui, wanted, direction="Down", limit=24, settle_ms=120):
    """Press Down (wrapping) until the focused row is `wanted`. Raises SetupError if it never shows up."""
    target = _norm(wanted)
    for _ in range(limit + 1):
        if _norm(focused_label(gui)) == target:
            return
        gui.builtin("Action(%s)" % direction)
        gui.sleep(settle_ms)
    raise SetupError("could not find '%s' (focus stayed on '%s')" % (wanted, focused_label(gui)))


def pick_in_list(gui, wanted):
    """Inside a Kodi select dialog: move to `wanted` and confirm it."""
    if not wait_until(gui, "Window.IsActive(selectdialog)", 6):
        raise SetupError("Kodi's list did not open")
    move_to_label(gui, wanted)
    gui.builtin("Action(Select)")
    if not wait_until(gui, "!Window.IsActive(selectdialog)", 6):
        raise SetupError("Kodi's list did not close")
    gui.sleep(200)


def assign_content(gui, folder, content_label, scraper_label=None):
    """Drive the Set content screen for the folder row `folder` of the Videos window that is already open.

    content_label: localized 'Movies' / 'TV shows' / 'None'. scraper_label: addon name of the information provider.
    """
    if not wait_until(gui, "Window.IsActive(videos)", 10):
        raise SetupError("the Videos screen did not open")
    # wait for the listing to fill (".." plus our two folders)
    for _ in range(50):
        if int(gui.info("Container.NumItems") or 0) >= 2:
            break
        gui.sleep(100)
    move_to_label(gui, folder)
    gui.builtin("Action(ContextMenu)")
    if not wait_until(gui, "Window.IsActive(contextmenu)", 6):
        raise SetupError("the context menu did not open on '%s'" % folder)
    gui.sleep(200)
    set_labels = (gui.string(STR_SET_CONTENT), gui.string(STR_CHANGE_CONTENT))
    for label in set_labels:
        try:
            move_to_label(gui, label, limit=14)
            break
        except SetupError:
            continue
    else:
        gui.builtin("Action(Back)")
        raise SetupError("Kodi's menu has no 'Set content' for '%s'" % folder)
    gui.builtin("Action(Select)")
    if not wait_until(gui, "Window.IsActive(contentsettings)", 8):
        raise SetupError("the Set content screen did not open")
    gui.sleep(300)
    # first row: "This directory contains"
    gui.builtin("Action(Select)")
    pick_in_list(gui, content_label)
    if scraper_label:
        gui.builtin("Action(Down)")
        gui.sleep(200)
        gui.builtin("Action(Select)")
        pick_in_list(gui, scraper_label)
    gui.builtin("SendClick(%d)" % CTRL_OK)
    # Kodi asks whether to refresh the items below this path: yes, that is the scan that fills the library
    if wait_until(gui, "Window.IsActive(yesnodialog)", 4):
        gui.builtin("SendClick(%d)" % CTRL_YES)
    if not wait_until(gui, "!Window.IsActive(contentsettings) + !Window.IsActive(yesnodialog)", 10):
        raise SetupError("the Set content screen did not close")


def wait_for_scan(gui, timeout=120):
    gui.sleep(800)
    deadline = time.time() + timeout
    while gui.visible("Library.IsScanningVideo") and time.time() < deadline:
        gui.sleep(500)


# ------------------------------------------------------------------------------------------ status
def library_status():
    """{'movies': bool, 'tvshows': bool}: is our folder a library path with items imported?

    Asks Kodi, never reads its database: our movies / episodes show up under our export folders once content is set."""
    frag = export._our_fragment()
    try:
        movies = bool(kodi_rpc.library_movies_under(frag))
        episodes = bool(kodi_rpc.library_episodes_under(frag))
    except kodi_rpc.RpcError:
        return {"movies": False, "tvshows": False}
    return {"movies": movies, "tvshows": episodes}


def needs_setup():
    """True when we have exported something but Kodi's library does not hold it yet."""
    if not HAVE_KODI:
        return False
    return bool(kinds_to_set(export.load_index().keys(), library_status()))


def kinds_to_set(index_keys, status):
    """Pure helper (tested): which folders still need content, given exported relative paths and Kodi status."""
    todo = []
    if any(k.startswith("movies/") for k in index_keys) and not status.get("movies"):
        todo.append("movies")
    if any(k.startswith("tvshows/") for k in index_keys) and not status.get("tvshows"):
        todo.append("tvshows")
    return todo


def run(gui=None, kinds=None, remove=False):
    """Set (or with remove=True clear) the library content of our export folders. Returns {'done': [...], 'failed': {kind: why}}."""
    gui = gui or KodiGui()
    root = export.kodi_paths()[0].rsplit("movies/", 1)[0]
    kinds = kinds or KINDS
    result = {"done": [], "failed": {}}
    if not remove:
        scraper = gui.addon_name("metadata.local") or "Local information only"
    else:
        scraper = None
    for kind in kinds:
        content = gui.string(STR_NONE) if remove else gui.string(STR_MOVIES if kind == "movies" else STR_TVSHOWS)
        log("library setup: %s -> '%s' (provider '%s')" % (kind, content, scraper))
        try:
            gui.builtin("ActivateWindow(Videos,%s,return)" % root)
            assign_content(gui, kind, content, scraper)
            wait_for_scan(gui)
            result["done"].append(kind)
            log("library setup: %s done" % kind)
        except SetupError as exc:
            result["failed"][kind] = str(exc)
            log("library setup: %s FAILED: %s" % (kind, exc), "error")
            _leave_screens(gui)
    return result


def _leave_screens(gui):
    """Close anything we left open (context menu, Set content, yes/no) without saving."""
    for _ in range(4):
        if gui.visible("Window.IsActive(contentsettings) | Window.IsActive(contextmenu) | Window.IsActive(selectdialog) | Window.IsActive(yesnodialog)"):
            gui.builtin("Action(Back)")
            gui.sleep(250)
        else:
            break

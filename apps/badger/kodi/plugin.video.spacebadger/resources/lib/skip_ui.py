# -*- coding: utf-8 -*-
"""'Skip intro' / 'Skip credits' button shown over the video (INTG-KODI-04).

A one-button WindowXMLDialog (resources/skins/default/1080i/SpaceBadgerSkip.xml): the button is focused, so a single
OK press on the remote skips. It goes away by itself after SHOW_SECONDS, when the marker is over, or when playback
stops (Back also dismisses it without touching playback).
"""
import threading
import time

import xbmc
import xbmcgui

from compat import addon_path, log

SHOW_SECONDS = 12
CTRL_BUTTON = 100


class SkipDialog(xbmcgui.WindowXMLDialog):
    def __init__(self, *args, **kwargs):
        xbmcgui.WindowXMLDialog.__init__(self, *args, **kwargs)
        self.label = ""
        self.player = None
        self.end = 0.0
        self.clicked = False
        self.stop = threading.Event()

    def onInit(self):
        self.getControl(CTRL_BUTTON).setLabel(self.label)
        threading.Thread(target=self._watch, name="sb-skip-watch", daemon=True).start()

    def onClick(self, control_id):
        if control_id == CTRL_BUTTON:
            self.clicked = True
            self.close()

    def onAction(self, action):
        if action.getId() in (xbmcgui.ACTION_NAV_BACK, xbmcgui.ACTION_PREVIOUS_MENU):
            self.close()

    def _watch(self):
        started = time.time()
        while not self.stop.is_set():
            try:
                playing = self.player.isPlayingVideo()
                pos = self.player.getTime() if playing else 0.0
            except RuntimeError:
                playing, pos = False, 0.0
            if not playing or pos >= self.end or time.time() - started > SHOW_SECONDS:
                self.close()
                return
            xbmc.sleep(400)


def offer(label, marker_end, target, player):
    """Show the button; seek to `target` when it is pressed. Returns True when skipped."""
    dialog = SkipDialog("SpaceBadgerSkip.xml", addon_path(), "default", "1080i")
    dialog.label, dialog.player, dialog.end = label, player, float(marker_end) - 1.0
    log("offering '%s' (marker ends %.0fs, seek target %.0fs)" % (label, marker_end, target))
    dialog.doModal()
    dialog.stop.set()
    clicked = dialog.clicked
    del dialog
    if clicked:
        try:
            player.seekTime(float(target))
            log("%s pressed: seek to %.0fs" % (label, target))
        except RuntimeError as exc:
            log("skip seek failed: %s" % exc, "warning")
    else:
        log("'%s' dismissed or expired" % label)
    return clicked

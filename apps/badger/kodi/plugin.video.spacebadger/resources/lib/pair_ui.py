# -*- coding: utf-8 -*-
"""'Pair with your phone' dialog (ACCT-PAIR-01): QR image + short code + countdown + 'Get a new code'.

The dialog is a WindowXMLDialog (resources/skins/default/1080i/SpaceBadgerPair.xml). A worker thread long-polls the API
(`wait=25`, in its own thread so the countdown keeps ticking), pauses POLL_SECONDS after each answer, and closes the dialog when the phone approved, denied or the code expired. On approval the
session token and the (probe-verified) library key are stored per PRIV-KEY-04 and the first sync is started.
"""
import os
import threading
import time

import xbmc
import xbmcgui

import core
import pairing
import profiles
import qrimage
from api import ApiClient
from compat import ADDON_ID, addon_path, data_dir, localized, log, notify, ok_dialog, select, set_prop

CTRL_QR, CTRL_CODE, CTRL_COUNTDOWN, CTRL_TEXT = 100, 101, 102, 103
BTN_NEW, BTN_ADVANCED, BTN_CANCEL = 200, 201, 202

RESULT_PAIRED, RESULT_ADVANCED, RESULT_CANCELLED = "paired", "advanced", "cancelled"


def device_name():
    friendly = (xbmc.getInfoLabel("System.FriendlyName") or "").strip()
    return friendly or "Kodi"


def _clock(seconds):
    seconds = int(seconds)
    return "%d:%02d" % (seconds // 60, seconds % 60)


def _poll_into(session, box):
    """One long poll; the answer lands in `box["status"]` (poll() never raises)."""
    box["status"] = session.poll()


class PairDialog(xbmcgui.WindowXMLDialog):
    def __init__(self, *args, **kwargs):
        xbmcgui.WindowXMLDialog.__init__(self, *args, **kwargs)
        self.api_url = core.account_api_url()
        self.session = None
        self.result = RESULT_CANCELLED
        self.error = None
        self.stop = threading.Event()
        self.new_code = threading.Event()
        self.worker = None
        self.paired = None

    # ------------------------------------------------------------ kodi callbacks
    def onInit(self):
        self.getControl(CTRL_TEXT).setText(localized(30101, "Open Badger on your phone, go to Settings, then Pair a device, and scan this code."))
        self._start_worker()

    def onClick(self, control_id):
        if control_id == BTN_NEW:
            self.new_code.set()
        elif control_id == BTN_ADVANCED:
            self.result = RESULT_ADVANCED
            self._close()
        elif control_id == BTN_CANCEL:
            self._close()

    def onAction(self, action):
        if action.getId() in (xbmcgui.ACTION_PREVIOUS_MENU, xbmcgui.ACTION_NAV_BACK):
            self._close()

    # ------------------------------------------------------------ internals
    def _close(self):
        self.stop.set()
        self.close()

    def _start_worker(self):
        self.worker = threading.Thread(target=self._run, name="sb-pair", daemon=True)
        self.worker.start()

    def _show_code(self):
        png = os.path.join(data_dir(), "pair-qr.png")
        qrimage.write_qr_png(png, self.session.qr_payload, scale=10, border=4)
        # a fresh file name per code: Kodi caches images by path
        shown = os.path.join(data_dir(), "pair-qr-%d.png" % int(time.time() * 1000))
        os.replace(png, shown)
        self._cleanup_png(keep=shown)
        self.getControl(CTRL_QR).setImage(shown, False)
        self.getControl(CTRL_CODE).setLabel(self.session.short_code)

    @staticmethod
    def _cleanup_png(keep):
        folder = data_dir()
        for name in os.listdir(folder):
            if name.startswith("pair-qr") and name.endswith(".png") and os.path.join(folder, name) != keep:
                try:
                    os.remove(os.path.join(folder, name))
                except OSError:
                    pass

    def _new_session(self):
        api = ApiClient(self.api_url)
        self.session = pairing.PairingSession(api, device_name()).start()
        self._show_code()

    def _run(self):
        try:
            self._new_session()
        except Exception as exc:  # noqa: BLE001
            log("pairing: could not start: %s" % exc, "error")
            self.error = "Could not reach Badger (%s). Check the server address under Advanced and your network." % exc
            self._close()
            return
        last_poll = 0.0
        expired = False
        inflight = None  # (session, box) of the long poll running in its own thread, so the countdown keeps ticking
        while not self.stop.is_set():
            if self.new_code.is_set():
                self.new_code.clear()
                try:
                    self._new_session()
                    expired = False
                    last_poll = 0.0
                    inflight = None
                except Exception as exc:  # noqa: BLE001
                    log("pairing: new code failed: %s" % exc, "error")
            left = self.session.seconds_left()
            if left <= 0 and not expired:
                expired = True
                self.getControl(CTRL_COUNTDOWN).setLabel(localized(30111, "This code expired. Choose 'Get a new code'."))
            elif not expired:
                self.getControl(CTRL_COUNTDOWN).setLabel(localized(30112, "Code expires in %s") % _clock(left))
            if not expired and inflight is None and time.time() - last_poll >= pairing.POLL_SECONDS:
                inflight = (self.session, {})
                threading.Thread(target=_poll_into, args=inflight, daemon=True).start()
            done = inflight is not None and "status" in inflight[1]
            if done:
                session, box = inflight
                inflight = None
                last_poll = time.time()  # the pause runs from the answer, not from the call
            if done and session is self.session and not expired:
                status = box["status"]
                state = status.get("status")
                if state == "approved":
                    try:
                        self.paired = self.session.complete(status)
                        self.result = RESULT_PAIRED
                    except pairing.PairingError as exc:
                        self.error = str(exc)
                    except Exception as exc:  # noqa: BLE001
                        log("pairing: completing failed: %s" % exc, "error")
                        self.error = "Pairing failed: %s" % exc
                    self._close()
                    return
                if state == "denied":
                    self.error = "Your phone declined this device."
                    self._close()
                    return
                if state in ("expired", "consumed"):
                    expired = True
                    self.getControl(CTRL_COUNTDOWN).setLabel(localized(30111, "This code expired. Choose 'Get a new code'."))
            self.stop.wait(0.5)


def choose_profile(names, preselect=-1):
    """'Who uses this Kodi?' (INTG-PROF-01): asked once, while pairing, or from the settings' 'Change profile'."""
    return select(localized(30152, "Who uses this Kodi?"), names, preselect)


def store_pairing(result, profile):
    """Persist token + key like the manual sign-in does (PRIV-KEY-04) with the chosen profile, then publish the new state."""
    api_url = core.account_api_url()
    core.save_session_state(result["token"], email=result.get("email") or "", apiUrl=api_url, pairedAt=time.time(),
                            **profiles.state_for(profile))
    import base64
    core.save_key(base64.b64encode(result["key"]).decode("ascii"))
    set_prop("access", "")
    set_prop("server_reset", str(time.time()))
    log("pairing: stored session token and library key (clientType=%s, profile %s)" % (result.get("clientType"), profile["id"]))


def _drop_session(result):
    """Pairing did not finish: sign the new device session out so the account keeps no half-paired Kodi."""
    api_url = core.account_api_url()
    ApiClient(api_url, result["token"]).logout()


def run():
    """Show the dialog. Returns one of RESULT_*. Stores the pairing when the phone approved and a profile is chosen."""
    dialog = PairDialog("SpaceBadgerPair.xml", addon_path(), "default", "1080i")
    dialog.doModal()
    result, error, paired = dialog.result, dialog.error, dialog.paired
    dialog.stop.set()
    del dialog
    if result == RESULT_PAIRED and paired:
        try:
            chosen = pairing.finish_pairing(paired, choose_profile, store_pairing, _drop_session)
        except profiles.ProfileError as exc:
            ok_dialog("Badger", str(exc))
            return RESULT_CANCELLED
        if chosen is None:
            ok_dialog("Badger", "Pairing was not finished: choose who uses this Kodi to pair it. Nothing was saved.")
            return RESULT_CANCELLED
        notify("Badger", "Paired with your phone as %s. Syncing your library..." % (chosen.get("name") or chosen["id"]))
        return RESULT_PAIRED
    if error:
        ok_dialog("Badger", error)
    return result

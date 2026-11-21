# -*- coding: utf-8 -*-
"""Sync orchestration shared by the service (periodic) and plugin actions (manual)."""
import time

import core
import export
import localized_texts
import profiles
from api import ApiError, AppUpdateRequiredError, UnauthorizedError, UnpaidError
from compat import CLIENT_VERSION, HAVE_KODI, UPDATE_REQUIRED_MESSAGE, get_prop, get_setting, log, notify, ok_dialog, set_prop
from library import KeyMismatchError
from ops_sql import UnknownOpTypeError

# Background work waits this long after the service starts (Kodi boot) and while something plays.
BOOT_DELAY_SECONDS = 20.0
# state.json: the add-on version + library version of the last export, and pictures it still waits for.
EXPORT_MARKER_KEY = "exportedLibrary"
EXPORT_PENDING_KEY = "exportArtPending"


def show_update_required(why, interactive=False):
    """LIB-FMT-13 / REL-CD-29: the API refused this add-on (426) or the library holds an op it does not know. The
    sync stops (nothing applied, the version does not move) and the user is told to update the add-on. Returns the
    message; a manual action shows it itself (router.action_sync), the background service gets the dialog once per
    Kodi session."""
    log("update required: %s" % why, "error")
    if not interactive and get_prop("update_required") != "1":
        set_prop("update_required", "1")
        ok_dialog("Badger", UPDATE_REQUIRED_MESSAGE)
    return UPDATE_REQUIRED_MESSAGE


def refresh_access(ctx):
    """Publish the account state (free|paid|unpaid) + wipeAt for the UI. 401 -> device wipe (ACCT-DEV-01)."""
    try:
        me = ctx.api.me()
    except UnauthorizedError:
        log("auth/me 401: token revoked or expired -> wiping local data", "warning")
        core.wipe_everything("auth/me 401")
        set_prop("access", "signedout")
        return None
    except Exception as exc:  # noqa: BLE001
        log("auth/me failed: %s" % exc, "warning")
        return None
    set_prop("access", me["state"])
    set_prop("wipe_at", me.get("wipeAt") or "")
    log("account state=%s wipeAt=%s" % (me["state"], me.get("wipeAt")))
    return me


def follow_profile(ctx):
    """INTG-PROF-01 before every sync: refresh the followed profile (its prefix follows a main-profile change). When
    no profile can be followed (deleted elsewhere, or a session from before profiles on an account with several) the
    user is told once, viewing writes stop and nothing syncs until "Change profile"; no further request is made."""
    before = core.load_state()
    followed = before.get("profileId")
    was_paused = profiles.paused(before)
    # ensure() decides from `before`; a "Change profile" pick saved while /profiles was in flight wins.
    ok, message = profiles.ensure(ctx.api, before, lambda **c: core.save_state_if_profile(followed, **c))
    state = core.load_state()
    paused = profiles.paused(state)
    if state.get("profileId") != followed:
        ok = bool(state.get("profileId")) and not paused
        message = "profile %s picked meanwhile" % state.get("profileId")
    ctx.lib.viewing_paused = paused or not state.get("profileId")
    if ok:
        ctx.lib.prefix = state.get("profilePrefix") or ""
        ctx.api.profile_id = state.get("profileId")
    elif paused and not was_paused:
        notify("Badger", message, ms=15000)
    return ok, message


def change_profile(ctx, choose, push=None):
    """Settings action 'Change profile' (INTG-PROF-01): ask, store the new profile, then catch up and re-sync only
    the viewing state (resume, watched, track choices) into Kodi; the media already synced stays. Also the way out of
    a paused state (followed profile deleted, or none picked yet). Returns the new profile, or None when nothing changed."""
    state = core.load_state()
    current = state.get("profileId")
    chosen = profiles.pick(ctx.api.profiles(), choose, current_id=current, always_ask=True)
    if chosen is None or (chosen["id"] == current and not profiles.paused(state)):
        log("profile change: kept %s" % current)
        return None
    core.save_state(**profiles.state_for(chosen))
    ctx.lib.prefix = profiles.key_prefix(chosen)
    ctx.lib.viewing_paused = False
    ctx.api.profile_id = chosen["id"]
    log("profile change: %s -> %s (prefix %r); media kept, viewing state re-synced" % (current, chosen["id"], ctx.lib.prefix))
    ctx.lib.sync(ctx.api, ctx.key)
    (push or export.push_watch_state)(ctx)
    return chosen


def run_sync(ctx, interactive=False):
    """Returns (ok, message). Never raises."""
    if not ctx.signed_in:
        return False, "not signed in"
    if not ctx.key:
        return False, "no library key"
    refresh_access(ctx)
    if get_prop("access") == "signedout":
        return False, "This device was signed out of Badger (its access was removed from another device or the account). Your library has been removed from Kodi. Open the Badger add-on to pair this device again."
    ok, message = follow_profile(ctx)
    if not ok:
        return False, message
    started = time.time()
    try:
        ctx.lib.sync(ctx.api, ctx.key)
    except KeyMismatchError:
        log("sync: library key does not match this account's library", "error")
        return False, "the library key does not match this library"
    except UnauthorizedError:
        core.wipe_everything("sync 401")
        set_prop("access", "signedout")
        return False, "This device was signed out of Badger (its access was removed from another device or the account). Your library has been removed from Kodi. Open the Badger add-on to pair this device again."
    except UnpaidError as exc:
        return False, "subscription unpaid (wipe %s)" % exc.wipe_at
    except AppUpdateRequiredError as exc:
        return False, show_update_required("API 426 %s (reason %s)" % (exc.code, exc.reason), interactive)
    except UnknownOpTypeError as exc:
        return False, show_update_required("unknown library op type %s" % exc, interactive)
    except ApiError as exc:
        log("sync failed: %s" % exc, "error")
        return False, "server error: %s" % exc
    except Exception as exc:  # noqa: BLE001
        log("sync failed: %s" % exc, "error")
        return False, "sync failed: %s" % exc
    log("sync ok in %.1fs, library version %s" % (time.time() - started, ctx.lib.version()))
    texts_written = 0
    if not interactive:
        # LIB-LANG-02: the background sync asks the texts no row keeps yet (a manual sync never waits on lookups).
        try:
            texts_written = localized_texts.refresh(ctx, localized_texts.kodi_language())["written"]
        except Exception as exc:  # noqa: BLE001
            log("texts refresh failed: %s" % exc, "error")
    if get_setting("auto_export") == "true":
        try:
            export_after_sync(ctx, force=interactive or bool(texts_written))
        except Exception as exc:  # noqa: BLE001
            log("export after sync failed: %s" % exc, "error")
    return True, "synced to version %s" % ctx.lib.version()


def export_after_sync(ctx, force=False, scan=None, language=None):
    """Re-export only when the library or Kodi's interface language changed (or the last export still waits for
    pictures), and ask Kodi to scan only when the export wrote or removed a file: an unchanged sync costs no disk walk
    and no library scan on a low-end box. Returns the export stats, or None when skipped."""
    language = language or localized_texts.kodi_language()
    marker = "%s|%s|%s" % (CLIENT_VERSION, ctx.lib.version(), language)
    state = core.load_state()
    if not force and state.get(EXPORT_MARKER_KEY) == marker and not state.get(EXPORT_PENDING_KEY) and export.has_index():
        log("export skipped: library version unchanged (%s)" % marker, "debug")
        return None
    stats = export.export_library(ctx, language=language)
    core.save_state(**{EXPORT_MARKER_KEY: marker, EXPORT_PENDING_KEY: stats.get("art_pending", 0)})
    if stats.get("written", 0) or stats.get("removed", 0):
        if scan is not None:
            scan()
        elif HAVE_KODI:
            export.scan_into_kodi()
    else:
        log("export unchanged: no Kodi library scan", "debug")
    return stats


class BackgroundGate(object):
    """When the service may start background work (periodic sync, ticket refill): not during the first
    BOOT_DELAY_SECONDS after the service started, while Kodi is still drawing its home screen, and never while the
    player plays. Work held back is only deferred: it starts at the first tick the gate is open."""

    def __init__(self, playing, now=time.monotonic, delay=None):
        self._playing = playing
        self._now = now
        self._open_at = now() + (BOOT_DELAY_SECONDS if delay is None else delay)

    def open(self):
        if self._now() < self._open_at:
            return False
        return not self._playing()

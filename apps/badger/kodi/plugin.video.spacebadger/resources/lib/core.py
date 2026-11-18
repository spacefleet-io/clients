# -*- coding: utf-8 -*-
"""Credentials, private files and the shared per-process context (api client + library store + keys).

PRIV-KEY-04: the library key is kept in a private file (0600 where the platform supports it) inside the
addon data dir, unobfuscated; the settings page shows a visible warning. The password typed in settings is
only used to log in and is cleared from settings right after the token is obtained.
"""
import json
import os
import shutil
import threading

import crypto
import metadata
import privacypass
import profiles
import tickets
from api import ApiClient, UnauthorizedError
from compat import DEFAULT_SETTINGS, HAVE_KODI, data_dir, get_setting, log, set_setting
from library import LibraryStore

STATE_FILE = "state.json"
KEY_FILE = "library.key"
PREFS_FILE = "prefs.json"
EXPORT_DIR = "library"

_lock = threading.RLock()


def _path(name):
    return os.path.join(data_dir(), name)


def _write_private(path, text):
    """Write a file readable by the owner only (best effort on platforms without POSIX modes)."""
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


def load_state():
    with _lock:
        try:
            with open(_path(STATE_FILE)) as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return {}


def save_state(**changes):
    with _lock:
        state = load_state()
        state.update(changes)
        _write_private(_path(STATE_FILE), json.dumps(state))
        return state


def save_state_if_profile(profile_id, **changes):
    """Save `changes` only while `profile_id` is still the followed profile; the check and the write happen together
    under `_lock`, so a "Change profile" pick made meanwhile is never overwritten or paused. Returns the saved state,
    or None when the followed profile changed."""
    with _lock:
        state = load_state()
        if state.get("profileId") != profile_id:
            log("profile: %s picked meanwhile; not saving %s" % (state.get("profileId"), sorted(changes)))
            return None
        state.update(changes)
        _write_private(_path(STATE_FILE), json.dumps(state))
        return state


def load_key_bytes():
    try:
        with open(_path(KEY_FILE)) as fh:
            return crypto.parse_library_key(fh.read())
    except OSError:
        return None


def holds_library_key():
    """Whether this Kodi holds the library key, for the saved-key question at sign-out (ACCT-DEV-03): the private
    key file exists, or a typed key still waits in the settings. A key file that cannot be checked counts as held."""
    if get_setting("library_key"):
        log("holds_library_key: a typed key waits in the settings")
        return True
    try:
        os.stat(_path(KEY_FILE))
    except FileNotFoundError:
        log("holds_library_key: no key file")
        return False
    except OSError as exc:
        log("holds_library_key: key file unreadable (%s); counting it as held" % exc, "warning")
        return True
    log("holds_library_key: key file present")
    return True


def save_key(text):
    """Validate and store the typed/pasted key (base64, grouped or not). Returns the raw 32 bytes."""
    raw = crypto.parse_library_key(text)
    import base64
    _write_private(_path(KEY_FILE), base64.b64encode(raw).decode("ascii"))
    log("library key stored in private file %s" % KEY_FILE)
    return raw


def load_prefs():
    try:
        with open(_path(PREFS_FILE)) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_prefs(prefs):
    with _lock:
        with open(_path(PREFS_FILE) + ".tmp", "w") as fh:
            json.dump(prefs, fh)
        os.replace(_path(PREFS_FILE) + ".tmp", _path(PREFS_FILE))


def set_media_pref(media_id, **values):
    with _lock:
        prefs = load_prefs()
        entry = prefs.setdefault(media_id, {})
        entry.update(values)
        save_prefs(prefs)


def export_dir():
    path = _path(EXPORT_DIR)
    if not os.path.isdir(path):
        os.makedirs(path)
    return path


def wipe_everything(reason):
    """ACCT-DEV-01: token revoked/expired -> wipe key, cached library, our items in Kodi's library and the exported folder."""
    log("WIPE (%s): removing token, key, library cache, Kodi library items, exported folder" % reason, "warning")
    try:
        import export
        removed = export.remove_all_from_kodi()
        log("WIPE: removed %s items from Kodi's video library" % removed)
    except Exception as exc:  # noqa: BLE001 - never block the wipe
        log("WIPE: removing Kodi library items failed: %s" % exc, "error")
    LibraryStore().wipe()
    for name in (STATE_FILE, KEY_FILE, PREFS_FILE, STATE_FILE + ".tmp", "export_index.json", "pending_ops.json"):
        p = _path(name)
        if os.path.exists(p):
            os.remove(p)
    # The ticket reserve goes with the sign-in: a removed or unpaid device keeps no metadata tickets (META-ANON-02). The
    # session is gone by now, so a refill still in flight fails its check inside the store lock and stores nothing. The
    # lock file stays: other processes may be waiting on it.
    try:
        ticket_store().clear()
    except OSError as exc:  # noqa: BLE001 - never block the wipe
        log("WIPE: clearing the ticket reserve failed: %s" % type(exc).__name__, "error")
    exp = _path(EXPORT_DIR)
    if os.path.isdir(exp):
        shutil.rmtree(exp, ignore_errors=True)
    art = _path("art")
    if os.path.isdir(art):
        shutil.rmtree(art, ignore_errors=True)


def ticket_store():
    return tickets.TicketStore(_path(tickets.RESERVE_FILE))


def ticket_session():
    """Opaque id of the signed-in session (the device token, kept in memory only) or None; the refill schedule's trigger."""
    return load_state().get("token") or None


def save_session_state(token, **changes):
    """save_state(token=...) for a sign-in. A token that differs from the current one is another account or device
    session: its predecessor's anonymous tickets are dropped first, so one reserve never spans two accounts, and its
    chosen profile is forgotten unless the caller names the new one (INTG-PROF-01)."""
    if token != ticket_session():
        ticket_store().clear()
        for name in ("profileId", "profileName", "profilePrefix", profiles.NEEDS_KEY):
            changes.setdefault(name, None)
    save_state(token=token, **changes)


PRODUCTION_API_URL = DEFAULT_SETTINGS["api_url"]


def account_api_url(state=None, environ=None):
    """The account API this run talks to (ACCT-AUTH-09). Outside a dev run (SB_DEV_TICKET_KEY=1) always the production
    API: the `api_url` setting and an `apiUrl` saved with the session (a stale one from an old dev run included) are
    ignored, because the run trusts the production ticket key only and another server would drop every ticket. A dev
    run uses the session's server, else the setting."""
    if not privacypass.dev_run(environ):
        return PRODUCTION_API_URL
    state = load_state() if state is None else state
    return (state.get("apiUrl") or get_setting("api_url")).rstrip("/")


def sync_dev_mode_setting(environ=None):
    """Mirror the dev switch into the hidden `dev_mode` setting, which only decides whether Kodi shows `api_url`
    (settings.xml). Written only when it differs: every write fires onSettingsChanged. The code never reads it back."""
    wanted = "true" if privacypass.dev_run(environ) else "false"
    if get_setting("dev_mode") != wanted:
        set_setting("dev_mode", wanted)


def ticket_auth():
    """`(api base url, headers)` for POST /metadata/tickets, or None when signed out. The only request that carries
    the session for metadata; it carries blinded values only (the API never sees a ticket)."""
    state = load_state()
    token = state.get("token")
    if not token:
        return None
    api_url = account_api_url(state)
    return api_url, ApiClient(api_url, token).json_headers()


class Context(object):
    """Per-process bundle. Cheap to build; every plugin invocation builds its own."""

    def __init__(self):
        state = load_state()
        self.api_url = account_api_url(state)
        self.token = state.get("token")
        self.api = ApiClient(self.api_url, self.token)
        self.key = load_key_bytes()
        self.master = crypto.derive_media_master_key(self.key) if self.key else None
        # Viewing data of the profile chosen at pairing (INTG-PROF-01); "" = the main profile's own storage.
        self.profile_id = state.get("profileId")
        self.api.profile_id = self.profile_id
        self.lib = LibraryStore(prefix=state.get("profilePrefix") or "")
        # No profile followed yet (a session from before profiles, before its first /profiles) is paused too: writing
        # with prefix "" would silently pick the oldest profile (INTG-PROF-01).
        self.lib.viewing_paused = profiles.paused(state) or not self.profile_id
        # Lookups never use self.api: they go straight to the metadata service with one anonymous ticket each.
        store = ticket_store()
        self.metadata = metadata.MetadataClient(
            take=store.take,
            put=store.put,
            url=lambda: metadata.resolve_metadata_url(get_setting("metadata_url"), self.api_url),
        )

    @property
    def signed_in(self):
        return bool(self.token)

    @property
    def ready(self):
        return bool(self.token and self.key and self.lib.exists())


def _device_name():
    if HAVE_KODI:
        import xbmc
        return (xbmc.getInfoLabel("System.FriendlyName") or "").strip() or "Kodi"
    return "Kodi"


def apply_settings_credentials(choose=None):
    """Move credentials typed in settings into private storage.

    - email+password (when a password is present): log in, pick the profile this Kodi follows like pairing does
      (INTG-PROF-01: the only one silently, else `choose(names, preselect)`), store the device token with it,
      clear the password. Nothing picked -> the new session is signed out and nothing is stored.
    - library_key (when present): validate, store in the private file, clear it from settings.
    Returns a short status string for notifications.
    """
    messages = []
    key_text = get_setting("library_key")
    if key_text and key_text.strip():
        try:
            save_key(key_text)
            messages.append("key stored")
        except crypto.CryptoError as exc:
            log("library key in settings is invalid: %s" % exc, "error")
            messages.append("invalid key")
        set_setting("library_key", "")  # only when non-empty: every set_setting fires onSettingsChanged
    password = get_setting("password")
    email = get_setting("email")
    if password and email:
        api_url = account_api_url({})
        api = ApiClient(api_url)
        try:
            api.login(email.strip(), password, device_name=_device_name())
            try:
                chosen = profiles.pick(api.profiles(), choose)
            except Exception:
                api.logout()
                raise
            if chosen is None:
                api.logout()
                messages.append("sign-in not finished: choose who uses this Kodi")
            else:
                save_session_state(api.token, email=email.strip(), apiUrl=api_url,
                                   **profiles.state_for(chosen))
                messages.append("signed in")
        except UnauthorizedError:
            messages.append("login failed")
        except Exception as exc:  # noqa: BLE001
            log("login failed: %s" % exc, "error")
            messages.append("login failed: %s" % exc)
        set_setting("password", "")  # only inside `if password and email`: no settings-changed feedback loop
    return ", ".join(messages)

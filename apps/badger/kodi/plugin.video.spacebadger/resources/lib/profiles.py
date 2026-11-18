# -*- coding: utf-8 -*-
"""The one Badger profile this Kodi follows (INTG-PROF-01, ACCT-SQUAD-02). Pure logic, no Kodi imports.

The profile is chosen while pairing: an account with one profile uses it without asking, an account with several
does not finish pairing until one is picked. The choice lives in state.json (`profileId`, `profileName`,
`profilePrefix`) and is never asked again; only the settings action "Change profile" asks.

Viewing data keys (same as apps/badger/mobile/src/lib/profiles):
the main profile (`isMain`, the account's oldest) uses the library's own storage (`media_items.progress_pct`,
`episode_resume_v1:<id>`, `track_prefs_v1:<id>`); every other profile the same records under `p:<profileId>:`
keys in `app_settings`, its progress as `p:<pid>:media_progress_v1:<mediaId>` {progressPct, lastWatchedAt, updatedAt}.
`isMain` can move when the main profile is deleted elsewhere, so the prefix is recomputed from each fresh
`GET /profiles`.
"""
import json
import math

from compat import log

MEDIA_PROGRESS_KEY_PREFIX = "media_progress_v1:"
STATE_KEYS = ("profileId", "profileName", "profilePrefix")


class ProfileError(Exception):
    """The profile list is unusable; the message is plain English and safe to show."""


def key_prefix(profile):
    """`""` for the main profile, `p:<id>:` otherwise (packages/shared/src/profiles.ts profileKeyPrefix)."""
    if profile.get("isMain"):
        return ""
    if not profile.get("id"):
        raise ProfileError("A profile without an id came back from Badger.")
    return "p:%s:" % profile["id"]


def ordered(profiles):
    """Oldest first, as the API lists them (main first)."""
    return sorted(profiles, key=lambda p: (not p.get("isMain"), p.get("createdAt") or "", p.get("id") or ""))


# INTG-PROF-01: while `profileNeeded` (state.json) holds a message, nothing syncs and no viewing state is written
# (resume, watched, track choices); the synced media stays. Set when the followed profile is deleted elsewhere, or for a
# session from before profiles on an account with several. Cleared by picking a profile ("Change profile").
NEEDS_KEY = "profileNeeded"
CHOOSE_MESSAGE = "Choose who uses this Kodi: open the Badger add-on settings and choose 'Change profile'."
GONE_ERRORS = ("profile_not_owned", "profile_required")


def gone_message(name):
    return "The Badger profile %s was deleted. Choose who uses this Kodi: open the Badger add-on settings and choose 'Change profile'." % (name or "you followed")


def paused(state):
    """True while no profile is followed (deleted elsewhere, or not yet picked): no viewing state may be written."""
    return bool(state.get(NEEDS_KEY))


def state_for(profile):
    return {"profileId": profile["id"], "profileName": profile.get("name") or "", "profilePrefix": key_prefix(profile), NEEDS_KEY: None}


def pick(profiles, choose, current_id=None, always_ask=False):
    """The profile to follow. One profile -> it, without asking (unless `always_ask`). Several -> `choose(names,
    preselect)` returns an index, or -1 when cancelled; `choose=None` (no screen to ask on) picks nothing."""
    listed = ordered(profiles or [])
    if not listed:
        raise ProfileError("This Badger account has no profile. Open Badger on your phone and try again.")
    if len(listed) == 1 and not always_ask:
        return listed[0]
    if choose is None:
        return None
    preselect = next((i for i, p in enumerate(listed) if p.get("id") == current_id), -1)
    index = choose([p.get("name") or p.get("id") for p in listed], preselect)
    if index is None or index < 0 or index >= len(listed):
        log("profile: no profile picked (%d offered)" % len(listed))
        return None
    return listed[index]


def ensure(api, state, save):
    """Run before every sync: (ok, message). With a stored profile, refresh its name and prefix from `GET /profiles`
    and never ask; a stored profile missing from the list is deleted: never switch, set `profileNeeded`. Without one
    (a session from before profiles), take the only profile; with several, set `profileNeeded` until one is picked."""
    if state.get(NEEDS_KEY):
        return False, state[NEEDS_KEY]
    stored = state.get("profileId")
    try:
        listed = api.profiles()
    except Exception as exc:  # noqa: BLE001 - offline: keep what was chosen
        if stored:
            log("profile: list unavailable (%s); keeping %s" % (exc, stored), "warning")
            return True, "profile kept"
        log("profile: list unavailable (%s) and none chosen yet" % exc, "warning")
        return False, "Could not load this account's profiles (%s)." % exc
    if stored:
        current = next((p for p in listed if p.get("id") == stored), None)
        if current is None:
            message = gone_message(state.get("profileName"))
            log("profile: followed profile %s was deleted; viewing state paused until a profile is picked" % stored, "warning")
            save(**{NEEDS_KEY: message})
            return False, message
        fresh = state_for(current)
        if any(state.get(k) != fresh[k] for k in STATE_KEYS):
            log("profile: %s refreshed (prefix %r -> %r)" % (stored, state.get("profilePrefix"), fresh["profilePrefix"]))
            save(**{k: fresh[k] for k in STATE_KEYS})
        return True, "profile %s" % stored
    listed = ordered(listed or [])
    if not listed:
        return False, "This Badger account has no profile. Open Badger on your phone and try again."
    if len(listed) > 1:
        log("profile: session from before profiles, %d profiles on the account: waiting for a pick" % len(listed), "warning")
        save(**{NEEDS_KEY: CHOOSE_MESSAGE})
        return False, CHOOSE_MESSAGE
    log("profile: session from before profiles: following the account's only profile %s" % listed[0]["id"])
    save(**state_for(listed[0]))
    return True, "profile %s" % listed[0]["id"]


def is_gone_error(exc):
    """An API answer meaning the followed profile is gone (400 `profile_required` / 403 `profile_not_owned`)."""
    return getattr(exc, "status", None) in (400, 403) and getattr(exc, "code", None) in GONE_ERRORS


def mark_gone(state, save):
    """The API refused the followed profile (deleted elsewhere, or none followed yet): pause viewing state until a
    pick; never switch. Returns the message to show."""
    message = gone_message(state.get("profileName")) if state.get("profileId") else CHOOSE_MESSAGE
    log("profile: followed profile %s refused; viewing state paused until a profile is picked" % state.get("profileId"), "warning")
    save(**{NEEDS_KEY: message})
    return message


# ------------------------------------------------------------------ progress of a non-main profile
def _pct(value):
    """normalizeProgressPct (apps/badger/mobile/src/lib/playback/resume.ts)."""
    pct = value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else 0
    pct = max(0.0, min(100.0, float(pct)))
    return max(0.0001, round(pct * 10000) / 10000.0) if pct > 0 else 0


def media_progress_value(progress_pct, last_watched_at, updated_at):
    return json.dumps({"progressPct": _pct(progress_pct), "lastWatchedAt": last_watched_at, "updatedAt": updated_at},
                      separators=(",", ":"))


def parse_media_progress(raw):
    """parseMediaProgressValue: dict {progressPct, lastWatchedAt} or None for missing / "" / malformed."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    pct = parsed.get("progressPct")
    if not isinstance(pct, (int, float)) or isinstance(pct, bool) or not math.isfinite(pct):
        return None
    last = parsed.get("lastWatchedAt")
    return {"progressPct": max(0.0, min(100.0, pct)), "lastWatchedAt": last if isinstance(last, str) and last else None}


def progress_op(prefix, media_id, progress_pct, last_watched_at, timestamp):
    """(op type, payload) that records a movie's or show's progress for the profile behind `prefix`."""
    if not prefix:
        return "media.progress", {"mediaId": media_id, "progressPct": progress_pct, "lastWatchedAt": last_watched_at,
                                  "updatedAt": timestamp}
    return "setting.set", {"key": prefix + MEDIA_PROGRESS_KEY_PREFIX + media_id,
                           "value": media_progress_value(progress_pct, last_watched_at, timestamp), "updatedAt": timestamp}

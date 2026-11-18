# -*- coding: utf-8 -*-
"""ACCT-STREAM-01..04: Kodi asks the API for the profile's stream place before playing a Badger title.

The play handler (plugin process) takes the place; at the limit it asks "Already playing on <device>. Play here
instead?" and "Play here" starts again with `takeover`. The background service keeps the place: a heartbeat every
20 s, "Playing on <device> now" and a stop when another device took it, and the place given back when playback stops.
The API unreachable plays without a place (ACCT-STREAM-05 option A, as the shared `@space/stream-slots` gate does).

The texts are the shared ones of packages/stream-slots/src/strings.ts (tests/test_stream_slot.py fails if they differ).
"""
from compat import log

HEARTBEAT_SECONDS = 20

STRINGS = {
    "en": {
        "alreadyPlaying": "Already playing on {device}. Play here instead?",
        "playHere": "Play here",
        "cancel": "Cancel",
        "playingElsewhere": "Playing on {device} now",
    },
    "fr": {
        "alreadyPlaying": u"Déjà en lecture sur {device}. Lire ici à la place ?",
        "playHere": "Lire ici",
        "cancel": "Annuler",
        "playingElsewhere": "Lecture en cours sur {device}",
    },
    "nl": {
        "alreadyPlaying": "Speelt al af op {device}. Hier afspelen?",
        "playHere": "Hier afspelen",
        "cancel": "Annuleren",
        "playingElsewhere": "Speelt nu af op {device}",
    },
    "de": {
        "alreadyPlaying": "Wird bereits auf {device} abgespielt. Stattdessen hier abspielen?",
        "playHere": "Hier abspielen",
        "cancel": "Abbrechen",
        "playingElsewhere": "Wird jetzt auf {device} abgespielt",
    },
    "es": {
        "alreadyPlaying": u"Ya se está reproduciendo en {device}. ¿Reproducir aquí?",
        "playHere": u"Reproducir aquí",
        "cancel": "Cancelar",
        "playingElsewhere": u"Ahora se está reproduciendo en {device}",
    },
}

DEVICE_LABELS = {
    "en": {"desktop": "a computer", "mobile": "a phone", "tv": "a TV", "web": "a web browser", "kodi": "Kodi",
           "jellyfin": "Jellyfin", "other": "another device"},
    "fr": {"desktop": "un ordinateur", "mobile": u"un téléphone", "tv": "une TV", "web": "un navigateur web",
           "kodi": "Kodi", "jellyfin": "Jellyfin", "other": "un autre appareil"},
    "nl": {"desktop": "een computer", "mobile": "een telefoon", "tv": "een tv", "web": "een webbrowser", "kodi": "Kodi",
           "jellyfin": "Jellyfin", "other": "een ander apparaat"},
    "de": {"desktop": "einem Computer", "mobile": "einem Telefon", "tv": "einem Fernseher", "web": "einem Webbrowser",
           "kodi": "Kodi", "jellyfin": "Jellyfin", "other": u"einem anderen Gerät"},
    "es": {"desktop": "una computadora", "mobile": u"un teléfono", "tv": "un televisor", "web": "un navegador web",
           "kodi": "Kodi", "jellyfin": "Jellyfin", "other": "otro dispositivo"},
}


def language_of(language):
    base = (language or "").lower().replace("_", "-").split("-")[0]
    return base if base in STRINGS else "en"


def device_label(language, device):
    """The device's own name, else a generic label for its type in `language`."""
    name = (device.get("deviceName") or "").strip()
    if name:
        return name
    labels = DEVICE_LABELS[language_of(language)]
    return labels.get(device.get("deviceType") or "other") or labels["other"]


def text(language, key, device=None):
    template = STRINGS[language_of(language)][key]
    return template.replace("{device}", device_label(language, device)) if device is not None else template


def _device(entry):
    entry = entry if isinstance(entry, dict) else {}
    return {"deviceName": entry.get("deviceName"), "deviceType": entry.get("deviceType")}


def start_stream(api, profile_id, takeover=False):
    """POST /playback/streams. {"status": "started", "streamId"} | {"status": "limit", "device"} | {"status": "unreachable"}.
    Every Kodi playback streams from the account's storage, so it is always `kind: "play"` (ACCT-STREAM-03)."""
    body = {"app": "badger", "kind": "play", "takeover": bool(takeover)}
    if profile_id:
        body["profileId"] = profile_id
    try:
        res = api.request_json("POST", "/playback/streams", body, expect=(200, 201, 409))
    except Exception as exc:  # noqa: BLE001
        log("stream place unavailable (playing without one): %s" % exc, "warning")
        return {"status": "unreachable"}
    if res.get("error") == "stream_limit":
        return {"status": "limit", "device": _device((res.get("playingOn") or [None])[0])}
    if res.get("streamId"):
        log("stream place taken: %s takeover=%s" % (res["streamId"], bool(takeover)))
        return {"status": "started", "streamId": res["streamId"]}
    log("stream place answer without a stream: %s" % res, "warning")
    return {"status": "unreachable"}


def heartbeat(api, stream_id):
    """{"status": "alive"} | {"status": "taken_over", "device"} | {"status": "ended"} | {"status": "unreachable"}."""
    try:
        res = api.request_json("POST", "/playback/streams/%s/heartbeat" % stream_id, {}, expect=(200, 404, 409))
    except Exception as exc:  # noqa: BLE001
        log("stream heartbeat failed (kept playing): %s" % exc, "warning")
        return {"status": "unreachable"}
    if res.get("error") == "stream_taken_over":
        return {"status": "taken_over", "device": {"deviceName": res.get("byDeviceName"), "deviceType": res.get("byDeviceType")}}
    if res.get("error") == "stream_ended":
        return {"status": "ended"}
    return {"status": "alive"}


def stop_stream(api, stream_id):
    try:
        api.request_json("DELETE", "/playback/streams/%s" % stream_id, expect=(200, 204, 404))
        log("stream place given back: %s" % stream_id)
    except Exception as exc:  # noqa: BLE001
        log("stream place not given back (it expires within a minute): %s" % exc, "warning")


def acquire(api, profile_id, language, ask):
    """Play-start flow. `ask(question, play_here, cancel)` -> True for "Play here".
    Returns ("play", stream_id or None) or ("cancel", None); Cancel sends nothing more."""
    res = start_stream(api, profile_id)
    if res["status"] == "limit":
        question = text(language, "alreadyPlaying", res["device"])
        if not ask(question, text(language, "playHere"), text(language, "cancel")):
            log("stream limit: cancelled (%s)" % question)
            return "cancel", None
        res = start_stream(api, profile_id, takeover=True)
        if res["status"] == "limit":
            log("stream limit: still at the limit after Play here", "warning")
            return "cancel", None
    return "play", res.get("streamId")


class Holder(object):
    """The service's hold on a place while Kodi plays: `due` claims a heartbeat slot every 20 s, `beat` sends it and
    returns the text to show when the playback must stop because another device took the place."""

    def __init__(self, api_factory, profile_id, stream_id, language, now):
        self.api_factory = api_factory
        self.profile_id = profile_id
        self.stream_id = stream_id
        self.language = language
        self.last = now

    def due(self, now):
        if now - self.last < HEARTBEAT_SECONDS:
            return False
        self.last = now
        return True

    def beat(self):
        api = self.api_factory()
        res = heartbeat(api, self.stream_id)
        if res["status"] == "taken_over":
            return text(self.language, "playingElsewhere", res["device"])
        if res["status"] != "ended":
            return None
        # The server already ended this stream (silent past expiry): take a place again, never by taking over.
        restarted = start_stream(api, self.profile_id)
        if restarted["status"] == "limit":
            return text(self.language, "playingElsewhere", restarted["device"])
        if restarted["status"] == "started":
            self.stream_id = restarted["streamId"]
        return None

    def release(self):
        stop_stream(self.api_factory(), self.stream_id)

# -*- coding: utf-8 -*-
"""LIB-LANG-01/02: a title's synopsis and its episodes' names and synopses in Kodi's interface language, English
when that language has none, the text stored in the library as the last resort.

The texts of one title in one language are kept in the library as one synced `setting.set` row, the same row every
Badger app reads and writes (`packages/shared/src/localizedTexts.ts`):
  key   `localized_text_v1:<type>:<id>:<language>`
  value JSON `{"v":1,"overview":…,"episodes":[[season,episode,name,overview],…],"absent":["s:e",…],"fetchedAt":…}`
Showing a title (listings, the library export, Up Next) only reads rows. The background sync (`refresh`) asks the
metadata service's `details` op once for a title and language that has no row, or whose row never heard of one of the
library's episodes (new episodes), and writes the answer back as the row. It keeps the ticket reserve above
TICKET_FLOOR, asks one title at a time and stops for the service's pause after a 429/503.
"""
import json
import re
import time

import core
import library
from compat import HAVE_KODI, log
from metadata import MetadataRequestError, MetadataUnavailableError, NoTicketError, TicketRejectedError

if HAVE_KODI:
    import xbmc

KEY_PREFIX = "localized_text_v1:"
# The language asked when the interface language has no text (`OVERVIEW_FALLBACK_LANGUAGE` in the other apps).
FALLBACK_LANGUAGE = "en"
# No lookup while the ticket reserve is at or below this: tickets stay for matches (as the artwork copies, META-ART-01).
TICKET_FLOOR = 100
# Least time between two lookups of one run, as the artwork copy paces titles (ARTWORK_COPY_PAUSE_MS).
LOOKUP_PAUSE_SECONDS = 2.0
# Lookups one background sync may ask; the rest is asked by the next sync (a large library spreads over a few syncs).
MAX_LOOKUPS_PER_RUN = 40
# Pause after the service answered 429/503 without a Retry-After (60 s) or could not be reached (30 s); at most 1 h.
PAUSE_DEFAULT_SECONDS = 60
PAUSE_NETWORK_SECONDS = 30
PAUSE_MAX_SECONDS = 3600
# state.json: lookups wait until this time (epoch seconds) after the service asked for a pause.
PAUSED_UNTIL_KEY = "textsPausedUntil"

_LANGUAGE = re.compile(r"^([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]+)*$")


def key(media_type, catalog_id, language):
    return "%s%s:%s:%s" % (KEY_PREFIX, media_type, catalog_id, language)


def episode_key(season, episode):
    return "%d:%d" % (int(season), int(episode))


def language_of(tag):
    """The language subtag the rows are keyed by ("fr-FR" -> "fr"), English for an empty or unreadable tag."""
    match = _LANGUAGE.match((tag or "").strip())
    return match.group(1).lower() if match else FALLBACK_LANGUAGE


def kodi_language():
    """Kodi's interface language as the rows key it; English outside Kodi."""
    return language_of(xbmc.getLanguage(xbmc.ISO_639_1) if HAVE_KODI else FALLBACK_LANGUAGE)


def _text(value):
    return value if isinstance(value, str) and value.strip() else None


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _reject_constant(name):
    raise ValueError("not JSON: %s" % name)


def serialize(record):
    """The row value, byte for byte as `serializeLocalizedText` writes it."""
    return json.dumps(
        {
            "v": 1,
            "overview": record["overview"],
            "episodes": [[e["seasonNumber"], e["episodeNumber"], e["name"], e["overview"]] for e in record["episodes"]],
            "absent": list(record["absent"]),
            "fetchedAt": record["fetchedAt"],
        },
        separators=(",", ":"),
        ensure_ascii=False,
    )


def parse(value):
    """The kept record, or None for a missing, deleted (""), unreadable or newer-version value (`parseLocalizedText`)."""
    if not value:
        return None
    try:
        raw = json.loads(value, parse_constant=_reject_constant)
    except ValueError:
        return None
    if not isinstance(raw, dict):
        return None
    version = raw.get("v")
    if not _number(version) or version != 1 or not isinstance(raw.get("episodes"), list):
        return None
    episodes = []
    for entry in raw["episodes"]:
        if not isinstance(entry, list):
            continue
        season, episode, name, overview = (list(entry) + [None] * 4)[:4]
        if not _number(season) or not _number(episode):
            continue
        episodes.append({"seasonNumber": season, "episodeNumber": episode, "name": _text(name), "overview": _text(overview)})
    absent = raw.get("absent")
    fetched_at = raw.get("fetchedAt")
    return {
        "overview": _text(raw.get("overview")),
        "episodes": episodes,
        "absent": [k for k in absent if isinstance(k, str)] if isinstance(absent, list) else [],
        "fetchedAt": fetched_at if isinstance(fetched_at, str) else "",
    }


def covers(record, episode_keys):
    """True when the row knows every library episode (answered, or listed as absent from the answer)."""
    known = set(record["absent"])
    for e in record["episodes"]:
        known.add("%s:%s" % (_key_part(e["seasonNumber"]), _key_part(e["episodeNumber"])))
    return all(k in known for k in episode_keys or ())


def _key_part(number):
    return str(int(number)) if float(number).is_integer() else str(number)


def record_of(item, episode_keys, fetched_at):
    """The row of one details answer; `absent` lists the library episodes the answer lacks (`recordOf`)."""
    episodes = []
    for e in item.get("episodes") or []:
        if not isinstance(e, dict) or not _number(e.get("seasonNumber")) or not _number(e.get("episodeNumber")):
            continue
        episodes.append({"seasonNumber": e["seasonNumber"], "episodeNumber": e["episodeNumber"],
                         "name": _text(e.get("name")), "overview": _text(e.get("overview"))})
    answered = set("%s:%s" % (_key_part(e["seasonNumber"]), _key_part(e["episodeNumber"])) for e in episodes)
    return {
        "overview": _text(item.get("overview")),
        "episodes": episodes,
        "absent": [k for k in episode_keys or () if k not in answered],
        "fetchedAt": fetched_at,
    }


def _lacking(record):
    """The row misses a synopsis or an episode text English may have."""
    return record["overview"] is None or any(e["name"] is None or e["overview"] is None for e in record["episodes"])


def _catalog_id(media):
    try:
        value = int(media.get("catalog_id"))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


# ------------------------------------------------------------------ showing (rows only, never a lookup)

def kept(read, media_type, catalog_id, language):
    """The kept texts of one title: {"overview": str|None, "episodes": {(season, episode): (name, overview)}}, the
    interface language's row first, then the English one, field by field. `read(key)` answers a row value or None."""
    rows = [parse(read(key(media_type, catalog_id, language)))]
    if language != FALLBACK_LANGUAGE:
        rows.append(parse(read(key(media_type, catalog_id, FALLBACK_LANGUAGE))))
    rows = [r for r in rows if r]
    overview = next((r["overview"] for r in rows if r["overview"] is not None), None)
    episodes = {}
    for row in reversed(rows):
        for e in row["episodes"]:
            k = (int(e["seasonNumber"]), int(e["episodeNumber"]))
            name, text = episodes.get(k, (None, None))
            episodes[k] = (e["name"] or name, e["overview"] or text)
    return {"overview": overview, "episodes": episodes}


class Localizer(object):
    """Shows titles and episodes with the kept texts of one language; the stored text where none is kept."""

    def __init__(self, lib, language):
        self.lib = lib
        self.language = language
        self._kept = {}

    def _texts(self, media):
        catalog_id = _catalog_id(media)
        if not catalog_id or media.get("type") not in ("movie", "tv"):
            return None
        cache_key = (media["type"], catalog_id)
        if cache_key not in self._kept:
            self._kept[cache_key] = kept(self.lib.setting_value, media["type"], catalog_id, self.language)
        return self._kept[cache_key]

    def media(self, media):
        texts = self._texts(media)
        if not texts or texts["overview"] is None:
            return media
        out = dict(media)
        out["overview"] = texts["overview"]
        return out

    def episode(self, show, ep):
        texts = self._texts(show)
        found = texts["episodes"].get((int(ep["season_number"]), int(ep["episode_number"]))) if texts else None
        if not found:
            return ep
        out = dict(ep)
        out["title"] = found[0] or ep.get("title")
        out["overview"] = found[1] or ep.get("overview")
        return out


# ------------------------------------------------------------------ background sync (the one place that asks)

class _Stop(Exception):
    pass


def refresh(ctx, language, count_tickets=None, sleep=time.sleep, clock=time.time, max_lookups=MAX_LOOKUPS_PER_RUN, now=None):
    """Asks the texts no row holds yet for `language` (and English where that language lacks some), one title at a
    time, and keeps each answer as its row. Never raises for the service; returns counts and why it stopped early
    (`stopped`: paused | ticket_floor | no_ticket | budget, else None)."""
    now = now or library.now_iso
    count_tickets = count_tickets or (lambda: core.ticket_store().count())
    lib = ctx.lib
    stats = {"titles": 0, "kept": 0, "asked": 0, "written": 0, "failed": 0, "stopped": None, "language": language}
    paused_until = core.load_state().get(PAUSED_UNTIL_KEY) or 0
    if clock() < paused_until:
        stats["stopped"] = "paused"
        log("texts: lookups paused for %ds more" % int(paused_until - clock()))
        return stats

    def ask(media_type, catalog_id, lang, episode_keys):
        if stats["asked"] >= max_lookups:
            raise _Stop("budget")
        if count_tickets() <= TICKET_FLOOR:
            raise _Stop("ticket_floor")
        if stats["asked"]:
            sleep(LOOKUP_PAUSE_SECONDS)
        stats["asked"] += 1
        try:
            answer = ctx.metadata.lookup({"op": "details", "type": media_type, "id": catalog_id, "language": lang})
        except NoTicketError:
            raise _Stop("no_ticket")
        except MetadataUnavailableError as exc:
            pause = exc.retry_after if exc.retry_after is not None else PAUSE_DEFAULT_SECONDS if exc.status else PAUSE_NETWORK_SECONDS
            core.save_state(**{PAUSED_UNTIL_KEY: clock() + min(max(pause, 1), PAUSE_MAX_SECONDS)})
            log("texts: service asked for a pause (%s, %ss)" % (exc.status or "unreachable", pause), "warning")
            raise _Stop("paused")
        except (TicketRejectedError, MetadataRequestError) as exc:
            stats["failed"] += 1
            log("texts: details lookup failed for one title: %s" % exc, "warning")
            return None
        item = answer.get("item") if isinstance(answer, dict) else None
        record = record_of(item if isinstance(item, dict) else {}, episode_keys, now())
        lib.write_op(ctx.api, ctx.key, "setting.set", {"key": key(media_type, catalog_id, lang), "value": serialize(record), "updatedAt": now()})
        stats["written"] += 1
        return record

    def ensure(media_type, catalog_id, lang, episode_keys):
        row = parse(lib.setting_value(key(media_type, catalog_id, lang)))
        if row and covers(row, episode_keys):
            stats["kept"] += 1
            return row
        # An out-of-date row still beats no text when the lookup fails.
        return ask(media_type, catalog_id, lang, episode_keys) or row

    try:
        for media_type in ("movie", "tv"):
            for media in lib.list_media(media_type):
                catalog_id = _catalog_id(media)
                if not catalog_id:
                    continue
                stats["titles"] += 1
                episode_keys = [episode_key(e["season_number"], e["episode_number"]) for e in lib.episodes(media["id"])] if media_type == "tv" else []
                own = ensure(media_type, catalog_id, language, episode_keys)
                if language != FALLBACK_LANGUAGE and own is not None and _lacking(own):
                    ensure(media_type, catalog_id, FALLBACK_LANGUAGE, episode_keys)
    except _Stop as stop:
        stats["stopped"] = str(stop)
    log("texts: %s" % stats)
    return stats

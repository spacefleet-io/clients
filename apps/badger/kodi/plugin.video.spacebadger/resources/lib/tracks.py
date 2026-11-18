# -*- coding: utf-8 -*-
"""Synced audio/subtitle preferences (PLAY-TRACK-04, INTG-KODI-04). Pure logic, no Kodi imports.

Contract (shared by desktop, mobile, Jellyfin and this addon; /tmp/sf-intg/track-prefs-contract.md): one plain
`setting.set` op per movie or TV show, key `track_prefs_v1:<mediaId>` (the SHOW id for an episode), value
{"audioLanguage": "fr"|null, "subtitle": {"language","format"?,"forced"?}|"off"|null, "updatedAt": ISO}.
"""
import json

KEY_PREFIX = "track_prefs_v1:"

# 639-1 first, then its 639-2 variants (contract table)
_GROUPS = (
    "en=eng fr=fre=fra de=ger=deu es=spa it=ita pt=por ru=rus ja=jpn ko=kor zh=chi=zho "
    "nl=dut=nld sv=swe no=nor=nob=nno da=dan fi=fin pl=pol tr=tur ar=ara he=heb hi=hin "
    "cs=cze=ces hu=hun el=gre=ell uk=ukr th=tha vi=vie id=ind ro=rum=ron bg=bul fa=per=fas "
    "is=ice=isl ms=may=msa bn=ben"
).split()
_TO_ISO1 = {}
for _g in _GROUPS:
    _parts = _g.split("=")
    for _p in _parts:
        _TO_ISO1[_p] = _parts[0]


def norm_lang(value):
    """Lowercase ISO 639-1 when the language has one, else the lowercased code; '' for und/empty."""
    v = (value or "").strip().lower().replace("_", "-").split("-")[0]
    if not v or v in ("und", "unk", "mis"):
        return ""
    return _TO_ISO1.get(v, v)


def lang_equal(a, b):
    na, nb = norm_lang(a), norm_lang(b)
    return bool(na) and na == nb


def key_for(media_id):
    return KEY_PREFIX + media_id


def parse(raw):
    """The stored JSON string -> dict, or None for a missing/malformed record."""
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    audio = data.get("audioLanguage")
    sub = data.get("subtitle")
    if audio is not None and not isinstance(audio, str):
        return None
    if sub is not None and sub != "off" and not (isinstance(sub, dict) and isinstance(sub.get("language"), str)):
        return None
    return data


def merge(current, audio=None, subtitle=None, updated_at=""):
    """Read-modify-write: only the given fields change, unknown fields are kept. `subtitle` is 'off' or a dict.
    Returns the new JSON string (same updatedAt goes into the op payload)."""
    record = dict(current or {})
    if audio:
        record["audioLanguage"] = norm_lang(audio) or audio.lower()
    if subtitle is not None:
        record["subtitle"] = subtitle
    record.setdefault("audioLanguage", None)
    record.setdefault("subtitle", None)
    record["updatedAt"] = updated_at
    return json.dumps(record, separators=(",", ":"))


def subtitle_choice(language, forced=False, fmt=None):
    sub = {"language": norm_lang(language) or (language or "").lower(), "forced": bool(forced)}
    if fmt:
        sub["format"] = fmt
    return sub


def stream_format(stream):
    """Subtitle format of a Kodi stream: an explicit 'format', else the extension of a sidecar file name ('sub-x.fre.sup')."""
    fmt = (stream.get("format") or "").lower()
    if fmt:
        return fmt
    name = (stream.get("name") or "").lower()
    ext = name.rsplit(".", 1)[-1] if "." in name else ""
    return ext if ext in ("srt", "sup", "ass", "ssa", "vtt", "sub") else ""


def find_stream(streams, language, forced=None, fmt=None):
    """streams: Kodi JSON-RPC audiostreams/subtitles ({index, language, isforced, ...}). Index or None.

    Same language; prefer the same `forced`, then the same format when both sides know it, then any same-language track."""
    if not language:
        return None
    same = [s for s in streams if lang_equal(s.get("language"), language)]
    if not same:
        return None
    if forced is not None:
        exact = [s for s in same if bool(s.get("isforced")) == bool(forced)]
        same = exact or same
    if fmt:
        by_fmt = [s for s in same if stream_format(s) == fmt.lower()]
        same = by_fmt or same
    return same[0].get("index")

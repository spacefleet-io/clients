# -*- coding: utf-8 -*-
"""Artwork from the user's vault only (META-ART-01, META-ART-02).

A picture is an `asset:<ct>::<key>` ref: an encrypted object in the user's storage, decrypted once into
<addon_data>/art/<sha1>.<ext> so Kodi (and the exporter) read local files. A provider path still in the library
(`/x.jpg`: its vault copy is not made yet) shows no picture and is never looked up here: the device that imports or
refreshes a title fetches its pictures from the metadata service and stores the copies, and a later library sync brings
the asset ref. Kodi itself writes no artwork into the library, so it never calls the metadata service for a picture.

The cache is bounded by bytes (ART_CACHE_BYTES; the least recently shown pictures go first), kept across restarts and
removed on sign-out with the rest of the add-on data (core.wipe_everything).

Nothing logged here names a title, an id or a path (PRIV-SRV-03 spirit: no log line says what was looked at).
"""
import hashlib
import os
import re
from concurrent.futures import ThreadPoolExecutor

import crypto
from compat import data_dir, log

# Decrypted pictures kept on disk; past this the least recently shown ones are removed.
ART_CACHE_BYTES = 128 * 1024 * 1024
_EXTS = ("jpg", "png")


def art_dir():
    path = os.path.join(data_dir(), "art")
    if not os.path.isdir(path):
        os.makedirs(path, exist_ok=True)  # fetch_many's workers may all create it on the first listing
    return path


def display_source(ref):
    """Where a stored picture shows from, as the shared `artworkDisplaySource`: "vault" (the user's encrypted copy),
    "pending" (a provider path whose copy is not made yet: placeholder) or "none" (placeholder)."""
    if not isinstance(ref, str) or not ref:
        return "none"
    if re.match(r"^/[^/]", ref):
        return "pending"
    if ref.startswith("asset:"):
        return "vault" if ref.find("::") > 0 else "none"
    return "none" if re.match(r"^[a-z][a-z0-9+.-]*:", ref, re.I) else "vault"


def _ext_for(content_type, data):
    ct = (content_type or "").lower()
    if "png" in ct or data[:4] == b"\x89PNG":
        return "png"
    return "jpg"


def _cache_base(ref):
    return os.path.join(art_dir(), hashlib.sha1(ref.encode("utf-8")).hexdigest())


def cached_path(ref):
    """The decrypted picture of a vault ref on disk, or None."""
    if display_source(ref) != "vault":
        return None
    base = _cache_base(ref)
    for ext in _EXTS:
        if os.path.exists(base + "." + ext):
            return base + "." + ext
    return None


def _store(ref, data, content_type=None):
    path = "%s.%s" % (_cache_base(ref), _ext_for(content_type, data))
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)
    return path


def _trim(keep=()):
    """Removes the least recently shown pictures until the cache fits ART_CACHE_BYTES; `keep` (the pictures the
    current listing shows) is never removed."""
    try:
        entries = []
        total = 0
        with os.scandir(art_dir()) as it:
            for entry in it:
                try:
                    stat = entry.stat()
                except OSError:
                    continue
                entries.append((stat.st_mtime, stat.st_size, entry.path))
                total += stat.st_size
        if total <= ART_CACHE_BYTES:
            return
        before, removed = total, 0
        keep = set(keep)
        for _mtime, size, path in sorted(entries):
            if total <= ART_CACHE_BYTES:
                break
            if path in keep:
                continue
            try:
                os.remove(path)
            except OSError:
                continue
            total -= size
            removed += 1
        log("artwork cache trimmed: %d -> %d bytes, %d pictures removed" % (before, total, removed))
    except OSError as exc:
        log("artwork cache trim failed: %s" % type(exc).__name__, "warning")


def _fetch_one(ctx, kind, ref):
    """(path-or-None, stored): the local file of a vault ref, decrypted from the user's storage on a cache miss."""
    if display_source(ref) != "vault" or not ref.startswith(("asset:", "assets/")):
        return None, False
    hit = cached_path(ref)
    if hit:
        try:
            os.utime(hit, None)  # just shown: the bound removes the least recently shown pictures first
        except OSError:
            pass
        return hit, False
    try:
        if ref.startswith("asset:"):
            content_type, _, key = ref[len("asset:"):].partition("::")
        else:
            content_type, key = None, ref
        # Artwork is library data: it keeps flowing while the silo is saturated (STOR-BW-09).
        raw = ctx.api.download(key, "library")
        plain = crypto.envelope_decrypt_b64(ctx.key, raw.decode("utf-8").strip())
        return _store(ref, plain, content_type), True
    except Exception as exc:  # noqa: BLE001 - artwork must never break browsing
        log("artwork %s failed: %s" % (kind, type(exc).__name__), "warning")
        return None, False


def fetch(ctx, kind, ref):
    """Local file path for an artwork ref, or None (a provider path, or the vault copy cannot be read now).
    kind: poster|backdrop|still|profile, for the log only."""
    path, stored = _fetch_one(ctx, kind, ref)
    if stored:
        _trim(keep=(path,))
    return path


def fetch_many(ctx, wanted, workers=6):
    """wanted: iterable of (kind, ref). Returns {(kind, ref): path-or-None}; vault copies only, never a lookup."""
    wanted = [w for w in dict.fromkeys(wanted) if w[1]]
    out = {}
    stored_any = False
    if wanted:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for w, (path, stored) in zip(wanted, pool.map(lambda w: _fetch_one(ctx, w[0], w[1]), wanted)):
                out[w] = path
                stored_any = stored_any or stored
    if stored_any:
        _trim(keep=[p for p in out.values() if p])
    return out

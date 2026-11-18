# -*- coding: utf-8 -*-
"""Local HLS server (127.0.0.1, random port) serving decrypted Badger media to inputstream.adaptive.

Model: apps/badger/desktop/src/main/playbackServer.ts. Routes (all under a random per-run secret prefix):
  /<secret>/m/<mediaId>/<episodeId|_>/master.m3u8          every video quality as a variant + audio renditions
  /<secret>/m/<mediaId>/<episodeId|_>/video-<formatId>.m3u8
  /<secret>/m/<mediaId>/<episodeId|_>/audio-<trackId>.m3u8
  /<secret>/m/<mediaId>/<episodeId|_>/sub-<subId>.<lang>.srt|sup   subtitle sidecar files (INTG-KODI-03)
  /<secret>/o/<urlquoted objectKey>.mp4|.m4s                fetch via tunnel + SFV1 decrypt (LRU cache + prefetch)
"""
import json
import math
import os
import re
import socket
import threading
import urllib.parse
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

import crypto
from api import ApiError, PlaybackUnavailableError, PlaybackStoppedError, UnpaidError, _json_or_empty, _raise_for, http_request
from compat import log

PREFETCH_SEGMENTS = 3
CACHE_MIN_BYTES = 32 * 1024 * 1024
CACHE_MAX_BYTES = 128 * 1024 * 1024
CACHE_FALLBACK_BYTES = 64 * 1024 * 1024
CACHE_RAM_DIVISOR = 64  # 1/64 of RAM: 32 MiB on a 2 GiB box, 128 MiB from 8 GiB up
# Set by the play preflight (playback._preflight), which reports errors itself: no second notice from the service.
PREFLIGHT_HEADER = "X-SpaceBadger-Preflight"
RESOLUTION_BY_QUALITY = {
    "2160p": (3840, 2160), "4k": (3840, 2160), "1440p": (2560, 1440), "1080p": (1920, 1080),
    "720p": (1280, 720), "576p": (1024, 576), "480p": (854, 480), "360p": (640, 360), "240p": (426, 240),
}
CAP_HEIGHT = {"480p": 480, "1080p": 1080}


# --------------------------------------------------------------------------------------------
# pure playlist building (unit-tested)
# --------------------------------------------------------------------------------------------
def segment_durations(chunks, total_duration):
    """Segment duration = next.start - start; last = duration - start; fallback duration/count."""
    count = len(chunks)
    if count == 0:
        return []
    out = []
    for i, chunk in enumerate(chunks):
        start = chunk.get("start_seconds")
        if i + 1 < count:
            nxt = chunks[i + 1].get("start_seconds")
            if start is not None and nxt is not None and nxt > start:
                out.append(float(nxt) - float(start))
                continue
        else:
            if start is not None and total_duration and total_duration > start:
                out.append(float(total_duration) - float(start))
                continue
        out.append(float(total_duration) / count if total_duration else 6.0)
    if count > 1:
        # A last segment more than twice as long as every other one is implausible for a segmented
        # stream (metadata duration disagreeing with the stored segments, seen on dev/test data): clamp it
        # to the average of the others so players do not see a multi-hour tail segment.
        others = out[:-1]
        if out[-1] > 2 * max(others):
            clamped = sum(others) / len(others)
            log("last segment %.1fs implausible (others max %.1fs): clamped to %.1fs" % (out[-1], max(others), clamped), "warning")
            out[-1] = clamped
    return out


def _object_url(base, key, suffix):
    return "%s/o/%s%s" % (base, urllib.parse.quote(key, safe=""), suffix)


# The service waits up to 180 s for an object (ObjectCache.get); the preflight allows that plus the local round trip.
PREFLIGHT_TIMEOUT = 190


def preflight_object(base, key, timeout=PREFLIGHT_TIMEOUT):
    """Play preflight through the long-lived service (`base` = its /<secret> URL): it fetches + decrypts `key` with its
    warm API client (placement, gateway, tunnel session already known) and keeps the plaintext in its cache, so the
    player's request for the same init segment is a cache hit. One byte comes back. The service's error answers are
    raised as the API errors they came from (402 UnpaidError, 503 PlaybackRefused/StoppedError, 401, profile gone)."""
    status, _h, raw = http_request("GET", _object_url(base, key, ".mp4"), {PREFLIGHT_HEADER: "1", "Range": "bytes=0-0"}, None, timeout)
    if status in (200, 206):
        return
    message = _json_or_empty(raw).get("message")
    try:
        _raise_for(status, raw)
    except ApiError as exc:
        if message and type(exc) is ApiError:
            raise ApiError(exc.status, exc.body, message) from None
        raise


def build_track_playlist(base, init_key, chunks, total_duration):
    durations = segment_durations(chunks, total_duration)
    target = max(1, int(math.ceil(max(durations)))) if durations else 1
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        "#EXT-X-TARGETDURATION:%d" % target,
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        '#EXT-X-MAP:URI="%s"' % _object_url(base, init_key, ".mp4"),
    ]
    for chunk, dur in zip(chunks, durations):
        lines.append("#EXTINF:%.3f," % dur)
        lines.append(_object_url(base, chunk["chunk_key"], ".m4s"))
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


def format_bandwidth(fmt):
    """bits/s. Prefer the measured size/duration (dev data carries nonsense bitrate_kbps), else bitrate_kbps."""
    total = fmt.get("total_size")
    if not total:
        sizes = [c.get("size_bytes") for c in fmt.get("chunks", []) if c.get("size_bytes")]
        total = sum(sizes) if sizes else None
    duration = fmt.get("duration_seconds")
    if total and duration and duration > 0:
        return max(1, int(total * 8 / duration))
    kbps = fmt.get("bitrate_kbps")
    return max(1, int((kbps or 5000) * 1000))


def quality_resolution(quality):
    q = (quality or "").strip().lower()
    if q in RESOLUTION_BY_QUALITY:
        return RESOLUTION_BY_QUALITY[q]
    m = re.match(r"^(\d{3,4})p$", q)
    if m:
        h = int(m.group(1))
        return (int(round(h * 16 / 9 / 2.0)) * 2, h)
    return None


def _escape_attr(text):
    return (text or "").replace('"', "'")


def apply_quality_cap(formats, cap):
    """PLAY-QUAL-07: the rungs a viewer under `cap` may be offered while its silo is saturated -> (formats, stop).
    480p (free): only rungs at or under 480p, and stop when there is none. 1080p (Starter, Standard): only rungs at or
    under 1080p, and keep everything when there is none (a paying viewer is never stopped). Any other cap changes nothing."""
    limit = CAP_HEIGHT.get(cap)
    if limit is None:
        return formats, False
    kept = [f for f in formats if (quality_resolution(f.get("quality")) or (0, limit + 1))[1] <= limit]
    if kept:
        return kept, False
    return (formats, False) if cap == "1080p" else ([], True)


def build_master(base, unit):
    """Master playlist: ALL stored qualities as variants (INTG-QUAL-01) + all audio tracks as renditions."""
    lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    audio = [t for t in unit["audio"] if t.get("init_key") and t.get("chunks")]
    primary = next((t for t in audio if t.get("is_default")), audio[0] if audio else None)
    label_counts = {}
    for t in audio:
        k = (t.get("label") or "").strip().lower()
        label_counts[k] = label_counts.get(k, 0) + 1
    seen = {}
    for t in audio:
        base_label = (t.get("label") or "").strip() or (t.get("language") or "Audio")
        k = base_label.lower()
        seen[k] = seen.get(k, 0) + 1
        name = "%s %d" % (base_label, seen[k]) if label_counts.get((t.get("label") or "").strip().lower(), 0) > 1 else base_label
        attrs = [
            "TYPE=AUDIO", 'GROUP-ID="audio"', 'NAME="%s"' % _escape_attr(name),
        ]
        if t.get("language"):
            attrs.append('LANGUAGE="%s"' % _escape_attr(t["language"]))
        attrs += ["DEFAULT=%s" % ("YES" if t is primary else "NO"), "AUTOSELECT=YES", 'URI="%s/m/%s/%s/audio-%s.m3u8"' % (base, unit["media"]["id"], unit["ep"], t["id"])]
        lines.append("#EXT-X-MEDIA:" + ",".join(attrs))
    for fmt in unit["formats"]:
        if not fmt.get("init_key") or not fmt.get("chunks"):
            continue
        codecs = ",".join(c for c in (fmt.get("codec_string"), primary.get("codec_string") if primary else None) if c)
        attrs = ["BANDWIDTH=%d" % format_bandwidth(fmt)]
        if codecs:
            attrs.append('CODECS="%s"' % codecs)
        res = quality_resolution(fmt.get("quality"))
        if res:
            attrs.append("RESOLUTION=%dx%d" % res)
        if audio:
            attrs.append('AUDIO="audio"')
        lines.append("#EXT-X-STREAM-INF:" + ",".join(attrs))
        lines.append("%s/m/%s/%s/video-%s.m3u8" % (base, unit["media"]["id"], unit["ep"], fmt["id"]))
    return "\n".join(lines) + "\n"


def subtitle_extension(fmt):
    f = (fmt or "").lower()
    if f in ("srt", "sup", "ass", "ssa", "vtt", "sub"):
        return f
    return None


def subtitle_filename(sub):
    ext = subtitle_extension(sub.get("format"))
    if not ext:
        return None
    lang = re.sub(r"[^A-Za-z0-9_-]", "", sub.get("language") or "und") or "und"
    return "sub-%s.%s.%s" % (sub["id"], lang, ext)


def physical_ram_bytes():
    """Total RAM from os.sysconf, or None where the platform does not report it (Windows)."""
    try:
        pages, page_size = os.sysconf("SC_PHYS_PAGES"), os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, ValueError, OSError):
        return None
    if pages <= 0 or page_size <= 0:
        return None
    return pages * page_size


def cache_max_bytes(ram_bytes=None):
    """Decrypted-segment cache budget (PERF-MEM): RAM / 64 clamped to 32..128 MiB; 64 MiB when RAM is unknown."""
    ram = physical_ram_bytes() if ram_bytes is None else ram_bytes
    if not ram:
        return CACHE_FALLBACK_BYTES
    return max(CACHE_MIN_BYTES, min(CACHE_MAX_BYTES, ram // CACHE_RAM_DIVISOR))


def _footprint(data):
    """Bytes a cached object really holds: a plaintext view keeps its whole decrypt buffer (header + pad) alive."""
    owner = getattr(data, "obj", None)
    return len(owner) if isinstance(owner, (bytes, bytearray)) else len(data)


# --------------------------------------------------------------------------------------------
# object fetching: tunnel download + SFV1 decrypt, LRU cache, in-flight de-dup, prefetch
# --------------------------------------------------------------------------------------------
class ObjectCache(object):
    def __init__(self, api, master_key, max_bytes=None):
        self.api = api
        self.master = master_key
        self.max_bytes = cache_max_bytes() if max_bytes is None else max_bytes
        self._lru = OrderedDict()
        self._bytes = 0
        self._lock = threading.RLock()
        self._inflight = {}
        self._pool = ThreadPoolExecutor(max_workers=3)
        self._next = {}  # key -> [following keys] (registered when playlists are generated)

    def register_sequence(self, keys):
        with self._lock:
            for i, key in enumerate(keys):
                self._next[key] = keys[i + 1:i + 1 + PREFETCH_SEGMENTS]

    def _put(self, key, data):
        with self._lock:
            if key in self._lru:
                self._bytes -= _footprint(self._lru.pop(key))
            self._lru[key] = data
            self._bytes += _footprint(data)
            while self._bytes > self.max_bytes and len(self._lru) > 1:
                _k, old = self._lru.popitem(last=False)
                self._bytes -= _footprint(old)

    def _fetch(self, key):
        raw = self.api.download(key, "playback")
        plain, was_encrypted = crypto.sfv1_decrypt(self.master, raw)
        log("object %s fetched: %d -> %d bytes%s" % (key.split("/")[-1][:8], len(raw), len(plain), "" if was_encrypted else " (plain)"), "debug")
        self._put(key, plain)
        return plain

    def get(self, key):
        """The object the player asks for now. A miss is fetched on the asking thread, never queued in the prefetch
        pool: after a seek the wanted segment goes first instead of waiting behind the segments that followed the old
        position. A prefetch of this key still queued is cancelled (fetched here instead); one already downloading is
        joined, not repeated."""
        with self._lock:
            hit = self._lru.get(key)
            if hit is not None:
                self._lru.move_to_end(key)
                return hit
            fut = self._inflight.get(key)
            if fut is not None and (fut.done() or fut.cancel()):  # finished (its callback not run yet) or still queued
                fut = None
            if fut is not None:
                mine = False
            else:
                fut = Future()
                fut.set_running_or_notify_cancel()
                self._inflight[key] = fut
                mine = True
        if not mine:
            data = fut.result(timeout=180)
            # a failed prefetch logs and yields None: the player's request fetches it itself and meets the error
            return data if data is not None else self.get(key)
        try:
            data = self._fetch(key)
            fut.set_result(data)
            return data
        except BaseException as exc:
            fut.set_exception(exc)
            raise
        finally:
            self._done(key, fut)

    def _done(self, key, fut):
        with self._lock:
            if self._inflight.get(key) is fut:
                del self._inflight[key]

    def prefetch_after(self, key):
        with self._lock:
            followers = list(self._next.get(key, ()))
        for nxt in followers:
            with self._lock:
                if nxt in self._lru or nxt in self._inflight:
                    continue
                fut = self._pool.submit(self._fetch_quiet, nxt)
                self._inflight[nxt] = fut
                fut.add_done_callback(lambda f, k=nxt: self._done(k, f))

    def _fetch_quiet(self, key):
        try:
            return self._fetch(key)
        except Exception as exc:  # noqa: BLE001
            log("prefetch %s failed: %s" % (key, exc), "warning")
            return None


# --------------------------------------------------------------------------------------------
# server
# --------------------------------------------------------------------------------------------
class _Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class PlaybackServer(object):
    def __init__(self, ctx_factory, secret, on_unavailable=None):
        """ctx_factory() -> Context (fresh: picks up a new token/key after settings changes)."""
        self.ctx_factory = ctx_factory
        self.on_unavailable = on_unavailable  # called with the PlaybackUnavailableError when a silo refuses or stops playback
        self.secret = secret
        self.httpd = None
        self.thread = None
        self.port = None
        self._ctx = None
        self._cache = None
        self._lock = threading.Lock()

    @property
    def base(self):
        return "http://127.0.0.1:%d/%s" % (self.port, self.secret)

    def context(self):
        with self._lock:
            if self._ctx is None:
                self._ctx = self.ctx_factory()
                self._cache = ObjectCache(self._ctx.api, self._ctx.master)
            return self._ctx, self._cache

    def reset(self):
        """Settings/credentials changed: rebuild context + cache lazily."""
        with self._lock:
            self._ctx = None
            self._cache = None

    def start(self):
        handler = _make_handler(self)
        self.httpd = _Server(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, name="sb-playback-http", daemon=True)
        self.thread.start()
        log("playback server listening on 127.0.0.1:%d" % self.port)

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
            log("playback server stopped")


def _make_handler(server):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "SpaceBadgerLocal/0.1"

        def log_message(self, fmt, *args):  # route http.server noise to the Kodi log
            log("http %s - %s" % (self.address_string(), fmt % args), "debug")

        def _send(self, status, body, ctype, head=False, extra=None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if not head:
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        def _send_ranged(self, data, ctype, head):
            rng = self.headers.get("Range")
            if rng:
                m = re.match(r"bytes=(\d*)-(\d*)", rng)
                if m and (m.group(1) or m.group(2)):
                    size = len(data)
                    if m.group(1):
                        start = int(m.group(1))
                        end = int(m.group(2)) if m.group(2) else size - 1
                    else:
                        start = max(0, size - int(m.group(2)))
                        end = size - 1
                    end = min(end, size - 1)
                    if start > end or start >= size:
                        return self._send(416, b"", ctype, head, {"Content-Range": "bytes */%d" % size})
                    return self._send(206, memoryview(data)[start:end + 1], ctype, head, {"Content-Range": "bytes %d-%d/%d" % (start, end, size)})
            return self._send(200, data, ctype, head)

        def _error(self, status, code, extra=None):
            body = json.dumps(dict({"error": code}, **(extra or {}))).encode("utf-8")
            self._send(status, body, "application/json")

        def do_HEAD(self):
            self._route(True)

        def do_GET(self):
            self._route(False)

        def _route(self, head):
            try:
                path = urllib.parse.urlsplit(self.path).path
                prefix = "/%s/" % server.secret
                if not path.startswith(prefix):
                    return self._error(404, "not_found")
                rest = path[len(prefix):]
                if rest.startswith("o/"):
                    return self._object(rest[2:], head)
                if rest.startswith("m/"):
                    return self._media(rest[2:], head)
                if rest == "health":
                    return self._send(200, b"ok", "text/plain", head)
                self._error(404, "not_found")
            except UnpaidError as exc:
                log("playback refused: subscription unpaid (wipeAt=%s)" % exc.wipe_at, "warning")
                self._error(402, "subscription_unpaid", {"wipeAt": exc.wipe_at})
            except PlaybackUnavailableError as exc:
                log("playback unavailable: %s" % exc, "warning")
                if server.on_unavailable and not self.headers.get(PREFLIGHT_HEADER):
                    server.on_unavailable(exc)  # a play preflight shows its own dialog instead
                self._error(503, exc.code or "playback_unavailable", {"traffic": exc.traffic})
            except ApiError as exc:
                log("playback api error: %s" % exc, "error")
                self._error(502 if exc.status >= 500 else exc.status, exc.code or "api_error", {"message": str(exc)})
            except Exception as exc:  # noqa: BLE001
                log("playback server error on %s: %r" % (self.path, exc), "error")
                try:
                    self._error(500, "internal_error", {"message": str(exc)})
                except Exception:  # noqa: BLE001
                    pass

        def _object(self, rest, head):
            quoted = rest.rsplit(".", 1)[0] if "." in rest else rest
            key = urllib.parse.unquote(quoted)
            ctx, cache = server.context()
            data = cache.get(key)
            cache.prefetch_after(key)
            self._send_ranged(data, "video/mp4", head)

        def _formats_within_cap(self, ctx, formats):
            """The variants the silo's quality cap allows right now (asked per play, not cached: the cap lifts with the silo)."""
            first = next((f for f in formats if f.get("init_key")), None)
            if not first:
                return formats
            try:
                traffic = ctx.api.refresh_traffic(first["init_key"])
            except (ApiError, OSError) as exc:
                log("traffic report unavailable, no quality cap applied: %s" % exc, "warning")
                return formats
            if not traffic or not traffic["saturated"]:
                return formats
            kept, stop = apply_quality_cap(formats, traffic["qualityCap"])
            if stop:
                raise PlaybackStoppedError(503, {"error": "playback_stopped", "traffic": traffic})
            return kept

        def _media(self, rest, head):
            parts = rest.split("/")
            if len(parts) != 3:
                return self._error(404, "not_found")
            media_id, ep, name = parts
            ctx, cache = server.context()
            unit = ctx.lib.playable_unit(media_id, None if ep == "_" else ep)
            if not unit:
                return self._error(404, "media_not_found")
            unit["ep"] = ep
            base = server.base
            if name == "master.m3u8":
                unit["formats"] = self._formats_within_cap(ctx, unit["formats"])
                body = build_master(base, unit).encode("utf-8")
                log("master.m3u8 for %s ep=%s: %d variants, %d audio, %d subs" % (media_id, ep, len(unit["formats"]), len(unit["audio"]), len(unit["subtitles"])))
                return self._send(200, body, "application/vnd.apple.mpegurl", head)
            m = re.match(r"^(video|audio)-(.+)\.m3u8$", name)
            if m:
                kind, ident = m.groups()
                rows = unit["formats"] if kind == "video" else unit["audio"]
                row = next((r for r in rows if r["id"] == ident), None)
                if not row:
                    return self._error(404, "track_not_found")
                cache.register_sequence([row["init_key"]] + [c["chunk_key"] for c in row["chunks"]])
                body = build_track_playlist(base, row["init_key"], row["chunks"], row.get("duration_seconds")).encode("utf-8")
                return self._send(200, body, "application/vnd.apple.mpegurl", head)
            m = re.match(r"^sub-(.+?)\.[A-Za-z0-9_-]+\.([a-z]+)$", name)
            if m:
                sub = next((s for s in unit["subtitles"] if s["id"] == m.group(1)), None)
                if not sub or not sub.get("object_key"):
                    return self._error(404, "subtitle_not_found")
                data = cache.get(sub["object_key"])
                ctype = "application/x-subrip" if m.group(2) == "srt" else "application/octet-stream"
                return self._send_ranged(data, ctype, head)
            self._error(404, "not_found")

    return Handler


def free_port_probe():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port

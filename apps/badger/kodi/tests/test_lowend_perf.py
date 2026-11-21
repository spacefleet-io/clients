"""Low-end host fixes ported from the desktop app (issue #934): segment decrypt without copies, a RAM-sized segment
cache, a play preflight through the service, parallel gateway probes, no export/scan for an unchanged library, and
background work held back at boot and during playback. Follow-ups (issue #956): a manual export of an unchanged
library starts no rescan, a delete removes only that title's export, a seek's segment goes before the prefetches, and
the library snapshot loads without extra full copies.

@req INTG-KODI-01 AES-256-GCM through the system OpenSSL, else the packaged pycryptodomex: both decrypt segments in
                  place and refuse a tampered one before any byte exists
@req INTG-KODI-03 the local HLS server answers byte ranges of the decrypted segment exactly
"""
import ctypes
import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
import tracemalloc
import unittest
import urllib.request
from unittest import mock

_DATA = tempfile.mkdtemp(prefix="sb-kodi-lowend-")
os.environ["SB_DATA_DIR"] = _DATA

import _path  # noqa: F401,E402
import api  # noqa: E402
import core  # noqa: E402
import crypto  # noqa: E402
import export  # noqa: E402
import hls  # noqa: E402
import images  # noqa: E402
import library  # noqa: E402
import payload_codec  # noqa: E402
import playback  # noqa: E402
import router  # noqa: E402
import syncer  # noqa: E402
import vendor_loader  # noqa: E402

MASTER = crypto.derive_media_master_key(bytes(range(32)))


def _backends():
    """Every AES-GCM backend this host can load, by name."""
    found = {}
    for name in crypto._candidate_libcrypto_names():
        try:
            found["libcrypto"] = crypto._LibcryptoBackend(ctypes.CDLL(name))
            break
        except Exception:  # noqa: BLE001
            continue
    vendor_loader.prepare()
    try:
        from Cryptodome.Cipher import AES
        found["Cryptodome"] = crypto._CryptodomeBackend(AES)
    except Exception:  # noqa: BLE001
        pass
    return found


class DecryptInPlace(unittest.TestCase):
    def _each_backend(self):
        backends = _backends()
        if not backends:
            self.skipTest("no AES-GCM backend on this host")
        for name, backend in backends.items():
            with self.subTest(backend=name), mock.patch.object(crypto, "_backend", backend):
                yield name

    def test_sfv1_round_trip_returns_a_view_of_the_plaintext(self):
        # @req INTG-KODI-01
        plain = os.urandom(256 * 1024 + 7)
        obj = crypto.sfv1_encrypt(MASTER, plain, pad=b"\x00" * 4096)
        for _name in self._each_backend():
            got, was_encrypted = crypto.sfv1_decrypt(MASTER, obj)
            self.assertTrue(was_encrypted)
            self.assertIsInstance(got, memoryview)
            self.assertEqual(got, plain)
            self.assertEqual(len(got.obj), len(obj) - 4 - 16 - 12 - 16 + (16 if _name == "libcrypto" else 0))

    def test_tampered_object_is_refused_on_every_byte_region(self):
        # @req INTG-KODI-01
        obj = crypto.sfv1_encrypt(MASTER, b"segment" * 500)
        for _name in self._each_backend():
            for pos in (40, len(obj) // 2, len(obj) - 1):  # ciphertext start, middle, tag
                bad = bytearray(obj)
                bad[pos] ^= 1
                with self.assertRaises(crypto.AuthenticationError):
                    crypto.sfv1_decrypt(MASTER, bytes(bad))

    def test_offset_decrypt_matches_slice_decrypt_and_envelope_stays_bytes(self):
        # @req INTG-KODI-01
        key = bytes(range(32))
        for _name in self._each_backend():
            blob = crypto.envelope_encrypt(key, b"abc" * 1000)
            view = crypto.aes_gcm_decrypt_view(key, blob[:12], b"junk" + blob, b"", 4 + 12)
            self.assertEqual(view, b"abc" * 1000)
            out = crypto.envelope_decrypt(key, blob)
            self.assertIsInstance(out, bytes)
            self.assertEqual(out, b"abc" * 1000)
            with self.assertRaises(crypto.AuthenticationError):
                crypto.aes_gcm_decrypt_view(bytes(32), blob[:12], blob, b"", 12)


class CacheBudget(unittest.TestCase):
    def test_budget_follows_ram_within_32_to_128_mib(self):
        mib, gib = 1024 * 1024, 1024 * 1024 * 1024
        self.assertEqual(hls.cache_max_bytes(1 * gib), 32 * mib)
        self.assertEqual(hls.cache_max_bytes(2 * gib), 32 * mib)
        self.assertEqual(hls.cache_max_bytes(4 * gib), 64 * mib)
        self.assertEqual(hls.cache_max_bytes(8 * gib), 128 * mib)
        self.assertEqual(hls.cache_max_bytes(64 * gib), 128 * mib)
        with mock.patch.object(hls, "physical_ram_bytes", return_value=None):
            self.assertEqual(hls.cache_max_bytes(), 64 * mib)
        self.assertTrue(32 * mib <= hls.ObjectCache(None, MASTER).max_bytes <= 128 * mib)

    def test_cache_counts_the_whole_decrypt_buffer_behind_a_view(self):
        cache = hls.ObjectCache(None, MASTER, max_bytes=250)
        buf = bytearray(100)
        cache._put("a", memoryview(buf)[10:20])  # holds 100 bytes, shows 10
        self.assertEqual(cache._bytes, 100)
        cache._put("b", memoryview(bytearray(100))[:5])
        cache._put("c", memoryview(bytearray(100))[:5])
        self.assertNotIn("a", cache._lru)  # 300 > 250: the oldest goes
        self.assertEqual(cache._bytes, 200)


class FakeApi(object):
    def __init__(self, objects, error=None):
        self.objects = objects
        self.error = error
        self.downloads = []

    def download(self, key, purpose="playback"):
        self.downloads.append(key)
        if self.error:
            raise self.error
        return self.objects[key]


class FakeCtx(object):
    def __init__(self, fake_api):
        self.api = fake_api
        self.master = MASTER


class LocalServer(unittest.TestCase):
    KEY = "media/plc12345/init-1080"

    def setUp(self):
        self.plain = bytes(range(256)) * 40  # 10240 bytes
        self.api = FakeApi({self.KEY: crypto.sfv1_encrypt(MASTER, self.plain, pad=b"\x00" * 333)})
        self.unavailable = []
        self.server = hls.PlaybackServer(lambda: FakeCtx(self.api), "s3cret", on_unavailable=self.unavailable.append)
        self.server.start()
        self.addCleanup(self.server.stop)

    def _get(self, rng=None):
        req = urllib.request.Request(hls._object_url(self.server.base, self.KEY, ".mp4"), headers={"Range": rng} if rng else {})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as err:
            return err.code, err.headers, err.read()

    def test_ranged_replies_carry_exactly_the_requested_bytes(self):
        # @req INTG-KODI-03
        status, headers, body = self._get()
        self.assertEqual((status, body), (200, self.plain))
        status, headers, body = self._get("bytes=100-199")
        self.assertEqual((status, body), (206, self.plain[100:200]))
        self.assertEqual(headers["Content-Range"], "bytes 100-199/10240")
        status, _h, body = self._get("bytes=10000-")
        self.assertEqual((status, body), (206, self.plain[10000:]))
        status, _h, body = self._get("bytes=-16")
        self.assertEqual((status, body), (206, self.plain[-16:]))
        status, headers, _b = self._get("bytes=20000-")
        self.assertEqual(status, 416)
        self.assertEqual(self.api.downloads, [self.KEY])  # one fetch, every reply served from the cache

    def test_preflight_fills_the_service_cache_for_the_player(self):
        # @req INTG-KODI-03
        hls.preflight_object(self.server.base, self.KEY)
        status, _h, body = self._get()
        self.assertEqual((status, body), (200, self.plain))
        self.assertEqual(self.api.downloads, [self.KEY])

    def test_preflight_raises_the_api_error_the_service_met(self):
        self.api.error = api.UnpaidError(402, {"error": "subscription_unpaid", "wipeAt": "2026-12-01T00:00:00.000Z"})
        with self.assertRaises(api.UnpaidError) as caught:
            hls.preflight_object(self.server.base, self.KEY)
        self.assertEqual(caught.exception.wipe_at, "2026-12-01T00:00:00.000Z")

        traffic = {"state": "high", "playbackBufferSeconds": 10, "saturated": True, "qualityCap": None, "playbackStopped": True}
        self.server.reset()
        self.api.error = api.PlaybackStoppedError(503, {"error": "playback_stopped", "traffic": traffic})
        with self.assertRaises(api.PlaybackStoppedError) as caught:
            hls.preflight_object(self.server.base, self.KEY)
        self.assertEqual(caught.exception.traffic, traffic)
        self.assertEqual(self.unavailable, [])  # the plugin's dialog is the one notice

        self.server.reset()
        self.api.error = api.UnauthorizedError(401, {"error": "unauthorized"})
        with self.assertRaises(api.UnauthorizedError):
            hls.preflight_object(self.server.base, self.KEY)

        self.server.reset()
        self.api.error = api.ApiError(400, {"error": "profile_not_owned"}, "profile gone")
        with self.assertRaises(api.ApiError) as caught:
            hls.preflight_object(self.server.base, self.KEY)
        self.assertEqual((caught.exception.status, caught.exception.code, str(caught.exception)), (400, "profile_not_owned", "profile gone"))


class GatewayProbes(unittest.TestCase):
    def test_first_healthy_answer_wins(self):
        delays = {"http://lan": 0.05, "http://wan": 0.6, "http://dead": None}

        def probe(url, timeout):
            delay = delays[url]
            if delay is None:
                raise OSError("refused")
            time.sleep(delay)
            return True

        started = time.monotonic()
        self.assertEqual(api.first_healthy_gateway(["http://dead", "http://wan", "http://lan"], 2.5, probe), "http://lan")
        self.assertLess(time.monotonic() - started, 0.5)

    def test_unhealthy_answers_are_skipped_and_hung_probes_cost_one_timeout(self):
        hang = threading.Event()
        self.addCleanup(hang.set)

        def probe(url, timeout):
            if url == "http://hung":
                hang.wait(5)
                return True
            if url == "http://busy":
                return False
            time.sleep(0.1)
            return True

        self.assertEqual(api.first_healthy_gateway(["http://busy", "http://hung", "http://ok"], 1.0, probe), "http://ok")
        started = time.monotonic()
        self.assertIsNone(api.first_healthy_gateway(["http://hung", "http://busy", "http://hung"], 0.3, probe))
        self.assertLess(time.monotonic() - started, 0.6)  # not one timeout per candidate
        self.assertIsNone(api.first_healthy_gateway([], 1.0, probe))


class FakeLib(object):
    def __init__(self, version, movies):
        self._version = version
        self.movies = movies

    def version(self):
        return self._version

    def list_media(self, kind):
        return list(self.movies) if kind == "movie" else []


class ExportAfterSync(unittest.TestCase):
    def setUp(self):
        for name in (core.STATE_FILE, export.INDEX_FILE):
            path = os.path.join(_DATA, name)
            if os.path.exists(path):
                os.remove(path)
        shutil.rmtree(os.path.join(_DATA, core.EXPORT_DIR), ignore_errors=True)
        patcher = mock.patch.object(images, "fetch_many", return_value={})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.ctx = type("Ctx", (), {})()
        self.ctx.lib = FakeLib(7, [{"id": "m1", "title": "Alien", "year": 1979, "type": "movie"}])
        self.scans = []

    def _run(self, force=False):
        return syncer.export_after_sync(self.ctx, force=force, scan=lambda: self.scans.append(1))

    def test_unchanged_library_skips_export_and_scan(self):
        first = self._run()
        self.assertGreater(first["written"], 0)
        self.assertEqual(len(self.scans), 1)
        with mock.patch.object(export, "export_library", wraps=export.export_library) as spy:
            self.assertIsNone(self._run())
            spy.assert_not_called()
        self.assertEqual(len(self.scans), 1)

    def test_changed_version_exports_but_scans_only_when_files_changed(self):
        self._run()
        self.ctx.lib._version = 8  # an op that touched nothing exported (a watched mark)
        stats = self._run()
        self.assertEqual((stats["written"], stats["removed"]), (0, 0))
        self.assertEqual(len(self.scans), 1)
        self.ctx.lib._version = 9
        self.ctx.lib.movies.append({"id": "m2", "title": "Heat", "year": 1995, "type": "movie"})
        stats = self._run()
        self.assertGreater(stats["written"], 0)
        self.assertEqual(len(self.scans), 2)
        self.ctx.lib._version = 10
        self.ctx.lib.movies.pop(0)
        stats = self._run()
        self.assertEqual((stats["written"], stats["removed"]), (0, 1))
        self.assertEqual(len(self.scans), 3)

    def test_pending_pictures_wiped_index_or_manual_sync_still_export(self):
        self._run()
        core.save_state(**{syncer.EXPORT_PENDING_KEY: 3})
        self.assertIsNotNone(self._run())
        self.assertIsNone(self._run())
        os.remove(os.path.join(_DATA, export.INDEX_FILE))
        self.assertIsNotNone(self._run())
        self.assertIsNotNone(self._run(force=True))


class BackgroundGate(unittest.TestCase):
    def test_held_back_at_boot_and_while_playing(self):
        clock = [100.0]
        playing = [False]
        gate = syncer.BackgroundGate(lambda: playing[0], now=lambda: clock[0])
        self.assertFalse(gate.open())
        clock[0] += syncer.BOOT_DELAY_SECONDS - 1
        self.assertFalse(gate.open())
        clock[0] += 1
        self.assertTrue(gate.open())
        playing[0] = True
        self.assertFalse(gate.open())
        playing[0] = False
        self.assertTrue(gate.open())


class ManualExport(unittest.TestCase):
    """Settings 'Export library' (#956): the export of a sync, so Kodi rescans only when a file changed."""

    def setUp(self):
        for name in (core.STATE_FILE, export.INDEX_FILE):
            path = os.path.join(_DATA, name)
            if os.path.exists(path):
                os.remove(path)
        shutil.rmtree(os.path.join(_DATA, core.EXPORT_DIR), ignore_errors=True)
        self.ctx = type("Ctx", (), {"ready": True})()
        self.ctx.lib = FakeLib(7, [{"id": "m1", "title": "Alien", "year": 1979, "type": "movie"}])
        self.scans = []
        for target, attr, value in (
            (images, "fetch_many", mock.Mock(return_value={})),
            (core, "Context", lambda: self.ctx),
            (router.library_setup, "needs_setup", lambda: False),
            (export, "scan_into_kodi", lambda: self.scans.append(1)),
            (syncer, "HAVE_KODI", True),
        ):
            patcher = mock.patch.object(target, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_unchanged_library_starts_no_rescan(self):
        # @req INTG-KODI-02
        router.action_export()
        self.assertEqual(len(self.scans), 1)  # first export wrote the files: Kodi scans
        router.action_export()
        self.assertEqual(len(self.scans), 1)  # nothing changed: no rescan
        os.remove(os.path.join(_DATA, core.EXPORT_DIR, "movies", "Alien (1979)", "Alien (1979).nfo"))
        router.action_export()
        self.assertEqual(len(self.scans), 2)  # a file put back: Kodi scans again


class FakeShowLib(FakeLib):
    def __init__(self, movies, shows, episodes):
        FakeLib.__init__(self, 1, movies)
        self.shows = shows
        self.eps = episodes  # show id -> [episode rows]
        self.target = None  # the account's targetOpStreamVersion (LIB-FMT-13); None: not switched

    def target_op_stream_version(self):
        return self.target

    def list_media(self, kind):
        return list(self.movies) if kind == "movie" else list(self.shows) if kind == "tv" else []

    def episodes(self, show_id):
        return list(self.eps.get(show_id, []))

    def episode_has_files(self, show_id):
        return {(e["season_number"], e["episode_number"]) for e in self.eps.get(show_id, [])}

    def get_media(self, media_id):
        return next((m for m in self.movies + self.shows if m["id"] == media_id), None)

    def collect_storage_keys(self, media_id):
        return ["media/%s/original" % media_id]

    def write_op(self, api_, key, op_type, payload):
        self.ops.append((op_type, payload))


def _ep(eid, season, number, title):
    return {"id": eid, "season_number": season, "episode_number": number, "title": title}


class DeleteExportsOneTitle(unittest.TestCase):
    """#956: a delete removes that title's (or episode's) export only, never a full re-export of the library."""

    def setUp(self):
        shutil.rmtree(os.path.join(_DATA, core.EXPORT_DIR), ignore_errors=True)
        patcher = mock.patch.object(images, "fetch_many", return_value={})
        patcher.start()
        self.addCleanup(patcher.stop)
        movies = [{"id": "m1", "title": "Alien", "year": 1979, "type": "movie"}, {"id": "m2", "title": "Heat", "year": 1995, "type": "movie"}]
        shows = [{"id": "s1", "title": "Dark", "year": 2017, "type": "tv"}]
        eps = {"s1": [_ep("e1", 1, 1, "Secrets"), _ep("e2", 1, 2, "Lies"), _ep("e3", 2, 1, "Beginnings")]}
        self.ctx = type("Ctx", (), {})()
        self.ctx.lib = FakeShowLib(movies, shows, eps)
        self.ctx.lib.ops = []
        self.ctx.api = mock.Mock()
        self.ctx.key = b"k"
        export.export_library(self.ctx)
        self.root = os.path.join(_DATA, core.EXPORT_DIR)

    def _files(self):
        out = {}
        for top, _dirs, names in os.walk(self.root):
            for name in names:
                path = os.path.join(top, name)
                out[os.path.relpath(path, self.root)] = os.stat(path).st_mtime_ns
        return out

    def test_deleting_a_movie_removes_only_its_folder(self):
        # @req INTG-DEL-01
        # @req INTG-KODI-02
        before = self._files()
        with mock.patch.object(playback, "yes_no", return_value=True), \
                mock.patch.object(export, "remove_from_kodi", return_value=1), \
                mock.patch.object(export, "export_library") as full_export:
            self.assertTrue(playback.delete_media(self.ctx, "m1"))
            full_export.assert_not_called()
        self.assertEqual(self.ctx.lib.ops, [("media.delete", {"mediaId": "m1"})])
        after = self._files()
        self.assertEqual(after, {rel: t for rel, t in before.items() if not rel.startswith("movies/Alien (1979)/")})
        self.assertFalse(os.path.exists(os.path.join(self.root, "movies", "Alien (1979)")))
        self.assertNotIn("m1", [ids["mediaId"] for ids in export.load_index().values()])
        self.assertEqual(len(export.load_index()), 4)  # Heat + the three episodes stay listed

    def test_deleting_an_episode_removes_only_its_files(self):
        # @req INTG-DEL-01
        # @req INTG-KODI-02
        before = self._files()
        details = {"episodes": [{"id": "e3", "seasonNumber": 2, "episodeNumber": 1}]}
        self.ctx.lib.media_details = lambda media_id: details
        with mock.patch.object(playback, "yes_no", return_value=True), \
                mock.patch.object(playback.details_mod, "episode_storage_keys", return_value=["media/s1/e3"]), \
                mock.patch.object(playback.details_mod, "without_episode_files", return_value={"id": "s1"}), \
                mock.patch.object(export, "remove_from_kodi", return_value=1), \
                mock.patch.object(export, "export_library") as full_export:
            self.assertTrue(playback.delete_episode(self.ctx, "s1", "e3"))
            full_export.assert_not_called()
        gone = {rel for rel in before if rel.startswith("tvshows/Dark (2017)/Season 02/")}
        self.assertEqual(len(gone), 2)  # its .strm + .nfo
        self.assertEqual(self._files(), {rel: t for rel, t in before.items() if rel not in gone})
        self.assertFalse(os.path.exists(os.path.join(self.root, "tvshows", "Dark (2017)", "Season 02")))
        self.assertNotIn("e3", [ids["episodeId"] for ids in export.load_index().values()])

    def test_a_switched_account_deletes_an_episode_with_one_episode_delete_op(self):
        # @req LIB-FMT-11[badger-kodi]
        # @test-id kodi-v4-episode-delete-op
        # @why op stream 4 has no playback in media.upsert: once switched, the add-on names the episode and its
        #      files in one media.episode.delete instead of re-sending the show's details
        self.ctx.lib.target = 4
        details = {"episodes": [{"id": "e3", "seasonNumber": 2, "episodeNumber": 1}],
                   "files": [{"id": "f-e3", "season": 2, "episode": 1}, {"id": "f-e1", "season": 1, "episode": 1}]}
        self.ctx.lib.media_details = lambda media_id: details
        with mock.patch.object(playback, "yes_no", return_value=True), \
                mock.patch.object(playback.details_mod, "episode_storage_keys", return_value=["media/s1/e3"]), \
                mock.patch.object(export, "remove_from_kodi", return_value=1), \
                mock.patch.object(export, "export_library"):
            ok = playback.delete_episode(self.ctx, "s1", "e3")
        print("ops=%s" % self.ctx.lib.ops)
        self.assertTrue(ok)
        self.assertEqual(self.ctx.lib.ops, [("media.episode.delete", {
            "mediaId": "s1", "episodeId": "e3", "seasonNumber": 2, "episodeNumber": 1, "fileIds": ["f-e3"]})])

    def test_the_last_episode_takes_its_show_folder(self):
        # @req INTG-KODI-02
        for eid in ("e1", "e2", "e3"):
            export.remove_exported("s1", eid)
        self.assertFalse(os.path.exists(os.path.join(self.root, "tvshows", "Dark (2017)")))
        self.assertTrue(os.path.exists(os.path.join(self.root, "movies", "Heat (1995)", "Heat (1995).strm")))
        self.assertEqual(sorted(ids["mediaId"] for ids in export.load_index().values()), ["m1", "m2"])


class BlockingApi(object):
    """download() of a key in `held` waits until the test releases it: stands in for a slow tunnel download."""

    def __init__(self, held):
        self.held = held
        self.release = threading.Event()
        self.downloads = []
        self.lock = threading.Lock()

    def download(self, key, purpose="playback"):
        with self.lock:
            self.downloads.append(key)
        if key in self.held:
            self.release.wait(10)
        return key.encode()


class SeekBeforePrefetch(unittest.TestCase):
    """#956: the segment the player asks for after a seek is fetched at once, not behind the queued prefetches."""

    def test_seek_segment_skips_the_prefetch_queue(self):
        # @req INTG-KODI-03
        keys = ["seg%02d" % i for i in range(20)]
        fake = BlockingApi(held=set(keys[1:10]))
        self.addCleanup(fake.release.set)
        cache = hls.ObjectCache(fake, MASTER, max_bytes=1 << 20)
        cache.register_sequence(keys)
        self.assertEqual(bytes(cache.get(keys[0])), b"seg00")
        cache.prefetch_after(keys[0])  # seg01..03: every prefetch worker busy on a slow download
        cache.prefetch_after(keys[3])  # seg04..06: queued behind them
        started = time.monotonic()
        self.assertEqual(bytes(cache.get(keys[15])), b"seg15")  # the seek target
        self.assertLess(time.monotonic() - started, 1.0)
        with fake.lock:
            self.assertNotIn("seg04", fake.downloads)  # the queued prefetches had not started yet
        fake.release.set()
        self.assertEqual(bytes(cache.get(keys[4])), b"seg04")

    def test_queued_prefetch_of_the_asked_key_is_fetched_by_the_asker(self):
        # @req INTG-KODI-03
        keys = ["seg%02d" % i for i in range(10)]
        fake = BlockingApi(held=set(keys[1:4]))
        self.addCleanup(fake.release.set)
        cache = hls.ObjectCache(fake, MASTER, max_bytes=1 << 20)
        cache.register_sequence(keys)
        cache.prefetch_after(keys[0])  # seg01..03 hold the workers
        cache.prefetch_after(keys[3])  # seg04..06 queued
        started = time.monotonic()
        self.assertEqual(bytes(cache.get(keys[5])), b"seg05")
        self.assertLess(time.monotonic() - started, 1.0)
        fake.release.set()
        cache._pool.shutdown(wait=True)
        self.assertEqual(fake.downloads.count("seg05"), 1)  # its queued prefetch was cancelled, not run as well


class SnapshotLoadMemory(unittest.TestCase):
    """#956: the snapshot (chunks -> envelope -> optional deflate frame -> SQLite file) loads with at most the stored
    snapshot and the plain file in memory at once. Before: chunk list + joined blob + decrypt input slice + plaintext
    (+ a bytes copy of it) + frame slice: about 5x the file at the peak."""

    KEY = bytes(range(32))
    MIB = 1024 * 1024

    def _api(self, db, compress):
        plain = payload_codec.encode_compressed_frame(db) if compress else db
        blob = crypto.envelope_encrypt(self.KEY, plain)
        objects, chunks = {}, []
        step = 2 * self.MIB
        for i in range(0, len(blob), step):
            stored = library.STORAGE_HEADER + b"\x00" * 4 + blob[i:i + step]
            digest = hashlib.sha256(stored).hexdigest()
            objects["library/chunks/" + digest] = stored
            chunks.append({"index": i // step, "hash": digest})
        manifest = {"snapshotId": "s1", "chunks": chunks, "dbHash": hashlib.sha256(db).hexdigest()}
        objects["manifest"] = library.STORAGE_HEADER + b"\x00" * 4 + crypto.envelope_encrypt(self.KEY, json.dumps(manifest).encode())
        return type("Api", (), {"download": lambda _self, key, purpose: objects[key]})()

    def _peak(self, db, compress):
        fake = self._api(db, compress)
        tracemalloc.start()
        try:
            _manifest, out = library.LibraryStore._download_snapshot(None, fake, self.KEY, {"manifestKey": "manifest"})
            self.assertEqual(bytes(out), db)
            del out
            return tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()

    def test_peak_stays_near_two_copies(self):
        # @req INTG-KODI-05
        plain_db = os.urandom(8 * self.MIB)
        text_db = os.urandom(4 * self.MIB).hex().encode()  # deflates about 2:1, like a SQLite file of text rows
        for db, compress in ((plain_db, False), (text_db, True)):
            peak = self._peak(db, compress)
            self.assertLess(peak, 2.5 * len(db), "compress=%s peak %.1f MiB" % (compress, peak / self.MIB))


def setUpModule():
    # `unittest discover` imports every test module before it runs any, so SB_DATA_DIR holds whichever module was
    # imported last; point the add-on back at this module's data dir before its tests run.
    os.environ["SB_DATA_DIR"] = _DATA


def tearDownModule():
    shutil.rmtree(_DATA, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()

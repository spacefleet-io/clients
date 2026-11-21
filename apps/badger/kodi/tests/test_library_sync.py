"""Spec LIB-SYNC-06 / LIB-SYNC-07 / LIB-STORE-05 (no @req tags: badger-kodi is not in those rules' applies yet).

LibraryStore.sync(): full snapshot download only on tooOld / first install.

Fakes the API; counts snapshot downloads. Each test prints phase markers prefixed with its id.
"""
import base64
import json
import os
import shutil
import tempfile
import unittest

import _path  # noqa: F401
import api as api_module
import crypto
import library
import ops_sql
import payload_codec

TEST_ID = "KODI-LIBRARY-SYNC-001"


def phase(msg, *args):
    print("[%s] %s" % (TEST_ID, msg % args if args else msg))


class FakeApi(object):
    def __init__(self, meta, ops_resp):
        self.meta = meta
        self.ops_resp = ops_resp
        self.ops_calls = []
        self.downloads = []
        self.posted = []

    def library_meta(self):
        return dict(self.meta)

    def library_ops(self, since):
        self.ops_calls.append(since)
        return self.ops_resp

    def download(self, key, purpose="playback"):
        self.downloads.append(key)
        raise AssertionError("unexpected download %s" % key)

    def post_op(self, *args):
        self.posted.append(args)
        raise AssertionError("no uploads expected")


class CountingStore(library.LibraryStore):
    """Counts snapshot downloads instead of fetching one: installs an empty DB with a marker table."""

    def __init__(self, directory):
        library.LibraryStore.__init__(self, directory)
        self.snapshot_downloads = 0

    def _download_snapshot(self, api, key, meta):
        self.snapshot_downloads += 1
        phase("snapshot download #%d requested", self.snapshot_downloads)
        return {"snapshotId": meta.get("snapshotId")}, b""

    def _install_snapshot(self, db_bytes, meta, manifest):
        self.close()
        c = self.conn()
        c.execute("BEGIN IMMEDIATE")
        self._set_state(
            c,
            version=int(meta.get("snapshotVersion") or 0),
            snapshotVersion=int(meta.get("snapshotVersion") or 0),
            snapshotId=manifest.get("snapshotId"),
            stateHash=None,
            lastOpId=None,
        )
        c.execute("COMMIT")


def seed(store, **state):
    c = store.conn()
    c.execute("BEGIN IMMEDIATE")
    store._set_state(c, **state)
    c.execute("COMMIT")


class LibrarySync(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="sb-lib-sync-")
        self.store = CountingStore(self.dir)
        self.key = b"\x00" * 32

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def _meta(self, **over):
        meta = {"exists": True, "version": 12, "snapshotVersion": 10, "snapshotId": "snap-B", "stateHash": "h12", "lastOpId": "op12"}
        meta.update(over)
        return meta

    def test_empty_ops_with_new_snapshot_id_does_not_download(self):
        # LIB-SYNC-06
        phase("another device published snapshot-B; our version is current; ops list is empty")
        seed(self.store, version=12, snapshotVersion=7, snapshotId="snap-A")
        api = FakeApi(self._meta(), {"ops": [], "tooOld": False})
        result = self.store.sync(api, self.key)
        phase("state=%s result=%s downloads=%d", self.store.state(), result, self.store.snapshot_downloads)
        self.assertEqual(self.store.snapshot_downloads, 0)
        self.assertFalse(result["reloaded"])
        self.assertEqual(self.store.state()["snapshotId"], "snap-B")
        self.assertEqual(self.store.state()["snapshotVersion"], 10)
        self.assertEqual(self.store.version(), 12)

    def test_empty_ops_behind_meta_advances_version_without_download(self):
        # LIB-SYNC-06
        phase("local version behind meta but server has no ops to give and not tooOld")
        seed(self.store, version=9, snapshotVersion=7, snapshotId="snap-B")
        api = FakeApi(self._meta(), {"ops": [], "tooOld": False})
        result = self.store.sync(api, self.key)
        phase("state=%s result=%s downloads=%d", self.store.state(), result, self.store.snapshot_downloads)
        self.assertEqual(self.store.snapshot_downloads, 0)
        self.assertFalse(result["reloaded"])
        self.assertEqual(self.store.version(), 12)

    def test_too_old_downloads_snapshot_once(self):
        # LIB-SYNC-06
        phase("server says tooOld")
        seed(self.store, version=3, snapshotVersion=2, snapshotId="snap-A")
        api = FakeApi(self._meta(), {"ops": [], "tooOld": True})
        result = self.store.sync(api, self.key)
        phase("state=%s result=%s downloads=%d ops_calls=%s", self.store.state(), result, self.store.snapshot_downloads, api.ops_calls)
        self.assertEqual(self.store.snapshot_downloads, 1)
        self.assertTrue(result["reloaded"])
        self.assertEqual(self.store.state()["snapshotId"], "snap-B")

    def test_first_install_downloads_snapshot(self):
        # LIB-SYNC-06
        self.assertFalse(self.store.exists())
        api = FakeApi(self._meta(), {"ops": [], "tooOld": False})
        result = self.store.sync(api, self.key)
        phase("state=%s downloads=%d", self.store.state(), self.store.snapshot_downloads)
        self.assertEqual(self.store.snapshot_downloads, 1)
        self.assertTrue(result["reloaded"])

    def test_up_to_date_does_not_download(self):
        # LIB-SYNC-06
        seed(self.store, version=12, snapshotVersion=10, snapshotId="snap-B")
        api = FakeApi(self._meta(), {"ops": [], "tooOld": False})
        result = self.store.sync(api, self.key)
        self.assertEqual(self.store.snapshot_downloads, 0)
        self.assertFalse(result["reloaded"])



class UploadApi(object):
    """Records every library call a progress write makes."""

    def __init__(self):
        self.calls = []
        self.version = 5

    def library_meta(self):
        self.calls.append("library_meta")
        return {"exists": True, "version": self.version, "stateHash": "h%d" % self.version, "snapshotId": "snap", "snapshotVersion": 5}

    def library_ops(self, since):
        self.calls.append("library_ops")
        raise AssertionError("not behind: no catch-up fetch expected")

    def download(self, key, purpose="playback"):
        self.calls.append("download")
        raise AssertionError("no download expected")

    def post_op(self, encrypted, op_id, base_version, prev, nxt, op_stream_version):
        self.calls.append("post_op")
        self.version = base_version + 1
        return {"version": self.version, "stateHash": nxt, "lastOpId": op_id}


class ProgressWriteCost(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="sb-lib-write-")
        self.store = library.LibraryStore(self.dir)
        self.key = bytes(range(32))
        c = self.store.conn()
        c.execute("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)")
        c.execute("CREATE TABLE media_items (id TEXT PRIMARY KEY, progress_pct REAL, last_watched_at TEXT, updated_at TEXT)")
        c.execute("INSERT INTO media_items (id) VALUES ('m')")
        seed(self.store, version=5, snapshotVersion=5, snapshotId="snap")

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_progress_writes_are_one_small_op_each_and_never_a_snapshot(self):
        # LIB-SYNC-07 / LIB-STORE-05: Kodi has no snapshot upload at all; a progress write is one op POST
        api = UploadApi()
        for i in range(40):
            ok = self.store.write_op(api, self.key, "media.progress", {"mediaId": "m", "progressPct": float(i), "lastWatchedAt": "t", "updatedAt": "t"})
            self.assertTrue(ok)
        phase("40 progress writes -> api calls=%s version=%s", sorted(set(api.calls)), self.store.version())
        self.assertEqual(api.calls.count("post_op"), 40)
        self.assertNotIn("download", api.calls)
        self.assertNotIn("library_ops", api.calls)
        self.assertEqual(self.store.version(), 45)

    def test_api_client_has_no_snapshot_upload(self):
        # LIB-SYNC-07: the add-on never publishes a full copy, so progress can never trigger one
        names = [n for n in dir(api_module.ApiClient) if "snapshot" in n.lower() or n.startswith("put_library")]
        phase("ApiClient snapshot-ish methods: %s", names)
        self.assertEqual(names, [])


class LineageServer(object):
    """Fake op endpoint with the real server's checks (putLibraryOp): base version, prev state hash, derived
    next hash. Records every library call so a test can count meta reads."""

    def __init__(self, key, version, state_hash):
        self.key = key
        self.version = version
        self.state_hash = state_hash
        self.entries = {}
        self.calls = []
        self.posts = []
        self.declared = []
        self.target = None  # LIB-FMT-13: the account's targetOpStreamVersion once the knob switches it

    def library_meta(self):
        self.calls.append("library_meta")
        meta = {"exists": True, "version": self.version, "stateHash": self.state_hash, "snapshotId": "snap", "snapshotVersion": 5}
        if self.target is not None:
            meta["targetOpStreamVersion"] = self.target
        return meta

    def library_ops(self, since):
        self.calls.append("library_ops")
        ops = [self.entries[v] for v in sorted(self.entries) if v > since]
        return {"ops": ops, "version": self.version, "tooOld": False}

    def download(self, key, purpose="playback"):
        self.calls.append("download")
        raise AssertionError("no download expected")

    def post_op(self, encrypted, op_id, base_version, prev, nxt, op_stream_version):
        self.calls.append("post_op")
        # LIB-FMT-13: before the switch a write declares op stream 3, never 4.
        self.declared.append(op_stream_version)
        if (self.target or 0) >= 4 and op_stream_version < 4:
            # like the API on a switched account: an older-stream writer is refused with 426
            raise api_module.AppUpdateRequiredError(426, {"error": "app_update_required", "reason": "library_op_stream", "opStreamVersion": 4})
        self.posts.append({"opId": op_id, "base": base_version, "prev": prev})
        if base_version != self.version:
            raise api_module.ApiError(409, {"error": "version_conflict", "version": self.version})
        if prev and prev != self.state_hash:
            raise api_module.ApiError(409, {"error": "lineage_conflict", "currentStateHash": self.state_hash})
        derived = api_module.next_state_hash(self.state_hash, op_id, encrypted)
        if nxt is not None and nxt != derived:
            raise api_module.ApiError(400, {"error": "invalid_state_hash"})
        self._append(op_id, encrypted, derived)
        return {"version": self.version, "snapshotVersion": 5, "stateHash": self.state_hash, "lastOpId": op_id}

    def remote_write(self, op):
        """Another device writes an op: the head moves on without this store knowing."""
        encrypted = crypto.envelope_encrypt(self.key, payload_codec.encode_op_payload(json.dumps(op).encode("utf-8")))
        self._append(op["id"], encrypted, api_module.next_state_hash(self.state_hash, op["id"], encrypted))

    def _append(self, op_id, encrypted, derived):
        self.version += 1
        self.state_hash = derived
        self.entries[self.version] = {"version": self.version, "opId": op_id, "payloadCiphertext": base64.b64encode(encrypted).decode("ascii")}


class OfflineApi(object):
    """Every call fails like a dropped network: write_op queues the op."""

    def __getattr__(self, name):
        def fail(*args, **kwargs):
            raise OSError("network down (%s)" % name)
        return fail


def progress(pct, at):
    return {"mediaId": "m", "progressPct": float(pct), "lastWatchedAt": at, "updatedAt": at}


class OpUploadMetaReads(unittest.TestCase):
    """LIB-STORE-05 (#663): an op upload is based on the locally stored version and state hash; GET
    /library/db/meta is read only when the server answers a mismatch, then the op is retried once."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="sb-lib-opmeta-")
        self.store = library.LibraryStore(self.dir)
        self.key = bytes(range(32))
        c = self.store.conn()
        c.execute("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)")
        c.execute("CREATE TABLE media_items (id TEXT PRIMARY KEY, progress_pct REAL, last_watched_at TEXT, updated_at TEXT)")
        c.execute("INSERT INTO media_items (id) VALUES ('m')")
        self.server = LineageServer(self.key, 5, "h5")
        seed(self.store, version=5, stateHash="h5", snapshotVersion=5, snapshotId="snap")

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def _queue_offline(self, count):
        for i in range(count):
            self.assertFalse(self.store.write_op(OfflineApi(), self.key, "media.progress", progress(i, "2026-10-21T10:00:%02dZ" % i)))
        self.assertEqual(len(self.store._load_pending()), count)

    def test_queued_ops_flush_without_meta_reads(self):
        # @bugfix @regression-proof: flush_pending read meta before every queued op (5 ops -> 5 meta GETs)
        phase("opmeta/queued: queue 5 progress ops offline")
        self._queue_offline(5)
        phase("opmeta/queued: flush against server at v5")
        ok = self.store.flush_pending(self.server, self.key)
        phase("opmeta/queued: ok=%s calls=%s bases=%s", ok, self.server.calls, [p["base"] for p in self.server.posts])
        self.assertTrue(ok)
        self.assertEqual(self.server.calls.count("library_meta"), 0)
        self.assertEqual(self.server.calls, ["post_op"] * 5)
        self.assertEqual([p["base"] for p in self.server.posts], [5, 6, 7, 8, 9])
        self.assertEqual(self.store.version(), 10)
        self.assertEqual(self.store.state()["stateHash"], self.server.state_hash)
        self.assertEqual(self.store._load_pending(), [])

    def test_progress_writes_make_no_meta_reads(self):
        # @bugfix @regression-proof: each write_op cost a meta GET plus the op POST (20 writes -> 20 meta GETs)
        phase("opmeta/writes: 20 progress writes online")
        for i in range(20):
            self.assertTrue(self.store.write_op(self.server, self.key, "media.progress", progress(i, "2026-10-21T10:01:%02dZ" % i)))
        phase("opmeta/writes: meta=%d posts=%d version=%s", self.server.calls.count("library_meta"), self.server.calls.count("post_op"), self.store.version())
        self.assertEqual(self.server.calls.count("library_meta"), 0)
        self.assertEqual(self.server.calls.count("post_op"), 20)
        self.assertEqual(self.store.version(), 25)
        self.assertEqual(self.store.state()["stateHash"], self.server.state_hash)

    def test_version_conflict_reads_meta_once_catches_up_and_retries(self):
        # @bugfix @regression-proof: the conflict path must still recover once meta is no longer read up front
        phase("opmeta/conflict: another device writes v6 and v7")
        self.server.remote_write({"id": "remote-6", "type": "media.progress", "createdAt": "t", "payload": progress(40, "2026-10-21T09:00:00Z")})
        self.server.remote_write({"id": "remote-7", "type": "media.progress", "createdAt": "t", "payload": progress(41, "2026-10-21T09:00:01Z")})
        ok = self.store.write_op(self.server, self.key, "media.progress", progress(50, "2026-10-21T10:02:00Z"))
        phase("opmeta/conflict: ok=%s calls=%s bases=%s version=%s", ok, self.server.calls, [p["base"] for p in self.server.posts], self.store.version())
        self.assertTrue(ok)
        self.assertEqual(self.server.calls, ["post_op", "library_meta", "library_ops", "post_op"])
        self.assertEqual([p["base"] for p in self.server.posts], [5, 7])
        self.assertEqual(self.store.version(), 8)
        self.assertEqual(self.store.state()["stateHash"], self.server.state_hash)
        self.assertEqual(self.store._load_pending(), [])
        phase("opmeta/conflict: next write rides the local state again")
        self.assertTrue(self.store.write_op(self.server, self.key, "media.progress", progress(51, "2026-10-21T10:02:01Z")))
        self.assertEqual(self.server.calls.count("library_meta"), 1)
        self.assertEqual(self.store.version(), 9)

    def test_stale_state_hash_reads_meta_once_and_retries(self):
        # A stale local hash at the right version is a lineage_conflict: one meta read, no catch-up, one retry
        seed(self.store, stateHash="stale")
        ok = self.store.write_op(self.server, self.key, "media.progress", progress(60, "2026-10-21T10:03:00Z"))
        phase("opmeta/lineage: ok=%s calls=%s", ok, self.server.calls)
        self.assertTrue(ok)
        self.assertEqual(self.server.calls, ["post_op", "library_meta", "post_op"])
        self.assertEqual(self.store.version(), 6)
        self.assertEqual(self.store.state()["stateHash"], self.server.state_hash)

    def test_missing_state_hash_lets_the_server_derive_without_meta(self):
        # No local hash (fresh snapshot install, remote ops just applied): no lineage headers, the server
        # derives the next hash from its own head and the base version still guards; no meta read.
        seed(self.store, stateHash=None)
        ok = self.store.write_op(self.server, self.key, "media.progress", progress(61, "2026-10-21T10:03:01Z"))
        phase("opmeta/nohash: ok=%s calls=%s prev=%s", ok, self.server.calls, [p["prev"] for p in self.server.posts])
        self.assertTrue(ok)
        self.assertEqual(self.server.calls, ["post_op"])
        self.assertEqual([p["prev"] for p in self.server.posts], [None])
        self.assertEqual(self.store.version(), 6)
        self.assertEqual(self.store.state()["stateHash"], self.server.state_hash)

    def test_other_errors_keep_the_op_queued_without_meta(self):
        # library_format_downgrade (409) is not a mismatch: retrying cannot help, the op stays queued
        def downgrade(*args):
            self.server.calls.append("post_op")
            raise api_module.ApiError(409, {"error": "library_format_downgrade"})
        self.server.post_op = downgrade
        ok = self.store.write_op(self.server, self.key, "media.progress", progress(62, "2026-10-21T10:03:02Z"))
        phase("opmeta/downgrade: ok=%s calls=%s pending=%d", ok, self.server.calls, len(self.store._load_pending()))
        self.assertFalse(ok)
        self.assertEqual(self.server.calls, ["post_op"])
        self.assertEqual(len(self.store._load_pending()), 1)


class OpStreamSwitch(unittest.TestCase):
    """LIB-FMT-13 (vault v4): the add-on reads stream 4 and takes the packed layout only once the account is
    switched (`targetOpStreamVersion` >= 4); its writes declare 3 before, 4 after; an op type it does not know stops
    the sync whole (nothing applied, the version stays) instead of being skipped."""

    setUp = OpUploadMetaReads.setUp
    tearDown = OpUploadMetaReads.tearDown

    def packed(self):
        return self.store.state().get("packedPlayback") is True

    def test_before_the_switch_writes_declare_3_and_the_layout_stays(self):
        # @req LIB-FMT-13[badger-kodi]
        # @test-id kodi-v4-unswitched-write
        # @why nothing writes op stream 4 or runs the layout step before the account is switched
        ok = self.store.write_op(self.server, self.key, "media.progress", progress(10, "2026-11-21T10:00:00Z"))
        self.store.sync(self.server, self.key)
        phase("unswitched: ok=%s declared=%s packed=%s target=%s", ok, self.server.declared, self.packed(),
              self.store.target_op_stream_version())
        self.assertTrue(ok)
        self.assertEqual(self.server.declared, [3])
        self.assertFalse(self.packed())
        self.assertEqual(self.store.target_op_stream_version(), 0)

    def test_a_426_on_write_rebases_on_the_switched_account_and_retries_once_as_4(self):
        # @req LIB-FMT-13[badger-kodi]
        # @test-id kodi-v4-switch-on-write
        # @why the knob can flip between two syncs: the refused write learns the target, converts, then declares 4
        self.server.target = 4
        ok = self.store.write_op(self.server, self.key, "media.progress", progress(11, "2026-11-21T10:00:01Z"))
        phase("switch on write: ok=%s declared=%s calls=%s packed=%s", ok, self.server.declared, self.server.calls, self.packed())
        self.assertTrue(ok)
        self.assertEqual(self.server.declared, [3, 4])
        self.assertEqual(self.server.calls.count("library_meta"), 1)
        self.assertTrue(self.packed())
        self.assertEqual(self.store.target_op_stream_version(), 4)
        self.assertEqual(self.store._load_pending(), [])

    def test_a_sync_on_a_switched_account_converts_then_writes_4(self):
        # @req LIB-FMT-12[badger-kodi]
        # @test-id kodi-v4-switch-on-sync
        self.server.target = 4
        self.store.sync(self.server, self.key)
        tables = [r[0] for r in self.store.conn().execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        phase("switched sync: packed=%s tables=%s", self.packed(), tables)
        self.assertTrue(self.packed())
        self.assertIn("media_chunk_lists", tables)
        self.assertIn("media_file_playback", tables)
        self.assertTrue(self.store.write_op(self.server, self.key, "media.progress", progress(12, "2026-11-21T10:00:02Z")))
        self.assertEqual(self.server.declared, [4])

    def test_the_tables_alone_do_not_make_a_copy_packed(self):
        # @req LIB-FMT-11[badger-kodi]
        # @test-id kodi-v4-empty-tables-unswitched
        # @why a v4 build's snapshot carries the packed tables EMPTY before the switch: old ops keep the old path
        c = self.store.conn()
        for ddl in (library.chunk_lists.CHUNK_LISTS_DDL, library.chunk_lists.FILE_PLAYBACK_DDL):
            c.execute(ddl)
        self.store.sync(self.server, self.key)
        phase("empty tables, unswitched: packed=%s", self.packed())
        self.assertFalse(self.packed())
        self.assertFalse(self.store._is_packed(self.store.conn()))

    def test_an_unknown_op_type_stops_the_sync_and_applies_nothing(self):
        # @req LIB-FMT-13[badger-kodi]
        # @test-id kodi-v4-unknown-op-stops
        # @why a skipped op would leave the library silently wrong; the user is asked to update instead
        self.server.remote_write({"id": "op-known", "type": "media.progress", "createdAt": "2026-11-21T10:00:03Z",
                                  "payload": progress(70, "2026-11-21T10:00:03Z")})
        self.server.remote_write({"id": "op-future", "type": "media.hologram.set", "createdAt": "2026-11-21T10:00:04Z", "payload": {}})
        with self.assertRaises(ops_sql.UnknownOpTypeError):
            self.store.sync(self.server, self.key)
        row = self.store.conn().execute("SELECT progress_pct FROM media_items WHERE id = 'm'").fetchone()
        phase("unknown op: version=%s server=%s progress=%s", self.store.version(), self.server.version, row[0])
        self.assertEqual(self.store.version(), 5)
        self.assertIsNone(row[0])


if __name__ == "__main__":
    unittest.main()

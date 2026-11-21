"""The API pages a long op tail (1000 ops per response, `hasMore`; `version` of a partial page is its last op).

LibraryStore must walk every page in the same sync: before, it applied the first page and stopped, so an add-on far
behind caught up 1000 ops per trigger and stayed stale in between. Same rule for the catch-up that precedes an
upload. A page that turns `tooOld` falls back to the snapshot like any other `tooOld`.

Fakes the API with real encrypted inline payloads. Each test prints phase markers prefixed with its id.
"""
import base64
import json
import shutil
import tempfile
import unittest

import _path  # noqa: F401
import api as api_module
import crypto
import library

TEST_ID = "KODI-LIBRARY-OPS-PAGING-001"
KEY = bytes(range(32))


def phase(msg, *args):
    print("[%s] %s" % (TEST_ID, msg % args if args else msg))


def entry(version):
    op = {
        "id": "op-%d" % version,
        "type": "setting.set",
        "createdAt": "2026-10-15T00:00:00.000Z",
        "payload": {"key": "k%d" % version, "value": "v%d" % version, "updatedAt": "2026-10-15T00:00:00.000Z"},
    }
    sealed = crypto.envelope_encrypt(KEY, json.dumps(op, separators=(",", ":")).encode("utf-8"))
    return {
        "opId": op["id"],
        "version": version,
        "objectKey": "library/ops/op-%d" % version,
        "createdAt": "2026-10-15T00:00:00.000Z",
        "size": len(sealed),
        "payloadCiphertext": base64.b64encode(sealed).decode("ascii"),
    }


class PagedApi(object):
    def __init__(self, head, first, page_size, too_old_from=None):
        self.head = head
        self.entries = [entry(v) for v in range(first, head + 1)]
        self.page_size = page_size
        self.too_old_from = too_old_from
        self.ops_calls = []
        self.meta_calls = 0

    def library_meta(self):
        self.meta_calls += 1
        return {"exists": True, "version": self.head, "snapshotVersion": 1, "snapshotId": "snap", "stateHash": "h", "lastOpId": "x"}

    def library_ops(self, since):
        self.ops_calls.append(since)
        if self.too_old_from is not None and since >= self.too_old_from:
            return {"ops": [], "tooOld": True, "hasMore": False, "version": self.head, "snapshotVersion": 1}
        newer = [e for e in self.entries if e["version"] > since]
        page = newer[: self.page_size]
        more = len(page) < len(newer)
        return {
            "ops": page,
            "tooOld": False,
            "hasMore": more,
            "version": page[-1]["version"] if more else self.head,
            "snapshotVersion": 1,
        }

    def download(self, key, purpose="playback"):
        raise AssertionError("unexpected download %s" % key)

    def post_op(self, encrypted, op_id, base_version, prev, nxt, op_stream_version):
        # Like the server: a writer behind the head is refused, which is what sends the store to catch up.
        if base_version != self.head:
            raise api_module.ApiError(409, {"error": "version_conflict", "version": self.head})
        self.head = base_version + 1
        return {"version": self.head, "stateHash": nxt, "lastOpId": op_id}


class CountingStore(library.LibraryStore):
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
        self._set_state(c, version=int(meta.get("snapshotVersion") or 0), snapshotVersion=1, snapshotId="snap", stateHash=None, lastOpId=None)
        c.execute("COMMIT")


class OpsPaging(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="sb-lib-paging-")
        self.store = CountingStore(self.dir)
        c = self.store.conn()
        c.execute("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)")
        c.execute("BEGIN IMMEDIATE")
        self.store._set_state(c, version=3, snapshotVersion=1, snapshotId="snap")
        c.execute("COMMIT")

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def settings(self):
        rows = self.store.conn().execute("SELECT key FROM app_settings ORDER BY key").fetchall()
        return [r["key"] for r in rows]

    def test_sync_walks_every_page_in_one_run(self):
        phase("7 ops behind (4..10), pages of 3")
        api = PagedApi(head=10, first=4, page_size=3)
        result = self.store.sync(api, KEY)
        phase("ops_calls=%s version=%s settings=%s result=%s", api.ops_calls, self.store.version(), self.settings(), result)
        self.assertEqual(api.ops_calls, [3, 6, 9])
        self.assertEqual(self.settings(), sorted("k%d" % v for v in range(4, 11)))
        self.assertEqual(self.store.version(), 10)
        self.assertEqual(result["applied"], 7)
        self.assertEqual(self.store.snapshot_downloads, 0)

    def test_a_page_that_turns_too_old_falls_back_to_the_snapshot(self):
        phase("second page tooOld")
        api = PagedApi(head=10, first=4, page_size=3, too_old_from=6)
        result = self.store.sync(api, KEY)
        phase("ops_calls=%s downloads=%d result=%s", api.ops_calls, self.store.snapshot_downloads, result)
        self.assertEqual(api.ops_calls[:2], [3, 6])
        self.assertEqual(self.store.snapshot_downloads, 1)
        self.assertTrue(result["reloaded"])

    def test_the_catch_up_before_an_upload_walks_every_page(self):
        phase("behind by 5 ops, then a local write")
        api = PagedApi(head=8, first=4, page_size=2)
        ok = self.store.write_op(api, KEY, "setting.set", {"key": "mine", "value": "1", "updatedAt": "2026-10-16T00:00:00.000Z"})
        phase("ok=%s ops_calls=%s version=%s settings=%s", ok, api.ops_calls, self.store.version(), self.settings())
        self.assertTrue(ok)
        self.assertEqual(api.ops_calls, [3, 5, 7])
        self.assertEqual(self.store.version(), 9)
        self.assertEqual(self.settings(), sorted(["k%d" % v for v in range(4, 9)] + ["mine"]))


if __name__ == "__main__":
    unittest.main()

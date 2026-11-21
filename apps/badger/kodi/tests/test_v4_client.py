"""@req LIB-FMT-13[badger-kodi] @req REL-CD-29[badger-kodi]
The add-on names itself on every call (`x-space-client: badger/kodi/<addon.xml version>`), asks library reads in op
stream 4, and turns a 426 `app_update_required` (or an op type it does not know) into the one update message.
"""
import json
import os
import re
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _path  # noqa: E402,F401
import api  # noqa: E402
import compat  # noqa: E402
import ops_sql  # noqa: E402
import syncer  # noqa: E402

ADDON_XML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin.video.spacebadger", "addon.xml")


def phase(msg, *args):
    print("[test_v4_client] " + (msg % args if args else msg))


class Recorder(object):
    def __init__(self, status=200, body=None):
        self.calls = []
        self.status = status
        self.body = body if body is not None else {"ok": True}

    def __call__(self, method, url, headers, data=None, timeout=None):
        self.calls.append((method, url, dict(headers)))
        return self.status, {}, json.dumps(self.body).encode("utf-8")


class Headers(unittest.TestCase):
    def test_every_call_names_the_add_on_and_its_version(self):
        # @test-id kodi-v4-client-header
        # @why REL-CD-29: the API gates on x-space-client; the version is the one addon.xml ships
        with open(ADDON_XML) as fh:
            shipped = re.search(r'<addon\b[^>]*\bversion="([^"]+)"', fh.read()).group(1)
        rec = Recorder(body={"exists": True, "version": 1})
        client = api.ApiClient("https://api.example", token="t")
        with mock.patch.object(api, "http_request", rec):
            client.library_meta()
            client.library_ops(0)
            client.request_json("GET", "/auth/me")
        for method, url, headers in rec.calls:
            phase("%s %s x-space-client=%s op-stream=%s", method, url, headers.get("x-space-client"),
                  headers.get("x-library-op-stream-version"))
            self.assertEqual(headers.get("x-space-client"), "badger/kodi/%s" % shipped)
        self.assertEqual(compat.CLIENT_VERSION, shipped)
        self.assertEqual([h.get("x-library-op-stream-version") for _m, _u, h in rec.calls], ["4", "4", None])

    def test_a_write_declares_what_it_is_given(self):
        # @test-id kodi-v4-write-header
        rec = Recorder(body={"version": 2})
        client = api.ApiClient("https://api.example", token="t")
        with mock.patch.object(api, "http_request", rec):
            client.post_op(b"x", "op-1", 1, None, None, ops_sql.write_op_stream_version(None))
            client.post_op(b"x", "op-2", 2, None, None, ops_sql.write_op_stream_version(4))
        declared = [h.get("x-library-op-stream-version") for _m, _u, h in rec.calls]
        phase("declared=%s", declared)
        self.assertEqual(declared, ["3", "4"])


class UpdateRequired(unittest.TestCase):
    BODY = {"error": "app_update_required", "app": "badger", "platform": "kodi", "version": "0.1.0", "minVersion": "0.2.0",
            "reason": "library_op_stream", "opStreamVersion": 4}

    def test_a_426_raises_app_update_required(self):
        # @test-id kodi-v4-426
        client = api.ApiClient("https://api.example", token="t")
        with mock.patch.object(api, "http_request", Recorder(status=426, body=self.BODY)):
            with self.assertRaises(api.AppUpdateRequiredError) as ctx:
                client.library_ops(0)
        phase("426 -> %r reason=%s", ctx.exception, ctx.exception.reason)
        self.assertEqual(ctx.exception.reason, "library_op_stream")

    def _ctx(self, error):
        ctx = mock.Mock()
        ctx.signed_in = True
        ctx.key = b"k"
        ctx.lib.sync.side_effect = error
        return ctx

    def test_the_background_sync_shows_the_update_dialog_once_per_session(self):
        # @test-id kodi-v4-update-dialog
        # @why the user must learn why the library stopped, without a dialog every sync interval
        props = {}
        with mock.patch.object(syncer, "refresh_access"), \
                mock.patch.object(syncer, "follow_profile", return_value=(True, "")), \
                mock.patch.object(syncer, "get_prop", side_effect=lambda k: props.get(k, "")), \
                mock.patch.object(syncer, "set_prop", side_effect=props.__setitem__), \
                mock.patch.object(syncer, "ok_dialog") as dialog:
            first = syncer.run_sync(self._ctx(api.AppUpdateRequiredError(426, self.BODY)))
            second = syncer.run_sync(self._ctx(ops_sql.UnknownOpTypeError("media.hologram.set")))
            manual = syncer.run_sync(self._ctx(api.AppUpdateRequiredError(426, self.BODY)), interactive=True)
        phase("results=%s dialogs=%s", [first, second, manual], dialog.call_args_list)
        self.assertEqual(first, (False, compat.UPDATE_REQUIRED_MESSAGE))
        self.assertEqual(second, (False, compat.UPDATE_REQUIRED_MESSAGE))
        self.assertEqual(manual, (False, compat.UPDATE_REQUIRED_MESSAGE))
        # background: one dialog for the session; the manual sync's message is shown by router.action_sync
        self.assertEqual(dialog.call_args_list, [mock.call("Badger", compat.UPDATE_REQUIRED_MESSAGE)])
        self.assertEqual(compat.UPDATE_REQUIRED_MESSAGE,
                         "SpaceFleet has been updated. Update the add-on to keep watching your library.")


if __name__ == "__main__":
    unittest.main()

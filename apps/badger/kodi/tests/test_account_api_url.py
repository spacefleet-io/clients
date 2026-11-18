"""@req ACCT-AUTH-09 the add-on's account-server setting (`api_url`) counts on a dev run only (SB_DEV_TICKET_KEY=1, the
same switch as the dev ticket key). Any other run talks to the production account API and ignores both the setting and
an `apiUrl` saved with the session, a stale one from an old dev run included."""
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

_DATA = tempfile.mkdtemp(prefix="sb-kodi-apiurl-")
os.environ["SB_DATA_DIR"] = _DATA

import _path  # noqa: F401,E402
import core  # noqa: E402

CUSTOM = "http://192.168.0.20:3000"
SAVED = "http://10.0.0.5:3000"
RELEASE_ENVS = [{}, {"SB_DEV_TICKET_KEY": ""}, {"SB_DEV_TICKET_KEY": "0"}, {"SB_DEV_TICKET_KEY": "true"}]
DEV_ENVS = [{"SB_DEV_TICKET_KEY": "1"}, {"SB_DEV_TICKET_KEY": " 1 "}]


def setUpModule():
    # `unittest discover` imports every test module before it runs any, so SB_DATA_DIR holds whichever module was
    # imported last; point the add-on back at this module's data dir before its tests run.
    os.environ["SB_DATA_DIR"] = _DATA


def phase(name):
    print("[kodi-account-api-url] phase: %s" % name)


class AccountApiUrl(unittest.TestCase):
    def setUp(self):
        self.settings = mock.patch.dict(os.environ, {"SB_SETTINGS_JSON": json.dumps({"api_url": CUSTOM + "/"})})
        self.settings.start()

    def tearDown(self):
        self.settings.stop()
        if os.path.exists(os.path.join(_DATA, "state.json")):
            os.remove(os.path.join(_DATA, "state.json"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(_DATA, ignore_errors=True)

    def test_a_run_without_the_dev_switch_ignores_the_setting_and_the_saved_server(self):
        phase("release ignores api_url and saved apiUrl")
        for env in RELEASE_ENVS:
            self.assertEqual(core.account_api_url({}, env), core.PRODUCTION_API_URL, env)
            self.assertEqual(core.account_api_url({"apiUrl": SAVED}, env), core.PRODUCTION_API_URL, env)
        self.assertEqual(core.PRODUCTION_API_URL, "https://api.spacefleet.io")
        phase("release ticket issuance goes to production")
        core.save_state(token="tok", apiUrl=SAVED)
        with mock.patch.dict(os.environ, {"SB_DEV_TICKET_KEY": ""}):
            api_url, _headers = core.ticket_auth()
        self.assertEqual(api_url, core.PRODUCTION_API_URL)
        phase("done")

    def test_a_dev_run_honours_the_saved_server_then_the_setting(self):
        phase("dev honours saved apiUrl, then api_url")
        for env in DEV_ENVS:
            self.assertEqual(core.account_api_url({"apiUrl": SAVED}, env), SAVED, env)
            self.assertEqual(core.account_api_url({}, env), CUSTOM, env)
        core.save_state(token="tok", apiUrl=SAVED)
        with mock.patch.dict(os.environ, {"SB_DEV_TICKET_KEY": "1"}):
            api_url, _headers = core.ticket_auth()
        self.assertEqual(api_url, SAVED)
        phase("done")

    def test_the_hidden_dev_mode_setting_mirrors_the_switch(self):
        phase("dev_mode mirrors SB_DEV_TICKET_KEY")
        written = []
        with mock.patch.object(core, "set_setting", lambda key, value: written.append((key, value))), \
                mock.patch.object(core, "get_setting", lambda key: "false"):
            core.sync_dev_mode_setting({})
            self.assertEqual(written, [])
            core.sync_dev_mode_setting({"SB_DEV_TICKET_KEY": "1"})
            self.assertEqual(written, [("dev_mode", "true")])
        phase("done")


if __name__ == "__main__":
    unittest.main()

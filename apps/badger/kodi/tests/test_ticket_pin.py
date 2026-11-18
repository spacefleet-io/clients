"""@req META-ANON-03 the add-on pins the same key as the TypeScript apps: ticket_pin.py must equal PINNED_TICKET_KEY (and
its dev key DEV_TICKET_KEY) in packages/privacy-pass/src/pinnedKey.ts, or this test fails (run tools/sync_ticket_pin.py)."""
import os
import re
import subprocess
import sys
import unittest

import _dev_signer as dev
import _path
import privacypass as pp
import ticket_pin

TS_PIN = os.path.join(dev.PRIVACY_PASS, "src", "pinnedKey.ts")


def ts_key(name):
    """(keyId, modulusHex) of the PinnedTicketKey constant `name` in pinnedKey.ts."""
    with open(TS_PIN, encoding="utf-8") as fh:
        text = fh.read()
    block = re.search(r"export const %s[^=]*=\s*\{(.*?)\n\};" % name, text, re.S).group(1)
    modulus = re.search(r'modulusHex:\s*"([0-9a-f]+)"', block).group(1)
    key_id = re.search(r'keyId:\s*"([0-9a-f]+)"', block)
    if key_id:
        key_id = key_id.group(1)
    else:
        assert re.search(r"keyId:\s*DEV_TICKET_KEY_ID", block)
        key_id = re.search(r'export const DEV_TICKET_KEY_ID\s*=\s*"([0-9a-f]+)"', text).group(1)
    return key_id, modulus


def pinned_key_id_of_a_run(env):
    """PINNED_KEY.key_id of a fresh add-on process with exactly `env` (the module picks its key at import)."""
    code = "import sys; sys.path.insert(0, %r); import privacypass; print(privacypass.PINNED_KEY.key_id)" % _path.LIB
    out = subprocess.run([sys.executable, "-c", code], env=env, check=True, capture_output=True, text=True)
    return out.stdout.strip()


class PinnedKey(unittest.TestCase):
    def test_python_pin_equals_the_typescript_pin(self):
        dev.phase("ticket-pin", "ticket_pin.py vs packages/privacy-pass/src/pinnedKey.ts")
        key_id, modulus = ts_key("PINNED_TICKET_KEY")
        self.assertEqual(ticket_pin.PINNED_KEY_ID, key_id, "key id drifted: run apps/badger/kodi/tools/sync_ticket_pin.py")
        self.assertEqual(ticket_pin.PINNED_MODULUS_HEX, modulus, "modulus drifted: run apps/badger/kodi/tools/sync_ticket_pin.py")
        dev_id, dev_modulus = ts_key("DEV_TICKET_KEY")
        self.assertEqual(ticket_pin.DEV_KEY_ID, dev_id, "dev key id drifted: run apps/badger/kodi/tools/sync_ticket_pin.py")
        self.assertEqual(ticket_pin.DEV_MODULUS_HEX, dev_modulus, "dev modulus drifted: run apps/badger/kodi/tools/sync_ticket_pin.py")

    def test_generated_file_is_what_the_generator_writes(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("sync_ticket_pin", os.path.join(dev.REPO, "apps", "badger", "kodi", "tools", "sync_ticket_pin.py"))
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        with open(tool.PY_PIN, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), tool.render(*tool.read_ts_pin()))

    def test_both_keys_are_self_consistent_and_rsa_2048(self):
        for key, key_id_hex in ((pp.PRODUCTION_KEY, ticket_pin.PINNED_KEY_ID), (pp.DEV_KEY, ticket_pin.DEV_KEY_ID)):
            n, key_id = pp.load_pinned_key(key)
            self.assertEqual(n.bit_length(), 2048)
            self.assertEqual(key_id.hex(), key_id_hex)

    def test_the_dev_key_is_the_committed_dev_key_and_the_pin_is_not(self):
        self.assertEqual(dev.dev_key().modulus.hex(), ticket_pin.DEV_MODULUS_HEX)
        self.assertNotEqual(ticket_pin.PINNED_MODULUS_HEX, ticket_pin.DEV_MODULUS_HEX)
        self.assertNotEqual(ticket_pin.PINNED_KEY_ID, ticket_pin.DEV_KEY_ID)

    def test_a_run_pins_the_production_key_unless_it_opts_in_to_the_dev_key(self):
        """@req META-ANON-06 an installed add-on (no opt-in) pins the production key; only SB_DEV_TICKET_KEY=1 pins the dev key."""
        dev.phase("ticket-pin", "fresh add-on processes with and without the dev opt-in")
        base = {k: v for k, v in os.environ.items() if k != pp.DEV_TICKET_KEY_ENV}
        prod = "9b305f0d75ab31dae50752aa4aaf069589ba013894db912b8b5a4b14d773c41a"
        self.assertEqual(ticket_pin.PINNED_KEY_ID, prod)
        self.assertEqual(pinned_key_id_of_a_run(base), prod)
        for value in ("", "0", "true", "yes"):
            self.assertEqual(pinned_key_id_of_a_run(dict(base, SB_DEV_TICKET_KEY=value)), prod, value)
        self.assertEqual(pinned_key_id_of_a_run(dict(base, SB_DEV_TICKET_KEY="1")), ticket_pin.DEV_KEY_ID)
        self.assertEqual(pp.keys_for_run({}), (pp.PRODUCTION_KEY,))
        self.assertEqual(pp.keys_for_run({"SB_DEV_TICKET_KEY": "true"}), (pp.PRODUCTION_KEY,))

    def test_a_dev_run_trusts_every_environment_and_a_release_run_the_production_key_alone(self):
        """@req META-ANON-07 a dev run (SB_DEV_TICKET_KEY=1) trusts the development and the production key, development
        first; any other run the production key alone, so a release can never trust the development key."""
        dev.phase("ticket-pin", "trusted keys per run")
        self.assertEqual(pp.keys_for_run({"SB_DEV_TICKET_KEY": " 1 "}), (pp.DEV_KEY, pp.PRODUCTION_KEY))
        for env in ({}, {"SB_DEV_TICKET_KEY": ""}, {"SB_DEV_TICKET_KEY": "0"}, {"SB_DEV_TICKET_KEY": "yes"}):
            self.assertNotIn(pp.DEV_KEY, pp.keys_for_run(env), env)


if __name__ == "__main__":
    unittest.main()

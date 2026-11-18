#!/usr/bin/env python3
"""Regenerate resources/lib/ticket_pin.py from packages/privacy-pass/src/pinnedKey.ts: the production ticket key apps pin
(PINNED_TICKET_KEY, META-ANON-03 / META-ANON-06) and the committed development key (DEV_TICKET_KEY) a dev run opts in to.

  python3 apps/badger/kodi/tools/sync_ticket_pin.py            # rewrite ticket_pin.py
  python3 apps/badger/kodi/tools/sync_ticket_pin.py --check    # exit 1 when it differs (tests/test_ticket_pin.py does the same)

Run it whenever a key in pinnedKey.ts changes (packages/privacy-pass/README.md "Rotation").
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TS_PIN = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "packages", "privacy-pass", "src", "pinnedKey.ts"))
PY_PIN = os.path.normpath(os.path.join(HERE, "..", "plugin.video.spacebadger", "resources", "lib", "ticket_pin.py"))

TEMPLATE = '''# -*- coding: utf-8 -*-
"""The ticket signing keys this add-on knows (META-ANON-03, META-ANON-06). GENERATED from packages/privacy-pass/src/pinnedKey.ts
(PINNED_TICKET_KEY and DEV_TICKET_KEY): do not edit by hand, run apps/badger/kodi/tools/sync_ticket_pin.py.
tests/test_ticket_pin.py fails when this file and the TypeScript keys differ. The add-on pins the PRODUCTION key; the
public development key (packages/privacy-pass/dev-keys/) only with the explicit dev opt-in SB_DEV_TICKET_KEY=1."""

# token_key_id: SHA-256 of the RSASSA-PSS SubjectPublicKeyInfo DER (RFC 9578 section 6.5), lowercase hex.
PINNED_KEY_ID = "%(key_id)s"
# RSA-2048 modulus, lowercase hex (the exponent is always 65537).
PINNED_MODULUS_HEX = (
%(modulus_lines)s
)

# The committed development key, same encoding.
DEV_KEY_ID = "%(dev_key_id)s"
DEV_MODULUS_HEX = (
%(dev_modulus_lines)s
)
'''


def _read_key(text, name, path):
    """(keyId, modulusHex) of the PinnedTicketKey constant `name`, taken from the TypeScript source."""
    block = re.search(r"export const %s[^=]*=\s*\{(.*?)\n\};" % name, text, re.S)
    if not block:
        raise SystemExit("%s not found in %s" % (name, path))
    body = block.group(1)
    key_id = re.search(r'keyId:\s*(?:"([0-9a-f]{64})"|(DEV_TICKET_KEY_ID))', body)
    modulus = re.search(r'modulusHex:\s*"([0-9a-f]{512})"', body)
    if not key_id or not modulus:
        raise SystemExit("%s in %s has an unexpected shape" % (name, path))
    if key_id.group(1):
        key_hex = key_id.group(1)
    else:
        dev = re.search(r'export const DEV_TICKET_KEY_ID\s*=\s*"([0-9a-f]{64})"', text)
        if not dev:
            raise SystemExit("DEV_TICKET_KEY_ID not found in %s" % path)
        key_hex = dev.group(1)
    return key_hex, modulus.group(1)


def read_ts_pin(path=TS_PIN):
    """(PINNED_TICKET_KEY, DEV_TICKET_KEY), each (keyId, modulusHex), taken from the TypeScript source."""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    return _read_key(text, "PINNED_TICKET_KEY", path), _read_key(text, "DEV_TICKET_KEY", path)


def _lines(modulus_hex):
    return "\n".join('    "%s"' % modulus_hex[i:i + 64] for i in range(0, len(modulus_hex), 64))


def render(pinned, dev):
    return TEMPLATE % {
        "key_id": pinned[0],
        "modulus_lines": _lines(pinned[1]),
        "dev_key_id": dev[0],
        "dev_modulus_lines": _lines(dev[1]),
    }


def main(argv):
    text = render(*read_ts_pin())
    if "--check" in argv:
        with open(PY_PIN, encoding="utf-8") as fh:
            same = fh.read() == text
        print("ticket_pin.py is up to date" if same else "ticket_pin.py differs from pinnedKey.ts: run tools/sync_ticket_pin.py")
        return 0 if same else 1
    with open(PY_PIN, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("wrote %s" % PY_PIN)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

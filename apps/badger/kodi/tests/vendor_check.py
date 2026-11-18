#!/usr/bin/env python3
"""Standalone proof that the vendored Cryptodome works on THIS machine (used by test_vendor_loader and on the Pi).

  python3 -S vendor_check.py LIB_DIR VECTORS_JSON

LIB_DIR is a directory holding crypto.py, compat.py, vendor_loader.py and vendor/. Forces the fallback
(SB_FORCE_CRYPTODOME=1), then checks: the vendored copy (not a system one) is imported, AES-GCM vectors from the TS
implementation, HKDF (pure-Python vs Cryptodome.Protocol.KDF.HKDF), and X25519 (RFC 7748 section 6.1) via Protocol.DH.
Prints one JSON line; exit code 0 only if everything passed. Run with ``-S`` so no system site-packages are visible.
"""
import base64
import json
import os
import sys

os.environ["SB_FORCE_CRYPTODOME"] = "1"
lib_dir, vectors_path = os.path.abspath(sys.argv[1]), sys.argv[2]
sys.path.insert(0, lib_dir)

import crypto  # noqa: E402
import vendor_loader  # noqa: E402

with open(vectors_path) as fh:
    V = json.load(fh)

report = {"python": sys.version.split()[0], "platform_key": vendor_loader.platform_key()}
backend_name = crypto.backend_name()  # triggers _load_backend -> vendor_loader.prepare()
status = vendor_loader.last_status()
report.update(backend=backend_name, loader=status)
assert backend_name == "Cryptodome", report
assert status["source"] == "vendored", report
assert os.path.realpath(status["dir"]).startswith(os.path.realpath(os.path.join(lib_dir, "vendor"))), report

key = crypto.parse_library_key(V["libraryKeyB64"])
assert crypto.envelope_decrypt(key, bytes.fromhex(V["envelopeHex"])) == base64.b64decode(V["envelopePlainB64"])
master = crypto.derive_media_master_key(key)
assert master.hex() == V["masterKeyHex"]
assert crypto.derive_object_key(master, bytes.fromhex(V["hkdfSaltHex"])).hex() == V["objectKeyHex"]
plain, was_encrypted = crypto.sfv1_decrypt(master, bytes.fromhex(V["sfv1Hex"]))
assert was_encrypted and plain == base64.b64decode(V["mediaPlainB64"])
blob = crypto.envelope_encrypt(key, b"abc" * 5000)
assert crypto.envelope_decrypt(key, blob) == b"abc" * 5000
try:
    crypto.envelope_decrypt(bytes(32), blob)
    raise SystemExit("wrong key accepted")
except crypto.AuthenticationError:
    pass

from Cryptodome.Hash import SHA256  # noqa: E402
from Cryptodome.Protocol.KDF import HKDF  # noqa: E402
from Cryptodome.Protocol.DH import import_x25519_private_key, import_x25519_public_key, key_agreement  # noqa: E402
from Cryptodome.PublicKey import ECC  # noqa: E402
from Cryptodome.Random import get_random_bytes  # noqa: E402

ikm, salt, info = bytes.fromhex("0b" * 22), bytes.fromhex("000102030405060708090a0b0c"), bytes.fromhex("f0f1f2f3f4f5f6f7f8f9")
assert HKDF(ikm, 42, salt, SHA256, context=info) == crypto.hkdf_sha256(ikm, salt, info, 42)

alice_priv = bytes.fromhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
bob_pub = bytes.fromhex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
shared = key_agreement(static_priv=import_x25519_private_key(alice_priv), static_pub=import_x25519_public_key(bob_pub), kdf=lambda s: s)
assert shared.hex() == "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742", shared.hex()

a, b = ECC.generate(curve="Curve25519"), ECC.generate(curve="Curve25519")
assert len(a.public_key().export_key(format="raw")) == 32
assert key_agreement(static_priv=a, static_pub=b.public_key(), kdf=lambda s: s) == \
    key_agreement(static_priv=b, static_pub=a.public_key(), kdf=lambda s: s)
assert len(get_random_bytes(16)) == 16

import Cryptodome  # noqa: E402
report["cryptodome_version"] = Cryptodome.__version__
report["cryptodome_file"] = Cryptodome.__file__
report["ok"] = True
print(json.dumps(report))

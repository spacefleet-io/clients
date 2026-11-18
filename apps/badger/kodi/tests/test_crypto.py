"""Crypto vectors produced by the TypeScript implementations (tests/gen_vectors.ts).

@req PRIV-ENC-01  library envelope + SFV1 objects decrypt with the TS-produced bytes
@req PRIV-KEY-01  the key never leaves the device: only the 32-byte raw key derives everything locally
"""
import base64
import hashlib
import json
import os
import unittest

import _path  # noqa: F401
import crypto

with open(os.path.join(os.path.dirname(__file__), "vectors.json")) as fh:
    V = json.load(fh)


class CryptoVectors(unittest.TestCase):
    def test_backend_loads(self):
        self.assertIn(crypto.backend_name(), ("libcrypto", "Cryptodome"))

    def test_hkdf_rfc5869_case1(self):
        ikm = bytes.fromhex("0b" * 22)
        salt = bytes.fromhex("000102030405060708090a0b0c")
        info = bytes.fromhex("f0f1f2f3f4f5f6f7f8f9")
        okm = crypto.hkdf_sha256(ikm, salt, info, 42)
        self.assertEqual(
            okm.hex(),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
        )

    def test_master_and_object_key_match_ts(self):
        key = crypto.parse_library_key(V["libraryKeyB64"])
        master = crypto.derive_media_master_key(key)
        self.assertEqual(master.hex(), V["masterKeyHex"])
        self.assertEqual(crypto.derive_object_key(master, bytes.fromhex(V["hkdfSaltHex"])).hex(), V["objectKeyHex"])

    def test_library_key_accepts_grouped_and_rejects_short(self):
        raw = base64.b64decode(V["libraryKeyB64"])
        grouped = " ".join(V["libraryKeyB64"][i:i + 4] for i in range(0, len(V["libraryKeyB64"]), 4))
        self.assertEqual(crypto.parse_library_key(grouped), raw)
        with self.assertRaises(crypto.CryptoError):
            crypto.parse_library_key(base64.b64encode(b"short").decode())

    def test_envelope_decrypts_ts_bytes(self):
        key = crypto.parse_library_key(V["libraryKeyB64"])
        plain = crypto.envelope_decrypt(key, bytes.fromhex(V["envelopeHex"]))
        self.assertEqual(plain, base64.b64decode(V["envelopePlainB64"]))

    def test_envelope_round_trip_and_wrong_key(self):
        key = crypto.parse_library_key(V["libraryKeyB64"])
        blob = crypto.envelope_encrypt(key, b"abc" * 1000)
        self.assertEqual(crypto.envelope_decrypt(key, blob), b"abc" * 1000)
        with self.assertRaises(crypto.AuthenticationError):
            crypto.envelope_decrypt(bytes(32), blob)
        tampered = bytearray(blob)
        tampered[20] ^= 1
        with self.assertRaises(crypto.AuthenticationError):
            crypto.envelope_decrypt(key, bytes(tampered))

    def test_sfv1_decrypts_ts_object(self):
        key = crypto.parse_library_key(V["libraryKeyB64"])
        master = crypto.derive_media_master_key(key)
        plain, was_encrypted = crypto.sfv1_decrypt(master, bytes.fromhex(V["sfv1Hex"]))
        self.assertTrue(was_encrypted)
        self.assertEqual(plain, base64.b64decode(V["mediaPlainB64"]))

    def test_sfv1_python_round_trip_and_passthrough(self):
        master = crypto.derive_media_master_key(bytes(range(32)))
        obj = crypto.sfv1_encrypt(master, b"x" * 123, pad=b"\x00" * 9)
        self.assertEqual(crypto.sfv1_decrypt(master, obj), (b"x" * 123, True))
        self.assertEqual(crypto.sfv1_decrypt(master, b"plain bytes"), (b"plain bytes", False))
        bad = bytearray(obj)
        bad[-1] ^= 1
        with self.assertRaises(crypto.AuthenticationError):
            crypto.sfv1_decrypt(master, bytes(bad))

    def test_state_hash_vector(self):
        sh = V["stateHash"]
        payload = bytes.fromhex(sh["envelopeHex"])
        got = hashlib.sha256(("%s|%s|%s" % (sh["prev"], sh["opId"], hashlib.sha256(payload).hexdigest())).encode()).hexdigest()
        self.assertEqual(got, sh["next"])


if __name__ == "__main__":
    unittest.main()

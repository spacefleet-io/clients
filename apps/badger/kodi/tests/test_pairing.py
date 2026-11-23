"""Pairing crypto + flow against the vectors published by packages/pairing-crypto.

@req ACCT-PAIR-01  device shows a code, polls, receives token + sealed key, verifies the keyProbe before storing
@req PRIV-KEY-05   X25519 + HKDF-SHA256 + AES-256-GCM sealed key identical to the TS implementation
"""
import base64
import json
import os
import struct
import unittest
import zlib

import _path  # noqa: F401
import crypto
import pairing
import qrimage
import x25519
from api import ApiError

HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(HERE, "..", "..", "..", "..", "packages", "pairing-crypto", "tests", "vectors.json")
with open(VECTORS) as fh:
    V = json.load(fh)


def b64(text):
    return base64.b64decode(text)


class X25519Rfc7748(unittest.TestCase):
    def test_rfc7748_section_6_1_both_backends(self):
        a_priv = bytes.fromhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        a_pub = bytes.fromhex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
        b_priv = bytes.fromhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
        b_pub = bytes.fromhex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        shared = bytes.fromhex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
        self.assertEqual(x25519.public_from_private(a_priv), a_pub)
        self.assertEqual(x25519.shared_secret(a_priv, b_pub), shared)
        self.assertEqual(x25519.shared_secret(b_priv, a_pub), shared)
        # the pure-Python ladder must agree with whatever backend was picked
        self.assertEqual(x25519._py_scalarmult(a_priv, b_pub), shared)
        self.assertEqual(x25519._py_scalarmult(a_priv, x25519._BASE_POINT), a_pub)

    def test_all_zero_shared_secret_rejected(self):
        with self.assertRaises(x25519.X25519Error):
            x25519.shared_secret(os.urandom(32), bytes(32))


class SealedKeyVector(unittest.TestCase):
    def test_device_keys_match_vector(self):
        self.assertEqual(x25519.public_from_private(b64(V["devicePrivateKey"])), b64(V["devicePublicKey"]))
        self.assertEqual(x25519.public_from_private(b64(V["ephemeralPrivateKey"])), b64(V["ephemeralPublicKey"]))

    def test_shared_and_derived_key(self):
        shared = x25519.shared_secret(b64(V["devicePrivateKey"]), b64(V["ephemeralPublicKey"]))
        self.assertEqual(shared.hex(), V["sharedSecretHex"])
        self.assertEqual(pairing.derive_pair_key(shared, V["requestId"]).hex(), V["derivedKeyHex"])

    def test_open_vector(self):
        key = pairing.open_sealed_key(b64(V["devicePrivateKey"]), V["requestId"], V["sealed"])
        self.assertEqual(key, b64(V["libraryKey"]))

    def test_seal_reproduces_vector(self):
        sealed = pairing.seal_library_key(
            b64(V["devicePublicKey"]), V["requestId"], b64(V["libraryKey"]),
            ephemeral_private=b64(V["ephemeralPrivateKey"]), iv=b64(V["iv"]))
        self.assertEqual(sealed, V["sealed"])

    def test_wrong_request_id_or_tampering_is_refused(self):
        with self.assertRaises(pairing.PairingError):
            pairing.open_sealed_key(b64(V["devicePrivateKey"]), "another-request", V["sealed"])
        bad = dict(V["sealed"], ct=base64.b64encode(b"\x00" * 48).decode())
        with self.assertRaises(pairing.PairingError):
            pairing.open_sealed_key(b64(V["devicePrivateKey"]), V["requestId"], bad)
        with self.assertRaises(pairing.PairingError):
            pairing.open_sealed_key(b64(V["devicePrivateKey"]), V["requestId"], dict(V["sealed"], v=2))


class ShortCodes(unittest.TestCase):
    def test_vectors(self):
        for case in V["shortCodes"]:
            self.assertEqual(pairing.normalize_short_code(case["input"]), case["normalized"], case["input"])
            if case["normalized"]:
                self.assertEqual(list(pairing.short_code_groups(case["normalized"])), case["groups"])

    # @bugfix @regression-proof Chris 2026-11-18: the code is shown as 4 + 4 with no dash, whatever the API sent.
    def test_groups_never_show_a_dash(self):
        self.assertEqual(pairing.short_code_groups("ABCD-EFGH"), ("ABCD", "EFGH"))
        self.assertEqual(pairing.short_code_groups("abcdefgh"), ("ABCD", "EFGH"))


class FakeApi(object):
    base_url = "http://fake"

    def __init__(self, session_holder):
        self.holder = session_holder
        self.polls = 0
        self.requests = []

    def request_json(self, method, path, body=None, expect=(200,), timeout=30):
        self.requests.append((method, path, body))
        if method == "POST" and path == "/pairing/requests":
            self.holder["public"] = b64(body["publicKey"])
            return {"requestId": V["requestId"], "pollSecret": "s3cret", "shortCode": "ABCDEFGH",
                    "qrPayload": "https://spacefleet.io/pair/badger?code=ABCDEFGH", "expiresAt": "2026-10-16T12:05:00.000Z"}
        self.polls += 1
        if self.polls == 1:
            return {"status": "pending"}
        # the "phone" seals to the public key the device announced
        sealed = pairing.seal_library_key(self.holder["public"], V["requestId"], b64(V["libraryKey"]))
        return {"status": "approved", "token": "tok", "user": {"id": "u", "email": "a@b.c"}, "sealedKey": sealed,
                "clientType": "badger-kodi"}


class SessionFlow(unittest.TestCase):
    def test_start_poll_complete_with_probe(self):
        holder = {}
        api = FakeApi(holder)
        session = pairing.PairingSession(api, "Living room Kodi", clock=lambda: 1792152000.0).start()
        self.assertEqual(session.short_code, "ABCDEFGH")
        self.assertEqual(api.requests[0][2]["deviceType"], "kodi")
        self.assertEqual(api.requests[0][2]["deviceName"], "Living room Kodi")
        self.assertEqual(base64.b64decode(api.requests[0][2]["publicKey"]), session.public)
        self.assertEqual(session.poll()["status"], "pending")
        # OPS-LIMIT-02: long-poll keeps Kodi far under 20 polls per minute.
        self.assertTrue(api.requests[1][1].endswith("&wait=25"))
        approved = session.poll()
        self.assertEqual(approved["status"], "approved")

        probe = crypto.envelope_encrypt_b64(b64(V["libraryKey"]), os.urandom(32))
        import api as api_module
        original = api_module.ApiClient.library_meta
        original_profiles = api_module.ApiClient.profiles
        api_module.ApiClient.library_meta = lambda self: {"keyProbe": probe}
        api_module.ApiClient.profiles = lambda self: [{"id": "p1", "name": "Chris", "isMain": True}]
        try:
            result = session.complete(approved)
        finally:
            api_module.ApiClient.library_meta = original
            api_module.ApiClient.profiles = original_profiles
        self.assertEqual(result["key"], b64(V["libraryKey"]))
        self.assertEqual(result["token"], "tok")
        self.assertEqual(result["profiles"][0]["id"], "p1")

    def test_key_that_fails_the_probe_is_never_accepted(self):
        probe = crypto.envelope_encrypt_b64(os.urandom(32), os.urandom(32))  # a different library's key
        with self.assertRaises(pairing.PairingError):
            pairing.verify_key_against_probe(b64(V["libraryKey"]), {"keyProbe": probe})
        self.assertIsNone(pairing.verify_key_against_probe(b64(V["libraryKey"]), {}))

    def test_poll_maps_404_to_expired_and_blips_to_pending(self):
        class Gone(object):
            base_url = ""

            def request_json(self, *a, **k):
                raise ApiError(404, {"error": "pairing_not_found"})

        class Down(Gone):
            def request_json(self, *a, **k):
                raise OSError("offline")

        s = pairing.PairingSession(Gone(), "x")
        s.request_id, s.poll_secret = "r", "p"
        self.assertEqual(s.poll()["status"], "expired")
        s.api = Down()
        self.assertEqual(s.poll()["status"], "pending")


class QrPng(unittest.TestCase):
    def test_png_is_valid_and_has_quiet_zone(self):
        matrix = qrimage.qr_matrix("https://spacefleet.io/pair/badger?code=ABCDEFGH")
        data = qrimage.png_bytes(matrix, scale=4, border=4)
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        width, height = struct.unpack(">II", data[16:24])
        self.assertEqual(width, (len(matrix) + 8) * 4)
        self.assertEqual(width, height)
        pos, idat = 8, b""
        while pos < len(data):
            length, kind = struct.unpack(">I4s", data[pos:pos + 8])
            body = data[pos + 8:pos + 8 + length]
            crc = struct.unpack(">I", data[pos + 8 + length:pos + 12 + length])[0]
            self.assertEqual(crc, zlib.crc32(kind + body) & 0xFFFFFFFF)
            if kind == b"IDAT":
                idat += body
            pos += 12 + length
        raw = zlib.decompress(idat)
        self.assertEqual(len(raw), height * (width + 1))
        first_row = raw[1:width + 1]
        self.assertEqual(set(first_row), {255})  # quiet zone is white


if __name__ == "__main__":
    unittest.main()

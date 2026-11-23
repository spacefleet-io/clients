"""Pairing crypto + flow against the vectors published by packages/pairing-crypto.

@req ACCT-PAIR-01  device shows a code, polls, receives token + sealed key, verifies the keyProbe before storing
@req PRIV-KEY-05   X25519 + HKDF-SHA256 + AES-256-GCM sealed key identical to the TS implementation
@req PRIV-PAIR-01  sf-pair-v2: commitment in the request, `#c=` in the QR, reveal on the phone's nonce, same six digits
@req PRIV-PAIR-04  the add-on makes its requests with the check (unfrozen for this change only)
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


V2_PATH = os.path.join(HERE, "..", "..", "..", "..", "packages", "pairing-crypto", "tests", "vectors-v2.json")
with open(V2_PATH) as fh:
    V2 = json.load(fh)


class CheckCodeVector(unittest.TestCase):
    """@test-id KODI-PAIR-CHECK-001 @req PRIV-PAIR-01
    @why Chris 2026-11-23 ("yes that'd be better"): Kodi must compute the very digits the phone shows, from the vector
    the TS package is tested against (written with node:crypto)."""

    def test_vector(self):
        pk, nr, na = b64(V2["publicKey"]), b64(V2["requesterNonce"]), b64(V2["approverNonce"])
        commitment = pairing.pairing_commitment(pk, nr)
        print("[kodi-pair-check] commitment", base64.b64encode(commitment).decode())
        self.assertEqual(base64.b64encode(commitment).decode(), V2["commitment"])
        self.assertEqual(pairing.commitment_fingerprint(commitment), V2["fingerprint"])
        self.assertEqual(pairing.pairing_check_code(pk, commitment, na, nr), V2["checkCode"])
        self.assertEqual(pairing.format_check_code("067383"), "067 383")
        self.assertEqual(pairing.with_commitment_fingerprint("https://spacefleet.io/pair/badger?code=X#c=evil", commitment),
                         "https://spacefleet.io/pair/badger?code=X#c=" + V2["fingerprint"])


class FakeV2Api(object):
    """A protocol-2 API: answers `pending`, then pending with the phone's nonce, then (after the reveal) pending."""
    base_url = "http://fake"

    def __init__(self, reveal_fails=0):
        self.requests = []
        self.created = None
        self.revealed = None
        self.reveal_fails = reveal_fails
        self.polls = 0

    def request_json(self, method, path, body=None, expect=(200,), timeout=30):
        self.requests.append((method, path, body))
        if method == "POST" and path == "/pairing/requests":
            self.created = body
            return {"requestId": "req-1", "pollSecret": "s3cret", "shortCode": "ABCDEFGH",
                    "qrPayload": "https://spacefleet.io/pair/badger?code=ABCDEFGH", "expiresAt": "2026-10-16T12:05:00.000Z"}
        if method == "POST" and path == "/pairing/requests/req-1/reveal":
            if self.reveal_fails:
                self.reveal_fails -= 1
                raise ApiError(503, "down")
            pk, nr = b64(self.created["publicKey"]), b64(body["requesterNonce"])
            if base64.b64encode(pairing.pairing_commitment(pk, nr)).decode() != self.created["commitment"]:
                raise ApiError(400, "pairing_commitment_mismatch")
            self.revealed = body["requesterNonce"]
            return {"ok": True}
        self.polls += 1
        if self.polls == 1 or self.revealed:
            return {"status": "pending"}
        return {"status": "pending", "approverNonce": V2["approverNonce"]}


class CheckFlow(unittest.TestCase):
    """@test-id KODI-PAIR-CHECK-002 @req PRIV-PAIR-01 @req PRIV-PAIR-04
    @why the add-on is a receiver: it must send a commitment, put its fingerprint in the QR, reveal its number only
    once the phone connected, and show the digits the phone computes from the same values."""

    def test_commit_reveal_and_code(self):
        api = FakeV2Api()
        session = pairing.PairingSession(api, "Living room Kodi", clock=lambda: 1792152000.0).start()
        created = api.created
        commitment = b64(created["commitment"])
        self.assertEqual(commitment, pairing.pairing_commitment(session.public, session.requester_nonce))
        self.assertTrue(session.qr_payload.endswith("#c=" + pairing.commitment_fingerprint(commitment)))
        print("[kodi-pair-check] phase: before the phone connects")
        self.assertEqual(session.poll(), {"status": "pending"})
        self.assertIsNone(api.revealed)
        print("[kodi-pair-check] phase: phone connected")
        answer = session.poll()
        expected = pairing.pairing_check_code(session.public, commitment, b64(V2["approverNonce"]), session.requester_nonce)
        self.assertEqual(answer, {"status": "pending", "checkCode": expected})
        self.assertEqual(b64(api.revealed), session.requester_nonce)
        # the code stays on screen; no second reveal
        self.assertEqual(session.poll(), {"status": "pending", "checkCode": expected})
        self.assertEqual(sum(1 for r in api.requests if r[1].endswith("/reveal")), 1)

    def test_failed_reveal_is_retried_on_the_next_poll(self):
        api = FakeV2Api(reveal_fails=1)
        session = pairing.PairingSession(api, "Kodi", clock=lambda: 1792152000.0).start()
        session.poll()
        self.assertEqual(session.poll(), {"status": "pending"})
        self.assertEqual(session.poll()["checkCode"], session.check_code)
        self.assertIsNotNone(session.check_code)

    def test_malformed_nonce_is_ignored(self):
        api = FakeV2Api()
        session = pairing.PairingSession(api, "Kodi", clock=lambda: 1792152000.0).start()
        api.polls = 1
        original = api.request_json
        api.request_json = lambda m, p, b=None, expect=(200,), timeout=30: (
            {"status": "pending", "approverNonce": "short"} if m == "GET" else original(m, p, b, expect, timeout))
        self.assertEqual(session.poll(), {"status": "pending"})
        self.assertIsNone(api.revealed)

    def test_failed_reveal_does_not_let_the_server_swap_the_nonce(self):
        """Found by the sf-pair-v2 TLA+ model: a server that keeps the reveal but fails the answer, then shows another
        phone nonce, must not get a code built from that nonce (it knows nR by then and could grind it)."""
        other = base64.b64encode(b"\x07" * 32).decode()
        api = FakeV2Api()
        original = api.request_json
        state = {"reveals": 0, "shown": V2["approverNonce"]}

        def lying(method, path, body=None, expect=(200,), timeout=30):
            if method == "POST" and path.endswith("/reveal"):
                state["reveals"] += 1
                original(method, path, body, expect, timeout)  # the server keeps nR
                if state["reveals"] == 1:
                    state["shown"] = other
                    raise ApiError(500, "internal")
                return {"ok": True}
            if method == "GET":
                return {"status": "pending", "approverNonce": state["shown"]}
            return original(method, path, body, expect, timeout)

        api.request_json = lying
        session = pairing.PairingSession(api, "Kodi", clock=lambda: 1792152000.0).start()
        commitment = b64(api.created["commitment"])
        self.assertEqual(session.poll(), {"status": "pending"})
        answer = session.poll()
        first = pairing.pairing_check_code(session.public, commitment, b64(V2["approverNonce"]), session.requester_nonce)
        swapped = pairing.pairing_check_code(session.public, commitment, b64(other), session.requester_nonce)
        print("[kodi-pair-check] lying server", {"reveals": state["reveals"], "answer": answer, "first": first, "swapped": swapped})
        self.assertEqual(answer, {"status": "pending", "checkCode": first})
        self.assertNotEqual(answer["checkCode"], swapped)


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

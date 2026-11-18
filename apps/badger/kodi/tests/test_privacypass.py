"""@req META-ANON-03 the Python port blinds, unblinds and verifies exactly like packages/privacy-pass: every RFC 9474 /
RFC 9578 vector and the dev-key vector, plus a full blind -> sign (dev key) -> finalize -> verify cycle.

Pending cells only warn, so the tags are truthful claims about what this proves (pinned-key verification of every ticket
in the add-on), not a status flip."""
import hashlib
import unittest

import _dev_signer as dev
import _path  # noqa: F401
import privacypass as pp


def h(text):
    return bytes.fromhex(text)


class Rfc9474Vector(unittest.TestCase):
    def test_a3_rsabssa_sha384_pss_deterministic(self):
        dev.phase("privacypass", "RFC 9474 A.3 (RSA-4096)")
        v = dev.load_vector("rfc9474-a3.json")
        n, d = int(v["n"], 16), int(v["d"], 16)
        msg, salt, inv = h(v["prepared_msg"]), h(v["salt"]), h(v["inv"])
        self.assertEqual(v["msg_prefix"], "")
        self.assertEqual(pp.emsa_pss_encode(msg, n.bit_length() - 1, salt), h(v["encoded_msg"]))
        blinded, got_inv = pp.blind(n, msg, salt=salt, inv=inv)
        self.assertEqual(blinded, h(v["blinded_msg"]))
        self.assertEqual(got_inv, inv)
        blind_sig = pow(int.from_bytes(blinded, "big"), d, n).to_bytes(512, "big")
        self.assertEqual(blind_sig, h(v["blind_sig"]))
        sig = pp.finalize(n, msg, blind_sig, inv)
        self.assertEqual(sig, h(v["sig"]))
        self.assertTrue(pp.verify(n, msg, sig))
        self.assertFalse(pp.verify(n, msg + b"x", sig))
        self.assertFalse(pp.verify(n, msg, sig[:-1] + bytes([sig[-1] ^ 1])))


class Rfc9578Vectors(unittest.TestCase):
    def test_a2_five_issuances(self):
        vectors = dev.load_vector("rfc9578-a2.json")["vectors"]
        self.assertEqual(len(vectors), 5)
        for index, v in enumerate(vectors, 1):
            dev.phase("privacypass", "RFC 9578 A.2 vector %d" % index)
            key = dev.PrivateKey.from_pem(h(v["skI"]).decode("ascii"))
            self.assertEqual(pp.rsa_pss_spki(key.modulus), h(v["pkI"]))
            key_id = hashlib.sha256(h(v["pkI"])).digest()
            token = h(v["token"])
            token_input = b"\x00\x02" + h(v["nonce"]) + hashlib.sha256(h(v["token_challenge"])).digest() + key_id
            self.assertEqual(token[:98], token_input)
            # the vector's `blind` is the blinding factor r; RFC 9474 Finalize takes its inverse
            inv = pow(int(v["blind"], 16), -1, key.n).to_bytes(256, "big")
            blinded, got_inv = pp.blind(key.n, token_input, salt=h(v["salt"]), inv=inv)
            self.assertEqual(blinded, h(v["token_request"])[3:])
            blind_sig = key.blind_sign(blinded)
            self.assertEqual(blind_sig, h(v["token_response"]))
            authenticator = pp.finalize(key.n, token_input, blind_sig, got_inv)
            self.assertEqual(authenticator, token[98:])
            self.assertTrue(pp.verify(key.n, token[:98], token[98:]))


class DevTokenVector(unittest.TestCase):
    def setUp(self):
        self.v = dev.load_vector("dev-token.json")
        self.n, self.key_id = pp.load_pinned_key()

    def test_constants_match_the_ts_codec(self):
        dev.phase("privacypass", "fixed challenge, key id, SPKI")
        self.assertEqual(pp.TOKEN_CHALLENGE, h(self.v["tokenChallengeHex"]))
        self.assertEqual(pp.CHALLENGE_DIGEST, h(self.v["challengeDigestHex"]))
        public = self.v["publicKey"]
        self.assertEqual(pp.PINNED_KEY.modulus_hex, public["modulusHex"])
        self.assertEqual(pp.rsa_pss_spki(h(public["modulusHex"])), h(public["spkiDerHex"]))
        self.assertEqual(self.key_id.hex(), public["keyIdHex"])
        self.assertEqual(pp.PINNED_KEY.key_id, public["keyIdHex"])

    def test_issuance_is_reproduced_byte_for_byte(self):
        dev.phase("privacypass", "deterministic issuance under the dev key")
        iss = self.v["issuance"]
        token_input = pp.authenticator_input(h(iss["nonceHex"]), self.key_id)
        self.assertEqual(token_input, h(iss["authenticatorInputHex"]))
        self.assertEqual(pp.emsa_pss_encode(token_input, self.n.bit_length() - 1, h(iss["saltHex"])), h(iss["encodedMsgHex"]))
        blinded, inv = pp.blind(self.n, token_input, salt=h(iss["saltHex"]), inv=h(iss["blindingInverseHex"]))
        self.assertEqual(blinded, h(iss["blindedMsgHex"]))
        authenticator = pp.finalize(self.n, token_input, h(iss["blindSigHex"]), inv)
        self.assertEqual(authenticator, h(iss["authenticatorHex"]))
        token = pp.build_token(h(iss["nonceHex"]), self.key_id, authenticator)
        self.assertEqual(token, h(self.v["token"]["hex"]))
        self.assertEqual(pp.b64url_encode(token), self.v["token"]["base64Url"])
        self.assertEqual(pp.private_token_authorization(token), self.v["token"]["authorizationHeader"])
        # the dev private key (test-only signer) signs the same blind signature the TS server produced
        self.assertEqual(dev.dev_key().blind_sign(blinded), h(iss["blindSigHex"]))
        self.assertIsNone(pp.verify_token(token))

    def test_invalid_tokens_fail_with_the_server_reasons(self):
        dev.phase("privacypass", "verify_token vs the TS verifier's invalid-token vectors")
        for entry in self.v["invalidTokens"]:
            self.assertEqual(pp.verify_token(h(entry["hex"])), entry["reason"], entry["reason"])


class IssuanceCycle(unittest.TestCase):
    """blind -> BlindSign with the dev private key -> finalize -> verify, through the same two calls the reserve makes."""

    def test_cycle_with_the_dev_key(self):
        dev.phase("privacypass", "create_ticket_requests -> sign -> finish_tickets")
        signer = dev.dev_key()
        blinded, pending = pp.create_ticket_requests(5)
        self.assertEqual(len(set(blinded)), 5)
        signed = [pp.b64url_encode(signer.blind_sign(pp.b64url_decode(b))) for b in blinded]
        tokens, dropped = pp.finish_tickets(pending, signed, response_key_id=pp.PINNED_KEY.key_id)
        self.assertEqual((len(tokens), dropped), (5, 0))
        self.assertEqual(len(set(t[:50] for t in tokens)), 5)
        for t in tokens:
            raw = pp.b64url_decode(t)
            self.assertEqual(len(raw), pp.TOKEN_LENGTH)
            self.assertEqual(raw[:2], b"\x00\x02")
            self.assertIsNone(pp.verify_token(raw))
            self.assertEqual(pp.token_key_id(raw), h(pp.PINNED_KEY.key_id))

    def test_bad_server_data_is_dropped_not_raised(self):
        dev.phase("privacypass", "drop wrong key id, bad signature, malformed entries")
        signer = dev.dev_key()
        blinded, pending = pp.create_ticket_requests(4)
        good = [pp.b64url_encode(signer.blind_sign(pp.b64url_decode(b))) for b in blinded]
        # a different key id drops the whole batch (META-ANON-03)
        self.assertEqual(pp.finish_tickets(pending, good, response_key_id="ab" * 32), ([], 4))
        self.assertEqual(pp.finish_tickets(pending, good, response_key_id=7), ([], 4))
        self.assertEqual(pp.finish_tickets(pending, "nope"), ([], 4))
        # per entry: wrong key's signature, garbage, wrong type, missing -> dropped; the good one is kept
        other = dev.PrivateKey.from_pem(h(dev.load_vector("rfc9578-a2.json")["vectors"][0]["skI"]).decode())
        wrong_key_sig = pp.b64url_encode(other.blind_sign(pp.b64url_decode(blinded[1])))
        tokens, dropped = pp.finish_tickets(pending, [good[0], wrong_key_sig, "!!!", 42], response_key_id=pp.PINNED_KEY.key_id.upper())
        self.assertEqual((len(tokens), dropped), (1, 3))
        self.assertIsNone(pp.verify_token(pp.b64url_decode(tokens[0])))

    def test_request_count_bounds_and_fresh_randomness(self):
        for bad in (0, 101, 1.5, "3"):
            with self.assertRaises(ValueError):
                pp.create_ticket_requests(bad)
        first = pp.create_ticket_requests(1)
        second = pp.create_ticket_requests(1)
        self.assertNotEqual(first[0], second[0])  # fresh nonce, salt and blinding factor every time

    def test_broken_pin_is_refused(self):
        with self.assertRaises(ValueError):
            pp.load_pinned_key(pp.PinnedKey("00" * 32, pp.PINNED_KEY.modulus_hex))
        with self.assertRaises(ValueError):
            pp.load_pinned_key(pp.PinnedKey(pp.PINNED_KEY.key_id, "ab" * 100))


if __name__ == "__main__":
    unittest.main()

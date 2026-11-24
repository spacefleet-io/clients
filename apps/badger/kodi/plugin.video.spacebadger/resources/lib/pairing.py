# -*- coding: utf-8 -*-
"""Pair this Kodi with the user's phone (ACCT-PAIR-01, PRIV-KEY-05). Contract: /tmp/sf-intg/pairing-contract.md.

Flow: new device makes an X25519 key pair -> POST /pairing/requests (no auth) -> shows QR + short code ->
polls GET /pairing/requests/:id?pollSecret=... -> on `approved` receives {token, sealedKey}; the library key is
unsealed with X25519 + HKDF-SHA256 + AES-256-GCM and MUST verify against the library's keyProbe before it is stored.
Then the profile is picked (INTG-PROF-01, `finish_pairing`): only after that is anything stored.

PRIV-PAIR-01 (sf-pair-v2): the request carries a commitment C = SHA-256("sf-pair-v2|commit" || pk || nR); once the
approving phone connected (the poll carries its nonce nA), this Kodi reveals nR and shows six digits of
SHA-256("sf-pair-v2|check" || pk || C || nA || nR), which the phone shows too. A server swapping keys cannot make both match.

This module is pure logic (no Kodi imports) so the whole protocol is unit-tested against
packages/pairing-crypto/tests/vectors.json and vectors-v2.json.
"""
import base64
import hashlib
import os
import re
import time

import crypto
import profiles
import x25519
from api import ApiError, ApiClient
from compat import log

HKDF_INFO = b"sf-pair-v1"
AAD_PREFIX = b"sf-pair-v1|"
COMMIT_TAG = b"sf-pair-v2|commit"
CHECK_TAG = b"sf-pair-v2|check"
NONCE_BYTES = 32
FINGERPRINT_BYTES = 16  # bytes of C the QR fragment carries (`#c=`), base64url without padding
POLL_SECONDS = 2.0  # pause after a "pending" answer, before the next poll
# The API holds a poll open up to this long (`?wait=`, capped at 25): one poll every ~27 s stays far under its
# 20-per-minute limit per address (OPS-LIMIT-02). The read timeout outlasts the hold.
POLL_WAIT_SECONDS = 25
POLL_HTTP_TIMEOUT = 35
DEVICE_TYPE = "kodi"

_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_CODE_SUBST = {"O": "0", "I": "1", "L": "1"}


class PairingError(Exception):
    """A pairing step failed; the message is plain English and safe to show."""


class PairingExpired(PairingError):
    pass


class PairingDenied(PairingError):
    pass


# ------------------------------------------------------------------ short code helpers (match @space/pairing-crypto)
def normalize_short_code(text):
    if not isinstance(text, str):
        return None
    code = re.sub(r"[\s\-\u2010-\u2015\u2212]+", "", text).upper()
    code = "".join(_CODE_SUBST.get(ch, ch) for ch in code)
    if len(code) != 8 or any(ch not in _CODE_ALPHABET for ch in code):
        return None
    return code


def short_code_groups(text):
    """ACCT-PAIR-01: the code's two groups of 4, shown with a gap between them and never a dash."""
    plain = re.sub(r"[^0-9A-Za-z]+", "", text or "").upper()
    half = (len(plain) + 1) // 2
    return plain[:half], plain[half:]


# ------------------------------------------------------------------ sealed key
def _b64d(text):
    return base64.b64decode(text)


def derive_pair_key(shared, request_id):
    return crypto.hkdf_sha256(shared, request_id.encode("utf-8"), HKDF_INFO, 32)


def open_sealed_key(device_private, request_id, sealed):
    """Unseal the library key (32 bytes). Raises PairingError on any malformed or forged blob."""
    try:
        if int(sealed.get("v", 0)) != 1:
            raise PairingError("This pairing message uses a newer format. Update the Badger add-on and try again.")
        epk, iv, ct = _b64d(sealed["epk"]), _b64d(sealed["iv"]), _b64d(sealed["ct"])
        if len(epk) != 32 or len(iv) != 12:
            raise PairingError("The pairing message is malformed. Try pairing again.")
        key = derive_pair_key(x25519.shared_secret(device_private, epk), request_id)
        plain = crypto.aes_gcm_decrypt(key, iv, ct, AAD_PREFIX + request_id.encode("utf-8"))
    except PairingError:
        raise
    except (KeyError, ValueError, TypeError, AttributeError, crypto.CryptoError, x25519.X25519Error) as exc:
        log("pairing: could not open sealed key: %s" % exc, "error")
        raise PairingError("Could not unlock the media library key sent by your phone. Try pairing again.")
    if len(plain) != 32:
        raise PairingError("The media library key sent by your phone has the wrong size. Try pairing again.")
    return plain


def seal_library_key(device_public, request_id, library_key, ephemeral_private=None, iv=None):
    """Approver side. Only used by tests (and a vector round-trip): the addon never approves pairings."""
    import os
    eph_priv = ephemeral_private or os.urandom(32)
    eph_pub = x25519.public_from_private(eph_priv)
    key = derive_pair_key(x25519.shared_secret(eph_priv, device_public), request_id)
    iv = iv or os.urandom(12)
    ct = crypto.aes_gcm_encrypt(key, iv, library_key, AAD_PREFIX + request_id.encode("utf-8"))
    return {"v": 1, "epk": base64.b64encode(eph_pub).decode("ascii"), "iv": base64.b64encode(iv).decode("ascii"),
            "ct": base64.b64encode(ct).decode("ascii")}


# ------------------------------------------------------------------ key probe (same check as manual key entry)
def verify_key_against_probe(library_key, meta):
    """True when verified, None when the account has no probe yet (nothing to verify against).
    Raises PairingError when the key does not decrypt the probe."""
    probe = (meta or {}).get("keyProbe")
    if not probe:
        return None
    try:
        crypto.envelope_decrypt_b64(library_key, probe)
        return True
    except crypto.CryptoError:
        raise PairingError("The media library key from your phone does not match this account's library. Nothing was saved.")


# ------------------------------------------------------------------ check code (PRIV-PAIR-01, same as @space/pairing-crypto)
def pairing_commitment(public_key, requester_nonce):
    return hashlib.sha256(COMMIT_TAG + public_key + requester_nonce).digest()


def pairing_check_code(public_key, commitment, approver_nonce, requester_nonce):
    """Six digits: the digest's first 4 bytes, big-endian, modulo 1 000 000, zero-padded."""
    digest = hashlib.sha256(CHECK_TAG + public_key + commitment + approver_nonce + requester_nonce).digest()
    return "%06d" % (int.from_bytes(digest[:4], "big") % 1000000)


def format_check_code(code):
    """Shown as "067 383" on both screens."""
    return "%s %s" % (code[:3], code[3:])


def commitment_fingerprint(commitment):
    return base64.urlsafe_b64encode(commitment[:FINGERPRINT_BYTES]).decode("ascii").rstrip("=")


def with_commitment_fingerprint(link, commitment):
    """The QR link with its fragment replaced by `#c=<fingerprint>`. This Kodi adds it: one from the server proves nothing."""
    return "%s#c=%s" % (link.split("#")[0], commitment_fingerprint(commitment))


def _nonce32(text):
    """A 32-byte value sent as standard base64, or None when malformed."""
    if not isinstance(text, str) or not re.match(r"^[A-Za-z0-9+/]{43}=$", text):
        return None
    try:
        value = base64.b64decode(text)
    except (ValueError, TypeError):
        return None
    return value if len(value) == NONCE_BYTES else None


# ------------------------------------------------------------------ session
class PairingSession(object):
    """One pairing attempt. `api` is an unauthenticated ApiClient."""

    def __init__(self, api, device_name, clock=time.time):
        self.api = api
        self.device_name = device_name
        self.clock = clock
        self.private, self.public = x25519.generate_keypair()
        self.requester_nonce = os.urandom(NONCE_BYTES)
        self.commitment = pairing_commitment(self.public, self.requester_nonce)
        self.check_code = None
        # PRIV-PAIR-01: the first approver nonce a poll carried, pinned before the reveal is sent.
        self.approver_nonce = None
        self.request_id = None
        self.poll_secret = None
        self.short_code = None
        self.qr_payload = None
        self.expires_at_epoch = None

    def start(self):
        body = {"deviceType": DEVICE_TYPE, "deviceName": self.device_name[:80],
                "publicKey": base64.b64encode(self.public).decode("ascii"),
                "commitment": base64.b64encode(self.commitment).decode("ascii")}
        res = self.api.request_json("POST", "/pairing/requests", body, expect=(200, 201))
        self.request_id = res["requestId"]
        self.poll_secret = res["pollSecret"]
        self.short_code = normalize_short_code(res["shortCode"]) or res["shortCode"]
        self.qr_payload = with_commitment_fingerprint(res["qrPayload"], self.commitment)
        self.expires_at_epoch = _parse_iso(res.get("expiresAt")) or self.clock() + 300
        log("pairing: request %s created, code %s, expires in %.0fs" % (self.request_id, self.short_code, self.seconds_left()))
        return self

    def seconds_left(self):
        return max(0.0, (self.expires_at_epoch or 0) - self.clock())

    def poll(self):
        """Long-polls the request; returns the status dict (`pending|expired|denied|approved|consumed`). Network
        blips = pending. A pending answer with the phone's nonce makes this Kodi reveal its own once; from then on a
        pending answer carries `checkCode`, the six digits to show."""
        try:
            res = self.api.request_json(
                "GET", "/pairing/requests/%s?pollSecret=%s&wait=%d" % (self.request_id, self.poll_secret, POLL_WAIT_SECONDS),
                expect=(200,), timeout=POLL_HTTP_TIMEOUT)
        except ApiError as exc:
            if exc.status in (404, 410):
                return {"status": "expired"}
            log("pairing: poll failed %s (will retry)" % exc, "warning")
            return {"status": "pending"}
        except Exception as exc:  # noqa: BLE001 - offline blip: keep waiting
            log("pairing: poll error %s (will retry)" % exc, "warning")
            return {"status": "pending"}
        if res.get("status") != "pending":
            return res
        approver_nonce = _nonce32(res.get("approverNonce"))
        if approver_nonce is not None and self.check_code is None:
            if self.approver_nonce is None:
                self.approver_nonce = approver_nonce
            elif approver_nonce != self.approver_nonce:
                log("pairing: approver number changed; ignored, the first one stays", "warning")
            self._reveal()
        return {"status": "pending", "checkCode": self.check_code} if self.check_code else {"status": "pending"}

    def _reveal(self):
        """PRIV-PAIR-01: reveal nR (the API accepts the same one again) and compute the code from the FIRST approver
        nonce, pinned before the reveal is sent. A server that takes the reveal but fails the answer, then shows another
        nonce, would know nR and could grind its new nonce until the code matches one it controls on the phone; a
        retry on the next poll therefore keeps the pinned nonce."""
        try:
            self.api.request_json(
                "POST", "/pairing/requests/%s/reveal" % self.request_id,
                {"pollSecret": self.poll_secret, "requesterNonce": base64.b64encode(self.requester_nonce).decode("ascii")},
                expect=(200, 204))
        except Exception as exc:  # noqa: BLE001 - retried on the next poll
            log("pairing: reveal failed (status %s)" % getattr(exc, "status", None), "warning")
            return
        self.check_code = pairing_check_code(self.public, self.commitment, self.approver_nonce, self.requester_nonce)
        log("pairing: check code ready")

    def complete(self, approved):
        """approved = the poll response with status approved. Returns {token,key,email,clientType,profiles}; verifies
        the keyProbe first. Pairing is not finished yet: `finish_pairing` picks the profile (INTG-PROF-01)."""
        token = approved.get("token")
        if not token or not approved.get("sealedKey"):
            raise PairingError("Pairing finished without a key. Try again.")
        key = open_sealed_key(self.private, self.request_id, approved["sealedKey"])
        authed = ApiClient(self.api.base_url, token)
        meta = authed.library_meta()
        verified = verify_key_against_probe(key, meta)
        log("pairing: approved by phone; key unsealed, keyProbe %s" % ("verified" if verified else "absent (new library)"))
        listed = authed.profiles()
        return {"token": token, "key": key, "email": (approved.get("user") or {}).get("email"),
                "clientType": approved.get("clientType"), "profiles": listed}


def finish_pairing(paired, choose, store, revoke):
    """INTG-PROF-01: pairing finishes only with a profile. One profile -> it, without asking; several -> `choose`.
    Nothing picked -> nothing is stored and the new session is dropped (`revoke`), so this Kodi never holds an
    account without a profile. Returns the profile, or None."""
    try:
        chosen = profiles.pick(paired.get("profiles") or [], choose)
    except profiles.ProfileError:
        revoke(paired)
        raise
    if chosen is None:
        log("pairing: no profile picked; session dropped, nothing stored")
        revoke(paired)
        return None
    store(paired, chosen)
    log("pairing: finished with profile %s" % chosen["id"])
    return chosen


def _parse_iso(text):
    if not text:
        return None
    try:
        from datetime import datetime, timezone
        cleaned = text.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(cleaned) if hasattr(datetime, "fromisoformat") else None
        if parsed is None:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        # Python 3.8/3.9 fromisoformat rejects fractional seconds that are not 3 or 6 digits
        match = re.match(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)", text)
        if not match:
            return None
        import calendar
        return float(calendar.timegm(tuple(int(g) for g in match.groups()) + (0, 0, 0)))

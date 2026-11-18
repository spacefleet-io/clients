# -*- coding: utf-8 -*-
"""Pair this Kodi with the user's phone (ACCT-PAIR-01, PRIV-KEY-05). Contract: /tmp/sf-intg/pairing-contract.md.

Flow: new device makes an X25519 key pair -> POST /pairing/requests (no auth) -> shows QR + short code ->
polls GET /pairing/requests/:id?pollSecret=... -> on `approved` receives {token, sealedKey}; the library key is
unsealed with X25519 + HKDF-SHA256 + AES-256-GCM and MUST verify against the library's keyProbe before it is stored.
Then the profile is picked (INTG-PROF-01, `finish_pairing`): only after that is anything stored.

This module is pure logic (no Kodi imports) so the whole protocol is unit-tested against
packages/pairing-crypto/tests/vectors.json.
"""
import base64
import re
import time

import crypto
import profiles
import x25519
from api import ApiError, ApiClient
from compat import log

HKDF_INFO = b"sf-pair-v1"
AAD_PREFIX = b"sf-pair-v1|"
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
    code = re.sub(r"[\s-]+", "", text).upper()
    code = "".join(_CODE_SUBST.get(ch, ch) for ch in code)
    if len(code) != 8 or any(ch not in _CODE_ALPHABET for ch in code):
        return None
    return code


def format_short_code(text):
    code = normalize_short_code(text)
    return "%s-%s" % (code[:4], code[4:]) if code else None


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
        raise PairingError("Could not unlock the library key sent by your phone. Try pairing again.")
    if len(plain) != 32:
        raise PairingError("The library key sent by your phone has the wrong size. Try pairing again.")
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
        raise PairingError("The library key from your phone does not match this account's library. Nothing was saved.")


# ------------------------------------------------------------------ session
class PairingSession(object):
    """One pairing attempt. `api` is an unauthenticated ApiClient."""

    def __init__(self, api, device_name, clock=time.time):
        self.api = api
        self.device_name = device_name
        self.clock = clock
        self.private, self.public = x25519.generate_keypair()
        self.request_id = None
        self.poll_secret = None
        self.short_code = None
        self.qr_payload = None
        self.expires_at_epoch = None

    def start(self):
        body = {"deviceType": DEVICE_TYPE, "deviceName": self.device_name[:80],
                "publicKey": base64.b64encode(self.public).decode("ascii")}
        res = self.api.request_json("POST", "/pairing/requests", body, expect=(200, 201))
        self.request_id = res["requestId"]
        self.poll_secret = res["pollSecret"]
        self.short_code = format_short_code(res["shortCode"]) or res["shortCode"]
        self.qr_payload = res["qrPayload"]
        self.expires_at_epoch = _parse_iso(res.get("expiresAt")) or self.clock() + 300
        log("pairing: request %s created, code %s, expires in %.0fs" % (self.request_id, self.short_code, self.seconds_left()))
        return self

    def seconds_left(self):
        return max(0.0, (self.expires_at_epoch or 0) - self.clock())

    def poll(self):
        """Long-polls the request; returns the raw status dict (`pending|expired|denied|approved|consumed`). Network
        blips = pending."""
        try:
            return self.api.request_json(
                "GET", "/pairing/requests/%s?pollSecret=%s&wait=%d" % (self.request_id, self.poll_secret, POLL_WAIT_SECONDS),
                expect=(200,), timeout=POLL_HTTP_TIMEOUT)
        except ApiError as exc:
            if exc.status in (404, 410):
                return {"status": "expired"}
            log("pairing: poll failed %s (will retry)" % exc, "warning")
        except Exception as exc:  # noqa: BLE001 - offline blip: keep waiting
            log("pairing: poll error %s (will retry)" % exc, "warning")
        return {"status": "pending"}

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

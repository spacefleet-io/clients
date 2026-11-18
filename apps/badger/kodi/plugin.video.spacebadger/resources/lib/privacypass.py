# -*- coding: utf-8 -*-
"""Privacy Pass token type 0x0002 (RFC 9578): RSA blind signatures, client side, pure Python.

Port of `packages/privacy-pass/src` (rsabssa.ts, token.ts, client.ts), checked against the same vectors
(`packages/privacy-pass/vectors/`, tests/test_privacypass.py). It needs only what Kodi's bundled Python always has:
`hashlib`, big-int `pow(x, y, n)` (modular inverse via `pow(x, -1, n)`, Python 3.8+) and `os.urandom`. No pycryptodome,
no OpenSSL, no network and no logging: nothing here ever writes a token or a nonce anywhere.

Scheme: RFC 9474 RSABSSA-SHA384-PSS-Deterministic (RSA-2048, e = 65537, SHA-384, MGF1-SHA-384, 48-byte salt, no
message randomizer). One ticket is

    token_type(2, 0x0002) || nonce(32) || challenge_digest(32) || token_key_id(32) || authenticator(256)

where the authenticator is the blind signature over the first 98 bytes (META-ANON-03: every ticket carries the one
pinned key's id and must verify against the pinned modulus, or it is dropped).
"""
import base64
import hashlib
import os
import re
from collections import namedtuple

from ticket_pin import DEV_KEY_ID, DEV_MODULUS_HEX, PINNED_KEY_ID, PINNED_MODULUS_HEX

TOKEN_TYPE = 0x0002
EXPONENT = 65537
ISSUER_NAME = "metadata.spacefleet.io"

HASH_LENGTH = 48
SALT_LENGTH = 48
NONCE_LENGTH = 32
KEY_ID_LENGTH = 32
MODULUS_LENGTH = 256
AUTHENTICATOR_LENGTH = 256
INPUT_LENGTH = 2 + NONCE_LENGTH + 32 + KEY_ID_LENGTH  # token_type || nonce || challenge_digest || token_key_id
TOKEN_LENGTH = INPUT_LENGTH + AUTHENTICATOR_LENGTH
MAX_TICKETS_PER_REQUEST = 100

_TOKEN_TYPE_BYTES = TOKEN_TYPE.to_bytes(2, "big")

# TokenChallenge (RFC 9577 section 2.1), the same for everyone: token_type || issuer_name<1..2^16-1> ||
# redemption_context<0..32> (empty) || origin_info<0..2^16-1> (empty).
TOKEN_CHALLENGE = (
    _TOKEN_TYPE_BYTES + len(ISSUER_NAME).to_bytes(2, "big") + ISSUER_NAME.encode("ascii") + b"\x00" + b"\x00\x00"
)
CHALLENGE_DIGEST = hashlib.sha256(TOKEN_CHALLENGE).digest()

PinnedKey = namedtuple("PinnedKey", "key_id modulus_hex")
PRODUCTION_KEY = PinnedKey(PINNED_KEY_ID, PINNED_MODULUS_HEX)
DEV_KEY = PinnedKey(DEV_KEY_ID, DEV_MODULUS_HEX)
# Environment variable of the explicit dev opt-in: exactly "1" on a run against a dev stack (its API signs with the
# committed dev key). Never set by Kodi or the add-on, so an installed add-on pins the production key.
DEV_TICKET_KEY_ENV = "SB_DEV_TICKET_KEY"


def dev_run(environ=None):
    """Whether this run is a dev run: SB_DEV_TICKET_KEY=1, the add-on's one dev switch. It decides both the ticket key
    (META-ANON-06) and whether the account-server setting `api_url` counts (ACCT-AUTH-09). An explicit opt-in, never
    inferred from the API or metadata URL (a home server sits on a LAN host too)."""
    env = os.environ if environ is None else environ
    return (env.get(DEV_TICKET_KEY_ENV) or "").strip() == "1"


def keys_for_run(environ=None):
    """The ticket keys this run trusts (META-ANON-06, META-ANON-07): PRODUCTION_KEY alone, or on a dev run
    (SB_DEV_TICKET_KEY=1) the key of every environment, development first, because its account-server setting
    (ACCT-AUTH-09) can point it at any of them. The reserve blinds for the first key and switches to another one of these
    when the API answers under it; an answer never adds a key."""
    return (DEV_KEY, PRODUCTION_KEY) if dev_run(environ) else (PRODUCTION_KEY,)


PINNED_KEYS = keys_for_run()
# The key a batch is blinded for first, and the default of the single-key helpers below.
PINNED_KEY = PINNED_KEYS[0]


# ------------------------------------------------------------------ encoding helpers
def b64url_encode(data):
    return base64.urlsafe_b64encode(bytes(data)).rstrip(b"=").decode("ascii")


_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]*$")


def b64url_decode(text):
    """Strict unpadded base64url; raises ValueError on anything else."""
    if not isinstance(text, str) or not _B64URL_RE.match(text) or len(text) % 4 == 1:
        raise ValueError("not base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _i2osp(value, length):
    return value.to_bytes(length, "big")


def _os2ip(data):
    return int.from_bytes(data, "big")


# ------------------------------------------------------------------ DER (the RSASSA-PSS SPKI that RFC 9578 section 6.5 hashes)
def _der_length(length):
    if length < 0x80:
        return bytes([length])
    if length < 0x100:
        return bytes([0x81, length])
    return bytes([0x82, length >> 8, length & 0xFF])


def _der(tag, *body):
    content = b"".join(body)
    return bytes([tag]) + _der_length(len(content)) + content


def _der_unsigned_integer(value):
    value = value.lstrip(b"\x00") or b"\x00"
    return _der(0x02, b"\x00" + value if value[0] & 0x80 else value)


_OID_RSASSA_PSS = bytes.fromhex("06092a864886f70d01010a")
_OID_MGF1 = bytes.fromhex("06092a864886f70d010108")
_OID_SHA384 = bytes.fromhex("0609608648016503040202")


def rsa_pss_spki(modulus):
    """DER SubjectPublicKeyInfo of an RSASSA-PSS key (SHA-384, MGF1-SHA-384, saltLength 48, e = 65537), `modulus` big-endian bytes."""
    sha384_id = _der(0x30, _OID_SHA384)
    params = _der(0x30, _der(0xA0, sha384_id), _der(0xA1, _der(0x30, _OID_MGF1, sha384_id)), _der(0xA2, _der(0x02, bytes([48]))))
    rsa_public_key = _der(0x30, _der_unsigned_integer(modulus), _der_unsigned_integer(_i2osp(EXPONENT, 3)))
    return _der(0x30, _der(0x30, _OID_RSASSA_PSS, params), _der(0x03, b"\x00" + rsa_public_key))


def key_id_of_modulus(modulus):
    """token_key_id: SHA-256 of the DER SPKI."""
    return hashlib.sha256(rsa_pss_spki(modulus)).digest()


def load_pinned_key(pinned=PINNED_KEY):
    """(n, key_id_bytes) of the pin; refuses a broken pin (key id not derived from the modulus, or not RSA-2048)."""
    modulus = bytes.fromhex(pinned.modulus_hex)
    if len(modulus) != MODULUS_LENGTH or not modulus[0] & 0x80:
        raise ValueError("pinned ticket key: modulus must be RSA-2048")
    key_id = key_id_of_modulus(modulus)
    if key_id.hex() != pinned.key_id.lower():
        raise ValueError("pinned ticket key: keyId does not match the modulus")
    return _os2ip(modulus), key_id


# ------------------------------------------------------------------ RFC 9474 RSABSSA-SHA384-PSS-Deterministic
def mgf1(seed, length):
    """MGF1 (RFC 8017 appendix B.2.1) with SHA-384."""
    out = b""
    counter = 0
    while len(out) < length:
        out += hashlib.sha384(seed + counter.to_bytes(4, "big")).digest()
        counter += 1
    return out[:length]


def emsa_pss_encode(msg, em_bits, salt):
    """EMSA-PSS-ENCODE (RFC 8017 section 9.1.1) with SHA-384, MGF1-SHA-384 and a 48-byte salt."""
    if len(salt) != SALT_LENGTH:
        raise ValueError("salt must be 48 bytes")
    em_len = (em_bits + 7) // 8
    if em_len < HASH_LENGTH + SALT_LENGTH + 2:
        raise ValueError("encoding error: modulus too small")
    h = hashlib.sha384(b"\x00" * 8 + hashlib.sha384(msg).digest() + salt).digest()
    db = bytearray(em_len - HASH_LENGTH - 1)
    db[len(db) - SALT_LENGTH - 1] = 0x01
    db[len(db) - SALT_LENGTH:] = salt
    mask = mgf1(h, len(db))
    masked = bytearray(a ^ b for a, b in zip(db, mask))
    masked[0] &= 0xFF >> (8 * em_len - em_bits)
    return bytes(masked) + h + b"\xbc"


def emsa_pss_verify(msg, em, em_bits):
    """EMSA-PSS-VERIFY (RFC 8017 section 9.1.2) with SHA-384, MGF1-SHA-384, 48-byte salt."""
    em_len = (em_bits + 7) // 8
    if len(em) != em_len or em_len < HASH_LENGTH + SALT_LENGTH + 2 or em[-1] != 0xBC:
        return False
    db_len = em_len - HASH_LENGTH - 1
    masked, h = em[:db_len], em[db_len:db_len + HASH_LENGTH]
    top_mask = 0xFF >> (8 * em_len - em_bits)
    if masked[0] & ~top_mask & 0xFF:
        return False
    db = bytearray(a ^ b for a, b in zip(masked, mgf1(h, db_len)))
    db[0] &= top_mask
    ps_len = db_len - SALT_LENGTH - 1
    if any(db[:ps_len]) or db[ps_len] != 0x01:
        return False
    expected = hashlib.sha384(b"\x00" * 8 + hashlib.sha384(msg).digest() + bytes(db[ps_len + 1:])).digest()
    return expected == h


def modulus_length(n):
    return (n.bit_length() + 7) // 8


def blind(n, msg, salt=None, inv=None, random_bytes=os.urandom):
    """RFC 9474 section 4.2 Blind. Returns (blinded_msg, inv) as `modulus_length(n)` big-endian bytes each.
    `salt` / `inv` (the blinding inverse r^-1 mod n) are for the published vectors; leave them out in real use."""
    k_len = modulus_length(n)
    em_bits = n.bit_length() - 1
    m = _os2ip(emsa_pss_encode(msg, em_bits, salt if salt is not None else random_bytes(SALT_LENGTH)))
    try:
        pow(m, -1, n)
    except ValueError:
        raise ValueError("invalid input")
    if inv is not None:
        inv_int = _os2ip(inv)
        try:
            r = pow(inv_int, -1, n)
        except ValueError:
            raise ValueError("blinding error")
    else:
        # k_len + 16 random bytes reduced mod n: bias below 2^-128. Redraw on the (negligible) non-invertible draw.
        while True:
            r = _os2ip(random_bytes(k_len + 16)) % n
            try:
                inv_int = pow(r, -1, n) if r else None
            except ValueError:
                inv_int = None
            if inv_int is not None:
                break
    z = (m * pow(r, EXPONENT, n)) % n
    return _i2osp(z, k_len), _i2osp(inv_int, k_len)


def verify(n, msg, sig):
    """RSASSA-PSS-VERIFY (RFC 8017 section 8.1.2) with the RFC 9474 parameters."""
    k_len = modulus_length(n)
    if len(sig) != k_len:
        return False
    s = _os2ip(sig)
    if s >= n:
        return False
    em_bits = n.bit_length() - 1
    em_len = (em_bits + 7) // 8
    m = pow(s, EXPONENT, n)
    if m.bit_length() > 8 * em_len:
        return False
    return emsa_pss_verify(msg, _i2osp(m, em_len), em_bits)


def finalize(n, msg, blind_sig, inv):
    """RFC 9474 section 4.4 Finalize: unblind and verify; raises ValueError when the signature does not verify."""
    k_len = modulus_length(n)
    if len(blind_sig) != k_len:
        raise ValueError("unexpected input size")
    z = _os2ip(blind_sig)
    if z >= n:
        raise ValueError("unexpected input size")
    sig = _i2osp((z * _os2ip(inv)) % n, k_len)
    if not verify(n, msg, sig):
        raise ValueError("invalid signature")
    return sig


# ------------------------------------------------------------------ token codec
def authenticator_input(nonce, key_id):
    """token_type || nonce || challenge_digest || token_key_id: what the blind signature covers."""
    if len(nonce) != NONCE_LENGTH:
        raise ValueError("nonce must be 32 bytes")
    if len(key_id) != KEY_ID_LENGTH:
        raise ValueError("token_key_id must be 32 bytes")
    return _TOKEN_TYPE_BYTES + nonce + CHALLENGE_DIGEST + key_id


def build_token(nonce, key_id, authenticator):
    if len(authenticator) != AUTHENTICATOR_LENGTH:
        raise ValueError("authenticator must be 256 bytes")
    return authenticator_input(nonce, key_id) + authenticator


def token_key_id(token):
    """The token_key_id bytes (66..98) of a 354-byte token, or None for another length."""
    return bytes(token[66:98]) if len(token) == TOKEN_LENGTH else None


def verify_token(token, pinned=PINNED_KEY):
    """Mirrors the server's checks: None when the token is good, else the reason
    (malformed, wrong_type, wrong_challenge, unknown_key, bad_signature)."""
    if len(token) != TOKEN_LENGTH:
        return "malformed"
    if token[:2] != _TOKEN_TYPE_BYTES:
        return "wrong_type"
    if token[34:66] != CHALLENGE_DIGEST:
        return "wrong_challenge"
    n, key_id = load_pinned_key(pinned)
    if token[66:98] != key_id:
        return "unknown_key"
    return None if verify(n, token[:INPUT_LENGTH], token[INPUT_LENGTH:]) else "bad_signature"


def private_token_authorization(token):
    """`PrivateToken token="<base64url token>"` (RFC 9577 section 2.2); `token` is bytes or an already encoded string."""
    return 'PrivateToken token="%s"' % (token if isinstance(token, str) else b64url_encode(token))


# ------------------------------------------------------------------ issuance, client side
def create_ticket_requests(count, pinned=PINNED_KEY, random_bytes=os.urandom):
    """Blind `count` (1..100) fresh token inputs against the pinned key.
    Returns (blinded, pending): base64url blinded messages for POST /metadata/tickets, and the secret per-ticket
    state (nonce, inv; bytes) that finish_tickets needs. Keep `pending` in memory only."""
    if not isinstance(count, int) or count < 1 or count > MAX_TICKETS_PER_REQUEST:
        raise ValueError("count must be an integer from 1 to %d" % MAX_TICKETS_PER_REQUEST)
    n, key_id = load_pinned_key(pinned)
    blinded, pending = [], []
    for _ in range(count):
        nonce = random_bytes(NONCE_LENGTH)
        blinded_msg, inv = blind(n, authenticator_input(nonce, key_id), random_bytes=random_bytes)
        blinded.append(b64url_encode(blinded_msg))
        pending.append((nonce, inv))
    return blinded, pending


def finish_tickets(pending, signed, pinned=PINNED_KEY, response_key_id=None):
    """Unblind `signed[i]` for `pending[i]` and keep it only when it verifies against the pinned key (META-ANON-03).
    A `response_key_id` other than the pinned id drops the whole batch. `signed` is untrusted server data:
    a wrong shape drops entries, never raises. Returns (tokens, dropped); tokens are base64url of the 354-byte token."""
    n, key_id = load_pinned_key(pinned)
    if not isinstance(signed, list):
        return [], len(pending)
    if response_key_id is not None and (not isinstance(response_key_id, str) or response_key_id.lower() != pinned.key_id.lower()):
        return [], len(pending)
    tokens, dropped = [], 0
    for index, (nonce, inv) in enumerate(pending):
        entry = signed[index] if index < len(signed) else None
        try:
            if not isinstance(entry, str):
                raise ValueError("missing signature")
            authenticator = finalize(n, authenticator_input(nonce, key_id), b64url_decode(entry), inv)
            tokens.append(b64url_encode(build_token(nonce, key_id, authenticator)))
        except ValueError:
            dropped += 1
    return tokens, dropped

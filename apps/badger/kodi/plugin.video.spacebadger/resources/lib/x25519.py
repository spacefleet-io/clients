# -*- coding: utf-8 -*-
"""X25519 (RFC 7748) for device pairing (PRIV-KEY-05, packages/pairing-crypto contract).

Order of backends:
1. system libcrypto through ctypes (EVP_PKEY_X25519, OpenSSL >= 1.1.0; same library the AES-GCM backend uses);
2. a pure-Python Montgomery ladder (RFC 7748 section 5). It is only used for the short-lived pairing key pair
   (one scalar multiplication per side per pairing), so speed and constant-time behaviour do not matter, and it
   works on every platform without a compiled library. pycryptodomex is deliberately not used here: its
   X25519 support only exists from 3.18 on and the pure-Python path needs no extra binary at all.

Public API: ``generate_keypair() -> (private32, public32)``, ``public_from_private(priv)``,
``shared_secret(priv, peer_pub)``, ``backend_name()``.
"""
import ctypes
import os

import crypto
from compat import log

_P = 2 ** 255 - 19
_A24 = 121665
_BASE_POINT = (9).to_bytes(32, "little")
_NID_X25519 = 1034


class X25519Error(Exception):
    pass


# --------------------------------------------------------------------------------------------
# pure Python
# --------------------------------------------------------------------------------------------
def _clamp(scalar):
    k = bytearray(scalar)
    k[0] &= 248
    k[31] &= 127
    k[31] |= 64
    return int.from_bytes(bytes(k), "little")


def _ladder(k, u):
    x1 = u
    x2, z2 = 1, 0
    x3, z3 = u, 1
    swap = 0
    for t in reversed(range(255)):
        k_t = (k >> t) & 1
        swap ^= k_t
        if swap:
            x2, x3 = x3, x2
            z2, z3 = z3, z2
        swap = k_t
        a = (x2 + z2) % _P
        aa = a * a % _P
        b = (x2 - z2) % _P
        bb = b * b % _P
        e = (aa - bb) % _P
        c = (x3 + z3) % _P
        d = (x3 - z3) % _P
        da = d * a % _P
        cb = c * b % _P
        x3 = (da + cb) % _P
        x3 = x3 * x3 % _P
        z3 = (da - cb) % _P
        z3 = x1 * z3 * z3 % _P
        x2 = aa * bb % _P
        z2 = e * (aa + _A24 * e) % _P
    if swap:
        x2, x3 = x3, x2
        z2, z3 = z3, z2
    return x2 * pow(z2, _P - 2, _P) % _P


def _py_scalarmult(priv, pub):
    u = int.from_bytes(pub, "little") & ((1 << 255) - 1)
    return _ladder(_clamp(priv), u).to_bytes(32, "little")


# --------------------------------------------------------------------------------------------
# libcrypto
# --------------------------------------------------------------------------------------------
_lib_cache = {"tried": False, "lib": None}


def _libcrypto():
    if _lib_cache["tried"]:
        return _lib_cache["lib"]
    _lib_cache["tried"] = True
    try:
        backend = crypto.backend()
        lib = getattr(backend, "lib", None)
        if lib is None or backend.name != "libcrypto":
            return None
        c = ctypes
        lib.EVP_PKEY_new_raw_private_key.restype = c.c_void_p
        lib.EVP_PKEY_new_raw_private_key.argtypes = [c.c_int, c.c_void_p, c.c_char_p, c.c_size_t]
        lib.EVP_PKEY_new_raw_public_key.restype = c.c_void_p
        lib.EVP_PKEY_new_raw_public_key.argtypes = [c.c_int, c.c_void_p, c.c_char_p, c.c_size_t]
        lib.EVP_PKEY_get_raw_public_key.restype = c.c_int
        lib.EVP_PKEY_get_raw_public_key.argtypes = [c.c_void_p, c.c_char_p, c.POINTER(c.c_size_t)]
        lib.EVP_PKEY_free.argtypes = [c.c_void_p]
        lib.EVP_PKEY_CTX_new.restype = c.c_void_p
        lib.EVP_PKEY_CTX_new.argtypes = [c.c_void_p, c.c_void_p]
        lib.EVP_PKEY_CTX_free.argtypes = [c.c_void_p]
        lib.EVP_PKEY_derive_init.argtypes = [c.c_void_p]
        lib.EVP_PKEY_derive_set_peer.argtypes = [c.c_void_p, c.c_void_p]
        lib.EVP_PKEY_derive.argtypes = [c.c_void_p, c.c_char_p, c.POINTER(c.c_size_t)]
        # self-test against the RFC 7748 section 6.1 vector before trusting it
        a_priv = bytes.fromhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        b_pub = bytes.fromhex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        expect = bytes.fromhex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
        if _lib_scalarmult(lib, a_priv, b_pub) != expect:
            raise X25519Error("libcrypto X25519 self-test failed")
        _lib_cache["lib"] = lib
    except Exception as exc:  # noqa: BLE001 - any missing symbol/old OpenSSL -> pure Python
        log("X25519 via libcrypto unavailable (%s); using the pure-Python implementation" % exc, "info")
        _lib_cache["lib"] = None
    return _lib_cache["lib"]


def _lib_scalarmult(lib, priv, pub):
    sk = lib.EVP_PKEY_new_raw_private_key(_NID_X25519, None, priv, 32)
    pk = lib.EVP_PKEY_new_raw_public_key(_NID_X25519, None, pub, 32)
    ctx = None
    try:
        if not sk or not pk:
            raise X25519Error("EVP_PKEY_new_raw_* failed")
        ctx = lib.EVP_PKEY_CTX_new(sk, None)
        if not ctx or lib.EVP_PKEY_derive_init(ctx) != 1 or lib.EVP_PKEY_derive_set_peer(ctx, pk) != 1:
            raise X25519Error("EVP_PKEY_derive setup failed")
        size = ctypes.c_size_t(32)
        out = ctypes.create_string_buffer(32)
        if lib.EVP_PKEY_derive(ctx, out, ctypes.byref(size)) != 1 or size.value != 32:
            raise X25519Error("EVP_PKEY_derive failed")
        return out.raw
    finally:
        if ctx:
            lib.EVP_PKEY_CTX_free(ctx)
        if sk:
            lib.EVP_PKEY_free(sk)
        if pk:
            lib.EVP_PKEY_free(pk)


def backend_name():
    return "libcrypto" if _libcrypto() is not None else "python"


def _scalarmult(priv, pub):
    if len(priv) != 32 or len(pub) != 32:
        raise X25519Error("X25519 keys must be 32 bytes")
    lib = _libcrypto()
    if lib is not None:
        return _lib_scalarmult(lib, bytes(priv), bytes(pub))
    return _py_scalarmult(bytes(priv), bytes(pub))


def public_from_private(priv):
    return _scalarmult(priv, _BASE_POINT)


def generate_keypair():
    priv = os.urandom(32)
    return priv, public_from_private(priv)


def shared_secret(priv, peer_pub):
    secret = _scalarmult(priv, peer_pub)
    if secret == bytes(32):
        raise X25519Error("X25519 produced an all-zero shared secret (invalid peer key)")
    return secret

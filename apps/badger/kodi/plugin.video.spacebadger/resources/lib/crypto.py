# -*- coding: utf-8 -*-
"""Crypto primitives for the Badger Kodi addon (INTG-KODI-01: pure Python, no bundled program).

AES-256-GCM comes from the system libcrypto through ctypes (OpenSSL 1.1.x and 3.x share the EVP ABI
used here). If no usable libcrypto exists, a vendored ``Cryptodome`` (pycryptodomex) next to this file
is used. HKDF-SHA256 is pure Python (hmac + hashlib).

Formats (see docs: library key protocol):
  * library envelope  : IV(12) | AES-256-GCM ciphertext | tag(16), raw 32-byte key, no AAD
  * SFV1 media object : "SFV1" | salt(16) | nonce(12) | ciphertext | tag(16), AAD "SFV1",
                        key = HKDF(HKDF(libraryKey, "sf-media-master-salt", "sf-media-master"), salt, "sf-media-v1")
                        plaintext = u32LE origLen | u16LE padLen | data[origLen] | pad
"""
import base64
import ctypes
import ctypes.util
import hashlib
import hmac
import os
import re
import struct
import threading

IV_LENGTH = 12
TAG_LENGTH = 16
SFV1_MAGIC = b"SFV1"
SFV1_SALT_BYTES = 16
SFV1_NONCE_BYTES = 12
SFV1_HEADER_BYTES = 6
_MASTER_SALT = b"sf-media-master-salt"
_MASTER_INFO = b"sf-media-master"
_OBJECT_INFO = b"sf-media-v1"

_EVP_CTRL_GCM_SET_IVLEN = 0x9
_EVP_CTRL_GCM_GET_TAG = 0x10
_EVP_CTRL_GCM_SET_TAG = 0x11


class CryptoError(Exception):
    pass


class AuthenticationError(CryptoError):
    """GCM tag mismatch: wrong key or corrupted data."""


# --------------------------------------------------------------------------------------------
# backends
# --------------------------------------------------------------------------------------------
_backend = None
_backend_lock = threading.Lock()
_backend_name = None


def _candidate_libcrypto_names():
    names = []
    found = ctypes.util.find_library("crypto")
    if found:
        names.append(found)
    names += [
        "libcrypto.so.3",
        "libcrypto.so.1.1",
        "libcrypto.so.1.0.0",
        "libcrypto.so",
        "libcrypto.3.dylib",
        "libcrypto.1.1.dylib",
        "libcrypto.dylib",
        "libcrypto-3.dll",
        "libcrypto-3-x64.dll",
        "libcrypto-1_1.dll",
        "libcrypto-1_1-x64.dll",
    ]
    seen = set()
    out = []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _address(buf):
    """Address of a bytes/bytearray buffer, without copying it (the caller keeps `buf` alive across the C call)."""
    if isinstance(buf, bytearray):
        return ctypes.addressof((ctypes.c_char * len(buf)).from_buffer(buf)) if buf else 0
    return ctypes.cast(ctypes.c_char_p(buf), ctypes.c_void_p).value


class _LibcryptoBackend(object):
    name = "libcrypto"

    def __init__(self, lib):
        self.lib = lib
        c = ctypes
        lib.EVP_CIPHER_CTX_new.restype = c.c_void_p
        lib.EVP_CIPHER_CTX_free.argtypes = [c.c_void_p]
        lib.EVP_aes_256_gcm.restype = c.c_void_p
        lib.EVP_CIPHER_CTX_ctrl.argtypes = [c.c_void_p, c.c_int, c.c_int, c.c_void_p]
        lib.EVP_CIPHER_CTX_ctrl.restype = c.c_int
        for fn in (lib.EVP_DecryptInit_ex, lib.EVP_EncryptInit_ex):
            fn.argtypes = [c.c_void_p, c.c_void_p, c.c_void_p, c.c_char_p, c.c_char_p]
            fn.restype = c.c_int
        for fn in (lib.EVP_DecryptUpdate, lib.EVP_EncryptUpdate):
            # The input is a raw pointer so a decrypt reads the ciphertext in place (pointer + offset, no slice copy).
            fn.argtypes = [c.c_void_p, c.c_void_p, c.POINTER(c.c_int), c.c_void_p, c.c_int]
            fn.restype = c.c_int
        for fn in (lib.EVP_DecryptFinal_ex, lib.EVP_EncryptFinal_ex):
            fn.argtypes = [c.c_void_p, c.c_void_p, c.POINTER(c.c_int)]
            fn.restype = c.c_int
        # Self-test with a known vector before accepting this libcrypto.
        key = bytes(range(32))
        iv = bytes(range(12))
        ct = self.encrypt(key, iv, b"hello", b"aad")
        if self.decrypt(key, iv, ct, b"aad") != b"hello":
            raise CryptoError("libcrypto self-test failed")

    def _ctx(self, enc, key, iv):
        lib = self.lib
        ctx = lib.EVP_CIPHER_CTX_new()
        if not ctx:
            raise CryptoError("EVP_CIPHER_CTX_new failed")
        init = lib.EVP_EncryptInit_ex if enc else lib.EVP_DecryptInit_ex
        try:
            if init(ctx, lib.EVP_aes_256_gcm(), None, None, None) != 1:
                raise CryptoError("cipher init failed")
            if lib.EVP_CIPHER_CTX_ctrl(ctx, _EVP_CTRL_GCM_SET_IVLEN, len(iv), None) != 1:
                raise CryptoError("set ivlen failed")
            if init(ctx, None, None, key, iv) != 1:
                raise CryptoError("key/iv init failed")
        except Exception:
            lib.EVP_CIPHER_CTX_free(ctx)
            raise
        return ctx

    def decrypt_view(self, key, iv, data, aad=b"", offset=0):
        """Decrypts data[offset:] (ciphertext | tag) without copying it. Returns a memoryview of a fresh bytearray,
        only after the GCM tag verified."""
        if not isinstance(data, (bytes, bytearray)):
            data = bytes(data)
        end = len(data)
        if end - offset < TAG_LENGTH:
            raise CryptoError("ciphertext too short")
        lib = self.lib
        ct_len = end - offset - TAG_LENGTH
        tag = bytes(data[end - TAG_LENGTH:])
        ctx = self._ctx(False, key, iv)
        try:
            outl = ctypes.c_int(0)
            if aad:
                if lib.EVP_DecryptUpdate(ctx, None, ctypes.byref(outl), aad, len(aad)) != 1:
                    raise CryptoError("aad update failed")
            out = bytearray(ct_len + 16)
            written = 0
            if ct_len:
                out_ptr = (ctypes.c_char * len(out)).from_buffer(out)
                # data still holds the tag past ct_len: pass an explicit length.
                if lib.EVP_DecryptUpdate(ctx, out_ptr, ctypes.byref(outl), _address(data) + offset, ct_len) != 1:
                    raise CryptoError("decrypt update failed")
                del out_ptr
                written = outl.value
            if lib.EVP_CIPHER_CTX_ctrl(ctx, _EVP_CTRL_GCM_SET_TAG, TAG_LENGTH, ctypes.c_char_p(tag)) != 1:
                raise CryptoError("set tag failed")
            tail = ctypes.create_string_buffer(32)
            if lib.EVP_DecryptFinal_ex(ctx, tail, ctypes.byref(outl)) != 1:
                raise AuthenticationError("AES-GCM authentication failed")
            return memoryview(out)[:written]
        finally:
            lib.EVP_CIPHER_CTX_free(ctx)

    def decrypt(self, key, iv, ciphertext_and_tag, aad=b""):
        return bytes(self.decrypt_view(key, iv, ciphertext_and_tag, aad))

    def encrypt(self, key, iv, plaintext, aad=b""):
        lib = self.lib
        ctx = self._ctx(True, key, iv)
        try:
            outl = ctypes.c_int(0)
            if aad:
                if lib.EVP_EncryptUpdate(ctx, None, ctypes.byref(outl), aad, len(aad)) != 1:
                    raise CryptoError("aad update failed")
            out = ctypes.create_string_buffer(len(plaintext) + 32)
            written = 0
            if plaintext:
                if lib.EVP_EncryptUpdate(ctx, out, ctypes.byref(outl), plaintext, len(plaintext)) != 1:
                    raise CryptoError("encrypt update failed")
                written = outl.value
            tail = ctypes.create_string_buffer(32)
            if lib.EVP_EncryptFinal_ex(ctx, tail, ctypes.byref(outl)) != 1:
                raise CryptoError("encrypt final failed")
            tag = ctypes.create_string_buffer(TAG_LENGTH)
            if lib.EVP_CIPHER_CTX_ctrl(ctx, _EVP_CTRL_GCM_GET_TAG, TAG_LENGTH, tag) != 1:
                raise CryptoError("get tag failed")
            return ctypes.string_at(out, written) + tag.raw
        finally:
            lib.EVP_CIPHER_CTX_free(ctx)


class _CryptodomeBackend(object):
    name = "Cryptodome"

    def __init__(self, module):
        self.AES = module

    def decrypt_view(self, key, iv, data, aad=b"", offset=0):
        """Same contract as the libcrypto backend: decrypts into a fresh bytearray, returned as a memoryview only after
        decrypt_and_verify checked the tag (a failed check raises; the half-filled buffer is dropped)."""
        view = memoryview(data)
        if len(view) - offset < TAG_LENGTH:
            raise CryptoError("ciphertext too short")
        out = bytearray(len(view) - offset - TAG_LENGTH)
        cipher = self.AES.new(key, self.AES.MODE_GCM, nonce=iv)
        if aad:
            cipher.update(aad)
        try:
            cipher.decrypt_and_verify(view[offset:len(view) - TAG_LENGTH], view[len(view) - TAG_LENGTH:], output=out)
        except ValueError as exc:
            raise AuthenticationError("AES-GCM authentication failed") from exc
        return memoryview(out)

    def decrypt(self, key, iv, ciphertext_and_tag, aad=b""):
        view = memoryview(ciphertext_and_tag)
        if len(view) < TAG_LENGTH:
            raise CryptoError("ciphertext too short")
        cipher = self.AES.new(key, self.AES.MODE_GCM, nonce=iv)
        if aad:
            cipher.update(aad)
        try:
            return cipher.decrypt_and_verify(view[:-TAG_LENGTH], view[-TAG_LENGTH:])
        except ValueError as exc:
            raise AuthenticationError("AES-GCM authentication failed") from exc

    def encrypt(self, key, iv, plaintext, aad=b""):
        cipher = self.AES.new(key, self.AES.MODE_GCM, nonce=iv)
        if aad:
            cipher.update(aad)
        ct, tag = cipher.encrypt_and_digest(plaintext)
        return ct + tag


def _load_backend():
    """Order: system libcrypto (ctypes), then Cryptodome (system install, else the vendored per-CPU copy).

    SB_FORCE_CRYPTODOME=1 or the file <addon_data>/force_cryptodome skips libcrypto (testing the fallback)."""
    import vendor_loader
    errors = []
    if vendor_loader.force_requested():
        vendor_loader.log("crypto: fallback forced (SB_FORCE_CRYPTODOME / force_cryptodome), skipping libcrypto")
        errors.append("libcrypto: skipped (forced Cryptodome)")
    else:
        for name in _candidate_libcrypto_names():
            try:
                backend_ = _LibcryptoBackend(ctypes.CDLL(name))
                vendor_loader.log("crypto: using system libcrypto %s" % name)
                return backend_
            except Exception as exc:  # noqa: BLE001 - any loader/ABI failure just means "try next"
                errors.append("%s: %s" % (name, exc))
    status = vendor_loader.prepare()
    try:
        from Cryptodome.Cipher import AES
        vendor_loader.log("crypto: using Cryptodome (%s: %s)" % (status["source"], status["dir"]))
        return _CryptodomeBackend(AES)
    except Exception as exc:  # noqa: BLE001
        errors.append("Cryptodome: %s (%s)" % (exc, status.get("error")))
    raise CryptoError("no AES-GCM backend available (%s)" % "; ".join(errors))


def backend():
    global _backend, _backend_name
    if _backend is None:
        with _backend_lock:
            if _backend is None:
                _backend = _load_backend()
                _backend_name = _backend.name
    return _backend


def backend_name():
    return backend().name


def aes_gcm_decrypt_view(key, iv, data, aad=b"", offset=0):
    """Decrypts data[offset:] (ciphertext | tag) in place: a memoryview of the plaintext, returned only after the tag
    verified. For hot paths (media segments); aes_gcm_decrypt returns bytes for everything else."""
    return backend().decrypt_view(key, iv, data, aad, offset)


def aes_gcm_decrypt(key, iv, ciphertext_and_tag, aad=b""):
    return backend().decrypt(key, iv, ciphertext_and_tag, aad)


def aes_gcm_encrypt(key, iv, plaintext, aad=b""):
    return backend().encrypt(key, iv, plaintext, aad)


# --------------------------------------------------------------------------------------------
# HKDF-SHA256 (RFC 5869)
# --------------------------------------------------------------------------------------------
def hkdf_sha256(ikm, salt, info, length=32):
    if not salt:
        salt = b"\x00" * 32
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm = b""
    block = b""
    counter = 1
    while len(okm) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]


# --------------------------------------------------------------------------------------------
# library key + envelope
# --------------------------------------------------------------------------------------------
def parse_library_key(text):
    """Accepts the key as shown to the user (base64, optional whitespace/groups of 4). Returns 32 bytes."""
    normalized = re.sub(r"\s+", "", text or "")
    if not normalized:
        raise CryptoError("INVALID_KEY")
    try:
        raw = base64.b64decode(normalized + "=" * (-len(normalized) % 4))
    except Exception as exc:  # noqa: BLE001
        raise CryptoError("INVALID_KEY") from exc
    if len(raw) != 32:
        raise CryptoError("INVALID_KEY")
    return raw


def envelope_decrypt(key, payload):
    payload = bytes(payload)
    if len(payload) <= IV_LENGTH + TAG_LENGTH:
        raise CryptoError("INVALID_BLOB")
    return aes_gcm_decrypt(key, payload[:IV_LENGTH], payload[IV_LENGTH:])


def envelope_decrypt_view(key, payload):
    """envelope_decrypt for large payloads (the library snapshot): decrypts payload[IV_LENGTH:] in place, without the
    bytes() and slice copies, and returns a memoryview of the plaintext (only after the tag verified)."""
    if len(payload) <= IV_LENGTH + TAG_LENGTH:
        raise CryptoError("INVALID_BLOB")
    return aes_gcm_decrypt_view(key, bytes(payload[:IV_LENGTH]), payload, b"", IV_LENGTH)


def envelope_encrypt(key, plaintext):
    iv = os.urandom(IV_LENGTH)
    return iv + aes_gcm_encrypt(key, iv, bytes(plaintext))


def envelope_decrypt_b64(key, text):
    return envelope_decrypt(key, base64.b64decode(re.sub(r"\s+", "", text)))


def envelope_encrypt_b64(key, plaintext):
    return base64.b64encode(envelope_encrypt(key, plaintext)).decode("ascii")


# --------------------------------------------------------------------------------------------
# SFV1 media objects
# --------------------------------------------------------------------------------------------
def derive_media_master_key(library_key):
    return hkdf_sha256(library_key, _MASTER_SALT, _MASTER_INFO, 32)


def derive_object_key(master_key, salt):
    return hkdf_sha256(master_key, salt, _OBJECT_INFO, 32)


def is_sfv1(payload):
    return len(payload) >= len(SFV1_MAGIC) and bytes(payload[:4]) == SFV1_MAGIC


def sfv1_decrypt(master_key, payload):
    """Returns (plaintext, was_encrypted). Objects without the SFV1 magic pass through (like desktop).

    The plaintext of an SFV1 object is a memoryview into the one buffer the cipher wrote (no slice copies of the
    ciphertext or the plaintext); it exists only once the GCM tag verified."""
    if not is_sfv1(payload):
        return bytes(payload), False
    min_len = 4 + SFV1_SALT_BYTES + SFV1_NONCE_BYTES + TAG_LENGTH
    if len(payload) < min_len:
        raise CryptoError("SFV1 object too short")
    salt = bytes(payload[4:4 + SFV1_SALT_BYTES])
    nonce = bytes(payload[4 + SFV1_SALT_BYTES:4 + SFV1_SALT_BYTES + SFV1_NONCE_BYTES])
    obj_key = derive_object_key(master_key, salt)
    framed = aes_gcm_decrypt_view(obj_key, nonce, payload, SFV1_MAGIC, 4 + SFV1_SALT_BYTES + SFV1_NONCE_BYTES)
    if len(framed) < SFV1_HEADER_BYTES:
        raise CryptoError("SFV1 plaintext too short")
    orig_len, pad_len = struct.unpack_from("<IH", framed)
    if SFV1_HEADER_BYTES + orig_len + pad_len > len(framed):
        raise CryptoError("SFV1 length header exceeds plaintext")
    return framed[SFV1_HEADER_BYTES:SFV1_HEADER_BYTES + orig_len], True


def sfv1_encrypt(master_key, plaintext, salt=None, nonce=None, pad=b""):
    """Used by tests (vector round trips) only; the addon never uploads media."""
    salt = salt if salt is not None else os.urandom(SFV1_SALT_BYTES)
    nonce = nonce if nonce is not None else os.urandom(SFV1_NONCE_BYTES)
    framed = struct.pack("<IH", len(plaintext), len(pad)) + bytes(plaintext) + bytes(pad)
    obj_key = derive_object_key(master_key, salt)
    return SFV1_MAGIC + salt + nonce + aes_gcm_encrypt(obj_key, nonce, framed, SFV1_MAGIC)

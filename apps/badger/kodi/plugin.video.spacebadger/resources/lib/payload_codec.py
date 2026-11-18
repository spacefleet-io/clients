# -*- coding: utf-8 -*-
"""Compression frame for library payloads (storage format v2, LIB-FMT-07).

Mirrors packages/library-db-definition/src/payloadCompression.ts. Snapshots and op payloads are compressed
BEFORE AES-GCM encryption, so the frame lives inside the decrypted plaintext:

    offset 0  0x00   sentinel
    offset 1  0x5A   marker ("Z")
    offset 2  codec  1 = raw DEFLATE (RFC 1951, no zlib/gzip wrapper)
    offset 3  ...    compressed bytes

A v1 plaintext (SQLite file starts with 'S', op JSON with '{') never starts with 0x00, so ``decode_payload``
accepts both formats. Kodi only writes ops (never snapshots), so only ``encode_op_payload`` exists on the
write side.
"""
import zlib

FRAME_SENTINEL = 0x00
FRAME_MARKER = 0x5A
FRAME_HEADER = b"\x00\x5a"
FRAME_HEADER_SIZE = 3
CODEC_DEFLATE_RAW = 1
COMPRESSION_LEVEL = 6


class PayloadCodecError(Exception):
    """A compressed frame uses an unknown codec or its stream is corrupt."""


def is_compressed_frame(data):
    return len(data) >= FRAME_HEADER_SIZE and data[0] == FRAME_SENTINEL and data[1] == FRAME_MARKER


# Inflate input step: zlib.decompress grows its output by doubling (up to ~2x the file at its peak); feeding the frame
# in small steps appends each inflated piece to one buffer that grows by ~1/8 instead.
INFLATE_STEP = 64 * 1024


def decode_payload(plaintext):
    """Plain bytes (bytes-like) of a decrypted payload: inflates a v2 frame, returns a v1 payload unchanged (the same
    object, so a snapshot plaintext handed in as a memoryview is never copied). The frame is read in place."""
    if not is_compressed_frame(plaintext):
        return plaintext
    codec = plaintext[2]
    if codec != CODEC_DEFLATE_RAW:
        raise PayloadCodecError("unknown_compression_codec:%d" % codec)
    view = memoryview(plaintext)
    inflater = zlib.decompressobj(-15)
    out = bytearray()
    try:
        for i in range(FRAME_HEADER_SIZE, len(view), INFLATE_STEP):
            out += inflater.decompress(view[i:i + INFLATE_STEP])
        out += inflater.flush()
    except zlib.error as exc:
        raise PayloadCodecError("corrupt_compressed_frame") from exc
    if not inflater.eof:
        raise PayloadCodecError("corrupt_compressed_frame")
    return out


def encode_compressed_frame(plain):
    """Wrap ``plain`` in a compressed frame (always compresses)."""
    comp = zlib.compressobj(COMPRESSION_LEVEL, zlib.DEFLATED, -15)
    deflated = comp.compress(bytes(plain)) + comp.flush()
    return FRAME_HEADER + bytes((CODEC_DEFLATE_RAW,)) + deflated


def encode_op_payload(op_json_bytes):
    """Frame an op payload; every change is compressed, small ones too (LIB-FMT-07)."""
    return encode_compressed_frame(op_json_bytes)

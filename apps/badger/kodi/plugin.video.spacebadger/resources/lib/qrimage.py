# -*- coding: utf-8 -*-
"""Render a QR code to a PNG file for the pairing dialog (ACCT-PAIR-01).

Encoding is done by the vendored `qrcodegen.py` (Project Nayuki, MIT licence, GPL-3.0 compatible; header kept intact).
The PNG is written by hand (zlib + struct): 1-bit-looking greyscale, black modules on a white quiet zone, no Pillow.
"""
import struct
import zlib

import qrcodegen


def qr_matrix(text, ecl="MEDIUM"):
    """List of rows of booleans (True = dark module), without the quiet zone."""
    level = getattr(qrcodegen.QrCode.Ecc, ecl)
    qr = qrcodegen.QrCode.encode_text(text, level)
    size = qr.get_size()
    return [[qr.get_module(x, y) for x in range(size)] for y in range(size)]


def png_bytes(matrix, scale=8, border=4):
    n = len(matrix)
    side = (n + 2 * border) * scale
    white, black = b"\xff", b"\x00"
    quiet_row = b"\x00" + white * side  # filter byte 0 + pixels
    rows = []
    for _ in range(border * scale):
        rows.append(quiet_row)
    for line in matrix:
        pixels = white * (border * scale)
        for dark in line:
            pixels += (black if dark else white) * scale
        pixels += white * (border * scale)
        row = b"\x00" + pixels
        rows.extend([row] * scale)
    for _ in range(border * scale):
        rows.append(quiet_row)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", side, side, 8, 0, 0, 0, 0)  # 8-bit greyscale
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


def write_qr_png(path, text, scale=8, border=4):
    data = png_bytes(qr_matrix(text), scale, border)
    with open(path, "wb") as fh:
        fh.write(data)
    return path

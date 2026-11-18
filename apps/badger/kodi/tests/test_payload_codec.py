"""Compressed library payload frame (storage format v2), decoded/encoded on the Kodi side.

The frame vectors below were produced by the TypeScript implementation
(packages/library-db-runtime/src/payloadCodec.ts: encodeCompressedFrame with node:zlib
deflateRawSync level 6) and are decoded here by Python's zlib.

LIB-FMT-07 (Kodi side; badger-kodi is not an app of that rule): snapshots and op payloads are compressed before encryption; readers accept v1 and v2 plaintext
"""
import json
import os
import sys
import unittest
import zlib

import _path  # noqa: F401
import crypto
import payload_codec

# encodeOpPayloadBytes(JSON of OP_OBJ) from the TS definition package
TS_OP_FRAME_HEX = (
    "005a01edd2310ec2301044d1bb4ced8d366b43e18e3b50d1597885a24460910d8a15e5ee084441474399a75f4f350bba8c88f6834444c87bef29841068f"
    "7050e568b226254b3ee7a694635389cef9a4cf3c110212c7be296b83d32c7770d339fe050521d6e29232ee8b522a287c3230dd36b71de6ce6ff83c354f2e"
    "f7baeeb13"
)
# encodeCompressedFrame(b"SQLite format 3\0" + b"row-" * 300) from the TS definition package
TS_SNAPSHOT_FRAME_HEX = "005a010b0ef4c92c495548cb2fca4d2c51306628ca2fd71dc5a361309a0646d340d110080300"
# the same payload framed with node:zlib deflateRawSync(level 6) (different zlib build, different bytes)
NODE_SNAPSHOT_FRAME_HEX = "005a010b0ef4c92c495548cb2fca4d2c51306628ca2fd71dc5a378148fe2a18001"
OP_OBJ = {
    "id": "11111111-2222-3333-4444-555555555555",
    "type": "setting.set",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "payload": {"key": "k", "value": "x" * 600, "updatedAt": "2026-01-01T00:00:00.000Z"},
}
SNAPSHOT_PLAIN = b"SQLite format 3\x00" + b"row-" * 300


def log(test_id, msg):
    sys.stderr.write("[%s] %s\n" % (test_id, msg))


def op_bytes(obj=OP_OBJ):
    return json.dumps(obj, separators=(",", ":")).encode("utf-8")


class PayloadCodec(unittest.TestCase):
    def test_v1_plaintext_passes_through(self):
        tid = "LIB-FMT-07/v1-passthrough"
        log(tid, "phase:setup v1 snapshot header + op JSON")
        for plain in (b"SQLite format 3\x00" + b"\x01" * 100, op_bytes(), b"{}", b"", b"\x00", b"\x00Z"):
            log(tid, "phase:decode len=%d head=%r" % (len(plain), plain[:4]))
            self.assertEqual(payload_codec.decode_payload(plain), plain)
        log(tid, "phase:done")

    def test_v2_frame_round_trips(self):
        tid = "LIB-FMT-07/v2-roundtrip"
        plain = op_bytes()
        log(tid, "phase:encode op len=%d" % len(plain))
        framed = payload_codec.encode_op_payload(plain)
        log(tid, "phase:encoded framed_len=%d header=%s" % (len(framed), framed[:3].hex()))
        self.assertEqual(framed[:3], b"\x00\x5a\x01")
        self.assertLess(len(framed), len(plain))
        self.assertEqual(payload_codec.decode_payload(framed), plain)
        snap = payload_codec.encode_compressed_frame(SNAPSHOT_PLAIN)
        log(tid, "phase:snapshot framed_len=%d plain_len=%d" % (len(snap), len(SNAPSHOT_PLAIN)))
        self.assertEqual(payload_codec.decode_payload(snap), SNAPSHOT_PLAIN)
        log(tid, "phase:done")

    def test_decodes_frames_produced_by_ts(self):
        tid = "LIB-FMT-07/ts-vector"
        op_frame = bytes.fromhex(TS_OP_FRAME_HEX)
        log(tid, "phase:decode ts op frame len=%d" % len(op_frame))
        self.assertEqual(json.loads(payload_codec.decode_payload(op_frame).decode("utf-8")), OP_OBJ)
        snap_frame = bytes.fromhex(TS_SNAPSHOT_FRAME_HEX)
        log(tid, "phase:decode ts snapshot frame len=%d" % len(snap_frame))
        self.assertEqual(payload_codec.decode_payload(snap_frame), SNAPSHOT_PLAIN)
        log(tid, "phase:done")

    def test_python_frame_is_raw_deflate_level_6(self):
        tid = "LIB-FMT-07/raw-deflate"
        framed = payload_codec.encode_compressed_frame(SNAPSHOT_PLAIN)
        comp = zlib.compressobj(6, zlib.DEFLATED, -15)
        expected = comp.compress(SNAPSHOT_PLAIN) + comp.flush()
        log(tid, "phase:compare body_len=%d" % len(framed[3:]))
        self.assertEqual(framed[3:], expected)
        # deflate streams are not canonical across zlib builds: only the decoded bytes must agree
        self.assertEqual(payload_codec.decode_payload(bytes.fromhex(NODE_SNAPSHOT_FRAME_HEX)), SNAPSHOT_PLAIN)
        log(tid, "phase:done")

    def test_unknown_codec_and_corrupt_stream_raise(self):
        tid = "LIB-FMT-07/errors"
        log(tid, "phase:unknown codec 2")
        with self.assertRaises(payload_codec.PayloadCodecError) as ctx:
            payload_codec.decode_payload(b"\x00\x5a\x02" + b"anything")
        self.assertIn("unknown_compression_codec:2", str(ctx.exception))
        log(tid, "phase:corrupt stream")
        with self.assertRaises(payload_codec.PayloadCodecError) as ctx:
            payload_codec.decode_payload(b"\x00\x5a\x01" + b"\xff" * 20)
        self.assertIn("corrupt_compressed_frame", str(ctx.exception))
        log(tid, "phase:done")

    def test_every_op_is_framed_small_ones_too(self):
        tid = "LIB-FMT-07/small-framed"
        small = op_bytes({"id": "a", "type": "progress.set", "payload": {"p": 1}})
        framed = payload_codec.encode_op_payload(small)
        log(tid, "phase:small len=%d framed_len=%d" % (len(small), len(framed)))
        self.assertEqual(framed[:3], b"\x00\x5a\x01")
        self.assertEqual(payload_codec.decode_payload(framed), small)
        noise = os.urandom(600)
        framed_noise = payload_codec.encode_op_payload(noise)
        log(tid, "phase:incompressible len=%d framed_len=%d" % (len(noise), len(framed_noise)))
        self.assertEqual(framed_noise[:3], b"\x00\x5a\x01")
        self.assertEqual(payload_codec.decode_payload(framed_noise), noise)
        log(tid, "phase:done")

    def test_framed_op_survives_encryption_round_trip(self):
        tid = "LIB-FMT-07/encrypted-roundtrip"
        key = crypto.parse_library_key("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
        framed = payload_codec.encode_op_payload(op_bytes())
        blob = crypto.envelope_encrypt(key, framed)
        log(tid, "phase:encrypted len=%d" % len(blob))
        got = payload_codec.decode_payload(crypto.envelope_decrypt(key, blob))
        self.assertEqual(json.loads(got.decode("utf-8")), OP_OBJ)
        log(tid, "phase:done")


if __name__ == "__main__":
    unittest.main()

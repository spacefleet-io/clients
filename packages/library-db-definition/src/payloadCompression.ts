/**
 * Compression frame for library payloads (storage format v2, LIB-FMT-07).
 *
 * Every saved copy of the library and every library change is compressed
 * BEFORE it is encrypted: ciphertext is incompressible, so the only place the
 * bytes can shrink is inside the AES-GCM plaintext. The frame therefore lives
 * inside the encryption envelope and the server never sees it.
 *
 *   Offset Size Field
 *   0      1    0x00        sentinel
 *   1      1    0x5A "Z"    marker
 *   2      1    codec       1 = raw DEFLATE (RFC 1951)
 *   3      …    compressed bytes
 *
 * Why this is collision-free against every v1 plaintext: a v1 snapshot starts
 * with the SQLite header `SQLite format 3\0` (first byte 0x53) and a v1 op
 * payload is the UTF-8 JSON of a `LibraryOp` (first byte `{` 0x7B). Neither
 * can start with 0x00, so `isCompressedFrame(bytes)` is an exact "v2 or v1"
 * discriminator, with no dependence on any version number being right. A
 * reader decrypts, calls `decodeCompressedFrame`, and gets the plain bytes for
 * both formats.
 *
 * Codec: raw DEFLATE, level 6. zstd was measured (3.9 MB playback database:
 * zstd-3 1.25 MB, deflate-6 1.34 MB, so deflate keeps about 93% of the
 * gain) but zstd cannot be read by the Kodi add-on (its Python has no zstd
 * before 3.14 and no vendorable wheel for Android / CoreELEC) and needs new
 * native libraries on iOS and Android. Raw deflate is in the standard library
 * of every client: `node:zlib` (desktop), `zlib` (Kodi), `java.util.zip`
 * (Android), the Compression framework (iOS), `fflate` (JS on React Native).
 * The `codec` byte leaves room for another codec later without a new frame.
 *
 * This module is platform-neutral on purpose (it runs in Hermes): the actual
 * deflate implementation is injected as a `DeflateCodec`.
 */

/** Marker bytes opening a compressed frame. */
export const COMPRESSED_FRAME_SENTINEL = 0x00;
export const COMPRESSED_FRAME_MARKER = 0x5a;

/** Frame header length: sentinel, marker, codec. */
export const COMPRESSED_FRAME_HEADER_SIZE = 3;

/** `codec` byte values. */
export const COMPRESSION_CODEC = Object.freeze({
  deflateRaw: 1,
});

/** Deflate level every writer uses (zlib level 6 is the speed/size knee). */
export const COMPRESSION_LEVEL = 6;

/** Raw DEFLATE (RFC 1951, no zlib/gzip wrapper) provided by the platform. */
export type DeflateCodec = {
  /** Compress at `COMPRESSION_LEVEL`. */
  deflateRaw(bytes: Uint8Array): Uint8Array;
  inflateRaw(bytes: Uint8Array): Uint8Array;
};

export class CompressedFrameError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "CompressedFrameError";
  }
}

/** True when `bytes` opens with the compressed-frame header (a v2 payload). */
export const isCompressedFrame = (bytes: Uint8Array): boolean =>
  bytes.length >= COMPRESSED_FRAME_HEADER_SIZE &&
  bytes[0] === COMPRESSED_FRAME_SENTINEL &&
  bytes[1] === COMPRESSED_FRAME_MARKER;

/** Wrap `plain` in a compressed frame (always compresses). */
export const encodeCompressedFrame = (plain: Uint8Array, codec: DeflateCodec): Uint8Array => {
  const deflated = codec.deflateRaw(plain);
  const framed = new Uint8Array(COMPRESSED_FRAME_HEADER_SIZE + deflated.length);
  framed[0] = COMPRESSED_FRAME_SENTINEL;
  framed[1] = COMPRESSED_FRAME_MARKER;
  framed[2] = COMPRESSION_CODEC.deflateRaw;
  framed.set(deflated, COMPRESSED_FRAME_HEADER_SIZE);
  return framed;
};

/**
 * Plain bytes of a stored payload: inflates a compressed frame, and returns a
 * v1 (never compressed) payload untouched. Throws `CompressedFrameError` for a
 * frame whose codec this build does not know or whose stream is corrupt.
 */
export const decodeCompressedFrame = (bytes: Uint8Array, codec: DeflateCodec): Uint8Array => {
  if (!isCompressedFrame(bytes)) return bytes;
  const codecId = bytes[2];
  if (codecId !== COMPRESSION_CODEC.deflateRaw) {
    throw new CompressedFrameError(`unknown_compression_codec:${codecId}`);
  }
  try {
    return codec.inflateRaw(bytes.subarray(COMPRESSED_FRAME_HEADER_SIZE));
  } catch {
    throw new CompressedFrameError("corrupt_compressed_frame");
  }
};

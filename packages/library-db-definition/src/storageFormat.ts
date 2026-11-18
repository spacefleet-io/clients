/**
 * Self-describing 8-byte header prefixed to stored library **manifest** objects.
 *
 * Surface #3 of the library DB (the remote storage/wire format at rest) had no
 * version discriminator at all — `manifest.schemaVersion: 1` was a hardcoded
 * literal, never read back. This module gives stored manifests a fixed binary
 * header so a reader can deterministically tell which format it is looking at
 * and refuse a format newer than the build supports.
 *
 *   Offset Size Field
 *   0      1    0x00            sentinel — NOT a valid base64 char
 *   1      3    "SBL"           magic (0x53 0x42 0x4C)
 *   4      1    objectKind      1 = manifest (2/3 reserved for chunk/op-payload)
 *   5      2    storageFormatVersion  uint16 big-endian, starts at 1
 *   7      1    flags           reserved, 0
 *                               ← then the existing IV(12) ‖ ciphertext ‖ GCM-tag(16) envelope
 *
 * Why the `0x00` first byte matters: a legacy base64-*text* manifest always
 * starts with a printable base64 character (>= 0x2B `+`), so a `0x00` first
 * byte followed by the `SBL` magic is a **collision-free** v0-vs-v1 test — not
 * a heuristic. `decodeStorageHeader` returning `null` IS the "legacy v0 object"
 * signal: callers route a `null` result to their v0 decode path.
 *
 * Chunks are deliberately NOT headered — they are content-addressed by
 * `sha256` and must never be reframed. Op payloads are versioned through the
 * wire contract (`opStreamVersion`), not a per-object header.
 *
 * Crypto boundary: the 8-byte header sits entirely OUTSIDE the AES-GCM
 * envelope. It is plaintext framing — not encrypted, not part of the GCM
 * additional-authenticated-data, and never fed to the cipher, the key, or the
 * IV. The writer prepends it after encryption; the reader strips it before
 * decryption. So the header's fields are inert at decrypt time: tampering with
 * them cannot affect the nonce, the key, or GCM tag verification — a corrupted
 * header at worst routes to the wrong decode branch (v0 vs v1) or trips the
 * version gate, never a silent plaintext change. Encrypt/decrypt behaviour is
 * byte-identical to the pre-header envelope.
 */

/** Length of the fixed binary header, in bytes. */
export const STORAGE_HEADER_SIZE = 8;

/**
 * Sentinel first byte. `0x00` is not a printable base64 character (the base64
 * alphabet starts at `+` = `0x2B`), which is what makes magic-present
 * detection collision-free against legacy base64-text manifests.
 */
export const STORAGE_HEADER_SENTINEL = 0x00;

/** Magic bytes following the sentinel: ASCII "SBL". */
export const STORAGE_HEADER_MAGIC: ReadonlyArray<number> = Object.freeze([0x53, 0x42, 0x4c]);

/**
 * `objectKind` byte values. Only `manifest` is emitted today; `chunk` and
 * `opPayload` are reserved so the header can be reused without a format change
 * if a per-object discriminator is ever needed for those.
 */
export const STORAGE_OBJECT_KIND = Object.freeze({
  manifest: 1,
  chunk: 2,
  opPayload: 3,
});

export type StorageObjectKind = (typeof STORAGE_OBJECT_KIND)[keyof typeof STORAGE_OBJECT_KIND];

/**
 * Current storage format version this build writes. Bump whenever the stored
 * object layout changes; pair the bump with a reader that still opens the
 * prior format.
 *
 * v2 (LIB-FMT-07): the plaintext inside the AES-GCM envelope is compressed
 * (see `payloadCompression.ts`): every saved copy of the library, and every
 * library change (all framed, however small). v1 objects (uncompressed) stay readable;
 * a v2 reader tells the two apart from the plaintext, not from this number.
 * The first v2 write moves the library to v2 on the server, which is what
 * keeps v1 apps (that cannot inflate) from fetching a compressed copy.
 */
export const STORAGE_FORMAT_VERSION = 2;

/**
 * Lowest storage format version this build can still read. A stored object
 * whose `storageFormatVersion` exceeds this build's `STORAGE_FORMAT_VERSION`
 * is too new and must be refused (Part D's compatibility gate). Raising this
 * lower bound is the deliberate act that drops support for an old format.
 */
export const MIN_SUPPORTED_STORAGE_FORMAT_VERSION = 1;

/** Largest value the 2-byte big-endian `storageFormatVersion` field can hold. */
const MAX_STORAGE_FORMAT_VERSION = 0xffff;

export type DecodedStorageHeader = {
  readonly objectKind: number;
  readonly storageFormatVersion: number;
};

/**
 * Encode the fixed 8-byte header for a stored library object.
 *
 * @param objectKind  one of `STORAGE_OBJECT_KIND` (today always `manifest`)
 * @param version     the storage format version to stamp (uint16, >= 1)
 * @returns a fresh 8-byte `Uint8Array`; prepend it to the crypto envelope
 */
export const encodeStorageHeader = (
  objectKind: number,
  version: number
): Uint8Array => {
  if (!Number.isInteger(objectKind) || objectKind < 1 || objectKind > 0xff) {
    throw new Error(`invalid_storage_object_kind:${objectKind}`);
  }
  if (
    !Number.isInteger(version) ||
    version < 1 ||
    version > MAX_STORAGE_FORMAT_VERSION
  ) {
    throw new Error(`invalid_storage_format_version:${version}`);
  }
  const header = new Uint8Array(STORAGE_HEADER_SIZE);
  header[0] = STORAGE_HEADER_SENTINEL;
  header[1] = STORAGE_HEADER_MAGIC[0]!;
  header[2] = STORAGE_HEADER_MAGIC[1]!;
  header[3] = STORAGE_HEADER_MAGIC[2]!;
  header[4] = objectKind;
  // storageFormatVersion — uint16 big-endian.
  header[5] = (version >>> 8) & 0xff;
  header[6] = version & 0xff;
  header[7] = 0; // flags — reserved.
  return header;
};

/**
 * Decode the storage header from the leading bytes of a stored object.
 *
 * @param bytes  the stored object's bytes (the full object or just a prefix
 *               of at least `STORAGE_HEADER_SIZE` bytes)
 * @returns the decoded `{ objectKind, storageFormatVersion }` when the
 *          `0x00 SBL` magic is present; `null` when it is absent — and that
 *          `null` IS the "legacy v0 object" signal callers must route to the
 *          v0 decode path.
 */
export const decodeStorageHeader = (
  bytes: Uint8Array
): DecodedStorageHeader | null => {
  if (bytes.length < STORAGE_HEADER_SIZE) return null;
  if (bytes[0] !== STORAGE_HEADER_SENTINEL) return null;
  if (
    bytes[1] !== STORAGE_HEADER_MAGIC[0] ||
    bytes[2] !== STORAGE_HEADER_MAGIC[1] ||
    bytes[3] !== STORAGE_HEADER_MAGIC[2]
  ) {
    return null;
  }
  const objectKind = bytes[4]!;
  const storageFormatVersion = ((bytes[5]! << 8) | bytes[6]!) >>> 0;
  return { objectKind, storageFormatVersion };
};

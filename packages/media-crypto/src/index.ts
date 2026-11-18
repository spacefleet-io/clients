// ---------------------------------------------------------------------------
// SpaceFleet media-object encryption format, SFV1 (encrypt + decrypt).
//
// Shared by every app that stores media in the user's storage: Badger's runtime
// ingest, offline download and web player, and Parrot's song chunks. Kept apart
// from any ingest module so a reader (offline download, Parrot's player) can
// decrypt without loading ffmpeg / mediaProcessor / GPU detection. Both
// directions share the constants below; changing any of them breaks every
// object already in storage.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import {
  SFV1_HEADER_BYTES,
  SFV1_MAGIC,
  SFV1_MASTER_INFO,
  SFV1_MASTER_SALT,
  SFV1_NONCE_BYTES,
  SFV1_OBJECT_INFO,
  SFV1_SALT_BYTES,
  SFV1_TAG_BYTES,
  sfv1PadCapBytes,
} from "./format";

const MAGIC = Buffer.from(SFV1_MAGIC);
const SALT_BYTES = SFV1_SALT_BYTES;
const NONCE_BYTES = SFV1_NONCE_BYTES;
const TAG_BYTES = SFV1_TAG_BYTES;
const HEADER_BYTES = SFV1_HEADER_BYTES;
const HKDF_INFO = Buffer.from(SFV1_OBJECT_INFO);
const MEDIA_MASTER_SALT = Buffer.from(SFV1_MASTER_SALT);
const MEDIA_MASTER_INFO = Buffer.from(SFV1_MASTER_INFO);
const ENCRYPT_STEP_BYTES = 1024 * 1024;

const deriveMediaMasterKey = (libraryKey: Buffer) =>
  Buffer.from(crypto.hkdfSync("sha256", libraryKey, MEDIA_MASTER_SALT, MEDIA_MASTER_INFO, 32));

const deriveObjectKey = (masterKey: Buffer, salt: Buffer) =>
  Buffer.from(crypto.hkdfSync("sha256", masterKey, salt, HKDF_INFO, 32));

/**
 * Encrypt one media object: `MAGIC | salt | nonce | AES-256-GCM(header | plaintext | padding) | tag`,
 * header = u32le plaintext length + u16le padding length, AAD = MAGIC. The inverse of
 * {@link decryptMediaObject}.
 *
 * Writes straight into the one output buffer: the earlier `Buffer.concat` chain held five
 * object-sized copies at once (payload, update output, ciphertext, result + the plaintext), which
 * on a 4 GB machine uploading several ~4 MiB segments in parallel added up (#928). GCM is a stream
 * mode, so encrypting header, plaintext and padding in separate `update` calls yields the same bytes.
 */
export const encryptMediaObject = (plaintext: Uint8Array, libraryKey: Buffer, paddingLength: number): Buffer => {
  if (libraryKey.length !== 32) throw new Error("media_key_missing");
  if (!Number.isInteger(paddingLength) || paddingLength < 0 || paddingLength > 0xffff) {
    throw new Error("media_object_padding_invalid");
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(plaintext.byteLength, 0);
  header.writeUInt16LE(paddingLength, 4);
  const ciphertextOffset = MAGIC.byteLength + SALT_BYTES + NONCE_BYTES;
  const tagOffset = ciphertextOffset + HEADER_BYTES + plaintext.byteLength + paddingLength;
  const out = Buffer.allocUnsafe(tagOffset + TAG_BYTES);
  MAGIC.copy(out, 0);
  salt.copy(out, MAGIC.byteLength);
  nonce.copy(out, MAGIC.byteLength + SALT_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveObjectKey(deriveMediaMasterKey(libraryKey), salt), nonce);
  cipher.setAAD(MAGIC);
  let at = ciphertextOffset;
  const put = (bytes: Buffer) => {
    bytes.copy(out, at);
    at += bytes.byteLength;
  };
  put(cipher.update(header));
  // 1 MiB steps: the transient update output stays small instead of one more object-sized buffer.
  for (let offset = 0; offset < plaintext.byteLength; offset += ENCRYPT_STEP_BYTES) {
    put(cipher.update(plaintext.subarray(offset, offset + ENCRYPT_STEP_BYTES)));
  }
  if (paddingLength > 0) put(cipher.update(crypto.randomBytes(paddingLength)));
  put(cipher.final());
  if (at !== tagOffset) throw new Error("media_object_encrypt_length_mismatch");
  cipher.getAuthTag().copy(out, tagOffset);
  return out;
};

/**
 * Seal one media object the way every upload does: {@link encryptMediaObject} with random padding
 * of 0..cap bytes, cap = 1 % of the plaintext clamped to 4–32 KiB (`SF_MEDIA_PAD_MAX_BYTES` overrides).
 */
export const sealMediaObjectWithPadding = (plaintext: Uint8Array, libraryKey: Buffer): Buffer => {
  const padCap = sfv1PadCapBytes(plaintext.byteLength, process.env.SF_MEDIA_PAD_MAX_BYTES);
  const padLen = padCap > 0 ? crypto.randomInt(0, padCap + 1) : 0;
  return encryptMediaObject(plaintext, libraryKey, padLen);
};

/**
 * Decrypt one encrypted media chunk back to plaintext.
 *
 * The inverse of {@link encryptMediaObject}. Used by:
 *   1. The Phase 7 ingest retranscode step (chunks fetched from storage,
 *      decrypted, fed into ffmpeg stdin for re-encoding to a missing quality).
 *   2. The Phase 2 offline download step (chunks fetched from storage,
 *      decrypted, concatenated into per-track intermediate files, then muxed
 *      into a single MKV/MP4 on disk for offline playback).
 *
 * Throws on:
 *   - missing/empty library key
 *   - missing/wrong magic header
 *   - too-short payload (no salt / nonce / tag room)
 *   - GCM authentication failure (caller treats as transport corruption)
 *
 * The thrown Error.message string is part of the error contract observed by
 * the runtime event log — do NOT reword it without checking event-log
 * consumers (renderer surfaces these on failed jobs).
 */
export const decryptMediaObject = (encrypted: Uint8Array, libraryKeyBase64: string): Buffer => {
  const normalized = libraryKeyBase64.trim().replace(/\s+/g, "");
  const libraryKey = normalized ? Buffer.from(normalized, "base64") : null;
  if (!libraryKey || libraryKey.length !== 32) {
    throw new Error("media_key_missing");
  }
  const bytes = Buffer.from(encrypted);
  if (bytes.byteLength < MAGIC.byteLength + SALT_BYTES + NONCE_BYTES + TAG_BYTES + HEADER_BYTES) {
    throw new Error("media_object_too_small");
  }
  if (!bytes.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    throw new Error("media_object_magic_invalid");
  }
  const saltOffset = MAGIC.byteLength;
  const nonceOffset = saltOffset + SALT_BYTES;
  const ciphertextOffset = nonceOffset + NONCE_BYTES;
  const tagOffset = bytes.byteLength - TAG_BYTES;
  const salt = bytes.subarray(saltOffset, nonceOffset);
  const nonce = bytes.subarray(nonceOffset, ciphertextOffset);
  const ciphertext = bytes.subarray(ciphertextOffset, tagOffset);
  const tag = bytes.subarray(tagOffset);
  const masterKey = deriveMediaMasterKey(libraryKey);
  const key = deriveObjectKey(masterKey, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const plaintextLength = decrypted.readUInt32LE(0);
  const paddingLength = decrypted.readUInt16LE(4);
  const payload = decrypted.subarray(HEADER_BYTES);
  if (payload.byteLength < plaintextLength + paddingLength) {
    throw new Error("media_object_payload_invalid");
  }
  return payload.subarray(0, plaintextLength);
};

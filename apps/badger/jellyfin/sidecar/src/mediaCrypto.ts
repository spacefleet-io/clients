import crypto from "node:crypto";

/**
 * SFV1 media object + library envelope decryption for the integrations.
 * Mirrors apps/badger/desktop/src/main/mediaCrypto.ts and
 * packages/library-db-runtime/src/crypto.ts (kept free of Electron workers).
 *
 * SFV1 object = "SFV1" | salt(16) | nonce(12) | AES-256-GCM ciphertext | tag(16), AAD = "SFV1";
 * key = HKDF(HKDF(libraryKey, "sf-media-master-salt", "sf-media-master"), salt, "sf-media-v1");
 * plaintext = u32LE origLen | u16LE padLen | data | padding.
 */
const MAGIC = Buffer.from("SFV1");
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 6;
const HKDF_INFO = Buffer.from("sf-media-v1");
const MEDIA_MASTER_SALT = Buffer.from("sf-media-master-salt");
const MEDIA_MASTER_INFO = Buffer.from("sf-media-master");

export const parseLibraryKey = (keyBase64: string): Buffer => {
  const normalized = keyBase64.trim().replace(/\s+/g, "");
  const raw = Buffer.from(normalized, "base64");
  if (raw.length !== 32) throw new Error("library_key_invalid");
  return raw;
};

export const deriveMediaMasterKey = (libraryKey: Buffer) =>
  Buffer.from(crypto.hkdfSync("sha256", libraryKey, MEDIA_MASTER_SALT, MEDIA_MASTER_INFO, 32));

const deriveObjectKey = (masterKey: Buffer, salt: Buffer) =>
  Buffer.from(crypto.hkdfSync("sha256", masterKey, salt, HKDF_INFO, 32));

export const hasSfv1Magic = (payload: Uint8Array) =>
  payload.byteLength >= MAGIC.length && Buffer.from(payload.subarray(0, MAGIC.length)).equals(MAGIC);

/** Decrypts a whole SFV1 object; payloads without the magic pass through unchanged (same backing buffer, no copy). */
export const decryptMediaObject = (masterKey: Buffer, payload: Uint8Array<ArrayBuffer>): Buffer<ArrayBuffer> => {
  const buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (!hasSfv1Magic(buf)) return buf;
  if (buf.length < MAGIC.length + SALT_BYTES + NONCE_BYTES + TAG_BYTES + HEADER_BYTES) {
    throw new Error("media_object_truncated");
  }
  let offset = MAGIC.length;
  const salt = buf.subarray(offset, offset + SALT_BYTES);
  offset += SALT_BYTES;
  const nonce = buf.subarray(offset, offset + NONCE_BYTES);
  offset += NONCE_BYTES;
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(offset, buf.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveObjectKey(masterKey, Buffer.from(salt)), nonce);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const plain = finishGcm(decipher, decipher.update(ciphertext));
  const origLen = plain.readUInt32LE(0);
  if (HEADER_BYTES + origLen > plain.length) throw new Error("media_object_corrupt");
  return plain.subarray(HEADER_BYTES, HEADER_BYTES + origLen);
};

/** Encrypts like the ingest does; used by tests and the test vectors. */
export const encryptMediaObject = (masterKey: Buffer, plaintext: Buffer, padLen = 0): Buffer<ArrayBuffer> => {
  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(plaintext.length, 0);
  header.writeUInt16LE(padLen, 4);
  const payload = Buffer.concat([header, plaintext, padLen > 0 ? crypto.randomBytes(padLen) : Buffer.alloc(0)]);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveObjectKey(masterKey, salt), nonce);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([MAGIC, salt, nonce, ciphertext, cipher.getAuthTag()]);
};

/**
 * GCM is a stream mode: `update` already returns every plaintext byte and `final` returns none, so
 * `Buffer.concat([update, final])` only made one more object-sized copy per segment (#934). `final` must still
 * run: it is the tag check, and throws on a tampered or wrong-key object.
 */
const finishGcm = (decipher: crypto.DecipherGCM, plain: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> => {
  const rest = decipher.final();
  return rest.length === 0 ? plain : Buffer.concat([plain, rest]);
};

/** Library envelope: IV(12) | ciphertext | tag(16), raw 32-byte key, no AAD. */
export const decryptLibraryEnvelope = (libraryKey: Buffer, payload: Uint8Array): Buffer => {
  const buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (buf.length < 12 + 16) throw new Error("envelope_truncated");
  const decipher = crypto.createDecipheriv("aes-256-gcm", libraryKey, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return finishGcm(decipher, decipher.update(buf.subarray(12, buf.length - 16)));
};

export const encryptLibraryEnvelope = (libraryKey: Buffer, plaintext: Buffer): Buffer => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", libraryKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
};

/** Asset objects (posters stored by the user) are base64 text of a library envelope. */
export const decryptAssetObject = (libraryKey: Buffer, payload: Uint8Array): Buffer => {
  const text = Buffer.from(payload).toString("utf8").trim();
  return decryptLibraryEnvelope(libraryKey, Buffer.from(text, "base64"));
};

/** The library's key probe (base64 envelope of random bytes) must decrypt with this key: same check as typing the key by hand. */
export const verifyKeyProbe = (keyBase64: string, probeBase64: string): boolean => {
  try {
    return decryptLibraryEnvelope(parseLibraryKey(keyBase64), Buffer.from(probeBase64, "base64")).length > 0;
  } catch {
    return false;
  }
};

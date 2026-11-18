import crypto from "node:crypto";
import { decryptAesGcmOffThread } from "./mediaDecryptPool";

export const HKDF_INFO = Buffer.from("sf-media-v1");
export const MAGIC = Buffer.from("SFV1");
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;

const HEADER_BYTES = 6;

const MEDIA_MASTER_SALT = Buffer.from("sf-media-master-salt");
const MEDIA_MASTER_INFO = Buffer.from("sf-media-master");

let cachedMasterKey: Buffer | null = null;

const readKeyFromEnv = () => {
  if (cachedMasterKey) return cachedMasterKey;
  const libraryBase64 = process.env.SF_LIBRARY_KEY_BASE64?.trim();
  if (libraryBase64) {
    const raw = Buffer.from(libraryBase64, "base64");
    if (raw.length === 32) {
      return deriveMediaMasterKey(raw);
    }
  }
  return null;
};

const deriveMediaMasterKey = (libraryKey: Buffer) => {
  return Buffer.from(crypto.hkdfSync("sha256", libraryKey, MEDIA_MASTER_SALT, MEDIA_MASTER_INFO, 32));
};

const setMediaMasterKey = (key: Buffer | null) => {
  cachedMasterKey = key;
};

export const deriveObjectKey = (masterKey: Buffer, salt: Buffer) => {
  return Buffer.from(crypto.hkdfSync("sha256", masterKey, salt, HKDF_INFO, 32));
};

const DEFAULT_PAD_MIN_BYTES = 4 * 1024;
const DEFAULT_PAD_MAX_BYTES = 32 * 1024;
const DEFAULT_PAD_PERCENT = 0.01;

const resolvePadMaxBytes = (plaintextLength?: number) => {
  const raw = process.env.SF_MEDIA_PAD_MAX_BYTES?.trim();
  if (raw) {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }
  if (!plaintextLength || plaintextLength <= 0) {
    return DEFAULT_PAD_MAX_BYTES;
  }
  const percentBytes = Math.ceil(plaintextLength * DEFAULT_PAD_PERCENT);
  return Math.min(
    Math.max(DEFAULT_PAD_MIN_BYTES, percentBytes),
    DEFAULT_PAD_MAX_BYTES,
  );
};

const isEncryptedPayload = (payload: Buffer) => {
  return payload.length >= MAGIC.length && payload.subarray(0, MAGIC.length).equals(MAGIC);
};

const encryptMediaObject = (plaintext: Buffer, padMaxBytes = resolvePadMaxBytes(plaintext.length)) => {
  const masterKey = readKeyFromEnv();
  if (!masterKey) {
    throw new Error("media_key_missing");
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const padCap = Math.min(Math.max(0, padMaxBytes), 0xffff);
  const padLen = padCap > 0 ? crypto.randomInt(0, padCap + 1) : 0;
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(plaintext.length, 0);
  header.writeUInt16LE(padLen, 4);
  const padding = padLen > 0 ? crypto.randomBytes(padLen) : Buffer.alloc(0);
  const payload = Buffer.concat([header, plaintext, padding]);
  const key = deriveObjectKey(masterKey, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, nonce, ciphertext, tag]);
};

// The AES-256-GCM work (and the auth-tag check) runs on a worker thread so a
// multi-MB segment never blocks the Electron main event loop (issue #25,
// NEW-main-sync-decrypt). Takes ownership of `payload`: its memory may be
// transferred to the worker, so callers must not read it afterwards.
const decryptMediaObject = async (payload: Buffer): Promise<{ plaintext: Buffer; wasEncrypted: boolean }> => {
  if (!isEncryptedPayload(payload)) {
    return { plaintext: payload, wasEncrypted: false };
  }
  const masterKey = readKeyFromEnv();
  if (!masterKey) {
    throw new Error("media_key_missing");
  }
  const headerOffset = MAGIC.length;
  const salt = payload.subarray(headerOffset, headerOffset + SALT_BYTES);
  const nonce = payload.subarray(headerOffset + SALT_BYTES, headerOffset + SALT_BYTES + NONCE_BYTES);
  const decrypted = await decryptAesGcmOffThread({
    key: deriveObjectKey(masterKey, salt),
    nonce,
    aad: MAGIC,
    payload,
    dataOffset: headerOffset + SALT_BYTES + NONCE_BYTES,
  });
  if (decrypted.length < HEADER_BYTES) {
    throw new Error("media_payload_invalid");
  }
  const origLen = decrypted.readUInt32LE(0);
  const padLen = decrypted.readUInt16LE(4);
  const dataStart = HEADER_BYTES;
  const dataEnd = Math.min(decrypted.length, dataStart + origLen);
  const plaintext = decrypted.subarray(dataStart, dataEnd);
  const expectedLen = dataStart + origLen + padLen;
  if (expectedLen > decrypted.length) {
    throw new Error("media_payload_truncated");
  }
  return { plaintext, wasEncrypted: true };
};

export {
  deriveMediaMasterKey,
  decryptMediaObject,
  encryptMediaObject,
  isEncryptedPayload,
  readKeyFromEnv,
  resolvePadMaxBytes,
  setMediaMasterKey,
};

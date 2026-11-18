import crypto from "react-native-quick-crypto";
import { Buffer } from "buffer";
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
} from "@space/media-crypto/format";
import { base64ToBytes } from "./storage";

const MAGIC = Buffer.from(SFV1_MAGIC);
const SALT_BYTES = SFV1_SALT_BYTES;
const NONCE_BYTES = SFV1_NONCE_BYTES;
const TAG_BYTES = SFV1_TAG_BYTES;
const HEADER_BYTES = SFV1_HEADER_BYTES;
const HKDF_INFO = Buffer.from(SFV1_OBJECT_INFO);
const MEDIA_MASTER_SALT = Buffer.from(SFV1_MASTER_SALT);
const MEDIA_MASTER_INFO = Buffer.from(SFV1_MASTER_INFO);

// react-native-quick-crypto expects the legacy Buffer type without the generic
// parameter that Node 22+ adds. This helper bridges the gap.
// react-native-quick-crypto expects the legacy `Buffer` type (without
// the generic parameter added in Node 22). This helper bridges the gap.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buf = (data: any) => Buffer.from(data) as unknown as Buffer;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedMasterKey: any = null;

const hkdfSha256 = (
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
) => {
  const prk = crypto.createHmac("sha256", buf(salt)).update(buf(ikm)).digest();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prev: any = Buffer.alloc(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let output: any = Buffer.alloc(0);
  let counter = 1;
  while (output.length < length) {
    const hmac = crypto.createHmac("sha256", prk);
    hmac.update(prev);
    hmac.update(buf(info));
    hmac.update(Buffer.from([counter]));
    prev = hmac.digest();
    output = Buffer.concat([output, prev]);
    counter += 1;
  }
  return output.subarray(0, length);
};

const deriveMediaMasterKey = (libraryKey: Uint8Array) => {
  return hkdfSha256(libraryKey, MEDIA_MASTER_SALT, MEDIA_MASTER_INFO, 32);
};

export const setMediaKeyFromBase64 = (libraryKeyBase64: string | null) => {
  if (!libraryKeyBase64) {
    cachedMasterKey = null;
    return;
  }
  const raw = buf(base64ToBytes(libraryKeyBase64));
  if (raw.length === 32) {
    cachedMasterKey = deriveMediaMasterKey(raw);
  }
};

const deriveObjectKey = (masterKey: Uint8Array, salt: Uint8Array) =>
  hkdfSha256(masterKey, salt, HKDF_INFO, 32);

const isEncryptedPayload = (payload: ReturnType<typeof Buffer.from>) => {
  if (payload.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (payload[i] !== MAGIC[i]) return false;
  }
  return true;
};

export const decryptMediaObject = (payload: Uint8Array) => {
  const buffer = Buffer.from(payload);
  if (!isEncryptedPayload(buffer)) {
    return { plaintext: new Uint8Array(buffer), wasEncrypted: false };
  }
  if (!cachedMasterKey) {
    throw new Error("media_key_missing");
  }
  const headerOffset = MAGIC.length;
  const salt = buffer.subarray(headerOffset, headerOffset + SALT_BYTES);
  const nonce = buffer.subarray(
    headerOffset + SALT_BYTES,
    headerOffset + SALT_BYTES + NONCE_BYTES
  );
  const ciphertext = buffer.subarray(
    headerOffset + SALT_BYTES + NONCE_BYTES,
    buffer.length - TAG_BYTES
  );
  const tag = buffer.subarray(buffer.length - TAG_BYTES);
  const key = deriveObjectKey(cachedMasterKey, salt);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decipher: any = crypto.createDecipheriv("aes-256-gcm", buf(key), buf(nonce));
  decipher.setAAD(buf(MAGIC));
  decipher.setAuthTag(buf(tag));
  const decrypted = Buffer.concat([decipher.update(buf(ciphertext)), decipher.final()]);
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
  return { plaintext: new Uint8Array(plaintext), wasEncrypted: true };
};

/**
 * Seals bytes as an SFV1 media object with the library's media key, as the computer app and the web page do
 * (`@space/media-crypto`, `@space/web-vault/sfv1`): `"SFV1" | salt | nonce | AES-256-GCM(u32LE length | u16LE pad
 * length | data | random pad) | tag`, AAD "SFV1", key HKDF(master, salt, "sf-media-v1"). A fetched subtitle is
 * sealed here before it goes to the vault (PLAY-SUBGET-03).
 */
export const encryptMediaObject = (plaintext: Uint8Array): Uint8Array => {
  if (!cachedMasterKey) {
    throw new Error("media_key_missing");
  }
  const padCap = sfv1PadCapBytes(plaintext.length);
  const padLen = crypto.randomBytes(2).readUInt16LE(0) % (padCap + 1);
  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(plaintext.length, 0);
  header.writeUInt16LE(padLen, 4);
  const body = Buffer.concat([header, Buffer.from(plaintext), Buffer.from(crypto.randomBytes(padLen))]);
  const key = deriveObjectKey(cachedMasterKey, buf(salt));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cipher: any = crypto.createCipheriv("aes-256-gcm", buf(key), buf(nonce));
  cipher.setAAD(buf(MAGIC));
  const ciphertext = Buffer.concat([cipher.update(buf(body)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([MAGIC, Buffer.from(salt), Buffer.from(nonce), ciphertext, Buffer.from(tag)]));
};

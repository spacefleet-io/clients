import crypto from "node:crypto";

const MAGIC = Buffer.from("SFV1");
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 6;
const HKDF_INFO = Buffer.from("spacefleet-content-v1");
const CONTENT_MASTER_SALT = Buffer.from("spacefleet-content-master-salt");
const CONTENT_MASTER_INFO = Buffer.from("spacefleet-content-master");

const parseContentKey = (value: string) => {
  const normalized = value.trim().replace(/\s+/g, "");
  if (!normalized) {
    throw new Error("content_key_missing");
  }
  const raw = Buffer.from(normalized, "base64");
  if (raw.length !== 32) {
    throw new Error("content_key_invalid");
  }
  return raw;
};

const deriveContentMasterKey = (contentKey: Buffer) =>
  Buffer.from(crypto.hkdfSync("sha256", contentKey, CONTENT_MASTER_SALT, CONTENT_MASTER_INFO, 32));

const deriveObjectKeyBytes = (masterKey: Buffer, salt: Buffer) =>
  Buffer.from(crypto.hkdfSync("sha256", masterKey, salt, HKDF_INFO, 32));

export const encryptContentObject = (plaintext: Uint8Array, contentKeyBase64: string) => {
  const contentKey = parseContentKey(contentKeyBase64);
  const masterKey = deriveContentMasterKey(contentKey);
  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(plaintext.byteLength, 0);
  header.writeUInt16LE(0, 4);
  const key = deriveObjectKeyBytes(masterKey, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([header, Buffer.from(plaintext)])), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, nonce, ciphertext, tag]);
};

export const decryptContentObject = (encryptedPayload: Uint8Array, contentKeyBase64: string) => {
  const bytes = Buffer.from(encryptedPayload);
  if (bytes.byteLength < MAGIC.byteLength + SALT_BYTES + NONCE_BYTES + TAG_BYTES + HEADER_BYTES) {
    throw new Error("content_object_too_small");
  }
  if (!bytes.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    throw new Error("content_object_magic_invalid");
  }
  const saltOffset = MAGIC.byteLength;
  const nonceOffset = saltOffset + SALT_BYTES;
  const ciphertextOffset = nonceOffset + NONCE_BYTES;
  const tagOffset = bytes.byteLength - TAG_BYTES;
  const salt = bytes.subarray(saltOffset, nonceOffset);
  const nonce = bytes.subarray(nonceOffset, ciphertextOffset);
  const ciphertext = bytes.subarray(ciphertextOffset, tagOffset);
  const tag = bytes.subarray(tagOffset);

  const contentKey = parseContentKey(contentKeyBase64);
  const masterKey = deriveContentMasterKey(contentKey);
  const key = deriveObjectKeyBytes(masterKey, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const plaintextLength = decrypted.readUInt32LE(0);
  const paddingLength = decrypted.readUInt16LE(4);
  const payload = decrypted.subarray(HEADER_BYTES);
  if (payload.byteLength < plaintextLength + paddingLength) {
    throw new Error("content_object_payload_invalid");
  }
  return payload.subarray(0, plaintextLength);
};

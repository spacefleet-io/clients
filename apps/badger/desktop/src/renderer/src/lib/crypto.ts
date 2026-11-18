import { base64ToBytes, bytesToBase64 } from "./storage";

const IV_LENGTH = 12;
const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;

const normalizeKey = (keyBase64: string) => keyBase64.trim().replace(/\s+/g, "");

export const importAesGcmKey = async (keyBase64: string) => {
  const normalized = normalizeKey(keyBase64);
  const raw = base64ToBytes(normalized);
  if (raw.byteLength !== 32) {
    throw new Error("INVALID_KEY");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
};

export const encryptBytesToBase64 = async (keyBase64: string, plaintext: Uint8Array) => {
  const key = await importAesGcmKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(plaintext))
  );

  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.byteLength);
  return bytesToBase64(packed);
};

export const decryptBase64ToBytes = async (keyBase64: string, payloadBase64: string) => {
  const packed = base64ToBytes(payloadBase64);
  if (packed.byteLength <= IV_LENGTH + 16) {
    throw new Error("INVALID_BLOB");
  }
  const iv = packed.slice(0, IV_LENGTH);
  const ciphertext = packed.slice(IV_LENGTH);
  const key = await importAesGcmKey(keyBase64);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(ciphertext));
  return new Uint8Array(plaintext);
};

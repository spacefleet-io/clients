// AES-256-GCM seal and open of the library's envelopes (`IV(12) | ciphertext | tag(16)`, base64 32-byte key), the
// layout every SpaceFleet app writes (key probe, manifests, snapshot chunks, artwork). Shared by Badger's and Parrot's
// phone apps.
import crypto from "react-native-quick-crypto";
import { Buffer } from "buffer";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The part of a GCM decipher this uses. quick-crypto types its Buffer as @craftzdog/react-native-buffer's, which the
 * `buffer` package's Buffer does not satisfy although the bytes are the same, so the decipher is read through this. */
type GcmDecipher = { setAuthTag(tag: Uint8Array): void; update(data: Uint8Array): Uint8Array; final(): Uint8Array };
type GcmCipher = { getAuthTag(): Uint8Array; update(data: Uint8Array): Uint8Array; final(): Uint8Array };

const decodeKey = (keyBase64: string) => {
  const raw = Buffer.from(keyBase64.trim().replace(/\s+/g, ""), "base64");
  if (raw.byteLength !== 32) throw new Error("INVALID_KEY");
  return raw;
};

/** Opens one envelope; throws INVALID_KEY, INVALID_BLOB, or the cipher's error on a wrong key (bad tag). */
export const decryptBytesToBytes = async (keyBase64: string, envelope: Uint8Array): Promise<Uint8Array> => {
  if (envelope.byteLength <= IV_BYTES + TAG_BYTES) throw new Error("INVALID_BLOB");
  const iv = envelope.subarray(0, IV_BYTES);
  const ciphertext = envelope.subarray(IV_BYTES, envelope.byteLength - TAG_BYTES);
  const tag = envelope.subarray(envelope.byteLength - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", decodeKey(keyBase64), iv) as unknown as GcmDecipher;
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
};

/** The same open for a base64 envelope (the key probe, stored artwork). */
export const decryptBase64ToBytes = (keyBase64: string, payloadBase64: string) =>
  decryptBytesToBytes(keyBase64, new Uint8Array(Buffer.from(payloadBase64, "base64")));

/** Seals `plaintext` in one envelope under a fresh random IV. */
export const encryptBytesToBytes = async (keyBase64: string, plaintext: Uint8Array): Promise<Uint8Array> => {
  const iv = new Uint8Array(crypto.randomBytes(IV_BYTES));
  const cipher = crypto.createCipheriv("aes-256-gcm", decodeKey(keyBase64), iv) as unknown as GcmCipher;
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, ciphertext, cipher.getAuthTag()]));
};

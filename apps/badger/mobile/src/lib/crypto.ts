import crypto from "react-native-quick-crypto";
import { Buffer } from "buffer";
import { base64ToBytes, bytesToBase64 } from "./storage";

// react-native-quick-crypto expects the legacy Buffer type without the generic
// parameter that Node 22+ adds. This helper bridges the gap.
// react-native-quick-crypto expects the legacy `Buffer` type (without
// the generic parameter added in Node 22). This helper bridges the gap
// by round-tripping through `unknown`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buf = (data: any) => Buffer.from(data) as unknown as Buffer;

const IV_LENGTH = 12;

const normalizeKey = (keyBase64: string) => keyBase64.trim().replace(/\s+/g, "");

const decodeKey = (keyBase64: string) => {
  const normalized = normalizeKey(keyBase64);
  const raw = base64ToBytes(normalized);
  if (raw.byteLength !== 32) {
    throw new Error("INVALID_KEY");
  }
  return buf(raw);
};

export const decodeKeyBase64 = (keyBase64: string) => decodeKey(keyBase64);

export const encryptBytesToBase64 = async (keyBase64: string, plaintext: Uint8Array) => {
  const key = decodeKey(keyBase64);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, buf(iv));
  const encrypted = Buffer.concat([cipher.update(buf(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([buf(iv), buf(encrypted), buf(tag)]);
  return bytesToBase64(new Uint8Array(packed));
};

// The library envelope (seal and open) is shared with Parrot (REL-FAM-02); this module stays the app's single crypto
// entry point, which the library tests mock.
export { decryptBase64ToBytes, decryptBytesToBytes, encryptBytesToBytes } from "@space/mobile-shell/libraryEnvelope";

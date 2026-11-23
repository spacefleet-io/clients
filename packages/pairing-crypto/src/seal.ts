import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64ToBytes, bytesToBase64 } from "./base64";

export const PAIRING_INFO = "sf-pair-v1";
export const PAIRING_AAD_PREFIX = "sf-pair-v1|";
export const LIBRARY_KEY_BYTES = 32;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export type PairingKeyInput = Uint8Array | string;

export type SealedKey = { v: 1; epk: string; iv: string; ct: string };

export type DeviceKeyPair = { publicKey: string; privateKey: string };

const utf8 = (text: string) => new TextEncoder().encode(text);

const toBytes = (value: PairingKeyInput, expected: number, label: string): Uint8Array => {
  const bytes = typeof value === "string" ? base64ToBytes(value) : value;
  if (bytes.length !== expected) throw new Error(`${label} must be ${expected} bytes`);
  return bytes;
};

/** CSPRNG bytes from WebCrypto (Bun, Node, browsers, React Native with its polyfill). */
export const randomBytes = (length: number): Uint8Array => {
  const out = new Uint8Array(length);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new Error("no secure random source: globalThis.crypto.getRandomValues missing");
  c.getRandomValues(out);
  return out;
};

const deriveKey = (sharedSecret: Uint8Array, requestId: string) =>
  hkdf(sha256, sharedSecret, utf8(requestId), utf8(PAIRING_INFO), 32);

/** New device: raw 32-byte X25519 keypair, base64 encoded. The private key never leaves the device. */
export const generateDeviceKeyPair = (): DeviceKeyPair => {
  const secretKey = randomBytes(32);
  return { publicKey: bytesToBase64(x25519.getPublicKey(secretKey)), privateKey: bytesToBase64(secretKey) };
};

export type SealLibraryKeyInput = {
  devicePublicKey: PairingKeyInput;
  requestId: string;
  libraryKey: PairingKeyInput;
  /** Test hook: fixed ephemeral private key / iv for published vectors. Never pass in production. */
  ephemeralPrivateKey?: PairingKeyInput;
  iv?: Uint8Array;
};

/** Approver: seals the 32-byte library key to the new device's public key. */
// tla: PairingV2/ASeal
export const sealLibraryKey = (input: SealLibraryKeyInput): SealedKey => {
  const devicePublicKey = toBytes(input.devicePublicKey, 32, "device public key");
  const libraryKey = toBytes(input.libraryKey, LIBRARY_KEY_BYTES, "library key");
  const ephemeralPrivate = input.ephemeralPrivateKey
    ? toBytes(input.ephemeralPrivateKey, 32, "ephemeral private key")
    : randomBytes(32);
  const iv = input.iv ?? randomBytes(IV_BYTES);
  if (iv.length !== IV_BYTES) throw new Error(`iv must be ${IV_BYTES} bytes`);
  const shared = x25519.getSharedSecret(ephemeralPrivate, devicePublicKey);
  const key = deriveKey(shared, input.requestId);
  const ct = gcm(key, iv, utf8(PAIRING_AAD_PREFIX + input.requestId)).encrypt(libraryKey);
  return {
    v: 1,
    epk: bytesToBase64(x25519.getPublicKey(ephemeralPrivate)),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(ct),
  };
};

/** Structural check used by the API and clients before touching crypto. */
export const isSealedKey = (value: unknown): value is SealedKey => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || typeof v.epk !== "string" || typeof v.iv !== "string" || typeof v.ct !== "string") return false;
  try {
    return (
      base64ToBytes(v.epk).length === 32 &&
      base64ToBytes(v.iv).length === IV_BYTES &&
      base64ToBytes(v.ct).length === LIBRARY_KEY_BYTES + GCM_TAG_BYTES
    );
  } catch {
    return false;
  }
};

export type OpenSealedKeyInput = {
  devicePrivateKey: PairingKeyInput;
  requestId: string;
  sealed: SealedKey;
};

/**
 * New device: recovers the library key. Throws if the blob is malformed, tampered, or sealed for a
 * different request/device. The caller MUST still verify the key against the library keyProbe.
 */
// tla: PairingV2/RApproved
export const openSealedKey = (input: OpenSealedKeyInput): Uint8Array => {
  if (!isSealedKey(input.sealed)) throw new Error("malformed sealed key");
  const devicePrivate = toBytes(input.devicePrivateKey, 32, "device private key");
  const shared = x25519.getSharedSecret(devicePrivate, base64ToBytes(input.sealed.epk));
  const key = deriveKey(shared, input.requestId);
  return gcm(key, base64ToBytes(input.sealed.iv), utf8(PAIRING_AAD_PREFIX + input.requestId)).decrypt(
    base64ToBytes(input.sealed.ct),
  );
};

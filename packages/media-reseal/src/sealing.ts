/**
 * Re-sealing one stored object under the next media library key (STOR-RESEAL-01). WebCrypto only, so desktop, phone
 * and Bun tests run the same code.
 *
 * Three formats are sealed with the library key, and the stored bytes alone tell which one by whether it opens:
 *   - `sfv1-media`:   SFV1 with the media derivation (`sf-media-master*`, `sf-media-v1`): Badger's DASH pieces,
 *                     subtitles, previews, Parrot's song chunks and tags (@space/media-crypto/format).
 *   - `sfv1-content`: SFV1 with the content derivation (`spacefleet-content-*`, @space/content-core).
 *   - `envelope`:     the library envelope `IV(12) | AES-256-GCM(raw key) | tag(16)`: artwork and Parrot covers.
 * The copy keeps its format and its padding length, so it is exactly as large as the old object (the gateway refuses a
 * larger copy, STOR-RESEAL-03). An object no format opens is unreadable: kept as it is (STOR-RESEAL-05).
 */
import {
  SFV1_HEADER_BYTES,
  SFV1_MAGIC,
  SFV1_MASTER_INFO,
  SFV1_MASTER_SALT,
  SFV1_NONCE_BYTES,
  SFV1_OBJECT_INFO,
  SFV1_SALT_BYTES,
  SFV1_TAG_BYTES,
} from "@space/media-crypto/format";

/** Content derivation of @space/content-core `encryption.ts` (same SFV1 layout, other HKDF strings). */
const CONTENT_MASTER_SALT = "spacefleet-content-master-salt";
const CONTENT_MASTER_INFO = "spacefleet-content-master";
const CONTENT_OBJECT_INFO = "spacefleet-content-v1";

const ENVELOPE_IV_BYTES = 12;

export type ResealFormat = "sfv1-media" | "sfv1-content" | "envelope";

/** One library key imported for re-sealing: never extractable, the raw bytes are wiped after import. */
export type ResealKey = {
  envelope: CryptoKey;
  mediaMaster: CryptoKey;
  contentMaster: CryptoKey;
};

/** The key the objects are sealed with now (`from`) and the next one (`to`). */
export type ResealKeys = { from: ResealKey; to: ResealKey };

export type ResealOutcome = { kind: "copied"; format: ResealFormat; sealed: Uint8Array<ArrayBuffer> } | { kind: "unreadable" };

const text = new TextEncoder();
const MAGIC = text.encode(SFV1_MAGIC);
const SFV1_CIPHER_OFFSET = MAGIC.byteLength + SFV1_SALT_BYTES + SFV1_NONCE_BYTES;

const hkdfMaster = async (hkdf: CryptoKey, salt: string, info: string): Promise<CryptoKey> => {
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: text.encode(salt), info: text.encode(info) }, hkdf, 256)
  );
  try {
    return await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  } finally {
    bits.fill(0);
  }
};

/** Imports the 32 raw key bytes, then overwrites `raw` with zeros: the caller must not reuse it. */
export const importResealKey = async (raw: Uint8Array): Promise<ResealKey> => {
  if (raw.byteLength !== 32) throw new Error("library_key_invalid");
  const bytes = new Uint8Array(raw);
  raw.fill(0);
  try {
    const envelope = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const hkdf = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits"]);
    return {
      envelope,
      mediaMaster: await hkdfMaster(hkdf, SFV1_MASTER_SALT, SFV1_MASTER_INFO),
      contentMaster: await hkdfMaster(hkdf, CONTENT_MASTER_SALT, CONTENT_MASTER_INFO),
    };
  } finally {
    bytes.fill(0);
  }
};

/** The base64 form apps keep the key in. */
export const importResealKeyFromBase64 = (keyBase64: string): Promise<ResealKey> =>
  importResealKey(Uint8Array.from(atob(keyBase64.replace(/\s+/g, "")), (char) => char.charCodeAt(0)));

const objectKey = (master: CryptoKey, info: string, salt: Uint8Array<ArrayBuffer>, usage: "encrypt" | "decrypt") =>
  crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: text.encode(info) }, master, { name: "AES-GCM", length: 256 }, false, [usage]);

const hasMagic = (sealed: Uint8Array) =>
  sealed.byteLength >= SFV1_CIPHER_OFFSET + SFV1_HEADER_BYTES + SFV1_TAG_BYTES && MAGIC.every((byte, i) => sealed[i] === byte);

/** The framed plaintext (`header | data | padding`) of an SFV1 object, or null when this derivation does not open it. */
const openSfv1Framed = async (master: CryptoKey, info: string, sealed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> => {
  const salt = sealed.slice(MAGIC.byteLength, MAGIC.byteLength + SFV1_SALT_BYTES);
  try {
    const framed = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: sealed.subarray(MAGIC.byteLength + SFV1_SALT_BYTES, SFV1_CIPHER_OFFSET), additionalData: MAGIC, tagLength: 128 },
        await objectKey(master, info, salt, "decrypt"),
        sealed.subarray(SFV1_CIPHER_OFFSET)
      )
    );
    const header = new DataView(framed.buffer, 0, SFV1_HEADER_BYTES);
    if (SFV1_HEADER_BYTES + header.getUint32(0, true) + header.getUint16(4, true) !== framed.byteLength) return null;
    return framed;
  } catch {
    return null;
  }
};

/** Seals the framed plaintext again, as is (same header, data and padding), under a fresh salt and nonce. */
const sealSfv1Framed = async (master: CryptoKey, info: string, framed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => {
  const salt = crypto.getRandomValues(new Uint8Array(SFV1_SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(SFV1_NONCE_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: MAGIC, tagLength: 128 }, await objectKey(master, info, salt, "encrypt"), framed)
  );
  const out = new Uint8Array(SFV1_CIPHER_OFFSET + cipher.byteLength);
  out.set(MAGIC, 0);
  out.set(salt, MAGIC.byteLength);
  out.set(nonce, MAGIC.byteLength + SFV1_SALT_BYTES);
  out.set(cipher, SFV1_CIPHER_OFFSET);
  return out;
};

const openEnvelope = async (key: CryptoKey, sealed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> => {
  if (sealed.byteLength < ENVELOPE_IV_BYTES + SFV1_TAG_BYTES) return null;
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(0, ENVELOPE_IV_BYTES) }, key, sealed.subarray(ENVELOPE_IV_BYTES))
    );
  } catch {
    return null;
  }
};

const sealEnvelope = async (key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => {
  const iv = crypto.getRandomValues(new Uint8Array(ENVELOPE_IV_BYTES));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const out = new Uint8Array(ENVELOPE_IV_BYTES + cipher.byteLength);
  out.set(iv, 0);
  out.set(cipher, ENVELOPE_IV_BYTES);
  return out;
};

/**
 * Opens `sealed` with `keys.from` and seals the same bytes with `keys.to`, in the same format and at the same size.
 * The plaintext is wiped once sealed. An object no format opens is `unreadable` (STOR-RESEAL-05).
 */
export const resealObject = async (keys: ResealKeys, stored: Uint8Array): Promise<ResealOutcome> => {
  const sealed = new Uint8Array(stored);
  if (hasMagic(sealed)) {
    const sfv1: Array<{ format: ResealFormat; from: CryptoKey; to: CryptoKey; info: string }> = [
      { format: "sfv1-media", from: keys.from.mediaMaster, to: keys.to.mediaMaster, info: SFV1_OBJECT_INFO },
      { format: "sfv1-content", from: keys.from.contentMaster, to: keys.to.contentMaster, info: CONTENT_OBJECT_INFO },
    ];
    for (const candidate of sfv1) {
      const framed = await openSfv1Framed(candidate.from, candidate.info, sealed);
      if (!framed) continue;
      try {
        return { kind: "copied", format: candidate.format, sealed: await sealSfv1Framed(candidate.to, candidate.info, framed) };
      } finally {
        framed.fill(0);
      }
    }
  }
  // An envelope starts with a random IV, which may read "SFV1" by chance: tried whatever the first bytes are.
  const plaintext = await openEnvelope(keys.from.envelope, sealed);
  if (!plaintext) return { kind: "unreadable" };
  try {
    return { kind: "copied", format: "envelope", sealed: await sealEnvelope(keys.to.envelope, plaintext) };
  } finally {
    plaintext.fill(0);
  }
};

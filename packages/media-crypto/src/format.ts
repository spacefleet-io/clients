// ---------------------------------------------------------------------------
// SFV1 format constants and the padding rule, with no Node import: the Node sealer (./index.ts) and the browser
// sealer/opener (@space/web-vault/sfv1) both read them here, so the two can never drift apart.
//   object    = "SFV1" | salt(16) | nonce(12) | AES-256-GCM(header | data | padding) | tag(16), AAD = "SFV1"
//   header    = u32LE data length | u16LE padding length
//   master    = HKDF-SHA256(libraryKey, "sf-media-master-salt", "sf-media-master")
//   objectKey = HKDF-SHA256(master, salt, "sf-media-v1")
// ---------------------------------------------------------------------------

export const SFV1_MAGIC = "SFV1";
export const SFV1_SALT_BYTES = 16;
export const SFV1_NONCE_BYTES = 12;
export const SFV1_TAG_BYTES = 16;
export const SFV1_HEADER_BYTES = 6;
export const SFV1_OBJECT_INFO = "sf-media-v1";
export const SFV1_MASTER_SALT = "sf-media-master-salt";
export const SFV1_MASTER_INFO = "sf-media-master";
export const SFV1_MAX_PADDING = 0xffff;

/**
 * The most random padding one sealed object gets: 1 % of the plaintext clamped to 4–32 KiB (32 KiB when the length is
 * unknown). `override` is the `SF_MEDIA_PAD_MAX_BYTES` setting on the Node side; a browser passes nothing.
 */
export const sfv1PadCapBytes = (plaintextLength?: number, override?: string | null): number => {
  const raw = override?.trim();
  if (raw) {
    const value = Number(raw);
    return Math.min(Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0, SFV1_MAX_PADDING);
  }
  const min = 4 * 1024;
  const max = 32 * 1024;
  if (!plaintextLength || plaintextLength <= 0) return max;
  return Math.min(Math.max(min, Math.ceil(plaintextLength * 0.01)), max);
};

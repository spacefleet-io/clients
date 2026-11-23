/**
 * PRIV-PAIR-01: the check that keeps a lying server out of pairing (`sf-pair-v2`).
 *
 * The receiving device commits to its one-time public key and a secret nonce `nR` (C = SHA-256(tag ‖ pk ‖ nR)) when it
 * makes its request. The sending device answers with its own nonce `nA`; only then does the receiver reveal `nR`. Both
 * show six digits of SHA-256(tag ‖ pk ‖ C ‖ nA ‖ nR), and the sender seals the key only once the user says the two
 * screens match. C fixes `nR` before `nA` exists and `nR` stays hidden until `nA` is fixed, so a server in the middle
 * cannot pick values that make both screens agree: it can only guess (1 in 1 000 000 per attempt).
 *
 * A scanned QR code carries the first 16 bytes of C in its fragment, added by the receiving device itself; when they
 * match, the camera has proved the device and the comparison is skipped.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { base64ToBytes, bytesToBase64, bytesToBase64Url } from "./base64";
import { randomBytes } from "./seal";

export const PAIRING_PROTOCOL_V2 = 2;
export const PAIRING_COMMIT_TAG = "sf-pair-v2|commit";
export const PAIRING_CHECK_TAG = "sf-pair-v2|check";
export const PAIRING_NONCE_BYTES = 32;
export const PAIRING_COMMITMENT_BYTES = 32;
/** Bytes of C the QR fragment carries: 128 bits, far beyond what a server could match by trying keys. */
export const PAIRING_FINGERPRINT_BYTES = 16;
export const CHECK_CODE_DIGITS = 6;

/**
 * PRIV-PAIR-04: a sending app refuses a request made without the check (sf-pair-v1: app versions from before v2), with
 * `update_required`, because otherwise a lying server could present any request as v1 and skip the check. The ONE
 * switch every sending app reads.
 */
export const PAIRING_V1_REQUESTS_ACCEPTED = false;

const utf8 = (text: string) => new TextEncoder().encode(text);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const exact = (value: string, length: number, label: string): Uint8Array => {
  const bytes = base64ToBytes(value);
  if (bytes.length !== length) throw new Error(`${label} must be ${length} bytes`);
  return bytes;
};

/** A fresh 32-byte nonce, standard base64. */
export const newPairingNonce = (): string => bytesToBase64(randomBytes(PAIRING_NONCE_BYTES));

/** C = SHA-256("sf-pair-v2|commit" ‖ pk ‖ nR), standard base64. */
// tla: PairingV2/RStart
export const pairingCommitment = (publicKey: string, requesterNonce: string): string =>
  bytesToBase64(
    sha256(concat(utf8(PAIRING_COMMIT_TAG), exact(publicKey, 32, "public key"), exact(requesterNonce, PAIRING_NONCE_BYTES, "nonce")))
  );

/** True when `requesterNonce` opens `commitment` for `publicKey`. Malformed input is simply false. */
// tla: PairingV2/ARead
export const commitmentOpens = (commitment: string, publicKey: string, requesterNonce: string): boolean => {
  try {
    const expected = exact(commitment, PAIRING_COMMITMENT_BYTES, "commitment");
    const actual = base64ToBytes(pairingCommitment(publicKey, requesterNonce));
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ actual[i]!;
    return diff === 0;
  } catch {
    return false;
  }
};

/** The QR fragment value: the first 16 bytes of C, base64url without padding. */
export const commitmentFingerprint = (commitment: string): string =>
  bytesToBase64Url(exact(commitment, PAIRING_COMMITMENT_BYTES, "commitment").slice(0, PAIRING_FINGERPRINT_BYTES));

/** True when a fingerprint read from a scanned QR names `commitment`. */
export const fingerprintMatches = (fingerprint: string | null | undefined, commitment: string): boolean => {
  if (!fingerprint) return false;
  try {
    return commitmentFingerprint(commitment) === fingerprint;
  } catch {
    return false;
  }
};

/**
 * The receiving device's own QR link: whatever the server built, with its fragment replaced by `#c=<fingerprint>`.
 * The receiver adds this itself; a fingerprint from the server would prove nothing.
 */
export const withCommitmentFingerprint = (link: string, commitment: string): string =>
  `${link.split("#")[0]}#c=${commitmentFingerprint(commitment)}`;

/** The fingerprint in a scanned link's fragment (`#c=…`), or null. */
export const fingerprintFromLink = (text: string): string | null => {
  const hash = text.trim().indexOf("#");
  if (hash < 0) return null;
  for (const part of text.trim().slice(hash + 1).split("&")) {
    const [key, value] = part.split("=");
    if (key === "c" && value && /^[A-Za-z0-9_-]{22}$/u.test(value)) return value;
  }
  return null;
};

export type CheckCodeInput = { publicKey: string; commitment: string; approverNonce: string; requesterNonce: string };

/** Six digits of SHA-256("sf-pair-v2|check" ‖ pk ‖ C ‖ nA ‖ nR): first 4 bytes big-endian, modulo 1 000 000. */
// tla: PairingV2/RPoll
// tla: PairingV2/ARead
export const pairingCheckCode = (input: CheckCodeInput): string => {
  const digest = sha256(
    concat(
      utf8(PAIRING_CHECK_TAG),
      exact(input.publicKey, 32, "public key"),
      exact(input.commitment, PAIRING_COMMITMENT_BYTES, "commitment"),
      exact(input.approverNonce, PAIRING_NONCE_BYTES, "approver nonce"),
      exact(input.requesterNonce, PAIRING_NONCE_BYTES, "requester nonce")
    )
  );
  const n = ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
  return String(n % 10 ** CHECK_CODE_DIGITS).padStart(CHECK_CODE_DIGITS, "0");
};

/** "123456" → "123 456", how both screens show it. */
export const formatCheckCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

/** Shape check the API and clients run on a nonce or commitment before using it. */
export const isPairingBlob32 = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) return false;
  try {
    return base64ToBytes(value).length === 32;
  } catch {
    return false;
  }
};

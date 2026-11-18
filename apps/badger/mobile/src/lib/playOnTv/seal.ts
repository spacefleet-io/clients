/**
 * End-to-end sealing of "Play on TV" messages (UX-TV-02, PRIV-SRV-01): the relay only ever sees `{ v, nonce, ciphertext }`.
 * AES-256-GCM with a key derived from the account key by SHA-256 over a label and the key, and the label as additional data.
 * The label is `sf-p2p-remote-v1` (the same construction the frozen headless client's notifications used with their own
 * label, PLAT-HEADLESS-01), so a message sealed for another purpose can never be opened as a remote command.
 *
 * Crypto is passed in (node's `crypto` in tests and in the e2e client, `react-native-quick-crypto` in the apps: both offer
 * the same calls), so this file runs everywhere.
 */
import { Buffer } from "buffer";
import { parseRemoteMessage, type RemoteMessage } from "./protocol";

export const REMOTE_SEAL_LABEL = "sf-p2p-remote-v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The relay envelope: the same shape as the desktop's `P2pEnvelope`. */
export type SealedEnvelope = { v: 1; nonce: string; ciphertext: string };

type Bytes = Uint8Array;
type CipherLike = { setAAD: (aad: Bytes) => unknown; update: (data: Bytes) => Bytes; final: () => Bytes; getAuthTag: () => Bytes };
type DecipherLike = { setAAD: (aad: Bytes) => unknown; setAuthTag: (tag: Bytes) => unknown; update: (data: Bytes) => Bytes; final: () => Bytes };

/** The part of node's `crypto` / `react-native-quick-crypto` this needs. */
export type SealCrypto = {
  createHash: (algorithm: "sha256") => { update: (data: Bytes | string) => { update: (data: Bytes | string) => { digest: () => Bytes } } };
  createCipheriv: (algorithm: "aes-256-gcm", key: Bytes, iv: Bytes) => CipherLike;
  createDecipheriv: (algorithm: "aes-256-gcm", key: Bytes, iv: Bytes) => DecipherLike;
  randomBytes: (size: number) => Bytes;
};

export type RemoteSealer = {
  seal: (message: RemoteMessage) => SealedEnvelope;
  /** The message inside, validated; null when it does not open with this account's key or is not a valid message. */
  open: (envelope: unknown) => RemoteMessage | null;
};

export const isSealedEnvelope = (value: unknown): value is SealedEnvelope => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1 && typeof candidate.nonce === "string" && typeof candidate.ciphertext === "string";
};

export const createRemoteSealer = (crypto: SealCrypto, accountKeyBase64: string): RemoteSealer => {
  const rawKey = Buffer.from(accountKeyBase64.trim().replace(/\s+/g, ""), "base64");
  if (rawKey.length !== 32) throw new Error("INVALID_KEY");
  const key = Buffer.from(crypto.createHash("sha256").update(REMOTE_SEAL_LABEL).update(rawKey).digest());
  const aad = Buffer.from(REMOTE_SEAL_LABEL, "utf8");

  return {
    seal(message) {
      const nonce = Buffer.from(crypto.randomBytes(NONCE_BYTES));
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad);
      const plain = Buffer.from(JSON.stringify(message), "utf8");
      const body = Buffer.concat([Buffer.from(cipher.update(plain)), Buffer.from(cipher.final())]);
      const tag = Buffer.from(cipher.getAuthTag());
      return { v: 1, nonce: nonce.toString("base64"), ciphertext: Buffer.concat([body, tag]).toString("base64") };
    },
    open(envelope) {
      if (!isSealedEnvelope(envelope)) return null;
      try {
        const nonce = Buffer.from(envelope.nonce, "base64");
        const payload = Buffer.from(envelope.ciphertext, "base64");
        if (nonce.length !== NONCE_BYTES || payload.length <= TAG_BYTES) return null;
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(payload.subarray(payload.length - TAG_BYTES));
        const plain = Buffer.concat([
          Buffer.from(decipher.update(payload.subarray(0, payload.length - TAG_BYTES))),
          Buffer.from(decipher.final()),
        ]);
        return parseRemoteMessage(JSON.parse(plain.toString("utf8")));
      } catch {
        return null;
      }
    },
  };
};

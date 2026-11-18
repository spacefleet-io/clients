// @req UX-TV-02[badger-mobile,badger-tv]
/**
 * @level unit
 * @why The relay must only ever see `{ v, nonce, ciphertext }`: a command sealed with the account key opens on the
 *   account's other device, and nothing else (another key, a tampered byte, another label's key derivation) opens.
 */
import * as nodeCrypto from "crypto";
import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";
import { buildMessage, IDLE_STATE } from "../src/lib/playOnTv/protocol";
import { createRemoteSealer, isSealedEnvelope, REMOTE_SEAL_LABEL, type SealCrypto, type SealedEnvelope } from "../src/lib/playOnTv/seal";

const crypto = nodeCrypto as unknown as SealCrypto;
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString("base64");
const OTHER_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i)).toString("base64");

const flipByte = (base64: string, at: number) => {
  const bytes = Buffer.from(base64, "base64");
  bytes[at] ^= 0x01;
  return bytes.toString("base64");
};

describe("createRemoteSealer", () => {
  it("round-trips a message and hides its content from the relay", () => {
    const sealer = createRemoteSealer(crypto, KEY);
    const message = buildMessage("tv-1", "phone-1", { ...IDLE_STATE, phase: "playing", title: "Secret Title", mediaId: "media-secret" }, 1_000);
    const envelope = sealer.seal(message);
    console.info("[phase:seal] envelope", JSON.stringify({ v: envelope.v, nonceLen: envelope.nonce.length, ctLen: envelope.ciphertext.length }));
    expect(Object.keys(envelope).sort()).toEqual(["ciphertext", "nonce", "v"]);
    expect(Buffer.from(envelope.nonce, "base64")).toHaveLength(12);
    const raw = JSON.stringify(envelope);
    expect(raw).not.toContain("Secret Title");
    expect(raw).not.toContain("media-secret");
    const opened = createRemoteSealer(crypto, ` ${KEY.slice(0, 10)}\n${KEY.slice(10)} `).open(envelope);
    console.info("[phase:open] opened", JSON.stringify({ ok: opened !== null, type: opened?.body.type }));
    expect(opened).toEqual(message);
  });

  it("uses a fresh nonce per seal", () => {
    const sealer = createRemoteSealer(crypto, KEY);
    const message = buildMessage("p", "t", { type: "hello" }, 1);
    const a = sealer.seal(message);
    const b = sealer.seal(message);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("does not open with another key", () => {
    const envelope = createRemoteSealer(crypto, KEY).seal(buildMessage("p", "t", { type: "pause" }, 1));
    const opened = createRemoteSealer(crypto, OTHER_KEY).open(envelope);
    console.info("[phase:open] wrong key", JSON.stringify({ opened }));
    expect(opened).toBeNull();
  });

  it("does not open a tampered ciphertext, tag or nonce", () => {
    const sealer = createRemoteSealer(crypto, KEY);
    const envelope = sealer.seal(buildMessage("p", "t", { type: "seekBy", deltaSeconds: 10 }, 1));
    const ctLen = Buffer.from(envelope.ciphertext, "base64").length;
    const tampered: SealedEnvelope[] = [
      { ...envelope, ciphertext: flipByte(envelope.ciphertext, 0) },
      { ...envelope, ciphertext: flipByte(envelope.ciphertext, ctLen - 1) },
      { ...envelope, nonce: flipByte(envelope.nonce, 3) },
      { ...envelope, nonce: Buffer.alloc(8).toString("base64") },
      { ...envelope, ciphertext: Buffer.alloc(16).toString("base64") },
    ];
    for (const [i, candidate] of tampered.entries()) {
      const opened = sealer.open(candidate);
      console.info("[phase:tamper]", JSON.stringify({ case: i, opened: opened !== null }));
      expect(opened).toBeNull();
    }
    expect(sealer.open(envelope)).not.toBeNull();
  });

  it("does not open an envelope sealed under another label's key derivation", () => {
    // Same AES-GCM construction, but the key and AAD use the desktop notifications' label instead of the remote one.
    const otherLabel = "sf-p2p-notify-v1";
    const raw = Buffer.from(KEY, "base64");
    const key = nodeCrypto.createHash("sha256").update(otherLabel).update(raw).digest();
    const nonce = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(otherLabel, "utf8"));
    const body = Buffer.concat([cipher.update(JSON.stringify(buildMessage("p", "t", { type: "stop" }, 1))), cipher.final()]);
    const envelope = { v: 1, nonce: nonce.toString("base64"), ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64") };
    const opened = createRemoteSealer(crypto, KEY).open(envelope);
    console.info("[phase:label] foreign label", JSON.stringify({ label: REMOTE_SEAL_LABEL, otherLabel, opened }));
    expect(opened).toBeNull();
  });

  it("returns null for a sealed payload that is not a valid message", () => {
    const sealer = createRemoteSealer(crypto, KEY);
    // Seal a non-message through the real sealer by smuggling an invalid body.
    const envelope = sealer.seal({ ...buildMessage("p", "t", { type: "hello" }, 1), body: { type: "rewind" } } as never);
    expect(sealer.open(envelope)).toBeNull();
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => createRemoteSealer(crypto, Buffer.alloc(16).toString("base64"))).toThrow("INVALID_KEY");
  });
});

describe("isSealedEnvelope", () => {
  it("accepts only the relay envelope shape", () => {
    const cases: Array<[unknown, boolean]> = [
      [{ v: 1, nonce: "a", ciphertext: "b" }, true],
      [{ v: 2, nonce: "a", ciphertext: "b" }, false],
      [{ v: 1, nonce: 1, ciphertext: "b" }, false],
      [{ v: 1, nonce: "a" }, false],
      [null, false],
      ["envelope", false],
    ];
    for (const [value, expected] of cases) {
      console.info("[phase:shape]", JSON.stringify({ value, expected }));
      expect(isSealedEnvelope(value)).toBe(expected);
    }
    expect(createRemoteSealer(crypto, KEY).open({ v: 2, nonce: "a", ciphertext: "b" })).toBeNull();
  });
});

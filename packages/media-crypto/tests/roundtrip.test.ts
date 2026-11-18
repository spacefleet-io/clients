/**
 * @test-id MEDIA-CRYPTO-ROUNDTRIP-001
 * @level unit
 * @why #928: encryptMediaObject now writes straight into one output buffer and feeds the cipher in 1 MiB steps
 *      instead of concatenating object-sized copies. Every object already in storage and every reader
 *      (retranscode, offline download, playback) depends on the exact format, so each size around the step
 *      boundary and each padding edge must still decrypt with decryptMediaObject to the same plaintext.
 * @covers packages/media-crypto/src/index.ts: encryptMediaObject, decryptMediaObject
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptMediaObject, encryptMediaObject } from "../src/index";

const MiB = 1024 * 1024;
// MAGIC 4 + salt 16 + nonce 12 + header 6 + tag 16
const OVERHEAD = 4 + 16 + 12 + 6 + 16;

describe("media object encryption", () => {
  const key = randomBytes(32);
  const keyB64 = key.toString("base64");

  it.each([
    [0, 0],
    [1, 0],
    [MiB - 1, 7],
    [MiB, 0],
    [MiB + 1, 0xffff],
    [4 * MiB + 17, 4096],
  ])("round-trips %i plaintext bytes with %i padding bytes", (size, padding) => {
    const plaintext = randomBytes(size);
    const sealed = encryptMediaObject(plaintext, key, padding);
    expect(sealed.byteLength).toBe(size + padding + OVERHEAD);
    expect(sealed.subarray(0, 4).toString("latin1")).toBe("SFV1");
    expect(decryptMediaObject(sealed, keyB64).equals(plaintext)).toBe(true);
  });

  it("uses a fresh salt and nonce per object", () => {
    const plaintext = randomBytes(64);
    const a = encryptMediaObject(plaintext, key, 0);
    const b = encryptMediaObject(plaintext, key, 0);
    expect(a.subarray(4, 32).equals(b.subarray(4, 32))).toBe(false);
  });

  it("rejects a wrong key, a tampered byte and an out-of-range padding", () => {
    const sealed = encryptMediaObject(randomBytes(2 * MiB + 3), key, 10);
    expect(() => decryptMediaObject(sealed, randomBytes(32).toString("base64"))).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[40] ^= 1;
    expect(() => decryptMediaObject(tampered, keyB64)).toThrow();
    expect(() => encryptMediaObject(randomBytes(4), key, 0x10000)).toThrow("media_object_padding_invalid");
    expect(() => encryptMediaObject(randomBytes(4), randomBytes(16), 0)).toThrow("media_key_missing");
  });
});

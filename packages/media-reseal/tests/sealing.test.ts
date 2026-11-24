import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { decryptContentObject, encryptContentObject } from "@space/content-core";
import { decryptMediaObject, encryptMediaObject } from "@space/media-crypto";
import { describe, expect, it } from "vitest";
import { importResealKey, importResealKeyFromBase64, resealObject, type ResealKeys } from "../src/sealing";

const sealEnvelope = (plain: Uint8Array, key: Buffer) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
};

const openEnvelope = (sealed: Uint8Array, key: Buffer) => {
  const bytes = Buffer.from(sealed);
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]);
};

const keysFor = async (from: Buffer, to: Buffer): Promise<ResealKeys> => ({
  // import wipes what it is given: hand it copies.
  from: await importResealKey(new Uint8Array(from)),
  to: await importResealKey(new Uint8Array(to)),
});

const plain = new TextEncoder().encode("a piece of a film, or a song, or a poster");

describe("resealObject (STOR-RESEAL-01/03/05)", () => {
  it("re-seals an SFV1 media object under the new key, same size and padding", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const stored = encryptMediaObject(plain, oldKey, 777);
    const outcome = await resealObject(await keysFor(oldKey, newKey), stored);
    if (outcome.kind !== "copied") throw new Error("expected a copy");
    expect(outcome.format).toBe("sfv1-media");
    expect(outcome.sealed.byteLength).toBe(stored.byteLength);
    expect(Buffer.from(decryptMediaObject(outcome.sealed, newKey.toString("base64")))).toEqual(Buffer.from(plain));
    expect(() => decryptMediaObject(outcome.sealed, oldKey.toString("base64"))).toThrow();
  });

  it("re-seals an SFV1 content object under the new key", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const stored = encryptContentObject(plain, oldKey.toString("base64"));
    const outcome = await resealObject(await keysFor(oldKey, newKey), stored);
    if (outcome.kind !== "copied") throw new Error("expected a copy");
    expect(outcome.format).toBe("sfv1-content");
    expect(outcome.sealed.byteLength).toBe(stored.byteLength);
    expect(Buffer.from(decryptContentObject(outcome.sealed, newKey.toString("base64")))).toEqual(Buffer.from(plain));
  });

  it("re-seals an envelope (artwork, covers) under the new key", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const stored = sealEnvelope(plain, oldKey);
    const outcome = await resealObject(await keysFor(oldKey, newKey), stored);
    if (outcome.kind !== "copied") throw new Error("expected a copy");
    expect(outcome.format).toBe("envelope");
    expect(outcome.sealed.byteLength).toBe(stored.byteLength);
    expect(openEnvelope(outcome.sealed, newKey)).toEqual(Buffer.from(plain));
  });

  it("calls an object the old key cannot open unreadable", async () => {
    const keys = await keysFor(randomBytes(32), randomBytes(32));
    expect(await resealObject(keys, randomBytes(300))).toEqual({ kind: "unreadable" });
    expect(await resealObject(keys, encryptMediaObject(plain, randomBytes(32), 0))).toEqual({ kind: "unreadable" });
    expect(await resealObject(keys, sealEnvelope(plain, randomBytes(32)))).toEqual({ kind: "unreadable" });
    expect(await resealObject(keys, new Uint8Array(0))).toEqual({ kind: "unreadable" });
  });

  it("imports the base64 key apps keep, and refuses a key of the wrong length", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const keys = { from: await importResealKeyFromBase64(oldKey.toString("base64")), to: await importResealKeyFromBase64(newKey.toString("base64")) };
    const outcome = await resealObject(keys, encryptMediaObject(plain, oldKey, 0));
    expect(outcome.kind).toBe("copied");
    await expect(importResealKey(new Uint8Array(16))).rejects.toThrow("library_key_invalid");
  });

  it("wipes the raw key it imports", async () => {
    const raw = new Uint8Array(randomBytes(32));
    await importResealKey(raw);
    expect(raw.every((b) => b === 0)).toBe(true);
  });
});

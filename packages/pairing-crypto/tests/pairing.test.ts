import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToBase64Url,
  formatShortCode,
  generateDeviceKeyPair,
  isSealedKey,
  normalizeShortCode,
  openSealedKey,
  buildPairLink,
  parseLegacyPairLink,
  parsePairLink,
  parsePairQrPayload,
  sealLibraryKey,
  shortCodeFromRandomBytes,
} from "../src";
import vectors from "./vectors.json";

/** @req PRIV-KEY-05 */
describe("sealed library key (contract v1)", () => {
  it("reproduces the published vector byte for byte", () => {
    const sealed = sealLibraryKey({
      devicePublicKey: vectors.devicePublicKey,
      requestId: vectors.requestId,
      libraryKey: vectors.libraryKey,
      ephemeralPrivateKey: vectors.ephemeralPrivateKey,
      iv: base64ToBytes(vectors.iv),
    });
    expect(sealed).toEqual(vectors.sealed);
  });

  it("opens the published vector with the device private key", () => {
    const key = openSealedKey({
      devicePrivateKey: vectors.devicePrivateKey,
      requestId: vectors.requestId,
      sealed: vectors.sealed as never,
    });
    expect(bytesToBase64(key)).toBe(vectors.libraryKey);
  });

  it("round-trips with fresh random keys and never repeats iv/epk", () => {
    const device = generateDeviceKeyPair();
    const libraryKey = crypto.getRandomValues(new Uint8Array(32));
    const a = sealLibraryKey({ devicePublicKey: device.publicKey, requestId: "req-1", libraryKey });
    const b = sealLibraryKey({ devicePublicKey: device.publicKey, requestId: "req-1", libraryKey });
    expect(a.iv).not.toBe(b.iv);
    expect(a.epk).not.toBe(b.epk);
    expect(isSealedKey(a)).toBe(true);
    expect(openSealedKey({ devicePrivateKey: device.privateKey, requestId: "req-1", sealed: a })).toEqual(libraryKey);
  });

  it("refuses another request id, another device, or a tampered blob", () => {
    const device = generateDeviceKeyPair();
    const other = generateDeviceKeyPair();
    const libraryKey = crypto.getRandomValues(new Uint8Array(32));
    const sealed = sealLibraryKey({ devicePublicKey: device.publicKey, requestId: "req-1", libraryKey });
    expect(() => openSealedKey({ devicePrivateKey: device.privateKey, requestId: "req-2", sealed })).toThrow();
    expect(() => openSealedKey({ devicePrivateKey: other.privateKey, requestId: "req-1", sealed })).toThrow();
    const ct = base64ToBytes(sealed.ct);
    ct[0] = ct[0]! ^ 1;
    expect(() =>
      openSealedKey({ devicePrivateKey: device.privateKey, requestId: "req-1", sealed: { ...sealed, ct: bytesToBase64(ct) } }),
    ).toThrow();
  });

  it("rejects malformed inputs", () => {
    expect(isSealedKey({ v: 1, epk: "AA==", iv: "AA==", ct: "AA==" })).toBe(false);
    expect(isSealedKey(null)).toBe(false);
    expect(() => sealLibraryKey({ devicePublicKey: "AAAA", requestId: "r", libraryKey: vectors.libraryKey })).toThrow();
  });
});

describe("base64", () => {
  it("matches Buffer for every tail length and accepts url-safe", () => {
    for (let n = 0; n < 40; n += 1) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
      expect(bytesToBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
      expect(base64ToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
    expect(() => base64ToBytes("a$b=")).toThrow();
  });
});

/** @req ACCT-PAIR-01 */
describe("short code + QR payload", () => {
  it("normalises, folds look-alikes and rejects bad input (shared vectors)", () => {
    for (const c of vectors.shortCodes) {
      expect(normalizeShortCode(c.input)).toBe(c.normalized);
      if (c.normalized && "formatted" in c) expect(formatShortCode(c.normalized)).toBe(c.formatted);
    }
  });

  it("parses QR payloads (shared vectors)", () => {
    for (const q of vectors.qrPayloads) expect(parsePairQrPayload(q.payload)).toBe(q.code);
  });

  it("derives codes only from the safe alphabet", () => {
    const code = shortCodeFromRandomBytes(crypto.getRandomValues(new Uint8Array(8)));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/u);
    expect(normalizeShortCode(code)).toBe(code);
  });
});

/** @req ACCT-PAIR-06[api,badger-mobile,parrot] */
describe("pairing QR link names the asking app", () => {
  it("builds a web link under /pair/<app> on the website", () => {
    expect(buildPairLink("https://spacefleet.io", "parrot", "ABCDEFGH")).toBe("https://spacefleet.io/pair/parrot?code=ABCD-EFGH");
    expect(buildPairLink("https://spacefleet.io/", "badger", "ABCDEFGH")).toBe("https://spacefleet.io/pair/badger?code=ABCD-EFGH");
    expect(buildPairLink("http://localhost:5173", "parrot", "ABCDEFGH")).toBe("http://localhost:5173/pair/parrot?code=ABCD-EFGH");
  });

  it("reads the app and the code back from a link (shared vectors)", () => {
    for (const q of vectors.qrPayloads) {
      const parsed = parsePairLink(q.payload);
      console.info("pair-link.vector", JSON.stringify({ payload: q.payload, parsed }));
      expect(parsed).toEqual(q.app === null ? null : { app: q.app, code: q.code });
    }
  });

  it("round-trips every app's link", () => {
    for (const app of ["badger", "parrot"] as const) {
      expect(parsePairLink(buildPairLink("https://spacefleet.io", app, "0123ABCD"))).toEqual({ app, code: "0123ABCD" });
    }
  });
});

/** @req ACCT-PAIR-06[badger-mobile,parrot] */
describe("QR of desktops released before the web link", () => {
  it("still reads spacebadger://pair?code= to its code until those desktops are unsupported", () => {
    const cases: Array<[string, string | null]> = [
      ["spacebadger://pair?code=ABCD-EFGH", "ABCDEFGH"],
      ["spacebadger://pair?code=abcdefgh", "ABCDEFGH"],
      ["spacebadger://pair/?x=1&code=ABCD-EFGH", "ABCDEFGH"],
      ["spacebadger://pair?code=nope", null],
      ["spacebadger://auth/provider?code=ABCDEFGH", null],
      ["parrot://pair?code=ABCDEFGH", null],
      ["https://spacefleet.io/pair/parrot?code=ABCD-EFGH", null],
    ];
    for (const [payload, code] of cases) {
      const legacy = parseLegacyPairLink(payload);
      console.info("pair-link.legacy", JSON.stringify({ payload, legacy, scanned: parsePairQrPayload(payload) }));
      expect(legacy).toBe(code);
      if (code) expect(parsePairQrPayload(payload)).toBe(code);
    }
  });
});

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Buffer } from "buffer";

/**
 * @test-id MOBILE-POLYFILL-001
 * @level unit
 * @why Hermes (React Native's JS engine) lacks TextEncoder, TextDecoder, and crypto.subtle.
 *   These polyfills are defined in index.js and must produce identical output to Node.js built-ins.
 *   Mismatches cause checksum failures in storage tunnel downloads.
 */

// Simulate the polyfills from index.js (these run in Node where the real APIs exist,
// so we test the polyfill implementations directly)
class PolyfillTextEncoder {
  encode(str: string) {
    return new Uint8Array(Buffer.from(str, "utf-8"));
  }
}

class PolyfillTextDecoder {
  decode(buf: Uint8Array | ArrayBuffer) {
    return Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString("utf-8");
  }
}

const polyfillDigest = async (algorithm: string, data: ArrayBuffer) => {
  const algo = algorithm.replace("-", "").toLowerCase();
  const hash = createHash(algo);
  hash.update(Buffer.from(data));
  return hash.digest().buffer;
};

const bytesToHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// On a polyfill/native mismatch, dump both byte arrays (hex + length) so the
// exact divergence point is visible without re-running under a debugger.
const dumpBytesSnapshot = (
  label: string,
  ctx: { input?: string; polyfill?: Uint8Array; native?: Uint8Array; expectedHex?: string },
) => {
  try {
    console.error(`=== [polyfills:${label}] snapshot ===`);
    if (ctx.input !== undefined) console.error(`input=${JSON.stringify(ctx.input)} (len=${ctx.input.length})`);
    if (ctx.polyfill) console.error(`polyfill: len=${ctx.polyfill.length} hex=${bytesToHex(ctx.polyfill)}`);
    if (ctx.native) console.error(`native:   len=${ctx.native.length} hex=${bytesToHex(ctx.native)}`);
    if (ctx.expectedHex) console.error(`expectedHex=${ctx.expectedHex}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("Hermes polyfills", () => {
  describe("TextEncoder", () => {
    it("encodes ASCII string to correct bytes", () => {
      console.info(`[polyfills:encode-ascii] comparing polyfill vs native TextEncoder`);
      const polyfill = new PolyfillTextEncoder();
      const native = new TextEncoder();
      const input = "hello world";
      const p = polyfill.encode(input);
      const n = native.encode(input);
      if (bytesToHex(p) !== bytesToHex(n)) dumpBytesSnapshot("encode-ascii", { input, polyfill: p, native: n });
      expect(p).toEqual(n);
    });

    it("encodes UTF-8 multi-byte characters", () => {
      console.info(`[polyfills:encode-utf8] comparing polyfill vs native on multi-byte input`);
      const polyfill = new PolyfillTextEncoder();
      const native = new TextEncoder();
      const input = "caf\u00e9 \u2603 \ud83d\ude00";
      const p = polyfill.encode(input);
      const n = native.encode(input);
      if (bytesToHex(p) !== bytesToHex(n)) dumpBytesSnapshot("encode-utf8", { input, polyfill: p, native: n });
      expect(p).toEqual(n);
    });

    it("encodes empty string", () => {
      console.info(`[polyfills:encode-empty] encoding empty string`);
      const polyfill = new PolyfillTextEncoder();
      const p = polyfill.encode("");
      if (p.length !== 0) dumpBytesSnapshot("encode-empty", { input: "", polyfill: p });
      expect(p).toEqual(new Uint8Array(0));
    });

    it("encodes JSON-serializable content (used by storageTunnel)", () => {
      console.info(`[polyfills:encode-json] comparing polyfill vs native on session.start JSON`);
      const polyfill = new PolyfillTextEncoder();
      const native = new TextEncoder();
      const json = JSON.stringify({ kind: "session.start", sessionId: "abc-123", token: "tok" });
      const p = polyfill.encode(json);
      const n = native.encode(json);
      if (bytesToHex(p) !== bytesToHex(n)) dumpBytesSnapshot("encode-json", { input: json, polyfill: p, native: n });
      expect(p).toEqual(n);
    });
  });

  describe("TextDecoder", () => {
    it("decodes Uint8Array to correct string", () => {
      console.info(`[polyfills:decode-uint8] comparing polyfill vs native TextDecoder`);
      const polyfill = new PolyfillTextDecoder();
      const native = new TextDecoder();
      const bytes = new Uint8Array([104, 101, 108, 108, 111]);
      const p = polyfill.decode(bytes);
      const n = native.decode(bytes);
      if (p !== n) {
        console.error(`=== [polyfills:decode-uint8] snapshot ===`);
        console.error(`bytes=${bytesToHex(bytes)} polyfill=${JSON.stringify(p)} native=${JSON.stringify(n)}`);
      }
      expect(p).toBe(n);
    });

    it("decodes UTF-8 multi-byte characters", () => {
      console.info(`[polyfills:decode-utf8] comparing polyfill vs native on multi-byte bytes`);
      const polyfill = new PolyfillTextDecoder();
      const native = new TextDecoder();
      const bytes = new TextEncoder().encode("caf\u00e9");
      const p = polyfill.decode(bytes);
      const n = native.decode(bytes);
      if (p !== n) {
        console.error(`=== [polyfills:decode-utf8] snapshot ===`);
        console.error(`bytes=${bytesToHex(bytes)} polyfill=${JSON.stringify(p)} native=${JSON.stringify(n)}`);
      }
      expect(p).toBe(n);
    });

    it("decodes ArrayBuffer", () => {
      console.info(`[polyfills:decode-arraybuffer] decoding from ArrayBuffer-backed Uint8Array`);
      const polyfill = new PolyfillTextDecoder();
      const buf = new TextEncoder().encode("test").buffer;
      const p = polyfill.decode(new Uint8Array(buf));
      if (p !== "test") {
        console.error(`=== [polyfills:decode-arraybuffer] snapshot ===`);
        console.error(`polyfill=${JSON.stringify(p)} expected="test"`);
      }
      expect(p).toBe("test");
    });
  });

  describe("crypto.subtle.digest", () => {
    it("produces correct SHA-256 for known input", async () => {
      console.info(`[polyfills:digest-known] hashing [1,2,3] expecting fixed digest`);
      const data = new Uint8Array([1, 2, 3]);
      const result = await polyfillDigest("SHA-256", data.buffer);
      const hex = bytesToHex(new Uint8Array(result));
      const expectedHex = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
      if (hex !== expectedHex) {
        console.error(`=== [polyfills:digest-known] snapshot ===`);
        console.error(`actualHex=${hex} expectedHex=${expectedHex}`);
      }
      expect(hex).toBe(expectedHex);
    });

    it("matches Node crypto for random data", async () => {
      console.info(`[polyfills:digest-random] hashing 256-byte ramp, comparing polyfill vs node`);
      const data = new Uint8Array(256);
      for (let i = 0; i < 256; i++) data[i] = i;

      const polyfillResult = await polyfillDigest("SHA-256", data.buffer);
      const nodeHash = createHash("sha256").update(Buffer.from(data)).digest();

      const pHex = bytesToHex(new Uint8Array(polyfillResult));
      const nHex = bytesToHex(new Uint8Array(nodeHash));
      if (pHex !== nHex) {
        console.error(`=== [polyfills:digest-random] snapshot ===`);
        console.error(`polyfillHex=${pHex} nodeHex=${nHex}`);
      }
      expect(pHex).toBe(nHex);
    });

    it("handles hyphenated algorithm name (SHA-256)", async () => {
      console.info(`[polyfills:digest-hyphenated-algo] verifying "SHA-256" name maps to a 32-byte digest`);
      const data = new Uint8Array([42]);
      const result = await polyfillDigest("SHA-256", data.buffer);
      const len = new Uint8Array(result).byteLength;
      if (len !== 32) {
        console.error(`=== [polyfills:digest-hyphenated-algo] snapshot ===`);
        console.error(`byteLength=${len} expected=32 hex=${bytesToHex(new Uint8Array(result))}`);
      }
      expect(len).toBe(32);
    });

    it("produces correct hash for empty input", async () => {
      console.info(`[polyfills:digest-empty] hashing empty ArrayBuffer expecting fixed digest`);
      const result = await polyfillDigest("SHA-256", new ArrayBuffer(0));
      const hex = bytesToHex(new Uint8Array(result));
      const expectedHex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      if (hex !== expectedHex) {
        console.error(`=== [polyfills:digest-empty] snapshot ===`);
        console.error(`actualHex=${hex} expectedHex=${expectedHex}`);
      }
      expect(hex).toBe(expectedHex);
    });

    it("produces correct hash for large input (192KB, typical chunk size)", async () => {
      const size = 192 * 1024;
      console.info(`[polyfills:digest-large] hashing ${size}-byte ramp, comparing polyfill vs node`);
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) data[i] = i & 0xff;

      const polyfillResult = await polyfillDigest("SHA-256", data.buffer);
      const nodeHash = createHash("sha256").update(Buffer.from(data)).digest();

      const pHex = bytesToHex(new Uint8Array(polyfillResult));
      const nHex = bytesToHex(new Uint8Array(nodeHash));
      if (pHex !== nHex) {
        console.error(`=== [polyfills:digest-large] snapshot ===`);
        console.error(`size=${size} polyfillHex=${pHex} nodeHex=${nHex}`);
      }
      expect(pHex).toBe(nHex);
    });
  });
});

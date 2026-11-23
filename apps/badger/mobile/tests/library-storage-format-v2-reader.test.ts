/**
 * @test-id MOBILE-LIB-FMT-V2-READER-001
 * @level unit
 * @req LIB-FMT-07
 *
 * @why Storage format v2 compresses the plaintext inside the AES-GCM envelope (a 3-byte frame header
 *   `00 5A 01` plus raw DEFLATE). The phone must read both: a compressed snapshot decrypted by the
 *   native module is inflated in place, a v1 snapshot is left byte-for-byte alone, and a compressed
 *   op fetched by sync is inflated before JSON.parse while plain v1 ops still parse.
 */
import { describe, expect, it, vi } from "vitest";
import { deflateSync } from "fflate";

const TAG = "[MOBILE-LIB-FMT-V2-READER-001]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const fs = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), nextDecrypted: new Uint8Array() }));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("react-native-quick-crypto", () => ({ default: {} }));
vi.mock("react-native-fs", () => ({
  default: {
    read: async (path: string, length: number, position: number) =>
      Buffer.from(fs.files.get(path)!.subarray(position, position + length)).toString("base64"),
    readFile: async (path: string) => Buffer.from(fs.files.get(path)!).toString("base64"),
    writeFile: async (path: string, data: string) => {
      fs.files.set(path, new Uint8Array(Buffer.from(data, "base64")));
    },
  },
}));
vi.mock("../src/native/LibrarySync", () => {
  const decrypt = async (_source: string, _key: string, target: string) => {
    fs.files.set(target, fs.nextDecrypted);
  };
  return {
    encryptLibraryToBinaryFile: vi.fn(),
    decryptLibraryFromBinaryFile: decrypt,
    decryptLibraryFromFile: decrypt,
    onLibrarySyncProgress: () => ({ remove: () => undefined }),
    sha256File: vi.fn(),
  };
});
vi.mock("../src/lib/library/transport", () => ({ CHUNK_SIZE_BYTES: 1024, downloadObjectViaTunnel: vi.fn() }));
vi.mock("../src/lib/crypto", () => ({
  decryptBytesToBytes: vi.fn(),
  encryptBytesToBase64: vi.fn(),
  encryptBytesToBytes: vi.fn(),
}));

import { fetchOpPayloads } from "@space/mobile-shell/libraryOps";
import { decryptFileToDb } from "../src/lib/library/snapshot";

const frame = (plain: Uint8Array) => {
  const body = deflateSync(plain, { level: 6 });
  const out = new Uint8Array(3 + body.length);
  out.set([0x00, 0x5a, 0x01]);
  out.set(body, 3);
  return out;
};

const fakeSqlite = () => {
  const bytes = new Uint8Array(40_000);
  bytes.set(new TextEncoder().encode("SQLite format 3\0"));
  for (let i = 16; i < bytes.length; i += 1) bytes[i] = i % 7;
  return bytes;
};

describe("mobile reads storage format v2 (LIB-FMT-07)", () => {
  it("inflates a compressed snapshot after native decrypt", async () => {
    const db = fakeSqlite();
    const framed = frame(db);
    log("phase:compressed snapshot", { dbBytes: db.length, framedBytes: framed.length });
    fs.nextDecrypted = framed;
    await decryptFileToDb("key", "/enc", "/db", "binary");
    const out = fs.files.get("/db")!;
    log("state:db", { bytes: out.length });
    expect(framed.length).toBeLessThan(db.length / 2);
    expect(Buffer.from(out).equals(Buffer.from(db))).toBe(true);
  });

  it("leaves a v1 (uncompressed) snapshot untouched", async () => {
    const db = fakeSqlite();
    log("phase:v1 snapshot", { dbBytes: db.length });
    fs.nextDecrypted = db;
    await decryptFileToDb("key", "/enc", "/db1", "base64");
    expect(Buffer.from(fs.files.get("/db1")!).equals(Buffer.from(db))).toBe(true);
  });

  it("parses compressed and plain ops in one fetch", async () => {
    const big = { id: "a", type: "media.progress", payload: { pad: "x".repeat(2000) } };
    const small = { id: "b", type: "media.progress", payload: { progressPct: 5 } };
    const plains = new Map([
      ["k1", frame(new TextEncoder().encode(JSON.stringify(big)))],
      ["k2", new TextEncoder().encode(JSON.stringify(small))],
    ]);
    log("phase:ops", { framedBytes: plains.get("k1")!.length });
    const ops = await fetchOpPayloads(
      [
        { opId: "a", version: 1, createdAt: "", size: 0, objectKey: "k1" },
        { opId: "b", version: 2, createdAt: "", size: 0, objectKey: "k2" },
      ],
      {
        download: async (key) => plains.get(key)!,
        decrypt: async (bytes) => bytes,
        decode: (bytes) => new TextDecoder().decode(bytes),
      }
    );
    log("state:ops", ops);
    expect(ops).toEqual([big, small]);
  });
});

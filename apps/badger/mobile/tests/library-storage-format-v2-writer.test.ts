/**
 * @test-id MOBILE-LIB-FMT-V2-WRITER-001
 * @level unit
 * @req LIB-FMT-07
 *
 * @why Storage format v2 compresses the plaintext BEFORE the AES-GCM envelope (a 3-byte frame header `00 5A 01`
 *   plus raw DEFLATE). The phone read v2 since #669; it must also write it, or every snapshot it publishes and
 *   every change it sends costs the full uncompressed size on the wire. Snapshots go through the native
 *   encryptor, so the framed bytes are staged in a temp file the native call reads, and the temp file is removed.
 *   Every change is framed, small ones included (a progress op is ~150 B).
 */
import { describe, expect, it, vi } from "vitest";
import { decodeCompressedFrame, isCompressedFrame } from "@space/library-db-definition/payloadCompression";
import { fflateCodec } from "@space/mobile-shell/libraryOps";

const TAG = "[MOBILE-LIB-FMT-V2-WRITER-001]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const h = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  nativeInputs: [] as Array<{ source: string; bytes: Uint8Array }>,
  nativeFails: false,
  jsEncrypted: [] as Uint8Array[],
}));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("react-native-quick-crypto", () => ({ default: {} }));
vi.mock("react-native-fs", () => ({
  default: {
    readFile: async (path: string) => Buffer.from(h.files.get(path)!).toString("base64"),
    writeFile: async (path: string, data: string) => {
      h.files.set(path, new Uint8Array(Buffer.from(data, "base64")));
    },
    unlink: async (path: string) => {
      h.files.delete(path);
    },
  },
}));
vi.mock("../src/native/LibrarySync", () => ({
  encryptLibraryToBinaryFile: async (source: string, _key: string, target: string) => {
    if (h.nativeFails) throw new Error("NATIVE_ENCRYPT_UNAVAILABLE");
    const bytes = h.files.get(source)!;
    h.nativeInputs.push({ source, bytes });
    h.files.set(target, new Uint8Array([0xee, ...bytes]));
  },
  decryptLibraryFromBinaryFile: vi.fn(),
  decryptLibraryFromFile: vi.fn(),
  onLibrarySyncProgress: () => ({ remove: () => undefined }),
  sha256File: vi.fn(),
}));
vi.mock("../src/lib/library/transport", () => ({ CHUNK_SIZE_BYTES: 1024, downloadObjectViaTunnel: vi.fn() }));
vi.mock("../src/lib/crypto", () => ({
  decryptBytesToBytes: vi.fn(),
  encryptBytesToBase64: vi.fn(),
  // identity "encryption" tagged with a leading 0xee so the test can tell it ran after compression
  encryptBytesToBytes: async (_key: string, bytes: Uint8Array) => {
    h.jsEncrypted.push(bytes);
    return new Uint8Array([0xee, ...bytes]);
  },
}));

import { encryptDbToBinaryFile } from "../src/lib/library/snapshot";
import { encryptOpPayload } from "../src/lib/library/opPayload";

const fakeSqlite = () => {
  const bytes = new Uint8Array(60_000);
  bytes.set(new TextEncoder().encode("SQLite format 3\0"));
  for (let i = 16; i < bytes.length; i += 1) bytes[i] = i % 7;
  return bytes;
};

describe("mobile writes storage format v2 (LIB-FMT-07)", () => {
  it("a snapshot is compressed before the native encryptor sees it, and the staging file is removed", async () => {
    const db = fakeSqlite();
    h.files.set("/db", db);
    log("phase:snapshot", { dbBytes: db.length });
    await encryptDbToBinaryFile("/db", "key", "/out");
    const input = h.nativeInputs[0];
    log("state:snapshot", { nativeInputBytes: input?.bytes.length, files: [...h.files.keys()] });
    expect(input, "the native encryptor ran").toBeDefined();
    expect(isCompressedFrame(input!.bytes), "it was handed a compressed frame, not the SQLite file").toBe(true);
    expect(input!.bytes.length).toBeLessThan(db.length / 2);
    expect(Buffer.from(decodeCompressedFrame(input!.bytes, fflateCodec)).equals(Buffer.from(db)), "inflates back to the DB").toBe(true);
    expect(h.files.has(input!.source), "the staging file is gone").toBe(false);
    expect(h.files.has("/out"), "the encrypted target was written").toBe(true);
    expect(h.files.get("/db"), "the source DB is untouched").toEqual(db);
  });

  it("the JS fallback encrypts the compressed frame too, and the staging file is still removed", async () => {
    h.nativeFails = true;
    h.jsEncrypted.length = 0;
    h.nativeInputs.length = 0;
    const db = fakeSqlite();
    h.files.set("/db2", db);
    log("phase:snapshot fallback");
    try {
      await encryptDbToBinaryFile("/db2", "key", "/out2");
    } finally {
      h.nativeFails = false;
    }
    const encrypted = h.jsEncrypted[0];
    log("state:fallback", { encryptedBytes: encrypted?.length, files: [...h.files.keys()] });
    expect(encrypted && isCompressedFrame(encrypted)).toBe(true);
    expect(h.files.get("/out2")?.[0], "the fallback result is what lands in the target").toBe(0xee);
    expect([...h.files.keys()].filter((path) => path.startsWith("/db2")), "no staging file left behind").toEqual(["/db2"]);
  });

  it("every change is framed then encrypted, a 150-byte progress op included", async () => {
    h.jsEncrypted.length = 0;
    const small = new TextEncoder().encode(JSON.stringify({ id: "a", type: "media.progress", payload: { progressPct: 5 } }));
    const big = new TextEncoder().encode(JSON.stringify({ id: "b", type: "media.upsert", payload: { pad: "x".repeat(3000) } }));
    for (const plain of [small, big]) {
      const sealed = await encryptOpPayload("key", plain);
      const framed = h.jsEncrypted[h.jsEncrypted.length - 1]!;
      log("state:op", { plainBytes: plain.length, framedBytes: framed.length, sealedBytes: sealed.length });
      expect(isCompressedFrame(framed), `a ${plain.length} B op is framed`).toBe(true);
      expect(Buffer.from(decodeCompressedFrame(framed, fflateCodec)).equals(Buffer.from(plain))).toBe(true);
      expect(sealed[0], "encryption ran on the frame").toBe(0xee);
    }
    expect(h.jsEncrypted[1]!.length, "a large op shrinks").toBeLessThan(big.length / 4);
  });
});

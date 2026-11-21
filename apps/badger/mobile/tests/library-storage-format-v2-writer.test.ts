/**
 * @test-id MOBILE-LIB-FMT-V2-WRITER-001
 * @level unit
 * @req LIB-FMT-07
 * @req LIB-SYNC-14
 * @bugfix @regression-proof
 *
 * @why Storage format v2 compresses the plaintext BEFORE the AES-GCM envelope (a 3-byte frame header `00 5A 01`
 *   plus raw DEFLATE). The phone read v2 since #669; it must also write it, or every snapshot it publishes and
 *   every change it sends costs the full uncompressed size on the wire. A snapshot is built by the native module in
 *   one streaming pass (SnapshotCodecTest checks its bytes): reading the SQLite file into JS to frame it threw
 *   OutOfMemoryError and froze the UI 52 s on a 60 MB library, so the JS side must never read the database.
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
  jsReads: [] as string[],
  nativeCalls: [] as Array<{ dbPath: string; key: string; target: string }>,
  jsEncrypted: [] as Uint8Array[],
}));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("react-native-quick-crypto", () => ({ default: {} }));
vi.mock("react-native-fs", () => ({
  default: {
    readFile: async (path: string) => {
      h.jsReads.push(path);
      return Buffer.from(h.files.get(path)!).toString("base64");
    },
    read: async (path: string) => {
      h.jsReads.push(path);
      return "";
    },
    writeFile: async (path: string, data: string) => {
      h.files.set(path, new Uint8Array(Buffer.from(data, "base64")));
    },
    unlink: async (path: string) => {
      h.files.delete(path);
    },
  },
}));
vi.mock("../src/native/LibrarySync", () => ({
  encryptSnapshotFile: async (dbPath: string, key: string, target: string) => {
    h.nativeCalls.push({ dbPath, key, target });
    h.files.set(target, new Uint8Array([0xee]));
    return { dbBytes: h.files.get(dbPath)!.length, storedBytes: 1, compressed: true, ms: 1 };
  },
  decryptSnapshotFile: vi.fn(),
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
  it("a snapshot is built by the native streaming codec; JS never reads the database", async () => {
    const db = fakeSqlite();
    h.files.set("/db", db);
    log("phase:snapshot", { dbBytes: db.length });
    const result = await encryptDbToBinaryFile("/db", "key", "/out");
    log("state:snapshot", { nativeCalls: h.nativeCalls, jsReads: h.jsReads, result });
    expect(h.nativeCalls, "one native call, straight from the SQLite file").toEqual([{ dbPath: "/db", key: "key", target: "/out" }]);
    expect(h.jsReads, "the database never crosses into JS").toEqual([]);
    expect(h.jsEncrypted, "no JS encryption of the snapshot").toEqual([]);
    expect([...h.files.keys()].sort(), "no staging file").toEqual(["/db", "/out"]);
    expect(result.dbBytes).toBe(db.length);
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

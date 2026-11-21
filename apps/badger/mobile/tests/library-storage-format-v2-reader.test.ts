/**
 * @test-id MOBILE-LIB-FMT-V2-READER-001
 * @level unit
 * @req LIB-FMT-07
 *
 * @why Storage format v2 compresses the plaintext inside the AES-GCM envelope (a 3-byte frame header
 *   `00 5A 01` plus raw DEFLATE). The phone must read both: a saved copy is decrypted AND inflated by the native
 *   module in one pass (SnapshotCodecTest checks v2 and v1 bytes; inflating in JS froze the UI ~17 s on a 16 MB
 *   copy, LIB-SYNC-14), so JS only hands over paths; a compressed op fetched by sync is inflated before JSON.parse
 *   while plain v1 ops still parse.
 */
import { describe, expect, it, vi } from "vitest";
import { deflateSync } from "fflate";

const TAG = "[MOBILE-LIB-FMT-V2-READER-001]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const fs = vi.hoisted(() => ({ jsReads: [] as string[], nativeCalls: [] as string[][] }));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("react-native-quick-crypto", () => ({ default: {} }));
vi.mock("react-native-fs", () => ({
  default: {
    read: async (path: string) => {
      fs.jsReads.push(path);
      return "";
    },
    readFile: async (path: string) => {
      fs.jsReads.push(path);
      return "";
    },
  },
}));
vi.mock("../src/native/LibrarySync", () => ({
  encryptSnapshotFile: vi.fn(),
  decryptSnapshotFile: async (source: string, key: string, target: string) => {
    fs.nativeCalls.push([source, key, target]);
    return { dbBytes: 40_000, storedBytes: 9_000, compressed: true, ms: 3 };
  },
  onLibrarySyncProgress: () => ({ remove: () => undefined }),
  sha256File: vi.fn(),
}));
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

describe("mobile reads storage format v2 (LIB-FMT-07)", () => {
  it("a saved copy is decrypted and inflated natively; JS never reads it", async () => {
    await decryptFileToDb("key", "/enc", "/db");
    log("state:snapshot", { nativeCalls: fs.nativeCalls, jsReads: fs.jsReads });
    expect(fs.nativeCalls).toEqual([["/enc", "key", "/db"]]);
    expect(fs.jsReads, "no JS read of the copy or the DB").toEqual([]);
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

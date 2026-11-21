/**
 * @test-id MOBILE-LIBRARY-FILE-SLICES-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: while the library snapshot flushed, the JS thread froze for ~3 s per 4 MiB chunk on a
 * OnePlus 6 (profile build): `RNFS.read(..., "base64")` of a whole chunk, the base64 decode, and a JS
 * sha256 of the bytes all ran on the JS thread in one piece. Hashes are now computed natively
 * (`sha256File`, nothing crosses the bridge) and the bytes JS still needs move in 64 KB slices with an
 * asynchronous native call between them, so touches and animation frames are served in between.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import type { TunnelUploadSource } from "@space/shared/storageTunnel";
import { buildChunkIndexFromFile, buildManifest, hashDbFile } from "../src/lib/library/snapshot";
import {
  DOWNLOAD_WRITE_SLICE_BYTES,
  FILE_SLICE_BYTES,
  UPLOAD_FRAME_BYTES,
  downloadChunksToFile,
  encodeBase64,
  readFileChunk,
  uploadChunksFromFile,
  uploadObjectViaTunnel,
} from "../src/lib/library/transport";

const h = vi.hoisted(() => ({
  reads: [] as Array<{ length: number; position: number; encoding: string }>,
  placed: [] as Array<{ path: string; base64: string; position: number }>,
  objects: new Map<string, { bytes: Uint8Array; ready: Promise<void> }>(),
  writes: [] as Array<{ path: string; data: string }>,
  readFile: new Uint8Array(0),
  sha256File: vi.fn(),
  downloaded: new Uint8Array(0),
  uploadOptions: null as null | { chunkSize?: number; checksumFn?: (chunk: Uint8Array, seq: number) => string | Promise<string> },
  uploadPayload: null as TunnelUploadSource | null,
  buildWsMessage: vi.fn(),
  buildUploadFrameBlob: vi.fn(async (..._args: unknown[]) => ({ blobId: "blob-1", size: 600 })),
  blob: { close: vi.fn() },
  createFromOptions: vi.fn((..._args: unknown[]) => h.blob),
}));

vi.mock("react-native-fs", () => ({
  default: {
    read: async (_path: string, length: number, position: number, encoding: string) => {
      h.reads.push({ length, position, encoding });
      return Buffer.from(h.readFile.subarray(position, position + length)).toString("base64");
    },
    readFile: async () => {
      throw new Error("whole-file reads must not happen");
    },
    writeFile: async (path: string, data: string) => {
      h.writes.push({ path, data });
    },
    appendFile: async () => {
      throw new Error("downloads write at fixed offsets, never append");
    },
    write: async (path: string, base64: string, position: number, encoding: string) => {
      expect(encoding).toBe("base64");
      h.placed.push({ path, base64, position });
    },
  },
}));
vi.mock("../src/native/LibrarySync", () => ({
  encryptLibraryToBinaryFile: vi.fn(),
  decryptLibraryFromBinaryFile: vi.fn(),
  decryptLibraryFromFile: vi.fn(),
  onLibrarySyncProgress: vi.fn(),
  sha256File: (...args: unknown[]) => h.sha256File(...args),
  buildUploadFrameBlob: (...args: unknown[]) => h.buildUploadFrameBlob(...args),
}));
vi.mock("@space/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    downloadStorageObjectViaTunnel: async (_token: string, key: string) => {
      const object = h.objects.get(key);
      if (!object) return h.downloaded;
      await object.ready;
      return object.bytes;
    },
    uploadStorageObjectViaTunnel: async (_token: string, _key: string, payload: TunnelUploadSource, options: typeof h.uploadOptions) => {
      h.uploadOptions = options;
      h.uploadPayload = payload;
    },
  };
});
vi.mock("react-native/Libraries/Blob/BlobManager", () => ({
  default: { createFromOptions: (...args: unknown[]) => h.createFromOptions(...args) },
}));
vi.mock("react-native-quick-crypto", () => ({
  default: { createHash: () => ({ update: () => ({ digest: () => "digest" }) }) },
}));
vi.mock("../src/lib/crypto", () => ({
  decryptBytesToBytes: vi.fn(),
  encryptBytesToBase64: vi.fn(),
  encryptBytesToBytes: vi.fn(),
}));

beforeEach(() => {
  h.reads.length = 0;
  h.placed.length = 0;
  h.objects.clear();
  h.writes.length = 0;
  h.sha256File.mockReset();
  h.buildUploadFrameBlob.mockClear();
  h.createFromOptions.mockClear();
  h.blob.close.mockClear();
  h.uploadPayload = null;
});

const pattern = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + 7) % 251);

describe("snapshot file handling keeps bytes off the JS thread", () => {
  it("@bugfix @regression-proof buildChunkIndexFromFile asks native code for the hashes and never reads the file", async () => {
    h.sha256File.mockResolvedValue({
      size: 10,
      hash: "whole",
      chunks: [
        { size: 4, hash: "a" },
        { size: 4, hash: "b" },
        { size: 2, hash: "c" },
      ],
    });

    const index = await buildChunkIndexFromFile("/docs/library/cache.blob");

    expect(h.sha256File).toHaveBeenCalledTimes(1);
    expect(h.sha256File).toHaveBeenCalledWith("/docs/library/cache.blob", 4 * 1024 * 1024);
    expect(h.reads).toEqual([]);
    expect(index).toEqual({
      totalSize: 10,
      chunks: [
        { index: 0, hash: "a", size: 4, offset: 0 },
        { index: 1, hash: "b", size: 4, offset: 4 },
        { index: 2, hash: "c", size: 2, offset: 8 },
      ],
    });
  });

  it("@bugfix @regression-proof hashDbFile hashes the plaintext DB natively, without per-chunk hashes", async () => {
    h.sha256File.mockResolvedValue({ size: 8_000_000, hash: "db-hash", chunks: [] });

    const db = await hashDbFile("/db/library.snapshot.sqlite");

    expect(h.sha256File).toHaveBeenCalledWith("/db/library.snapshot.sqlite", 0);
    expect(db).toEqual({ sizeBytes: 8_000_000, hash: "db-hash" });
    const manifest = buildManifest("snap-1", db, [{ index: 0, hash: "a", size: 4 }]);
    expect(manifest.dbSizeBytes).toBe(8_000_000);
    expect(manifest.dbHash).toBe("db-hash");
  });

  it("@bugfix @regression-proof readFileChunk reads in 64 KB slices and reassembles the exact bytes", async () => {
    h.readFile = pattern(FILE_SLICE_BYTES * 3 + 123);

    const bytes = await readFileChunk("/docs/library/cache.blob", FILE_SLICE_BYTES * 2 + 50, 100);

    expect(FILE_SLICE_BYTES).toBe(64 * 1024);
    expect(h.reads.map((read) => read.length)).toEqual([FILE_SLICE_BYTES, FILE_SLICE_BYTES, 50]);
    expect(h.reads.map((read) => read.position)).toEqual([100, 100 + FILE_SLICE_BYTES, 100 + FILE_SLICE_BYTES * 2]);
    expect(Buffer.from(bytes).equals(Buffer.from(h.readFile.subarray(100, 100 + FILE_SLICE_BYTES * 2 + 50)))).toBe(true);
  });

  it("@bugfix @regression-proof readFileChunk returns what exists when the file ends early", async () => {
    h.readFile = pattern(70_000);

    const bytes = await readFileChunk("/docs/library/cache.blob", FILE_SLICE_BYTES * 2, 0);

    expect(bytes.length).toBe(70_000);
  });

  it("@regression-proof downloadChunksToFile writes each chunk at its offset in 1 MB slices as soon as it lands (#957)", async () => {
    const first = pattern(DOWNLOAD_WRITE_SLICE_BYTES * 2 + 10);
    const second = pattern(12_345).reverse();
    const firstGate = Promise.withResolvers<void>();
    h.objects.set("library/chunks/a", { bytes: first, ready: firstGate.promise });
    h.objects.set("library/chunks/b", { bytes: second, ready: Promise.resolve() });
    const manifest = { chunks: [{ hash: "a", size: first.length }, { hash: "b", size: second.length }] };

    const done = downloadChunksToFile("token", manifest, "/docs/out.blob");
    // The second chunk is written while the first is still downloading: no batch waits for its slowest chunk.
    await vi.waitFor(() => expect(h.placed.map((entry) => entry.position)).toEqual([first.length]));
    firstGate.resolve();
    await done;

    expect(h.writes).toEqual([{ path: "/docs/out.blob", data: "" }]);
    expect(h.placed).toHaveLength(4);
    const file = Buffer.alloc(first.length + second.length);
    for (const entry of h.placed) {
      const bytes = Buffer.from(entry.base64, "base64");
      expect(bytes.length).toBeLessThanOrEqual(DOWNLOAD_WRITE_SLICE_BYTES);
      bytes.copy(file, entry.position);
    }
    expect(file.equals(Buffer.concat([first, second]))).toBe(true);
  });

  it("@regression-proof downloadChunksToFile refuses a chunk whose size differs from the manifest", async () => {
    h.downloaded = pattern(100);
    await expect(downloadChunksToFile("token", { chunks: [{ hash: "a", size: 101 }] }, "/docs/out.blob")).rejects.toThrow(
      "LIBRARY_CHUNK_SIZE_MISMATCH"
    );
  });

  it("encodeBase64 matches the buffer package for every slice length", () => {
    for (const length of [0, 1, 2, 3, 8191, 8192, 8193, 70_000, DOWNLOAD_WRITE_SLICE_BYTES]) {
      const bytes = pattern(length);
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
      expect(encodeBase64(bytes.subarray(1))).toBe(Buffer.from(bytes.subarray(1)).toString("base64"));
    }
  });

  it("@bugfix @regression-proof upload frames never read or encode bytes in JS: the native module builds the Blob", async () => {
    // RN's WebSocket.send base64-encodes binary frames in JS (~0.8 s/MB) and RNFS.read decodes in JS
    // (~0.8 s/MB): any frame size big enough to be efficient froze the thread past 100 ms per frame.
    // The Blob path leaves JS only the (asynchronous) call and the hand-over to WebSocket.send.
    await uploadChunksFromFile("token", "/docs/library/cache.blob", [{ hash: "a", size: 3 * UPLOAD_FRAME_BYTES, offset: 1000 }]);

    expect(h.uploadOptions?.chunkSize).toBe(UPLOAD_FRAME_BYTES);
    expect(h.uploadPayload?.byteLength).toBe(3 * UPLOAD_FRAME_BYTES);

    const built = await h.uploadPayload?.buildWsMessage({ uploadId: "up1", seq: 2, offset: UPLOAD_FRAME_BYTES, length: 512 });
    expect(h.buildUploadFrameBlob).toHaveBeenCalledWith("/docs/library/cache.blob", 1000 + UPLOAD_FRAME_BYTES, 512, "up1", 2);
    expect(h.createFromOptions).toHaveBeenCalledWith({ blobId: "blob-1", offset: 0, size: 600 });
    expect(built?.message).toBe(h.blob);
    built?.release();
    expect(h.blob.close).toHaveBeenCalledTimes(1);
    expect(h.reads, "no byte of the chunk may be read through RNFS").toHaveLength(0);
  });

  it("@bugfix @regression-proof the HTTP fallback reads the frame through the sliced reader at the chunk offset", async () => {
    h.readFile = pattern(5000);
    await uploadChunksFromFile("token", "/docs/library/cache.blob", [{ hash: "a", size: 2000, offset: 1000 }]);

    const bytes = await h.uploadPayload?.read(100, 50);

    expect(Buffer.from(bytes ?? []).equals(Buffer.from(h.readFile.subarray(1100, 1150)))).toBe(true);
  });

  it("@bugfix @regression-proof the fallback checksum hook yields to the event loop first", async () => {
    vi.useFakeTimers();
    try {
      await uploadObjectViaTunnel("token", "library/chunks/a", { byteLength: 1, read: async () => new Uint8Array(1), buildWsMessage: h.buildWsMessage });

      let checksum: string | null = null;
      void Promise.resolve(h.uploadOptions?.checksumFn?.(new Uint8Array(4), 0)).then((value) => {
        checksum = value ?? null;
      });
      await Promise.resolve();
      expect(checksum, "the checksum must wait for a macrotask").toBeNull();
      await vi.advanceTimersByTimeAsync(0);
      expect(checksum).toBe("sha256:digest");
    } finally {
      vi.useRealTimers();
    }
  });
});

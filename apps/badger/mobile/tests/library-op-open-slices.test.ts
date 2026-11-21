/**
 * @test-id MOBILE-OPS-OPEN-SLICES-001
 * @level unit
 * @req LIB-SYNC-14
 * @bugfix @regression-proof
 *
 * @why A 3.5 MB stored change opened natively came back as one Java String: ~56 MB of JSON (deflate packs repetitive
 *   JSON ~16:1) is 113 MB of UTF-16, and op6 (256 MB heap) crash-looped with OutOfMemoryError in
 *   `LibrarySyncModule.openOpPayload` on every launch. Native now opens the change into a cache file and reports
 *   UTF-8-safe slice ends (SnapshotCodecTest checks the cuts); JS must read every slice in order, rebuild the exact
 *   text, and remove the file whatever happens.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const TAG = "[MOBILE-OPS-OPEN-SLICES-001]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

type Opened = { storedBytes: number; jsonBytes: number; sliceEnds: number[]; ms: number };

const native = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  openCalls: [] as Array<{ payloadBase64: string; keyBase64: string; targetPath: string; sliceBytes: number }>,
  reads: [] as Array<[number, number]>,
  openResult: null as null | { text: string; sliceEnds: number[] },
  openError: null as null | Error,
  readError: null as null | Error,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
  NativeModules: {
    LibrarySync: {
      openOpPayloadToFile: async (payloadBase64: string, keyBase64: string, targetPath: string, sliceBytes: number): Promise<Opened> => {
        native.openCalls.push({ payloadBase64, keyBase64, targetPath, sliceBytes });
        if (native.openError) throw native.openError;
        const { text, sliceEnds } = native.openResult!;
        const bytes = new TextEncoder().encode(text);
        native.files.set(targetPath, bytes);
        return { storedBytes: payloadBase64.length, jsonBytes: bytes.length, sliceEnds, ms: 1 };
      },
      readTextSlice: async (path: string, start: number, end: number): Promise<string> => {
        native.reads.push([start, end]);
        if (native.readError) throw native.readError;
        const bytes = native.files.get(path);
        if (!bytes) throw new Error(`ENOENT ${path}`);
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
      },
    },
  },
}));

vi.mock("react-native-fs", () => ({
  default: {
    CachesDirectoryPath: "/caches",
    exists: async (path: string) => native.files.has(path),
    unlink: async (path: string) => {
      native.files.delete(path);
    },
  },
}));

import { OP_TEXT_SLICE_BYTES, openOpPayload } from "../src/native/LibrarySync";

/** Slice ends at UTF-8 character starts, the cut SnapshotCodec makes (checked natively by SnapshotCodecTest). */
const utf8SliceEnds = (text: string, sliceBytes: number) => {
  const bytes = new TextEncoder().encode(text);
  const ends: number[] = [];
  let position = sliceBytes;
  while (position < bytes.length) {
    if ((bytes[position] & 0xc0) !== 0x80) {
      ends.push(position);
      position += sliceBytes;
    } else {
      position += 1;
    }
  }
  if (bytes.length > 0) ends.push(bytes.length);
  return ends;
};

beforeEach(() => {
  native.files.clear();
  native.openCalls.length = 0;
  native.reads.length = 0;
  native.openResult = null;
  native.openError = null;
  native.readError = null;
});

describe("a large stored change is read back in slices, never as one native string (LIB-SYNC-14)", () => {
  it("rebuilds the exact text from every slice in order and removes the cache file", async () => {
    const text = JSON.stringify(Array.from({ length: 300 }, (_, n) => ({ title: "Amélie €12 🎬 naïve", n })));
    const sliceEnds = utf8SliceEnds(text, 997);
    native.openResult = { text, sliceEnds };

    const opened = await openOpPayload("cGF5bG9hZA==", "a2V5");
    log("state:opened", { slices: sliceEnds.length, reads: native.reads.length, files: [...native.files.keys()] });

    expect(opened, "the text is rebuilt byte for byte across slices that end mid-word").toBe(text);
    expect(native.openCalls).toHaveLength(1);
    expect(native.openCalls[0].sliceBytes, "native is asked for bounded slices").toBe(OP_TEXT_SLICE_BYTES);
    expect(native.openCalls[0].targetPath.startsWith("/caches/library-op-")).toBe(true);
    expect(native.reads, "each slice starts where the previous one ended").toEqual(
      sliceEnds.map((end, index) => [index === 0 ? 0 : sliceEnds[index - 1], end]),
    );
    expect(sliceEnds.length, "the fixture really spans several slices").toBeGreaterThan(5);
    expect(native.files.size, "the cache file is removed after reading").toBe(0);
  });

  it("passes on the native open error and reads nothing", async () => {
    native.openError = new Error("DECRYPT_FAILED");

    await expect(openOpPayload("cGF5bG9hZA==", "a2V5")).rejects.toThrow("DECRYPT_FAILED");
    log("state:open-failed", { reads: native.reads.length, files: native.files.size });

    expect(native.reads).toEqual([]);
    expect(native.files.size).toBe(0);
  });

  it("removes the cache file when a slice cannot be read", async () => {
    native.openResult = { text: '{"type":"noop"}', sliceEnds: [15] };
    native.readError = new Error("READ_FAILED");

    await expect(openOpPayload("cGF5bG9hZA==", "a2V5")).rejects.toThrow("READ_FAILED");
    log("state:read-failed", { files: native.files.size });

    expect(native.files.size, "a failed read leaves no cache file behind").toBe(0);
  });
});

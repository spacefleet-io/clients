/**
 * @test-id MOBILE-LIB-SNAPSHOT-NATIVE-002
 * @level unit
 * @req LIB-FMT-07
 * @req LIB-SYNC-14
 * @bugfix @regression-proof
 *
 * @why The phone now writes its saved copy of the library natively (SnapshotCodec.kt / LibrarySync.swift streaming
 *   SQLite file -> raw deflate -> AES-GCM) instead of in JS, which ran out of memory and froze the UI 52 s on a
 *   60 MB library. Every other reader still decodes it with the shared JS path: `decodeCompressedFrame` with
 *   `fflateCodec` (web, older phones) or `node:zlib` (desktop, Kodi). `native-v2.bin` was written by
 *   SnapshotCodec.encrypt; `js-v2.bin` is what the JS writers produce, and SnapshotCodecTest decodes it natively.
 *   Regenerate `js-v2.bin`: `SNAPSHOT_CODEC_WRITE_FIXTURE=1 bunx vitest run tests/library-snapshot-native-compat.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  COMPRESSION_LEVEL,
  decodeCompressedFrame,
  encodeCompressedFrame,
  isCompressedFrame,
  type DeflateCodec,
} from "@space/library-db-definition/payloadCompression";
import { fflateCodec } from "@space/mobile-shell/libraryOps";

const TAG = "[MOBILE-LIB-SNAPSHOT-NATIVE-002]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const FIXTURES = path.resolve(__dirname, "../android/app/src/test/resources/snapshot-codec");
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);

const zlibCodec: DeflateCodec = {
  deflateRaw: (bytes) => new Uint8Array(deflateRawSync(bytes, { level: COMPRESSION_LEVEL })),
  inflateRaw: (bytes) => new Uint8Array(inflateRawSync(bytes)),
};

/** Same bytes as `fixtureDb()` in SnapshotCodecTest.kt. */
const fixtureDb = (size = 200_000) => {
  const bytes = new Uint8Array(size);
  const header = new TextEncoder().encode("SQLite format 3\0");
  bytes.set(header);
  let state = 12345;
  for (let i = header.length; i < size; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) | 0;
    bytes[i] = Math.floor(i / 1000) % 3 === 0 ? (state >>> 16) & 0xff : ((i % 251) ^ (Math.floor(i / 4096) & 0xff)) & 0xff;
  }
  return bytes;
};

const aesKey = () => webcrypto.subtle.importKey("raw", KEY, "AES-GCM", false, ["encrypt", "decrypt"]);

const open = async (stored: Uint8Array) =>
  new Uint8Array(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: stored.slice(0, 12) }, await aesKey(), stored.slice(12)));

describe("a natively written saved copy is storage format v2 (LIB-FMT-07)", () => {
  it("decodes with the JS readers every other app uses", async () => {
    const stored = new Uint8Array(readFileSync(path.join(FIXTURES, "native-v2.bin")));
    const frame = await open(stored);
    log("state:native-v2", { storedBytes: stored.length, frameBytes: frame.length });
    expect(isCompressedFrame(frame)).toBe(true);
    const expected = Buffer.from(fixtureDb());
    expect(Buffer.from(decodeCompressedFrame(frame, fflateCodec)).equals(expected), "fflate (web, phones)").toBe(true);
    expect(Buffer.from(decodeCompressedFrame(frame, zlibCodec)).equals(expected), "node:zlib (desktop, Kodi)").toBe(true);
  });

  it("the JS-written fixture the native reader decodes is a real v2 copy of the same DB", async () => {
    if (process.env.SNAPSHOT_CODEC_WRITE_FIXTURE) {
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(
        await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), encodeCompressedFrame(fixtureDb(), zlibCodec))
      );
      writeFileSync(path.join(FIXTURES, "js-v2.bin"), Buffer.concat([iv, sealed]));
      log("phase:fixture-written", { bytes: 12 + sealed.length });
    }
    const frame = await open(new Uint8Array(readFileSync(path.join(FIXTURES, "js-v2.bin"))));
    expect(Buffer.from(decodeCompressedFrame(frame, fflateCodec)).equals(Buffer.from(fixtureDb()))).toBe(true);
  });
});

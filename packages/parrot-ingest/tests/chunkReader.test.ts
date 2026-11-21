/**
 * @test-id PARROT-INGEST-CHUNKREADER-001
 * @level unit
 * @why Playback reads a stored song back by byte range from 1 MiB SFV1 chunks: each chunk sealed with
 *      @space/media-crypto must decrypt to exactly its plaintext, any range must reassemble to the same bytes as
 *      the original file, and seeks must not download the same chunk twice. PAR-PLAY-08: the chunks of one file share
 *      reused tunnel sessions (one when read in turn, at most PARROT_DOWNLOAD_LANES_PER_FILE when read ahead) instead
 *      of one session per chunk (2026-11-21: ~0.9 s per 1 MiB chunk, 13 s before a song started).
 * @bugfix @regression-proof
 * @covers packages/parrot-ingest/src/chunkReader.ts
 * @covers packages/parrot-core/src/fileRange.ts
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { encryptMediaObject, sealMediaObjectWithPadding } from "@space/media-crypto";
import { TRACK_FILE_CHUNK_SIZE_BYTES, type TrackFileChunkRow } from "@space/parrot-library-db-definition";
import { readParrotFileRange } from "@space/parrot-core";
import { createParrotChunkLoader, PARROT_DOWNLOAD_LANES_PER_FILE } from "../src/chunkReader";
import { PARROT_APP_ID } from "../src/importer";
import { testLog } from "./helpers";

const log = testLog("PARROT-INGEST-CHUNKREADER-001");
const CHUNK = TRACK_FILE_CHUNK_SIZE_BYTES;
/** The tunnel session opener's full signature carries SDK option types the fakes do not need. */
type OpenSession = NonNullable<Parameters<typeof createParrotChunkLoader>[0]["openSession"]>;
const PROFILE_ID = "profile-main";

/** A file sealed as chunks the way the importer stores it, plus a fake tunnel session opener that records its calls. */
const storeFile = (size: number) => {
  const key = randomBytes(32);
  const plain = new Uint8Array(randomBytes(size));
  const objects = new Map<string, Uint8Array>();
  const chunks: TrackFileChunkRow[] = [];
  for (let offset = 0, idx = 0; offset < size; offset += CHUNK, idx += 1) {
    const part = plain.subarray(offset, offset + CHUNK);
    const objectKey = `media/parrot-test/tf-test/chunk-${String(idx).padStart(5, "0")}`;
    objects.set(objectKey, new Uint8Array(sealMediaObjectWithPadding(part, key)));
    chunks.push({ idx, objectKey, plainOffset: offset, plainSize: part.length });
  }
  const calls: Array<{ objectKey: string; session: number }> = [];
  const opens: Array<{ token: string; options: unknown; appId: unknown }> = [];
  let closed = 0;
  const pending: Array<() => void> = [];
  let gate = false;
  const openSession = ((token: string, options: unknown, appId?: unknown) => {
    opens.push({ token, options, appId });
    const session = opens.length;
    return {
      download: async (objectKey: string) => {
        calls.push({ objectKey, session });
        if (gate) {
          const { promise, resolve } = Promise.withResolvers<void>();
          pending.push(resolve);
          await promise;
        }
        const sealed = objects.get(objectKey);
        if (!sealed) throw new Error(`no such object ${objectKey}`);
        return sealed;
      },
      close: async () => {
        closed += 1;
      },
    };
  }) as unknown as OpenSession;
  const dump = () => ({ size, chunks, calls: calls.map((call) => `${call.objectKey}@${call.session}`), opens: opens.length, closed });
  return {
    key,
    plain,
    objects,
    chunks,
    calls,
    openSession,
    opens,
    closedCount: () => closed,
    dump,
    holdDownloads: () => {
      gate = true;
    },
    releaseDownloads: () => {
      gate = false;
      for (const resolve of pending.splice(0)) resolve();
    },
  };
};

const collect = async (iterator: AsyncGenerator<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const part of iterator) parts.push(part);
  return Buffer.concat(parts);
};

describe("parrot chunk loader", () => {
  // @req PAR-PLAY-08
  // @req STOR-REUSE-02
  it("downloads a file's chunks on one tunnel session opened with the token, client type and Parrot app id", async () => {
    // 2026-11-21 (Daft Punk import): each 1 MiB chunk opened its own tunnel session (~0.9 s each), so a song whose
    // index sits at its end took ~13 s to start. The chunks of one file now share a reused session.
    const store = storeFile(5 * CHUNK + 777);
    const messages: string[] = [];
    const load = createParrotChunkLoader({
      token: () => "token-1",
      profileId: async () => PROFILE_ID,
      libraryKeyBase64: () => store.key.toString("base64"),
      clientType: "parrot-desktop",
      openSession: store.openSession,
      log: (message) => messages.push(message),
    });
    for (const chunk of store.chunks) {
      const plain = await load(chunk);
      log(`chunk ${chunk.idx}`, { plainSize: chunk.plainSize, got: plain.length });
      expect(Buffer.from(plain).equals(Buffer.from(store.plain.subarray(chunk.plainOffset, chunk.plainOffset + chunk.plainSize)))).toBe(true);
    }
    log("sessions and downloads", store.dump());
    log("loader log", messages);
    expect(store.opens).toEqual([
      {
        token: "token-1",
        options: { objectKey: store.chunks[0]!.objectKey, profileId: PROFILE_ID, clientType: "parrot-desktop" },
        appId: PARROT_APP_ID,
      },
    ]);
    expect(store.calls).toEqual(store.chunks.map((chunk) => ({ objectKey: chunk.objectKey, session: 1 })));
    expect(messages[0]).toBe("[parrot-chunks] media/parrot-test: session 1 of 4");
    expect(messages.filter((line) => line.includes(" bytes"))).toHaveLength(6);
    load.clear();
    expect(store.closedCount()).toBe(1);
  });

  // @req PAR-PLAY-08
  it("reads a range ahead on at most PARROT_DOWNLOAD_LANES_PER_FILE sessions side by side", async () => {
    const store = storeFile(12 * CHUNK + 5);
    const load = createParrotChunkLoader({
      token: () => "t",
      profileId: async () => PROFILE_ID,
      libraryKeyBase64: () => store.key.toString("base64"),
      clientType: "parrot-desktop",
      openSession: store.openSession,
      log: (message) => log("loader", message),
    });
    let inFlight = 0;
    let most = 0;
    const counting = async (chunk: Parameters<typeof load>[0]) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        return await load(chunk);
      } finally {
        inFlight -= 1;
      }
    };
    const got = await collect(readParrotFileRange(store.chunks, 0, store.plain.length - 1, counting, PARROT_DOWNLOAD_LANES_PER_FILE - 1));
    log("parallel range", { ...store.dump(), most });
    expect(got.equals(Buffer.from(store.plain))).toBe(true);
    expect(most).toBe(PARROT_DOWNLOAD_LANES_PER_FILE);
    expect(store.opens.length).toBeGreaterThan(1);
    expect(store.opens.length).toBeLessThanOrEqual(PARROT_DOWNLOAD_LANES_PER_FILE);
    expect(store.calls.map((call) => call.objectKey)).toEqual(store.chunks.map((chunk) => chunk.objectKey));
    load.clear();
    expect(store.closedCount()).toBe(store.opens.length);
  });

  it("serves repeated reads from memory and shares a download in flight", async () => {
    const store = storeFile(CHUNK + 10);
    const load = createParrotChunkLoader({
      token: () => "t",
      profileId: async () => PROFILE_ID,
      libraryKeyBase64: () => store.key.toString("base64"),
      clientType: "parrot-desktop",
      openSession: store.openSession,
    });
    store.holdDownloads();
    const a = load(store.chunks[0]!);
    const b = load(store.chunks[0]!);
    await Promise.resolve();
    store.releaseDownloads();
    const [first, second] = await Promise.all([a, b]);
    const third = await load(store.chunks[0]!);
    log("calls after three reads of chunk 0", store.dump().calls);
    expect(store.calls).toHaveLength(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("evicts the least recently used chunks past maxBytes, and clear() empties the cache", async () => {
    const store = storeFile(3 * CHUNK);
    const load = createParrotChunkLoader({
      token: () => "t",
      profileId: async () => PROFILE_ID,
      libraryKeyBase64: () => store.key.toString("base64"),
      clientType: "parrot-desktop",
      maxBytes: 2 * CHUNK,
      openSession: store.openSession,
    });
    const [c0, c1, c2] = store.chunks as [TrackFileChunkRow, TrackFileChunkRow, TrackFileChunkRow];
    await load(c0);
    await load(c1);
    await load(c0); // c0 is now the most recently used
    await load(c2); // evicts c1
    log("calls before re-reads", store.dump().calls);
    expect(store.calls.map((call) => call.objectKey)).toEqual([c0.objectKey, c1.objectKey, c2.objectKey]);
    await load(c0);
    expect(store.calls).toHaveLength(3);
    await load(c1);
    log("calls after re-reading the evicted chunk", store.dump().calls);
    expect(store.calls.map((call) => call.objectKey)).toEqual([c0.objectKey, c1.objectKey, c2.objectKey, c1.objectKey]);
    load.clear();
    await load(c0);
    expect(store.calls).toHaveLength(5);
  });

  it("rejects a chunk whose plaintext size does not match the chunk map, and a wrong key", async () => {
    const store = storeFile(1000);
    const wrongSize = { ...store.chunks[0]!, plainSize: 999 };
    const load = createParrotChunkLoader({
      token: () => "t",
      profileId: async () => PROFILE_ID,
      libraryKeyBase64: () => store.key.toString("base64"),
      clientType: "parrot-desktop",
      openSession: store.openSession,
    });
    await expect(load(wrongSize)).rejects.toThrow(`chunk ${wrongSize.objectKey} decrypted to 1000 bytes, expected 999`);
    const wrongKey = createParrotChunkLoader({
      token: () => "t",
      profileId: async () => PROFILE_ID,
      libraryKeyBase64: () => randomBytes(32).toString("base64"),
      clientType: "parrot-desktop",
      openSession: store.openSession,
    });
    await expect(wrongKey(store.chunks[0]!)).rejects.toThrow();
    // A failed download is not cached: the next read tries again.
    await expect(load(store.chunks[0]!)).resolves.toHaveLength(1000);
    log("calls", store.dump().calls);
    expect(store.calls).toHaveLength(3);
  });

  it("reads objects sealed without padding too", async () => {
    const key = randomBytes(32);
    const plain = randomBytes(4096);
    const chunk = { idx: 0, objectKey: "k0", plainOffset: 0, plainSize: plain.length };
    const sealed = new Uint8Array(encryptMediaObject(plain, key, 0));
    const load = createParrotChunkLoader({
      token: () => "t",
      profileId: async () => PROFILE_ID,
      libraryKeyBase64: () => key.toString("base64"),
      clientType: "parrot-desktop",
      openSession: (() => ({ download: async () => sealed, close: async () => undefined })) as unknown as OpenSession,
    });
    expect(Buffer.from(await load(chunk)).equals(plain)).toBe(true);
  });
});

describe("readParrotFileRange", () => {
  const size = 3 * CHUNK + 12_345;

  it.each([
    ["whole file", 0, size - 1],
    ["first byte", 0, 0],
    ["last byte", size - 1, size - 1],
    ["inside one chunk", 100, 200],
    ["exactly one chunk", CHUNK, 2 * CHUNK - 1],
    ["across a boundary", CHUNK - 5, CHUNK + 5],
    ["across every chunk", 17, size - 18],
    ["tail of the file", 3 * CHUNK, size - 1],
  ])("reassembles %s", async (_name, start, end) => {
    const store = storeFile(size);
    const load = createParrotChunkLoader({
      token: () => "t",
      profileId: async () => PROFILE_ID,
      libraryKeyBase64: () => store.key.toString("base64"),
      clientType: "parrot-desktop",
      openSession: store.openSession,
    });
    const bytes = await collect(readParrotFileRange(store.chunks, start, end, load));
    const expected = Buffer.from(store.plain.subarray(start, end + 1));
    const touched = store.chunks.filter((chunk) => chunk.plainOffset + chunk.plainSize > start && chunk.plainOffset <= end);
    log(`range ${start}-${end}`, { got: bytes.length, expected: expected.length, downloads: store.dump().calls });
    expect(bytes.length).toBe(end - start + 1);
    expect(bytes.equals(expected)).toBe(true);
    expect(store.calls.map((call) => call.objectKey)).toEqual(touched.map((chunk) => chunk.objectKey));
  });

  it("yields nothing for a range past the end", async () => {
    const store = storeFile(1000);
    const load = createParrotChunkLoader({
      token: () => "t",
      profileId: async () => PROFILE_ID,
      libraryKeyBase64: () => store.key.toString("base64"),
      clientType: "parrot-desktop",
      openSession: store.openSession,
    });
    const bytes = await collect(readParrotFileRange(store.chunks, 5000, 6000, load));
    expect(bytes.length).toBe(0);
    expect(store.calls).toHaveLength(0);
  });

  it("prefetches the next chunk and survives a consumer that stops early", async () => {
    const store = storeFile(3 * CHUNK);
    const load = createParrotChunkLoader({
      token: () => "t",
      profileId: async () => PROFILE_ID,
      libraryKeyBase64: () => store.key.toString("base64"),
      clientType: "parrot-desktop",
      openSession: store.openSession,
    });
    const iterator = readParrotFileRange(store.chunks, 0, 3 * CHUNK - 1, load);
    const first = await iterator.next();
    log("after first chunk", store.dump().calls);
    expect(first.value).toHaveLength(CHUNK);
    expect(store.calls.map((call) => call.objectKey)).toEqual([store.chunks[0]!.objectKey, store.chunks[1]!.objectKey]);
    await iterator.return(undefined);
    expect(store.calls).toHaveLength(2);
  });

  it("surfaces a chunk that fails to load", async () => {
    const store = storeFile(2 * CHUNK);
    store.objects.delete(store.chunks[1]!.objectKey);
    const load = createParrotChunkLoader({
      token: () => "t",
      profileId: async () => PROFILE_ID,
      libraryKeyBase64: () => store.key.toString("base64"),
      clientType: "parrot-desktop",
      openSession: store.openSession,
    });
    await expect(collect(readParrotFileRange(store.chunks, 0, 2 * CHUNK - 1, load))).rejects.toThrow(`no such object ${store.chunks[1]!.objectKey}`);
  });
});

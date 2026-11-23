// @req PAR-FMT-02: every song is stored as its original plus a light copy, made at import and backfilled.
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { decryptMediaObject, sealMediaObjectWithPadding } from "@space/media-crypto";
import { PARROT_LIGHT_COPY } from "@space/parrot-core";
import { importParrotFiles, type ParrotImportTransport } from "../src/importer";
import { getParrotFile, openParrotLibrary, serializeParrotLibrary } from "../src/library";
import {
  addParrotLightCopy,
  backfillParrotLightCopies,
  parrotLightCopyWait,
  parrotLightFileId,
  parrotOriginalInMemory,
  type ParrotLightCopyMaker,
} from "../src/lightCopy";
import { readParrotTrackInfo } from "../src/readTrack";
import { makeAudioFixture, makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-LIGHT-COPY-001");
const TOKEN = "token-abc";
const USER_ID = "user-chris";

type FakeServer = {
  objects: Map<string, Uint8Array>;
  state: { version: number; dbBytes: Uint8Array | null };
  transport: ParrotImportTransport;
  files: () => Array<Record<string, unknown>>;
};

const createFakeServer = (): FakeServer => {
  const objects = new Map<string, Uint8Array>();
  const state = { version: 0, dbBytes: null as Uint8Array | null };
  const upload = async (_token: string, objectKey: string, payload: Uint8Array, options: Record<string, unknown> = {}) => {
    const placed = options.placementId ? `media/${String(options.placementId)}/${objectKey}` : objectKey;
    objects.set(placed, payload);
    return placed;
  };
  const transport = {
    upload,
    fetchSnapshot: async () => (state.dbBytes ? { snapshotVersion: state.version, dbBytes: state.dbBytes } : null),
    publishSnapshot: async (input: { dbBytes: Uint8Array; baseVersion: number }) => {
      if (input.baseVersion !== state.version) throw Object.assign(new Error("library_db_conflict"), { status: 409 });
      state.version += 1;
      state.dbBytes = new Uint8Array(input.dbBytes);
      return { version: state.version };
    },
  } as unknown as ParrotImportTransport;
  const files = () => {
    const db = openParrotLibrary(state.dbBytes);
    const rows = db
      .prepare("SELECT id, track_id AS trackId, codec, container, mime, lossless, bitrate_kbps AS bitrateKbps, light_copy AS lightCopy FROM track_files ORDER BY light_copy, id")
      .all() as Array<Record<string, unknown>>;
    db.close();
    return rows;
  };
  return { objects, state, transport, files };
};

/** A stand-in encoder: "OggS" then the original's first bytes, so the test can tell which original it was given. */
const fakeMaker = (calls: Array<{ size: number; title?: string | null; codec: string }>): ParrotLightCopyMaker => async ({ size, read, tags, codec }) => {
  calls.push({ size, title: tags.title, codec });
  const out = new Uint8Array(4 + 16);
  out.set(new TextEncoder().encode("OggS"), 0);
  out.set(await read(0, Math.min(size, 16) - 1), 4);
  return out;
};

describe("light copies", () => {
  let root: string;
  let flac: string;
  let mp3: string;
  const keyBase64 = randomBytes(32).toString("base64");

  beforeAll(async () => {
    root = await makeTempDir("light-copy");
    flac = makeAudioFixture(path.join(root, "01 - Tone.flac"), { title: "Tone", artist: "Parrot", album: "Tests", track: "1" }, 1, log);
    mp3 = makeAudioFixture(path.join(root, "02 - Other.mp3"), { title: "Other", artist: "Parrot", album: "Tests", track: "2" }, 1, log);
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = (server: FakeServer) => ({
    token: TOKEN,
    userId: USER_ID,
    libraryKeyBase64: keyBase64,
    clientType: "parrot-desktop",
    transport: server.transport,
    log: (message: string) => log(message),
  });

  it("import stores each song's light copy next to its original, sealed and chunked like it", async () => {
    const server = createFakeServer();
    const calls: Array<{ size: number; title?: string | null; codec: string }> = [];
    const result = await importParrotFiles([flac, mp3], { ...base(server), makeLightCopy: fakeMaker(calls) });
    expect(result.imported).toEqual([flac, mp3]);
    expect(calls.map((call) => [call.title, call.codec])).toEqual([
      ["Tone", "flac"],
      ["Other", "mp3"],
    ]);
    const files = server.files();
    log("files", files);
    const originals = files.filter((file) => file.lightCopy === 0);
    const lights = files.filter((file) => file.lightCopy === 1);
    expect(lights).toHaveLength(2);
    for (const light of lights) {
      const original = originals.find((file) => file.trackId === light.trackId)!;
      expect(light).toMatchObject({ id: parrotLightFileId(original.id as string), codec: "opus", container: "ogg", mime: PARROT_LIGHT_COPY.mime, bitrateKbps: 64, lossless: 0 });
      const db = openParrotLibrary(server.state.dbBytes);
      const stored = getParrotFile(db, light.id as string)!;
      db.close();
      const sealed = server.objects.get(stored.chunks[0]!.objectKey)!;
      expect(new TextDecoder().decode(new Uint8Array(decryptMediaObject(sealed, keyBase64)).subarray(0, 4))).toBe("OggS");
    }
  });

  it("a failed light copy does not fail the import; importing again adds it", async () => {
    const server = createFakeServer();
    const failing: ParrotLightCopyMaker = async () => {
      throw new Error("cannot decode");
    };
    const first = await importParrotFiles([flac], { ...base(server), makeLightCopy: failing });
    expect(first.imported).toEqual([flac]);
    expect(server.files().filter((file) => file.lightCopy === 1)).toHaveLength(0);
    const calls: Array<{ size: number; codec: string }> = [];
    const again = await importParrotFiles([flac], { ...base(server), makeLightCopy: fakeMaker(calls) });
    expect(again.skipped).toEqual([flac]);
    expect(calls).toHaveLength(1);
    expect(server.files().filter((file) => file.lightCopy === 1)).toHaveLength(1);
    // Nothing left to make: a third import adds nothing.
    await importParrotFiles([flac], { ...base(server), makeLightCopy: fakeMaker(calls) });
    expect(calls).toHaveLength(1);
  });

  const markLong = (server: FakeServer, title: string, durationMs: number) => {
    const db = openParrotLibrary(server.state.dbBytes);
    const trackId = String(db.prepare("SELECT t.id AS id FROM tracks t WHERE t.title = ?").get(title)?.id);
    expect(trackId).not.toBe("undefined");
    db.prepare("UPDATE tracks SET duration_ms = ? WHERE id = ?").run(durationMs, trackId);
    server.state.dbBytes = serializeParrotLibrary(db);
    db.close();
  };
  const backfill = (server: FakeServer, longSongs: boolean, loaded: string[], calls: Array<{ size: number; title?: string | null; codec: string }>) =>
    backfillParrotLightCopies({
      token: TOKEN,
      libraryKeyBase64: keyBase64,
      transport: server.transport,
      load: async (chunk) => {
        loaded.push(chunk.objectKey);
        return new Uint8Array(decryptMediaObject(server.objects.get(chunk.objectKey)!, keyBase64));
      },
      make: fakeMaker(calls),
      longSongs,
      upload: async ({ fileId, bytes }) => {
        const key = `media/test/${fileId}/chunk-00000`;
        server.objects.set(key, new Uint8Array(sealMediaObjectWithPadding(bytes, Buffer.from(keyBase64, "base64"))));
        return [{ idx: 0, objectKey: key, plainOffset: 0, plainSize: bytes.length }];
      },
      log: (message) => log(message),
    });

  it("the backfill gives songs imported without one their light copy, from the stored original", async () => {
    const server = createFakeServer();
    await importParrotFiles([flac, mp3], base(server));
    expect(server.files().filter((file) => file.lightCopy === 1)).toHaveLength(0);
    const calls: Array<{ size: number; title?: string | null; codec: string }> = [];
    const result = await backfill(server, false, [], calls);
    log("backfill", result);
    expect(result).toMatchObject({ made: 2, failed: 0, left: 0 });
    expect(calls.map((call) => [call.title, call.codec, call.size]).sort()).toEqual(
      [
        ["Other", "mp3", (await fs.stat(mp3)).size],
        ["Tone", "flac", (await fs.stat(flac)).size],
      ].sort()
    );
    expect(server.files().filter((file) => file.lightCopy === 1)).toHaveLength(2);
    const again = await backfillParrotLightCopies({
      token: TOKEN,
      libraryKeyBase64: keyBase64,
      transport: server.transport,
      load: async () => {
        throw new Error("nothing to load");
      },
      make: fakeMaker(calls),
      longSongs: false,
      upload: async () => [],
    });
    expect(again).toMatchObject({ made: 0, left: 0 });
  });

  // @bugfix @regression-proof: a user's Parrot desktop crashed (2026-11-11) while the backfill handed an 8.4-hour, 870 MB
  // original to the encoder window. Chris 2026-11-11: songs over 90 minutes get their light copy automatically only
  // where the hardware allows it (the rule Badger uses); the copy itself is streamed, never decoded whole.
  it("on a weak computer a song over 90 minutes waits: its original is never downloaded nor handed to the encoder", async () => {
    const server = createFakeServer();
    await importParrotFiles([flac, mp3], base(server));
    // The library says the FLAC lasts 8.4 hours, like the 870 MB playlist recording in a real user library.
    markLong(server, "Tone", 30_293_000);
    const loaded: string[] = [];
    const calls: Array<{ size: number; title?: string | null; codec: string }> = [];
    const result = await backfill(server, false, loaded, calls);
    log("backfill on a weak computer", { result, loaded });
    expect(result).toMatchObject({ made: 1, failed: 0, skipped: 1, left: 0 });
    expect(calls.map((call) => call.title)).toEqual(["Other"]);
    expect(loaded).toHaveLength(1);

    // A strong computer makes it later, from the same library.
    const strongCalls: Array<{ size: number; title?: string | null; codec: string }> = [];
    const strong = await backfill(server, true, [], strongCalls);
    log("backfill on a strong computer", strong);
    expect(strong).toMatchObject({ made: 1, failed: 0, skipped: 0, left: 0 });
    expect(strongCalls).toEqual([{ size: (await fs.stat(flac)).size, title: "Tone", codec: "flac" }]);
  });

  it("at import, songs up to 90 minutes (or of unknown length) always get their light copy, longer ones only on a strong computer", async () => {
    const info = await readParrotTrackInfo(flac);
    const original = new Uint8Array(await fs.readFile(flac));
    const tryOne = async (durationMs: number | null, longSongs: boolean) => {
      let made = 0;
      const op = await addParrotLightCopy({
        db: openParrotLibrary(null),
        trackId: "tr-long",
        originalFileId: "tf-long",
        original: parrotOriginalInMemory(original),
        info: { ...info, durationMs },
        longSongs,
        make: async ({ size, read, container, durationMs: length }) => {
          made += 1;
          expect([size, container, length]).toEqual([original.length, "flac", durationMs]);
          expect(await read(0, 3)).toEqual(original.subarray(0, 4));
          return new Uint8Array(4);
        },
        upload: async () => [],
        log: (message) => log(message),
      });
      expect(op === null).toBe(made === 0);
      return made;
    };
    expect(await tryOne(90 * 60_000, false)).toBe(1);
    expect(await tryOne(null, false)).toBe(1);
    expect(await tryOne(91 * 60_000, false)).toBe(0);
    expect(await tryOne(30_293_000, false)).toBe(0);
    expect(await tryOne(3 * 3_600_000, true)).toBe(1);
    expect(parrotLightCopyWait({ durationMs: 91 * 60_000, longSongs: false })).toContain("91 minutes");
  });

  // @bugfix @regression-proof: the backfill wrote Ogg and WAV originals to a `.audio` temp file, which the tag reader
  // refuses ("not an audio file Parrot imports"), so those songs never got their light copy.
  it("the backfill reads an Ogg original's tags from a temp file with an audio extension Parrot imports", async () => {
    const ogg = makeAudioFixture(path.join(root, "03 - Third.ogg"), { title: "Third", artist: "Parrot", album: "Tests", track: "3" }, 1, log);
    const server = createFakeServer();
    await importParrotFiles([ogg], base(server));
    const calls: Array<{ size: number; title?: string | null; codec: string }> = [];
    const result = await backfill(server, false, [], calls);
    log("backfill of an Ogg original", result);
    expect(result).toMatchObject({ made: 1, failed: 0 });
    expect(calls.map((call) => [call.title, call.codec])).toEqual([["Third", "vorbis"]]);
  });
});

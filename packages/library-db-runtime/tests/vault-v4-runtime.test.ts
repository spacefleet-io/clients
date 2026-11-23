/**
 * @test-id LIB-V4-RUNTIME-001
 * @level integration (real LibraryDb + bun:sqlite + real AES-GCM against a fake API that enforces the switch)
 * @why Vault v4 ships to every device at once but switches accounts one by one (vault v4 plan §2.3). The runtime
 *   must keep writing op stream 3 until its account is switched, convert its own copy in place when it is (never by
 *   downloading the library again), keep every title and every playable chunk key through the conversion, and read
 *   the v4 ops other writers send. A regression here either refuses a switched account's library or strands an
 *   unswitched one, so this pins each step on the real LibraryDb.
 *
 * @req LIB-FMT-11[badger-desktop,runtime] LIB-FMT-12[badger-desktop,runtime] LIB-FMT-13[badger-desktop,runtime]
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { CHUNK_LIST_KEY_MODE, seedChunkKey } from "@space/library-db-definition/chunkLists";
import type { LibraryOp } from "@space/shared/libraryOps";
import * as realApi from "../src/api";
import type { LibraryMeta } from "../src/api";
import { decryptLibraryPayload, encryptSnapshotBytes } from "../src/payloadCodec";

const TAG = "[LIB-V4-RUNTIME-001]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

type FakeOp = { version: number; opId: string; payloadCiphertext: string; createdAt: string; declared: number };

/** A server that enforces the op-stream switch the way the API does (vault v4 plan §1.3). */
const fake = {
  exists: false,
  version: 0,
  snapshotVersion: 0,
  stateHash: null as string | null,
  lastOpId: null as string | null,
  manifestKey: null as string | null,
  snapshotId: null as string | null,
  ops: [] as FakeOp[],
  objects: new Map<string, Uint8Array>(),
  /** The knob: `LIBRARY_OP_STREAM_V4` covers this account when 4. */
  target: 3,
  /** The op stream the stored library is in (highest declared write). */
  stored: 3,
  opPuts: [] as number[],
  snapshotPuts: [] as number[],
  getLibraryDbCalls: 0,
  /** Next snapshot PUT answers this instead of storing (a lost race, a server outage). */
  failNextSnapshot: null as null | (() => Error),
  reset() {
    this.exists = false;
    this.version = 0;
    this.snapshotVersion = 0;
    this.stateHash = null;
    this.lastOpId = null;
    this.manifestKey = null;
    this.snapshotId = null;
    this.ops = [];
    this.objects = new Map();
    this.target = 3;
    this.stored = 3;
    this.opPuts = [];
    this.snapshotPuts = [];
    this.getLibraryDbCalls = 0;
    this.failNextSnapshot = null;
  },
  /** The server's write gate: a switched account takes only declared ≥ 4; an unswitched one refuses 4. */
  gate(declared: number) {
    if (this.target >= 4 && declared < 4) {
      throw new realApi.ApiError(426, { error: "app_update_required", reason: "library_op_stream", opStreamVersion: 4 });
    }
    if (this.target < 4 && declared >= 4) throw new realApi.ApiError(409, { error: "op_stream_not_switched" });
    this.stored = Math.max(this.stored, declared);
  },
  meta(): LibraryMeta {
    const meta = {
      exists: this.exists,
      bootstrapRequired: !this.exists,
      syncUnavailable: false,
      version: this.version,
      snapshotVersion: this.snapshotVersion,
      hash: null,
      stateHash: this.stateHash,
      lastOpId: this.lastOpId,
      consistency: this.exists ? "ok" : "missing_snapshot",
      updatedAt: new Date().toISOString(),
      keyProbe: null,
      keyProbeUpdatedAt: null,
      blobEncoding: "binary",
      snapshotId: this.snapshotId,
      manifestKey: this.manifestKey,
      chunkSize: null,
      snapshotHistory: [],
      opsHistory: [],
      storageFormatVersion: 2,
      opStreamVersion: this.stored,
      targetOpStreamVersion: this.target,
    } satisfies LibraryMeta & { targetOpStreamVersion: number };
    return meta;
  },
};

const originalApi = { ...realApi };
afterAll(() => {
  mock.module("../src/api", () => originalApi);
});

mock.module("../src/api", () => ({
  ...originalApi,
  getLibraryMeta: async () => fake.meta(),
  getLibraryDb: async () => {
    fake.getLibraryDbCalls += 1;
    return {
      exists: fake.exists,
      version: fake.version,
      snapshotVersion: fake.snapshotVersion,
      hash: null,
      manifestKey: fake.manifestKey,
      updatedAt: new Date().toISOString(),
      blobEncoding: "binary" as const,
      snapshotId: fake.snapshotId,
      chunkSize: null,
    };
  },
  getLibraryOps: async (_token: string, since: number) => {
    const history = fake.ops.filter((op) => op.version > fake.snapshotVersion);
    const minVersion = history.length ? Math.min(...history.map((op) => op.version)) : fake.snapshotVersion;
    const tooOld = since < Math.max(fake.snapshotVersion, minVersion - 1);
    const ops = tooOld ? [] : history.filter((op) => op.version > since);
    return {
      version: fake.version,
      snapshotVersion: fake.snapshotVersion,
      tooOld,
      ops: ops.map(({ declared: _declared, ...op }) => ({ ...op, objectKey: `library/ops/${op.opId}`, size: 0 })),
      storageFormatVersion: 2,
      opStreamVersion: fake.stored,
    };
  },
  putLibraryOp: async (
    _token: string,
    baseVersion: number,
    opId: string,
    payload: Uint8Array,
    lineage: { prevStateHash?: string | null; nextStateHash?: string | null } | undefined,
    opStreamVersion: number
  ) => {
    fake.opPuts.push(opStreamVersion);
    fake.gate(opStreamVersion);
    if (baseVersion !== fake.version) throw new realApi.ApiError(409, { error: "version_conflict", version: fake.version });
    fake.version += 1;
    fake.stateHash = lineage?.nextStateHash ?? fake.stateHash;
    fake.lastOpId = opId;
    fake.ops.push({
      version: fake.version,
      opId,
      payloadCiphertext: Buffer.from(payload).toString("base64"),
      createdAt: new Date().toISOString(),
      declared: opStreamVersion,
    });
    return { version: fake.version, snapshotVersion: fake.snapshotVersion, stateHash: fake.stateHash, lastOpId: opId };
  },
  putLibraryDb: async (...args: unknown[]) => {
    const [, expectedVersion, manifestBase64, snapshotId, , , , stateHash, lastOpId] = args as [
      string,
      number,
      string,
      string,
      number,
      string | null,
      boolean,
      string | null,
      string | null,
    ];
    const opStreamVersion = Number(args[12] ?? 3);
    fake.snapshotPuts.push(opStreamVersion);
    const failure = fake.failNextSnapshot;
    fake.failNextSnapshot = null;
    if (failure) throw failure();
    fake.gate(opStreamVersion);
    if (expectedVersion !== fake.version) throw new realApi.ApiError(409, { error: "version_conflict", version: fake.version });
    fake.version += 1;
    fake.snapshotVersion = fake.version;
    fake.exists = true;
    fake.snapshotId = snapshotId;
    fake.manifestKey = `library/manifests/${snapshotId}`;
    fake.objects.set(fake.manifestKey, new TextEncoder().encode(manifestBase64));
    fake.stateHash = stateHash ?? fake.stateHash ?? `snap-${snapshotId}`;
    fake.lastOpId = lastOpId ?? fake.lastOpId;
    return { version: fake.version, stateHash: fake.stateHash, lastOpId: fake.lastOpId, snapshotVersion: fake.version };
  },
  uploadStorageObjectViaTunnel: async (_token: string, objectKey: string, payload: Uint8Array) => {
    fake.objects.set(objectKey, Uint8Array.from(payload));
    return { ok: true };
  },
  downloadStorageObjectViaTunnel: async (_token: string, objectKey: string) => {
    const bytes = fake.objects.get(objectKey);
    if (!bytes) throw new realApi.ApiError(404, { error: "not_found" });
    return bytes;
  },
  listStorageObjects: async () => ({ keys: [...fake.objects.keys()] }),
  deleteStorageObjects: async (_token: string, keys: string[]) => {
    for (const key of keys) fake.objects.delete(key);
    return { deleted: keys.length };
  },
}));

// Imported after mock.module so LibraryDb binds the fake API (same as the other LibraryDb integration tests).
const { LibraryDb, PlaybackOpTooLargeError } = await import("../src/libraryDb");
type Db = typeof LibraryDb.prototype;
const defaultProgressOpsFlushDelayMs = LibraryDb.progressOpsFlushDelayMs;

const TOKEN = "token-vault-v4";
const KEY = randomBytes(32).toString("base64");
const PLACEMENT_ID = "0123456789abcdef0123456789abcdef";
const PLACEMENT = `media/${PLACEMENT_ID}`;
const roots: string[] = [];
const useFreshRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "sf-vault-v4-"));
  roots.push(root);
  process.env.SF_USER_DATA_PATH = root;
  return root;
};

beforeEach(() => {
  fake.reset();
  useFreshRoot();
  LibraryDb.progressOpsFlushDelayMs = 0;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
  LibraryDb.progressOpsFlushDelayMs = defaultProgressOpsFlushDelayMs;
});

const catalogTitle = (id: number, type: "movie" | "tv", title: string, episodes = 0) => ({
  id,
  type,
  title,
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2026",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  cast: [],
  trailers: [],
  totalEpisodes: episodes || null,
  seasons: episodes ? [{ seasonNumber: 1, name: "Season 1", overview: null, posterPath: null, airDate: null, episodeCount: episodes }] : [],
  episodes: Array.from({ length: episodes }, (_, index) => ({
    seasonNumber: 1,
    episodeNumber: index + 1,
    name: `Episode ${index + 1}`,
    overview: null,
    stillPath: null,
    airDate: null,
  })),
});

// Real LibraryDb flushes ops on real debounce timers; each poll waits on an explicit condition (same as remote-sync-prepare-apply.test.ts).
const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 10_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await Bun.sleep(10);
  }
};

type TestSqlite = { prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown } };
const internals = (db: Db) =>
  db as unknown as {
    pendingOps: unknown[];
    opsFlushInFlight: boolean;
    syncEnabled: boolean;
    secondaryOpsInFlight: Promise<void> | null;
    coreSqlite: TestSqlite;
    metadataSqlite: TestSqlite;
    playbackSqlite: TestSqlite;
    uploadSnapshot(meta: LibraryMeta): Promise<void>;
    ensurePublishableState(stage: "ops" | "snapshot" | "pending-snapshot"): Promise<boolean>;
  };
const drained = (db: Db) => internals(db).pendingOps.length === 0 && !internals(db).opsFlushInFlight;

const syncOnce = async (db: Db) => {
  const prepared = await db.prepareRemoteSync(null);
  const outcome = await db.applyPreparedRemoteSync(prepared);
  log("sync", { kind: prepared.kind, outcome, serverVersion: fake.version, packed: db.isPackedPlaybackLayout() });
  return prepared.kind;
};

/** What a player needs from a title: its formats' init and chunk keys, its audio tracks' chunk keys. */
const playable = (db: Db, mediaId: string) => {
  const details = db.getMediaDetails(mediaId);
  return {
    title: details?.title ?? null,
    files: (details?.files ?? []).map((file) => `${file.season ?? "-"}x${file.episode ?? "-"}:${file.filename}`).sort(),
    formats: db
      .listMediaFormats(mediaId)
      .map((format) => ({
        file: format.fileId,
        quality: format.quality,
        initKey: format.initKey,
        chunks: format.chunks.map((chunk) => `${chunk.key}|${chunk.sizeBytes}|${chunk.startSeconds}`),
      }))
      .sort((a, b) => `${a.file}${a.quality}`.localeCompare(`${b.file}${b.quality}`)),
    audio: (details?.audioTracks ?? [])
      .map((track) => ({ id: track.id, chunks: (track.chunks ?? []).map((chunk) => chunk.key) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
};

const decodedOps = async (from = 0) =>
  Promise.all(
    fake.ops.slice(from).map(async (op) => ({
      declared: op.declared,
      op: JSON.parse(
        new TextDecoder().decode(await decryptLibraryPayload(KEY, new Uint8Array(Buffer.from(op.payloadCiphertext, "base64"))))
      ) as LibraryOp,
    }))
  );

/** Pushes an op from "another device" onto the fake server's stream, framed like a v4 writer sends it. */
const pushRemoteOp = async (op: LibraryOp) => {
  const payload = await encryptSnapshotBytes(KEY, new TextEncoder().encode(JSON.stringify(op)));
  fake.version += 1;
  fake.ops.push({
    version: fake.version,
    opId: op.id,
    payloadCiphertext: Buffer.from(payload).toString("base64"),
    createdAt: op.createdAt,
    declared: 4,
  });
  fake.stateHash = `remote-${fake.version}`;
  fake.lastOpId = op.id;
};

/**
 * A version-3 library with a version-3 stream after its snapshot: a movie with two formats and an audio track, a
 * two-episode show with one format per episode. The snapshot is published first, the playback arrives as ops.
 */
const seedV3Library = async () => {
  const db = await LibraryDb.open(TOKEN, KEY);
  db.setSyncEnabled(true);
  const movieId = await db.addMediaFromCatalog(catalogTitle(71_001, "movie", "Vault V4 Movie"));
  const showId = await db.addMediaFromCatalog(catalogTitle(71_002, "tv", "Vault V4 Show", 2));
  await waitFor("catalog ops flushed", () => drained(db));
  await db.flushPending();
  log("seed:snapshot", { version: fake.version, snapshotVersion: fake.snapshotVersion });

  const movieFile = await db.linkFileToMedia(movieId, "/videos/movie.mkv");
  await db.addMediaFormat(
    movieId,
    movieFile,
    "1080p",
    "h264",
    10,
    Array.from({ length: 6 }, (_, index) => ({ key: `${PLACEMENT}/${randomUUID()}`, sizeBytes: 1000 + index, startSeconds: index * 4 })),
    4000,
    { initKey: `${PLACEMENT}/movie-init`, initSize: 100, durationSeconds: 24, totalSize: 6200, isSource: true }
  );
  await db.addMediaFormat(movieId, movieFile, "360p", "h264", 2, [`${PLACEMENT}/movie-360-a`, `${PLACEMENT}/movie-360-b`], 800, {
    initKey: `${PLACEMENT}/movie-360-init`,
  });
  await db.addAudioTrackWithChunks({
    mediaId: movieId,
    fileId: movieFile,
    season: null,
    episode: null,
    language: "en",
    label: "English",
    codec: "aac",
    initKey: `${PLACEMENT}/movie-audio-init`,
    initSize: 10,
    durationSeconds: 24,
    totalSize: 110,
    chunks: [{ key: `${PLACEMENT}/${randomUUID()}`, sizeBytes: 100 }],
  });
  for (const episode of [1, 2]) {
    const fileId = await db.linkFileToMedia(showId, `/videos/s01e0${episode}.mkv`, 1, episode);
    await db.addMediaFormat(showId, fileId, "720p", "h264", 4, [{ key: `${PLACEMENT}/${randomUUID()}`, sizeBytes: 500 }], 2000, {
      initKey: `${PLACEMENT}/ep${episode}-init`,
    });
  }
  await waitFor("playback ops flushed", () => drained(db));
  log("seed:stream", { version: fake.version, snapshotVersion: fake.snapshotVersion, ops: fake.ops.length });
  return { db, movieId, showId };
};

const playbackRows = (db: Db, sql: string, ...params: unknown[]) => internals(db).playbackSqlite.prepare(sql).all(...params);

describe("vault v4 runtime (LIB-FMT-11/12/13)", () => {
  it("an unswitched account never writes op stream 4 and keeps the version-3 layout", async () => {
    const { db, movieId, showId } = await seedV3Library();
    await internals(db).uploadSnapshot(fake.meta());
    log("state:declared", { opPuts: fake.opPuts, snapshotPuts: fake.snapshotPuts, stored: fake.stored });
    expect(fake.opPuts.length).toBeGreaterThan(0);
    expect(fake.snapshotPuts.length).toBeGreaterThanOrEqual(2);
    expect(fake.opPuts.every((version) => version === 3)).toBe(true);
    expect(fake.snapshotPuts.every((version) => version === 3)).toBe(true);
    expect(fake.stored).toBe(3);
    expect(db.getTargetOpStreamVersion()).toBe(3);
    expect(db.isPackedPlaybackLayout()).toBe(false);
    // Every op is a version-3 op: playback rides inside media.upsert.
    const types = new Set((await decodedOps()).map((entry) => entry.op.type));
    log("state:op-types", [...types]);
    expect(types.has("media.file.playback.set")).toBe(false);
    expect(playable(db, movieId).formats.length).toBe(2);
    expect(playable(db, showId).formats.length).toBe(2);
    db.close();
  }, 60_000);

  it("a v3 library plus a v3 stream reads the same titles and playable keys after the switch, and publishes the converted copy once", async () => {
    const { db: writer, movieId, showId } = await seedV3Library();
    const before = { movie: playable(writer, movieId), show: playable(writer, showId) };
    log("state:before", { movieFormats: before.movie.formats.length, showFormats: before.show.formats.length });
    expect(before.movie.formats.length).toBe(2);
    expect(before.movie.audio[0]?.chunks.length).toBe(1);

    log("phase:a version-3 device reads it unswitched");
    useFreshRoot();
    const unswitched = await LibraryDb.open(TOKEN, KEY);
    expect(unswitched.isPackedPlaybackLayout()).toBe(false);
    expect({ movie: playable(unswitched, movieId), show: playable(unswitched, showId) }).toEqual(before);
    unswitched.close();

    log("phase:switch the account");
    fake.target = 4;
    const snapshotPutsBefore = fake.snapshotPuts.length;

    log("phase:a fresh device opens the version-3 snapshot + stream on the switched account");
    useFreshRoot();
    const fresh = await LibraryDb.open(TOKEN, KEY);
    log("state:fresh", { packed: fresh.isPackedPlaybackLayout(), target: fresh.getTargetOpStreamVersion(), snapshotPuts: fake.snapshotPuts });
    expect(fresh.getTargetOpStreamVersion()).toBe(4);
    expect(fresh.isPackedPlaybackLayout()).toBe(true);
    expect({ movie: playable(fresh, movieId), show: playable(fresh, showId) }).toEqual(before);
    // It reached the server head with nothing pending, so it publishes the converted copy declaring 4.
    expect(fake.snapshotPuts.slice(snapshotPutsBefore)).toEqual([4]);
    expect(fake.stored).toBe(4);
    const rows = playbackRows(fresh, "SELECT key_mode, count FROM media_chunk_lists ORDER BY count") as Array<{ key_mode: number; count: number }>;
    log("state:packed-rows", rows);
    expect(rows.length).toBe(5);
    expect(playbackRows(fresh, "SELECT COUNT(*) AS n FROM media_format_chunks")).toEqual([{ n: 0 }]);

    log("phase:the long-running writer adopts the switch on its next sync and publishes nothing more");
    await syncOnce(writer);
    log("state:writer", { packed: writer.isPackedPlaybackLayout(), snapshotPuts: fake.snapshotPuts, stored: fake.stored });
    expect(writer.isPackedPlaybackLayout()).toBe(true);
    expect(fake.snapshotPuts.slice(snapshotPutsBefore)).toEqual([4]);
    expect({ movie: playable(writer, movieId), show: playable(writer, showId) }).toEqual(before);
    await syncOnce(fresh);
    expect(fake.snapshotPuts.slice(snapshotPutsBefore)).toEqual([4]);

    log("phase:a third device opens the version-4 snapshot");
    useFreshRoot();
    const third = await LibraryDb.open(TOKEN, KEY);
    expect(third.isPackedPlaybackLayout()).toBe(true);
    expect({ movie: playable(third, movieId), show: playable(third, showId) }).toEqual(before);
    for (const db of [writer, fresh, third]) db.close();
  }, 90_000);

  it("the device that loses the race to publish the converted copy keeps its own copy", async () => {
    const { db: writer, movieId } = await seedV3Library();
    const before = playable(writer, movieId);
    fake.target = 4;
    fake.failNextSnapshot = () => new realApi.ApiError(409, { error: "version_conflict", version: fake.version + 1 });
    const getLibraryDbBefore = fake.getLibraryDbCalls;
    await syncOnce(writer);
    log("state:loser", { snapshotPuts: fake.snapshotPuts, getLibraryDb: fake.getLibraryDbCalls - getLibraryDbBefore, pending: writer.hasPendingSync() });
    expect(fake.snapshotPuts.at(-1)).toBe(4);
    expect(fake.getLibraryDbCalls).toBe(getLibraryDbBefore);
    expect(writer.isPackedPlaybackLayout()).toBe(true);
    expect(writer.hasPendingSync()).toBe(false);
    expect(playable(writer, movieId)).toEqual(before);
    writer.close();
  }, 60_000);

  it("a switched writer sends v4 ops and another device applies set, delete and episode.delete", async () => {
    const { db: writer, movieId, showId } = await seedV3Library();
    fake.target = 4;
    await syncOnce(writer);
    expect(writer.isPackedPlaybackLayout()).toBe(true);
    useFreshRoot();
    const reader = await LibraryDb.open(TOKEN, KEY);
    expect(playable(reader, movieId)).toEqual(playable(writer, movieId));

    log("phase:writer adds a format to the movie file");
    const opsBefore = fake.ops.length;
    const putsBefore = fake.opPuts.length;
    const movieFile = writer.getMediaDetails(movieId)!.files[0]!.id;
    await writer.addMediaFormat(movieId, movieFile, "720p", "h264", 4, [`${PLACEMENT}/${randomUUID()}`], 2000, {
      initKey: `${PLACEMENT}/movie-720-init`,
    });
    await waitFor("v4 ops flushed", () => drained(writer));
    const sent = await decodedOps(opsBefore);
    log("state:sent", sent.map((entry) => ({ type: entry.op.type, declared: entry.declared })));
    expect(fake.opPuts.slice(putsBefore).every((version) => version === 4)).toBe(true);
    expect(sent.map((entry) => entry.op.type)).toContain("media.file.playback.set");
    // Only the changed title's playback goes up: the show's episodes are untouched.
    const sets = sent.flatMap((entry) => (entry.op.type === "media.file.playback.set" ? [entry.op.payload] : []));
    expect(sets.every((set) => set.mediaId === movieId)).toBe(true);
    expect(sets.some((set) => set.fileId === movieFile)).toBe(true);
    expect(await syncOnce(reader)).toBe("ops");
    expect(playable(reader, movieId)).toEqual(playable(writer, movieId));
    expect(playable(reader, movieId).formats.length).toBe(3);

    log("phase:writer removes every format of the movie file");
    for (const format of writer.listMediaFormats(movieId)) await writer.removeMediaFormat(format.id);
    await waitFor("removal ops flushed", () => drained(writer));
    log("state:removal-ops", (await decodedOps(opsBefore + sent.length)).map((entry) => entry.op.type));
    expect(await syncOnce(reader)).toBe("ops");
    expect(playable(reader, movieId).formats).toEqual([]);
    expect(playable(reader, movieId)).toEqual(playable(writer, movieId));

    log("phase:a second change to the same file sends only that file's playback");
    const opsBeforeSecond = fake.ops.length;
    await writer.addMediaFormat(movieId, movieFile, "480p", "h264", 2, [`${PLACEMENT}/${randomUUID()}`], 1000);
    await waitFor("second change flushed", () => drained(writer));
    const second = (await decodedOps(opsBeforeSecond)).map((entry) => entry.op);
    log("state:second", second.map((op) => op.type));
    expect(second.filter((op) => op.type === "media.file.playback.set").length).toBe(1);
    expect(await syncOnce(reader)).toBe("ops");
    expect(playable(reader, movieId)).toEqual(playable(writer, movieId));

    log("phase:another device deletes a file's playback and one episode");
    const show = reader.getMediaDetails(showId)!;
    const episodeOne = show.episodes.find((episode) => episode.episodeNumber === 1)!;
    const episodeOneFile = show.files.find((file) => file.episode === 1)!.id;
    const episodeTwoFile = show.files.find((file) => file.episode === 2)!.id;
    const createdAt = new Date(Date.now() + 1000).toISOString();
    await pushRemoteOp({
      id: randomUUID(),
      type: "media.file.playback.delete",
      createdAt,
      payload: { mediaId: showId, fileId: episodeTwoFile },
    });
    await pushRemoteOp({
      id: randomUUID(),
      type: "media.episode.delete",
      createdAt,
      payload: { mediaId: showId, episodeId: episodeOne.id, seasonNumber: 1, episodeNumber: 1, fileIds: [episodeOneFile] },
    });
    expect(await syncOnce(reader)).toBe("ops");
    const after = reader.getMediaDetails(showId)!;
    log("state:show-after", {
      episodes: after.episodes.map((episode) => episode.episodeNumber),
      files: after.files.map((file) => file.episode),
      formats: reader.listMediaFormats(showId).map((format) => format.fileId),
    });
    expect(after.episodes.map((episode) => episode.episodeNumber)).toEqual([2]);
    expect(after.files.map((file) => file.id)).toEqual([episodeTwoFile]);
    expect(reader.listMediaFormats(showId)).toEqual([]);
    for (const db of [writer, reader]) db.close();
  }, 90_000);

  it("a version-3 device that receives a v4 op converts before applying it", async () => {
    const { db: writer, movieId } = await seedV3Library();
    writer.close();
    useFreshRoot();
    const reader = await LibraryDb.open(TOKEN, KEY);
    expect(reader.isPackedPlaybackLayout()).toBe(false);
    const movieFile = reader.getMediaDetails(movieId)!.files[0]!.id;
    // The account switches and another device's v4 op lands; this device's next sync reads both.
    fake.target = 4;
    fake.stored = 4;
    await pushRemoteOp({
      id: randomUUID(),
      type: "media.file.playback.delete",
      createdAt: new Date(Date.now() + 1000).toISOString(),
      payload: { mediaId: movieId, fileId: movieFile },
    });
    await syncOnce(reader);
    expect(reader.isPackedPlaybackLayout()).toBe(true);
    expect(reader.listMediaFormats(movieId)).toEqual([]);
    reader.close();
  }, 60_000);

  it("stores a seeded chunk list as key mode 2 and ignores a seed that does not reproduce the keys", async () => {
    fake.target = 4;
    const db = await LibraryDb.open(TOKEN, KEY);
    db.setSyncEnabled(true);
    expect(db.isPackedPlaybackLayout()).toBe(true);
    const mediaId = await db.addMediaFromCatalog(catalogTitle(71_010, "movie", "Seeded"));
    const fileId = await db.linkFileToMedia(mediaId, "/videos/seeded.mkv");
    const seed = randomBytes(16);
    const seededKeys = Array.from({ length: 4 }, (_, index) => seedChunkKey(seed, PLACEMENT_ID, index));
    const seeded = await db.addMediaFormat(
      mediaId,
      fileId,
      "1080p",
      "h264",
      4,
      seededKeys.map((key, index) => ({ key, sizeBytes: 2000 + index, startSeconds: index * 2 })),
      4000,
      { chunkKeySeed: seed.toString("base64") }
    );
    const badKeys = [`${PLACEMENT}/${randomUUID()}`, `${PLACEMENT}/${randomUUID()}`];
    const unseeded = await db.addMediaFormat(mediaId, fileId, "360p", "h264", 1, badKeys, 800, {
      chunkKeySeed: randomBytes(16).toString("base64"),
    });
    const modes = Object.fromEntries(
      (playbackRows(db, "SELECT owner_id, key_mode FROM media_chunk_lists") as Array<{ owner_id: string; key_mode: number }>).map(
        (row) => [row.owner_id, row.key_mode]
      )
    );
    log("state:key-modes", modes);
    expect(modes[seeded]).toBe(CHUNK_LIST_KEY_MODE.seed);
    expect(modes[unseeded]).not.toBe(CHUNK_LIST_KEY_MODE.seed);
    const formats = new Map(db.listMediaFormats(mediaId).map((format) => [format.id, format.chunks.map((chunk) => chunk.key)]));
    expect(formats.get(seeded)).toEqual(seededKeys);
    expect(formats.get(unseeded)).toEqual(badKeys);

    log("phase:the seeded list goes up as a seed and a reader expands the same keys");
    await waitFor("ops flushed", () => drained(db));
    await db.flushPending();
    useFreshRoot();
    const reader = await LibraryDb.open(TOKEN, KEY);
    const readerFormats = new Map(reader.listMediaFormats(mediaId).map((format) => [format.id, format.chunks.map((chunk) => chunk.key)]));
    expect(readerFormats.get(seeded)).toEqual(seededKeys);
    expect(readerFormats.get(unseeded)).toEqual(badKeys);
    for (const open of [db, reader]) open.close();
  }, 60_000);

  it("refuses a file's playback that does not fit in one op instead of truncating it", async () => {
    fake.target = 4;
    const db = await LibraryDb.open(TOKEN, KEY);
    db.setSyncEnabled(true);
    const mediaId = await db.addMediaFromCatalog(catalogTitle(71_020, "movie", "Too Large"));
    const fileId = await db.linkFileToMedia(mediaId, "/videos/large.mkv");
    // Text keys (key mode 0) that are not UUIDs: ~1.6 MB of keys once base64'd into the op.
    const keys = Array.from({ length: 24_000 }, (_, index) => `${PLACEMENT}/chunk-${index}-${randomBytes(12).toString("hex")}`);
    let thrown: unknown = null;
    try {
      await db.addMediaFormat(mediaId, fileId, "2160p", "hevc", 9000, keys, 40_000);
    } catch (error) {
      thrown = error;
    }
    log("state:thrown", { name: (thrown as Error | null)?.name, message: (thrown as Error | null)?.message });
    expect(thrown).toBeInstanceOf(PlaybackOpTooLargeError);
    expect((thrown as InstanceType<typeof PlaybackOpTooLargeError>).fileId).toBe(fileId);
    // The rows stay whole locally; nothing truncated went up.
    expect(db.listMediaFormats(mediaId)[0]?.chunks.length).toBe(keys.length);
    await waitFor("other ops flushed", () => drained(db));
    const sent = await decodedOps();
    // The file's earlier (empty) playback from linking it may have gone up; no set carrying the refused format did.
    const fileSets = sent.flatMap((entry) =>
      entry.op.type === "media.file.playback.set" && entry.op.payload.fileId === fileId ? [entry.op.payload] : []
    );
    log("state:file-sets", fileSets.map((set) => set.formats.length));
    expect(fileSets.every((set) => set.formats.length === 0)).toBe(true);
    db.close();
  }, 60_000);

  it("discards a version-3 pending snapshot once the account switched", async () => {
    const { db, movieId } = await seedV3Library();
    fake.failNextSnapshot = () => new realApi.ApiError(503, { error: "unavailable" });
    await internals(db).uploadSnapshot(fake.meta()).catch((error: unknown) => log("state:upload-failed", String(error)));
    expect(db.hasPendingSync()).toBe(true);
    fake.target = 4;
    expect(await db.refreshTargetOpStreamVersion()).toBe(4);
    const putsBefore = fake.snapshotPuts.length;
    await db.flushPending();
    log("state:after-flush", { pending: db.hasPendingSync(), snapshotPuts: fake.snapshotPuts.slice(putsBefore) });
    expect(db.hasPendingSync()).toBe(false);
    expect(fake.snapshotPuts.slice(putsBefore).includes(3)).toBe(false);
    expect(playable(db, movieId).formats.length).toBe(2);
    db.close();
  }, 60_000);

  it("an op refused with 426 library_op_stream converts the copy and goes again declaring 4", async () => {
    const { db, movieId } = await seedV3Library();
    expect(db.isPackedPlaybackLayout()).toBe(false);
    fake.target = 4;
    const putsBefore = fake.opPuts.length;
    await db.setProgress(movieId, 33);
    await waitFor("op flushed after the switch", () => drained(db) && fake.opPuts.length > putsBefore);
    log("state:declared", fake.opPuts.slice(putsBefore));
    expect(fake.opPuts.slice(putsBefore)[0]).toBe(3);
    expect(fake.opPuts.slice(putsBefore).at(-1)).toBe(4);
    expect(db.isPackedPlaybackLayout()).toBe(true);
    expect(db.getTargetOpStreamVersion()).toBe(4);
    db.close();
  }, 60_000);

  /**
   * @bugfix @regression-proof LIB-SYNC-22 (Badger delete leak, 2026-11-23 release smoke)
   * A device that applied another device's `media.delete` kept the title's metadata/playback/templates rows: only
   * `media.upsert` and the version-4 playback ops reached those files, and compaction kept a `media.file.playback.set`
   * of a title deleted later in the same batch. With the title gone from `media_items` the rows were orphans; once the
   * device deleted its last title, the publish guard (`semantic_orphaned_playback_rows`) quarantined sync, so that
   * delete never reached the server and the title came back on every other device.
   * @req LIB-SYNC-22[runtime]
   */
  const secondaryRows = (db: Db, mediaId: string) => {
    const one = (sqlite: { prepare(sql: string): { all(...params: unknown[]): unknown[] } }, table: string, column = "media_id") =>
      sqlite.prepare(`SELECT COUNT(1) AS c FROM ${table} WHERE ${column} = ?`).all(mediaId)[0] as { c: number };
    const rows = {
      media_items: one(internals(db).coreSqlite, "media_items", "id").c,
      media_files: one(internals(db).metadataSqlite, "media_files").c,
      media_formats: one(internals(db).playbackSqlite, "media_formats").c,
      media_audio_tracks: one(internals(db).playbackSqlite, "media_audio_tracks").c,
      media_file_playback: one(internals(db).playbackSqlite, "media_file_playback").c,
      chunk_lists: (playbackRows(db, "SELECT owner_id FROM media_chunk_lists") as unknown[]).length,
    };
    return rows;
  };
  const secondaryDone = (db: Db) => internals(db).secondaryOpsInFlight === null;
  const addPlayableFilm = async (db: Db, catalogId: number, name: string) => {
    const id = await db.addMediaFromCatalog(catalogTitle(catalogId, "movie", name));
    const file = await db.linkFileToMedia(id, `/videos/${name}.mp4`);
    await db.addMediaFormat(id, file, "360p", "h264", 1, [{ key: `${PLACEMENT}/${randomUUID()}`, sizeBytes: 500 }], 700, { initKey: `${PLACEMENT}/${name}-init`, initSize: 10, durationSeconds: 6, totalSize: 510 });
    await db.addAudioTrackWithChunks({ mediaId: id, fileId: file, season: null, episode: null, language: "en", label: "English", codec: "aac", initKey: `${PLACEMENT}/${name}-audio-init`, initSize: 10, durationSeconds: 6, totalSize: 110, chunks: [{ key: `${PLACEMENT}/${randomUUID()}`, sizeBytes: 100 }] });
    await db.markMediaPlayable(id);
    return id;
  };
  /** Device A on a switched, empty library and a fresh device B on the same account. */
  const twoDevicesOnEmptyV4Library = async () => {
    const { db: a } = await seedV3Library();
    fake.target = 4;
    await syncOnce(a);
    for (const media of a.getSnapshot().media as Array<{ id: string }>) await a.deleteMedia(media.id);
    await waitFor("a drained", () => drained(a));
    await internals(a).uploadSnapshot(fake.meta());
    useFreshRoot();
    const b = await LibraryDb.open(TOKEN, KEY);
    b.setSyncEnabled(true);
    await syncOnce(b);
    await waitFor("b secondary applied", () => secondaryDone(b));
    log("two-devices:ready", { version: fake.version, snapshotVersion: fake.snapshotVersion, bMedia: (b.getSnapshot().media as unknown[]).length });
    return { a, b };
  };
  /** B deletes `mediaId` (its last title) and must send the delete and stay in sync. */
  const expectLastDeleteReachesServer = async (b: Db, mediaId: string, label: string) => {
    const opsBefore = fake.ops.length;
    await b.deleteMedia(mediaId);
    await waitFor(`${label}: b drained after delete`, () => drained(b) || !internals(b).syncEnabled, 10_000).catch((error) =>
      log(`${label}:not-drained`, String(error))
    );
    const sent = (await decodedOps(opsBefore)).map((entry) => entry.op);
    log(`${label}:sent`, { sent: sent.map((op) => op.type), syncEnabled: internals(b).syncEnabled, pending: internals(b).pendingOps.length, orphans: {
      formats: playbackRows(b, "SELECT media_id FROM media_formats"),
      audio: playbackRows(b, "SELECT media_id FROM media_audio_tracks"),
      filePlayback: playbackRows(b, "SELECT media_id FROM media_file_playback"),
    } });
    expect(internals(b).syncEnabled).toBe(true);
    expect(sent.some((op) => op.type === "media.delete" && op.payload.mediaId === mediaId)).toBe(true);
    expect(playbackRows(b, "SELECT media_id FROM media_formats")).toEqual([]);
    expect(playbackRows(b, "SELECT media_id FROM media_audio_tracks")).toEqual([]);
  };

  it("@bugfix a remote add + delete in one batch leaves no playback rows, and the device's last delete still reaches the server", async () => {
    const { a, b } = await twoDevicesOnEmptyV4Library();
    const opsBefore = fake.ops.length;
    const remoteId = await addPlayableFilm(a, 72_001, "remote");
    await waitFor("a drained after add", () => drained(a));
    await a.deleteMedia(remoteId);
    await waitFor("a drained after delete", () => drained(a));
    log("batch:ops", (await decodedOps(opsBefore)).map((entry) => entry.op.type));

    await syncOnce(b);
    await waitFor("b secondary applied", () => secondaryDone(b));
    const after = secondaryRows(b, remoteId);
    log("batch:b-after", { after, chunkListOwners: playbackRows(b, "SELECT owner_id FROM media_chunk_lists") });
    expect(after).toEqual({ media_items: 0, media_files: 0, media_formats: 0, media_audio_tracks: 0, media_file_playback: 0, chunk_lists: 0 });

    const ownId = await addPlayableFilm(b, 72_002, "own");
    await waitFor("b drained after add", () => drained(b));
    await expectLastDeleteReachesServer(b, ownId, "batch");
    a.close();
    b.close();
  }, 60_000);

  it("@bugfix a remote delete arriving on its own removes the title's metadata and playback rows", async () => {
    const { a, b } = await twoDevicesOnEmptyV4Library();
    const remoteId = await addPlayableFilm(a, 72_003, "kept-then-deleted");
    await waitFor("a drained after add", () => drained(a));
    await syncOnce(b);
    await waitFor("b secondary applied (add)", () => secondaryDone(b));
    const before = secondaryRows(b, remoteId);
    log("alone:b-before", before);
    expect(before.media_items).toBe(1);
    expect(before.media_formats).toBeGreaterThan(0);

    await a.deleteMedia(remoteId);
    await waitFor("a drained after delete", () => drained(a));
    await syncOnce(b);
    await waitFor("b secondary applied (delete)", () => secondaryDone(b));
    const after = secondaryRows(b, remoteId);
    log("alone:b-after", after);
    expect(after).toEqual({ media_items: 0, media_files: 0, media_formats: 0, media_audio_tracks: 0, media_file_playback: 0, chunk_lists: 0 });
    a.close();
    b.close();
  }, 60_000);

  it("@bugfix a device already holding orphaned playback rows still sends the delete of its last title", async () => {
    const { a, b } = await twoDevicesOnEmptyV4Library();
    // The state a 0.1.44–0.1.46 device is left in: a title gone from media_items with its playback rows still there.
    const ghostId = await addPlayableFilm(b, 72_004, "ghost");
    const ownId = await addPlayableFilm(b, 72_005, "own");
    await waitFor("b drained after adds", () => drained(b));
    internals(b).coreSqlite.prepare("DELETE FROM media_items WHERE id = ?").run(ghostId);
    log("legacy:b-orphans", secondaryRows(b, ghostId));
    expect(secondaryRows(b, ghostId).media_formats).toBeGreaterThan(0);

    await expectLastDeleteReachesServer(b, ownId, "legacy");
    expect(secondaryRows(b, ghostId)).toEqual({ media_items: 0, media_files: 0, media_formats: 0, media_audio_tracks: 0, media_file_playback: 0, chunk_lists: 0 });
    a.close();
    b.close();
  }, 60_000);

  it("the publish guard still quarantines playback rows without titles when this device deleted nothing", async () => {
    const { a, b } = await twoDevicesOnEmptyV4Library();
    const id = await addPlayableFilm(b, 72_006, "wiped");
    await waitFor("b drained after add", () => drained(b));
    // A core file that lost its rows (not a delete of this device): the guard must keep refusing to publish.
    internals(b).coreSqlite.prepare("DELETE FROM media_items WHERE id = ?").run(id);
    const publishable = await internals(b).ensurePublishableState("ops");
    log("guard:result", { publishable, syncEnabled: internals(b).syncEnabled, rows: secondaryRows(b, id) });
    expect(publishable).toBe(false);
    expect(internals(b).syncEnabled).toBe(false);
    expect(secondaryRows(b, id).media_formats).toBeGreaterThan(0);
    a.close();
    b.close();
  }, 60_000);
});

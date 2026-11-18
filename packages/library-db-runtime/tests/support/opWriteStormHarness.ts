/**
 * Shared harness for the #25 library write-storm test and bench: an
 * in-memory fake of the library routes LibraryDb touches (the API's
 * semantics: strict baseVersion on op/snapshot PUT, lineage check, one server
 * version per op), the real LibraryDb loaded against it, and the writes the
 * runtime issues for an ingest commit.
 */
import { randomBytes } from "node:crypto";
import { mock } from "bun:test";
import type { LibraryOp } from "@space/shared/libraryOps";
import * as realApi from "../../src/api";
import type { LibraryMeta } from "../../src/api";
import { decryptLibraryPayload } from "../../src/payloadCodec";

const TAG = "[op-write-storm]";
export const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

type FakeOp = { version: number; opId: string; payloadCiphertext: string; size: number; at: number };

export const fake = {
  exists: false,
  version: 0,
  snapshotVersion: 0,
  stateHash: null as string | null,
  lastOpId: null as string | null,
  manifestKey: null as string | null,
  snapshotId: null as string | null,
  ops: [] as FakeOp[],
  objects: new Map<string, Uint8Array>(),
  calls: [] as string[],
  /** When set, putLibraryOp parks on it (after counting itself in putsStarted) so a test can hold a flush in flight. */
  putGate: null as Promise<void> | null,
  putsStarted: 0,
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
    this.calls = [];
    this.putGate = null;
    this.putsStarted = 0;
  },
  dump() {
    return { version: this.version, snapshotVersion: this.snapshotVersion, ops: this.ops.length, lastCalls: this.calls.slice(-20) };
  },
  meta(): LibraryMeta {
    return {
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
      storageFormatVersion: 1,
      opStreamVersion: 1,
    };
  },
};

const versionConflict = () => new realApi.ApiError(409, { error: "version_conflict", version: fake.version });

// mock.module is process-global in a bun test run: every importing file
// calls restoreRealApi() in afterAll so sibling files never hit this fake.
// The harness is evaluated once per run, so only ONE discovered test file may
// import it (the bench is not a *.test.ts file for that reason).
const originalApi = { ...realApi };
export const restoreRealApi = () => {
  mock.module("../../src/api", () => originalApi);
};

mock.module("../../src/api", () => ({
  ...originalApi,
  getLibraryMeta: async () => {
    fake.calls.push(`getLibraryMeta -> v=${fake.version}`);
    return fake.meta();
  },
  getLibraryDb: async () => ({
    exists: fake.exists,
    version: fake.version,
    snapshotVersion: fake.snapshotVersion,
    hash: null,
    manifestKey: fake.manifestKey,
    updatedAt: new Date().toISOString(),
    blobEncoding: "binary" as const,
    snapshotId: fake.snapshotId,
    chunkSize: null,
  }),
  getLibraryOps: async (_token: string, since: number) => {
    const history = fake.ops.filter((op) => op.version > fake.snapshotVersion);
    const minVersion = history.length ? Math.min(...history.map((op) => op.version)) : fake.snapshotVersion;
    const earliestAllowed = Math.max(fake.snapshotVersion, minVersion - 1);
    const tooOld = since < earliestAllowed;
    const ops = tooOld ? [] : history.filter((op) => op.version > since);
    return {
      version: fake.version,
      snapshotVersion: fake.snapshotVersion,
      tooOld,
      ops: ops.map((op) => ({ ...op, createdAt: new Date(op.at).toISOString(), objectKey: `library/ops/${op.opId}` })),
      storageFormatVersion: 1,
      opStreamVersion: 1,
    };
  },
  putLibraryOp: async (
    _token: string,
    baseVersion: number,
    opId: string,
    payload: Uint8Array,
    lineage?: { prevStateHash?: string | null; nextStateHash?: string | null }
  ) => {
    fake.putsStarted += 1;
    if (fake.putGate) await fake.putGate;
    if (baseVersion !== fake.version) {
      fake.calls.push(`putLibraryOp base=${baseVersion} -> 409 current=${fake.version}`);
      throw versionConflict();
    }
    const prev = lineage?.prevStateHash ?? null;
    if (prev !== null && prev !== fake.stateHash) {
      throw new realApi.ApiError(409, { error: "lineage_conflict", currentStateHash: fake.stateHash });
    }
    fake.version += 1;
    fake.stateHash = lineage?.nextStateHash ?? fake.stateHash;
    fake.lastOpId = opId;
    fake.ops.push({
      version: fake.version,
      opId,
      payloadCiphertext: Buffer.from(payload).toString("base64"),
      size: payload.byteLength,
      at: Date.now(),
    });
    fake.calls.push(`putLibraryOp op=${opId.slice(0, 8)} bytes=${payload.byteLength} -> v=${fake.version}`);
    return { version: fake.version, snapshotVersion: fake.snapshotVersion, stateHash: fake.stateHash, lastOpId: opId };
  },
  putLibraryDb: async (
    _token: string,
    expectedVersion: number,
    manifestBase64: string,
    snapshotId: string,
    _chunkSize: number,
    _keyProbe?: string | null,
    _force?: boolean,
    stateHash?: string | null,
    lastOpId?: string | null
  ) => {
    if (expectedVersion !== fake.version) throw versionConflict();
    fake.version += 1;
    fake.snapshotVersion = fake.version;
    fake.exists = true;
    fake.snapshotId = snapshotId;
    fake.manifestKey = `library/manifests/${snapshotId}`;
    fake.objects.set(fake.manifestKey, new TextEncoder().encode(manifestBase64));
    fake.stateHash = stateHash ?? fake.stateHash ?? `snap-${snapshotId}`;
    fake.lastOpId = lastOpId ?? fake.lastOpId;
    fake.calls.push(`putLibraryDb -> v=${fake.version}`);
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

// Dynamic import on purpose (module-loading boundary): libraryDb must load
// AFTER mock.module so its `./api` bindings resolve to the fake.
export const { LibraryDb } = await import("../../src/libraryDb");
export type Db = typeof LibraryDb.prototype;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export const TOKEN = "token-op-write-storm";
export const KEY = randomBytes(32).toString("base64");

// Private sync state, read for conditions/diagnostics only (no public accessor).
type Internals = { pendingOps: Array<{ type: string }>; opsFlushInFlight: boolean };
const internalsOf = (db: Db) => db as unknown as Internals; // test-only peek
export const drained = (db: Db) => internalsOf(db).pendingOps.length === 0 && !internalsOf(db).opsFlushInFlight;
/** Ops queued locally and not yet uploaded (an in-flight head still counts: flushOps shift()s it on success). */
export const pendingCount = (db: Db) => internalsOf(db).pendingOps.length;

// Real timers on purpose: the op-flush debounce and progress deferral under
// test are real setTimeouts inside LibraryDb; every wait polls a condition.
export const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 10_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      log(`waitFor:timeout ${label}`, fake.dump());
      throw new Error(`waitFor timeout: ${label}`);
    }
    await Bun.sleep(10);
  }
  log(`waitFor:ok ${label}`, { ms: Date.now() - started });
};

export type DecodedServerOp = { version: number; size: number; at: number; op: LibraryOp };
export const decodeServerOps = async (sinceVersion: number): Promise<DecodedServerOp[]> => {
  const decoded: DecodedServerOp[] = [];
  for (const entry of fake.ops) {
    if (entry.version <= sinceVersion) continue;
    const plain = await decryptLibraryPayload(KEY, new Uint8Array(Buffer.from(entry.payloadCiphertext, "base64")));
    decoded.push({ version: entry.version, size: entry.size, at: entry.at, op: JSON.parse(new TextDecoder().decode(plain)) as LibraryOp });
  }
  return decoded;
};

/**
 * Most `media.progress` uploads a progress-only save stream may cause while it
 * runs for `elapsedMs` with `LibraryDb.progressOpsFlushDelayMs === delayMs`.
 *
 * Real semantics of libraryDb.ts (scheduleOpsFlush / queueOp / flushOps):
 *  - A queue holding only progress ops arms ONE timer `delayMs` out; later
 *    saves coalesce into the queue and do not re-arm it. When it fires,
 *    flushOps uploads the head, and a save that lands while that PUT is in
 *    flight is queued BEHIND the head (queueOp never compacts the in-flight
 *    head, `keep = 1`) — so the same flush loop uploads it right after. While
 *    each loop iteration (encrypt + PUT + two small file writes) finishes
 *    within one save interval, one flush drains TWO progress ops: the head
 *    plus the latest value that arrived during the upload.
 *  - The next timer is armed only once the loop has emptied the queue, so
 *    flush starts are at least `delayMs` apart: at most floor(elapsed/delay)
 *    flushes begin while the saves run, plus one final flush for the tail.
 *  Hence uploads <= 2 * (floor(elapsedMs / delayMs) + 1) UNDER THAT ASSUMPTION.
 *  It is not a hard per-flush cap: flushOps re-checks the queue after every
 *  iteration and queueOp keeps whatever is at the head, so a save landing
 *  during the second (or a later) upload is drained by the same loop too. An
 *  iteration stalled past a save interval on a starved runner can therefore
 *  push one flush to 3+ uploads. A real regression (one upload per save, ~20
 *  for a 20-save session) stays far above this bound.
 */
export const maxProgressUploads = (elapsedMs: number, delayMs: number): number =>
  2 * (Math.floor(elapsedMs / delayMs) + 1);

export const summarize = (ops: DecodedServerOp[]) => {
  const byType: Record<string, { count: number; bytes: number }> = {};
  for (const entry of ops) {
    const bucket = (byType[entry.op.type] ??= { count: 0, bytes: 0 });
    bucket.count += 1;
    bucket.bytes += entry.size;
  }
  const bytes = ops.reduce((sum, entry) => sum + entry.size, 0);
  return { ops: ops.length, bytes, bytesPerOp: ops.length ? Math.round(bytes / ops.length) : 0, byType };
};

export const seedMovie = async (db: Db, tmdbId: number, title: string) =>
  db.addMediaFromTmdb({
    id: tmdbId,
    type: "movie",
    title,
    originalTitle: null,
    originalLanguage: "en",
    overview: "A long enough overview so the media details look like a real title. ".repeat(4),
    year: "2026",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast: [],
    trailers: [],
    totalEpisodes: null,
    seasons: [],
    episodes: [],
  });

const chunkList = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ key: `${prefix}/chunk-${index}`, sizeBytes: 4_000_000, startSeconds: index * 4 }));

/** The writes the runtime's source-job commit step issues for one quality (deps-adapter.ts). */
export const ingestCommit = async (db: Db, mediaId: string, quality: string) => {
  const fileId = await db.linkFileToMedia(mediaId, `${mediaId}-${quality}.mkv`);
  const formatId = await db.addMediaFormat(mediaId, fileId, quality, "h264", 1200, chunkList(`v/${quality}`, 180), 4000, {
    durationSeconds: 720,
    totalSize: 720_000_000,
    isSource: true,
  });
  await db.addChaptersForFormat(String(formatId), [
    { title: "Intro", startSeconds: 0 },
    { title: "Main", startSeconds: 60 },
  ]);
  for (const language of ["en", "fr", "de", "es", "it", "ja"]) {
    await db.addAudioTrackWithChunks({
      mediaId,
      fileId,
      season: null,
      episode: null,
      language,
      label: `${language} 5.1`,
      codec: "aac",
      initKey: `a/${quality}/${language}/init`,
      initSize: 800,
      durationSeconds: 720,
      totalSize: 20_000_000,
      chunks: chunkList(`a/${quality}/${language}`, 180),
    });
  }
  for (const language of ["en", "fr", "de", "es"]) {
    await db.addSubtitleTrackWithObject({
      mediaId,
      fileId,
      season: null,
      episode: null,
      language,
      label: language,
      objectKey: `s/${quality}/${language}.vtt`,
      format: "vtt",
    });
  }
  await db.markMediaPlayable(mediaId);
};

export const openSynced = async () => {
  const db = await LibraryDb.open(TOKEN, KEY);
  db.setSyncEnabled(true);
  return db;
};

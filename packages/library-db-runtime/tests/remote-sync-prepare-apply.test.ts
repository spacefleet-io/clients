/**
 * @bugfix @regression-proof
 *
 * #25 N4 — the runtime ran `syncFromRemoteIfNewer` inside its single op gate,
 * network round trip included, so on a saturated uplink one sync held every
 * library read and write for minutes. The sync is now split:
 * `prepareRemoteSync` (network: flush local ops/snapshot, meta, ops/snapshot
 * download) runs outside the gate, `applyPreparedRemoteSync` (local rows)
 * inside it. These tests pin the two correctness edges of that split on the
 * REAL LibraryDb against a fake API:
 *
 *  1. Apply must refuse a fetch whose base moved while it was in flight. Here
 *     a local progress write reaches the server during the slow ops fetch (its
 *     flush hits 409, rebases, re-uploads). Applying the older fetch would
 *     replay the other device's op over the newer local value.
 *  2. A pending compaction snapshot whose base the server has passed (409)
 *     is discarded instead of being re-uploaded on every sync forever.
 *
 * Pre-fix both fail: `prepareRemoteSync`/`applyPreparedRemoteSync` do not
 * exist, and `flushPending` kept the doomed snapshot pending.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { LibraryOp } from "@space/shared/libraryOps";
import * as realApi from "../src/api";
import type { LibraryMeta } from "../src/api";
import { encryptBytesToBytes } from "../src/crypto";
import { decryptLibraryPayload } from "../src/payloadCodec";

const TAG = "[remote-sync-prepare-apply]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

// ---------------------------------------------------------------------------
// Fake API
// ---------------------------------------------------------------------------
type FakeOp = { version: number; opId: string; payloadCiphertext: string; createdAt: string };
type HeldCall = { label: string; release: () => void };

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
  // Session purpose of every object download, in order (STOR-BW-09: library reads open `library`).
  downloadPurposes: [] as Array<string | undefined>,
  // Number of upcoming putLibraryOp calls to hold before / after the commit.
  holdBeforeCommit: 0,
  holdAfterCommit: 0,
  // Number of upcoming getLibraryOps calls to hold (slow remote fetch).
  holdGetOps: 0,
  // Max ops per getLibraryOps page (0 = unpaged), like the API's `hasMore` paging.
  opsPageSize: 0,
  // Versions with no op row (a hole in the history): like the API, ops asked across one are tooOld.
  lostOpVersions: new Set<number>(),
  held: [] as HeldCall[],
  calls: [] as string[],
  // Bytes of every GET /library/db/meta answer served, as JSON (LIB-STORE-05 measurement).
  metaBytes: 0,
  publishes: [] as Array<{ snapshotId: string; chunkRefs: string[]; chunkRefsSource?: { client: string; refsVersion: number } }>,
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
    this.downloadPurposes = [];
    this.holdBeforeCommit = 0;
    this.holdAfterCommit = 0;
    this.holdGetOps = 0;
    this.opsPageSize = 0;
    this.lostOpVersions = new Set();
    this.held = [];
    this.calls = [];
    this.metaBytes = 0;
    this.publishes = [];
  },
  async hold(label: string) {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.held.push({ label, release: resolve });
    this.calls.push(`HELD ${label}`);
    await promise;
  },
  releaseOldestHeld() {
    const call = this.held.shift();
    if (!call) throw new Error("no held call to release");
    this.calls.push(`RELEASED ${call.label}`);
    call.release();
  },
  releaseAllHeld() {
    while (this.held.length) this.releaseOldestHeld();
  },
  dump() {
    return {
      version: this.version,
      snapshotVersion: this.snapshotVersion,
      opVersions: this.ops.map((op) => op.version),
      held: this.held.map((call) => call.label),
      lastCalls: this.calls.slice(-30),
    };
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

// mock.module is process-global in a bun test run: snapshot the REAL exports
// now (before the mock patches the live bindings) and put them back in
// afterAll, or api.test.ts / media-delete-*.test.ts would hit the fake.
const originalApi = { ...realApi };
afterAll(() => {
  mock.module("../src/api", () => originalApi);
});

mock.module("../src/api", () => ({
  ...originalApi,
  getLibraryMeta: async () => {
    const meta = fake.meta();
    fake.metaBytes += Buffer.byteLength(JSON.stringify(meta));
    fake.calls.push(`getLibraryMeta -> v=${fake.version}`);
    return meta;
  },
  getLibraryDb: async () => {
    fake.calls.push(`getLibraryDb -> snapshotVersion=${fake.snapshotVersion}`);
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
    if (fake.holdGetOps > 0) {
      fake.holdGetOps -= 1;
      await fake.hold(`getLibraryOps since=${since}`);
    }
    // Port of the API's getLibraryOps: only ops newer than the snapshot.
    const history = fake.ops.filter((op) => op.version > fake.snapshotVersion);
    const minVersion = history.length ? Math.min(...history.map((op) => op.version)) : fake.snapshotVersion;
    const earliestAllowed = Math.max(fake.snapshotVersion, minVersion - 1);
    const acrossHole = [...fake.lostOpVersions].some((lost) => lost > since && lost <= fake.version);
    const tooOld = since < earliestAllowed || acrossHole;
    const ops = tooOld ? [] : history.filter((op) => op.version > since);
    const pageOps = fake.opsPageSize > 0 ? ops.slice(0, fake.opsPageSize) : ops;
    const hasMore = pageOps.length < ops.length;
    fake.calls.push(`getLibraryOps since=${since} -> ${tooOld ? "tooOld" : `[${ops.map((op) => op.version).join(",")}]`}`);
    return {
      version: pageOps.length && hasMore ? pageOps[pageOps.length - 1]!.version : fake.version,
      snapshotVersion: fake.snapshotVersion,
      tooOld,
      ops: pageOps.map((op) => ({ ...op, objectKey: `library/ops/${op.opId}`, size: 0 })),
      hasMore,
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
    const label = `putLibraryOp base=${baseVersion} op=${opId.slice(0, 8)}`;
    if (fake.holdBeforeCommit > 0) {
      fake.holdBeforeCommit -= 1;
      await fake.hold(`${label} (before commit)`);
    }
    if (baseVersion !== fake.version) {
      fake.calls.push(`${label} -> 409 current=${fake.version}`);
      throw versionConflict();
    }
    const prev = lineage?.prevStateHash ?? null;
    if (prev !== null && prev !== fake.stateHash) {
      fake.calls.push(`${label} -> 409 lineage`);
      throw new realApi.ApiError(409, { error: "lineage_conflict", currentStateHash: fake.stateHash });
    }
    fake.version += 1;
    fake.stateHash = lineage?.nextStateHash ?? fake.stateHash;
    fake.lastOpId = opId;
    fake.ops.push({
      version: fake.version,
      opId,
      payloadCiphertext: Buffer.from(payload).toString("base64"),
      createdAt: new Date().toISOString(),
    });
    fake.calls.push(`${label} -> committed v=${fake.version}`);
    const result = { version: fake.version, snapshotVersion: fake.snapshotVersion, stateHash: fake.stateHash, lastOpId: opId };
    if (fake.holdAfterCommit > 0) {
      fake.holdAfterCommit -= 1;
      await fake.hold(`${label} (response after commit v=${result.version})`);
    }
    return result;
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
    lastOpId?: string | null,
    _appId?: unknown,
    chunkRefs?: string[],
    chunkRefsSource?: { client: string; refsVersion: number }
  ) => {
    fake.publishes.push({ snapshotId, chunkRefs: chunkRefs ?? [], chunkRefsSource });
    if (expectedVersion !== fake.version) {
      fake.calls.push(`putLibraryDb expected=${expectedVersion} -> 409 current=${fake.version}`);
      throw versionConflict();
    }
    fake.version += 1;
    fake.snapshotVersion = fake.version;
    fake.exists = true;
    fake.snapshotId = snapshotId;
    fake.manifestKey = `library/manifests/${snapshotId}`;
    // v0 storage: the stored manifest object is the base64 TEXT of the envelope.
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
  downloadStorageObjectViaTunnel: async (_token: string, objectKey: string, options?: { purpose?: string }) => {
    fake.downloadPurposes.push(options?.purpose);
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

// Dynamic import on purpose: libraryDb must be loaded AFTER mock.module so its
// `./api` bindings resolve to the fake (module-loading boundary under test).
const { LibraryDb } = await import("../src/libraryDb");
type Db = typeof LibraryDb.prototype;
const defaultProgressOpsFlushDelayMs = LibraryDb.progressOpsFlushDelayMs;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TOKEN = "token-remote-sync-split";
const KEY = randomBytes(32).toString("base64");
let root = "";

// Private LibraryDb fields read for diagnostics/conditions only; there is no
// public accessor and the test must observe the sync engine's real state.
type Internals = {
  version: number;
  remoteVersion: number;
  opsFlushInFlight: boolean;
  pendingOps: Array<{ type: string; payload: { progressPct?: number } }>;
  /** Non-progress ops since the last snapshot (LIB-SYNC-07). */
  opsSinceSnapshot: { snapshotVersion: number; count: number };
};
const internalsOf = (db: Db) => {
  const internals = db as unknown as Internals; // test-only peek at private sync state
  return internals;
};

// Real timers are deliberate: flushOps' debounce (250 ms) and 409 backoff
// (2 s) are real setTimeouts inside LibraryDb, and the race under test is
// between those real async paths. Every wait polls an explicit condition.
const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 10_000) => {
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

const drained = (db: Db) => internalsOf(db).pendingOps.length === 0 && !internalsOf(db).opsFlushInFlight;

const progressOf = (db: Db, mediaId: string) => db.getMediaDetails(mediaId)?.progressPct ?? null;

const readCacheJson = () => {
  const path = join(root, "library", "cache.json");
  if (!existsSync(path)) return null;
  const { version, lastOpId } = JSON.parse(readFileSync(path, "utf8")) as { version: number; lastOpId: string | null };
  return { version, lastOpId };
};

/** Last media.progress value the SERVER holds for mediaId (decrypted op log). */
const serverProgress = async (mediaId: string) => {
  let latest: number | null = null;
  for (const op of fake.ops) {
    const plain = await decryptLibraryPayload(KEY, new Uint8Array(Buffer.from(op.payloadCiphertext, "base64")));
    const decoded = JSON.parse(new TextDecoder().decode(plain)) as LibraryOp;
    if (decoded.type === "media.progress" && decoded.payload.mediaId === mediaId) {
      latest = decoded.payload.progressPct;
    }
  }
  return latest;
};

const dumpState = (label: string, db: Db | null, mediaId: string) => {
  const internals = db ? internalsOf(db) : null;
  log(`dump:${label}`, {
    local:
      db && internals
        ? {
            progressPct: progressOf(db, mediaId),
            version: internals.version,
            remoteVersion: internals.remoteVersion,
            opsFlushInFlight: internals.opsFlushInFlight,
            pendingOps: internals.pendingOps.map((op) => `${op.type}:${op.payload?.progressPct ?? ""}`),
          }
        : null,
    cacheJson: readCacheJson(),
    server: fake.dump(),
  });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const MOVIE = {
  id: 25_004,
  type: "movie" as const,
  title: "N4 Sync Split Movie",
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
  totalEpisodes: null,
  seasons: [],
  episodes: [],
};

const bootstrapWithMovie = async () => {
  log("phase:bootstrap LibraryDb.open on empty fake API");
  const db = await LibraryDb.open(TOKEN, KEY);
  db.setSyncEnabled(true);
  const mediaId = await db.addMediaFromCatalog(MOVIE);
  await waitFor("seed ops flushed", () => drained(db));
  dumpState("after-bootstrap", db, mediaId);
  return { db, mediaId };
};

/** Commit a media.progress op as if another device saved it. */
const pushRemoteProgress = async (mediaId: string, progressPct: number) => {
  const op: LibraryOp = {
    id: randomBytes(16).toString("hex"),
    type: "media.progress",
    createdAt: new Date().toISOString(),
    payload: { mediaId, progressPct, updatedAt: new Date().toISOString() },
  } as LibraryOp;
  const encrypted = await encryptBytesToBytes(KEY, new TextEncoder().encode(JSON.stringify(op)));
  fake.version += 1;
  fake.stateHash = `remote-device-${fake.version}`;
  fake.lastOpId = op.id;
  fake.ops.push({
    version: fake.version,
    opId: op.id,
    payloadCiphertext: Buffer.from(encrypted).toString("base64"),
    createdAt: op.createdAt,
  });
  fake.calls.push(`remote device committed media.progress=${progressPct} v=${fake.version}`);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-remote-sync-split-"));
  process.env.SF_USER_DATA_PATH = root;
  fake.reset();
  // These races are about remote rebase, not the progress upload deferral
  // (library-op-write-storm.test.ts): upload each save on the normal debounce.
  LibraryDb.progressOpsFlushDelayMs = 0;
  log("setup", { root });
});

afterEach(() => {
  fake.releaseAllHeld();
  log("teardown", { root });
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
  LibraryDb.progressOpsFlushDelayMs = defaultProgressOpsFlushDelayMs;
});

describe("issue #25 N4 — remote sync split around the runtime op gate", () => {
  it("@bugfix @regression-proof apply refuses a fetch whose base moved in flight, so a newer local write is not rolled back", async () => {
    const { db, mediaId } = await bootstrapWithMovie();
    db.setProgress(mediaId, 10);
    await waitFor("progress 10 uploaded", () => drained(db));

    log("phase:another device saves progress 20");
    await pushRemoteProgress(mediaId, 20);

    log("phase:prepare a sync whose ops fetch is slow (held)");
    fake.holdGetOps = 1;
    const preparing = db.prepareRemoteSync(null);
    await waitFor("ops fetch in flight and held", () => fake.held.length === 1);

    log("phase:local save 30 during the slow fetch — its upload 409s, rebases onto the remote op, re-uploads");
    db.setProgress(mediaId, 30);
    await waitFor("local save 30 reached the server", () => drained(db), 15_000);
    const remoteVersionAfterLocalSave = internalsOf(db).remoteVersion;
    dumpState("after-local-save", db, mediaId);

    fake.releaseAllHeld();
    const prepared = await preparing;
    log("phase:prepared", { kind: prepared.kind, fromVersion: "fromVersion" in prepared ? prepared.fromVersion : null });
    const outcome = await db.applyPreparedRemoteSync(prepared);
    dumpState("after-apply", db, mediaId);
    try {
      expect(prepared.kind).toBe("ops");
      expect(outcome).toBe("stale");
      expect(progressOf(db, mediaId)).toBe(30);
      expect(internalsOf(db).remoteVersion).toBe(remoteVersionAfterLocalSave);
      expect(await serverProgress(mediaId)).toBe(30);
    } catch (err) {
      log("FAIL dump", { outcome, fake: fake.dump() });
      throw err;
    }

    log("phase:the caller's fallback full sync converges on 30");
    await db.syncFromRemoteIfNewer(null);
    expect(progressOf(db, mediaId)).toBe(30);
    db.close();
  }, 30_000);

  it("@bugfix @regression-proof prepare + apply reproduce the one-shot sync when nothing moved", async () => {
    const { db, mediaId } = await bootstrapWithMovie();
    await pushRemoteProgress(mediaId, 64);
    const prepared = await db.prepareRemoteSync(null);
    const outcome = await db.applyPreparedRemoteSync(prepared);
    dumpState("after-apply", db, mediaId);
    expect(outcome).toBe(true);
    expect(progressOf(db, mediaId)).toBe(64);
    expect(internalsOf(db).remoteVersion).toBe(fake.version);
    db.close();
  }, 30_000);

  // @req LIB-SYNC-08[badger-desktop]
  // @req LIB-SYNC-08[runtime]
  it("a write that queues no upsert leaves the details clock where the last sent upsert put it, so an older-looking remote edit still applies", async () => {
    const { db, mediaId } = await bootstrapWithMovie();
    db.markMediaPlayable(mediaId);
    await waitFor("playable upsert uploaded", () => drained(db));
    const sentClock = db.getMediaDetails(mediaId)?.updatedAt;
    log("state:after first markMediaPlayable", { sentClock });

    // A later wall-clock millisecond, so a bumped updated_at would differ.
    const started = Date.now();
    while (Date.now() === started) {
      // spin until the clock ticks
    }
    db.markMediaPlayable(mediaId);
    const afterNoopWrite = db.getMediaDetails(mediaId)?.updatedAt;
    log("state:after no-op markMediaPlayable", { sentClock, afterNoopWrite, pendingOps: internalsOf(db).pendingOps.length });
    expect(internalsOf(db).pendingOps.length).toBe(0);
    expect(afterNoopWrite).toBe(sentClock);
    db.close();
  }, 30_000);

  // @req LIB-SYNC-06[badger-desktop]
  it("an empty op list with tooOld=false is up to date: adopt the version, download no snapshot", async () => {
    const { db, mediaId } = await bootstrapWithMovie();
    const remoteVersionBefore = internalsOf(db).remoteVersion;

    log("phase:LIB-SYNC-06 the server version moves without any op (a snapshot commit by another device)");
    fake.version += 1;
    fake.calls.length = 0;
    dumpState("before-prepare", db, mediaId);

    const prepared = await db.prepareRemoteSync(null);
    log("phase:LIB-SYNC-06 prepared", { kind: prepared.kind, calls: fake.calls, remoteVersionBefore });
    const outcome = await db.applyPreparedRemoteSync(prepared);
    dumpState("after-apply", db, mediaId);
    const snapshotFetched = fake.calls.some((call) => call.startsWith("getLibraryDb"));
    try {
      expect(prepared.kind).toBe("ops");
      expect(snapshotFetched).toBe(false);
      expect(outcome).toBe(false);
      expect(internalsOf(db).remoteVersion).toBe(fake.version);
      expect(internalsOf(db).remoteVersion).toBeGreaterThan(remoteVersionBefore);
    } catch (err) {
      log("FAIL dump", { prepared: prepared.kind, outcome, fake: fake.dump() });
      throw err;
    }

    log("phase:LIB-SYNC-06 the next sync has nothing to ask");
    fake.calls.length = 0;
    expect((await db.prepareRemoteSync(null)).kind).toBe("none");
    expect(fake.calls.some((call) => call.startsWith("getLibraryOps"))).toBe(false);
    db.close();
  }, 30_000);

  it("a paged op tail (hasMore) is collected page by page and applied as one sync", async () => {
    const { db, mediaId } = await bootstrapWithMovie();
    await pushRemoteProgress(mediaId, 11);
    await pushRemoteProgress(mediaId, 22);
    await pushRemoteProgress(mediaId, 33);
    fake.opsPageSize = 2;
    fake.calls.length = 0;

    const prepared = await db.prepareRemoteSync(null);
    log("phase:paged prepared", { kind: prepared.kind, calls: fake.calls });
    const outcome = await db.applyPreparedRemoteSync(prepared);
    dumpState("after-paged-apply", db, mediaId);
    try {
      expect(prepared.kind).toBe("ops");
      expect(fake.calls.filter((call) => call.startsWith("getLibraryOps")).length).toBe(2);
      expect(outcome).toBe(true);
      expect(progressOf(db, mediaId)).toBe(33);
      expect(internalsOf(db).remoteVersion).toBe(fake.version);
    } catch (err) {
      log("FAIL dump", { outcome, fake: fake.dump() });
      throw err;
    }
    db.close();
  }, 30_000);

  it("@bugfix @regression-proof a pending snapshot whose base the server passed (409) is dropped, not re-uploaded every sync", async () => {
    const { db, mediaId } = await bootstrapWithMovie();
    const snapshotPath = join(root, "n4-pending-snapshot.bin");
    const manifestPath = join(root, "n4-pending-manifest.bin");
    writeFileSync(snapshotPath, randomBytes(4096));
    writeFileSync(manifestPath, randomBytes(256));
    // Test seam: plant the pending compaction snapshot an interrupted
    // uploadSnapshot leaves behind, built on a base the server has passed.
    (db as unknown as { pendingSync: unknown }).pendingSync = {
      baseVersion: 0,
      snapshotId: "n4-stale-snapshot",
      chunkSize: 4096,
      snapshotPath,
      manifestPath,
      updatedAt: new Date().toISOString(),
      keyProbe: null,
      stateHash: null,
      lastOpId: null,
    };
    expect(db.hasPendingSync()).toBe(true);

    const countPuts = () => fake.calls.filter((c) => c.startsWith("putLibraryDb")).length;
    const putsBefore = countPuts();
    const first = await db.flushPending();
    const putsAfterFirst = countPuts() - putsBefore;
    log("phase:first flushPending", { first, putsAfterFirst, hasPendingSync: db.hasPendingSync(), calls: fake.calls.slice(-5) });
    await db.flushPending();
    const putsAfterSecond = countPuts() - putsBefore;
    try {
      expect(putsAfterFirst).toBe(1);
      expect(fake.calls).toContain(`putLibraryDb expected=0 -> 409 current=${fake.version}`);
      expect(db.hasPendingSync()).toBe(false);
      expect(putsAfterSecond).toBe(1);
      // Dropping the stale snapshot leaves the local library untouched.
      expect(db.getMediaDetails(mediaId)?.title).toBe(MOVIE.title);
    } catch (err) {
      log("FAIL dump", { putsAfterFirst, putsAfterSecond, fake: fake.dump() });
      throw err;
    } finally {
      db.close();
    }
  }, 30_000);

  // @req LIB-SYNC-03[badger-desktop]
  it("@bugfix @regression-proof a full save older than the device's copy is refused: the library and its version never move backwards", async () => {
    // Live incident 2026-10-28: the server's op history had a hole (a resent op id bumped the version
    // without an op row), so every ops request across it answered tooOld. The runtime then replaced its
    // library with the server's FIRST full save (version 1), set remoteVersion=1, and looped: each upload
    // 409'd, each sync re-applied the same old save. The desktop dropped every frame at or below the
    // version it already showed, so the screen froze and a new import never appeared.
    const { db, mediaId } = await bootstrapWithMovie();
    await pushRemoteProgress(mediaId, 41);
    await pushRemoteProgress(mediaId, 42);
    const remoteVersionBefore = internalsOf(db).remoteVersion;
    // Punch the hole: the first remote op is missing, so ops after the device's version are tooOld.
    const dropped = fake.ops.find((op) => op.version === remoteVersionBefore + 1);
    fake.ops = fake.ops.filter((op) => op !== dropped);
    if (dropped) fake.lostOpVersions.add(dropped.version);
    fake.calls.length = 0;
    log("phase:LIB-SYNC-03 server history has a hole above the device", {
      remoteVersionBefore,
      droppedVersion: dropped?.version ?? null,
      serverSnapshotVersion: fake.snapshotVersion,
      serverVersion: fake.version,
    });
    expect(dropped).toBeDefined();
    expect(fake.snapshotVersion).toBeGreaterThan(0);
    expect(fake.snapshotVersion).toBeLessThan(remoteVersionBefore);

    const prepared = await db.prepareRemoteSync(null);
    const outcome = await db.applyPreparedRemoteSync(prepared);
    dumpState("after-old-snapshot-offered", db, mediaId);
    const manifestDownloads = fake.downloadPurposes.length;
    try {
      expect(fake.calls).toContain(`getLibraryOps since=${remoteVersionBefore} -> tooOld`);
      expect(prepared.kind).toBe("none");
      expect(outcome).toBe(false);
      expect(internalsOf(db).remoteVersion).toBe(remoteVersionBefore);
      expect(internalsOf(db).version).toBeGreaterThanOrEqual(remoteVersionBefore);
      expect(db.getMediaDetails(mediaId)?.title).toBe(MOVIE.title);
    } catch (err) {
      log("FAIL dump", { prepared: prepared.kind, outcome, manifestDownloads, fake: fake.dump() });
      throw err;
    } finally {
      db.close();
    }
  }, 30_000);
});

// PR #143 re-review P1: the orphan sweep deletes chunks no snapshot_history
// entry names, trusting only entries whose producer vouched for its chunkRefs.
// The desktop vouches on every publish, so it must never publish hashes that
// differ from what the published manifest reads.
describe("PR #143 — desktop publishes vouched chunkRefs only (@bugfix @regression-proof)", () => {
  const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  type PendingSeam = { pendingSync: unknown };
  /** Plants the pending compaction snapshot an interrupted uploadSnapshot leaves. */
  const plantPending = (db: Db, name: string, recordRefs: (fileHash: string) => string[] | undefined) => {
    const snapshotBytes = randomBytes(4096);
    const fileHash = sha256(snapshotBytes);
    const snapshotPath = join(root, `${name}-snapshot.bin`);
    const manifestPath = join(root, `${name}-manifest.bin`);
    writeFileSync(snapshotPath, snapshotBytes);
    writeFileSync(manifestPath, randomBytes(256));
    const chunkRefs = recordRefs(fileHash);
    // Test seam: LibraryDb keeps pendingSync private.
    const seam = db as unknown as PendingSeam;
    seam.pendingSync = {
      baseVersion: fake.version,
      snapshotId: name,
      chunkSize: 4096,
      snapshotPath,
      manifestPath,
      updatedAt: new Date().toISOString(),
      keyProbe: null,
      stateHash: fake.stateHash,
      lastOpId: fake.lastOpId,
      ...(chunkRefs ? { chunkRefs } : {}),
    };
    return { fileHash };
  };

  it("bootstrap and a verified pending drain stamp the desktop chunkRefs source", async () => {
    const { db } = await bootstrapWithMovie();
    const bootstrapPublish = fake.publishes[0];
    const { fileHash } = plantPending(db, "p143-verified", (hash) => [hash]);
    await db.flushPending();
    const drainPublish = fake.publishes.at(-1);
    log("phase:p143-verified", { publishes: fake.publishes, hasPendingSync: db.hasPendingSync() });
    try {
      expect(bootstrapPublish?.chunkRefsSource).toEqual({ client: "desktop-runtime", refsVersion: 2 });
      expect(drainPublish?.snapshotId).toBe("p143-verified");
      expect(drainPublish?.chunkRefs).toEqual([fileHash]);
      expect(drainPublish?.chunkRefsSource).toEqual({ client: "desktop-runtime", refsVersion: 2 });
      expect(db.hasPendingSync()).toBe(false);
    } finally {
      db.close();
    }
  }, 30_000);

  it("a pending snapshot file that no longer hashes to its recorded chunkRefs is discarded, never published", async () => {
    const { db, mediaId } = await bootstrapWithMovie();
    plantPending(db, "p143-rewritten", () => ["0".repeat(64)]);
    const publishesBefore = fake.publishes.length;
    await db.flushPending();
    log("phase:p143-rewritten", { publishes: fake.publishes.slice(publishesBefore), hasPendingSync: db.hasPendingSync() });
    try {
      expect(fake.publishes.slice(publishesBefore), "a mismatched pending snapshot must not be published").toEqual([]);
      expect(db.hasPendingSync()).toBe(false);
      expect(db.getMediaDetails(mediaId)?.title).toBe(MOVIE.title);
    } finally {
      db.close();
    }
  }, 30_000);

  it("a pre-#143 pending record (no recorded chunkRefs) publishes without a chunkRefs source", async () => {
    const { db } = await bootstrapWithMovie();
    const { fileHash } = plantPending(db, "p143-legacy", () => undefined);
    await db.flushPending();
    const drainPublish = fake.publishes.at(-1);
    log("phase:p143-legacy", { drainPublish });
    try {
      expect(drainPublish?.snapshotId).toBe("p143-legacy");
      expect(drainPublish?.chunkRefs).toEqual([fileHash]);
      expect(drainPublish?.chunkRefsSource).toBeUndefined();
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("STOR-BW-09 — library reads open `library` sessions", () => {
  it("a fresh device downloading the remote manifest and chunks opens only `library` sessions", async () => {
    const seeded = await bootstrapWithMovie();
    seeded.db.close();
    fake.downloadPurposes = [];

    const secondRoot = mkdtempSync(join(tmpdir(), "sf-remote-sync-split-second-"));
    process.env.SF_USER_DATA_PATH = secondRoot;
    try {
      const db = await LibraryDb.open(TOKEN, KEY);
      db.close();
      log("phase:library-purposes", { purposes: fake.downloadPurposes });
      expect(fake.downloadPurposes.length).toBeGreaterThan(0);
      expect(fake.downloadPurposes.every((purpose) => purpose === "library")).toBe(true);
    } finally {
      rmSync(secondRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("LIB-SYNC-07 — viewing progress never causes a full save of the library", () => {
  const SNAPSHOT_THRESHOLD = 250; // OPS_SNAPSHOT_THRESHOLD in libraryDb.ts
  const snapshotsPublished = () => fake.calls.filter((call) => call.startsWith("putLibraryDb ")).length;
  // Test seam: the 250 ms debounce makes 300 uploads take minutes of wall time,
  // so drive the real flush loop directly until the queue is empty.
  const flushUntilDrained = async (db: Db) => {
    const flushable = db as unknown as { flushOps(): Promise<void> };
    await waitFor("queue filled", () => internalsOf(db).pendingOps.length > 0 || drained(db));
    const started = Date.now();
    while (!drained(db)) {
      if (Date.now() - started > 60_000) throw new Error("flushUntilDrained timeout");
      await flushable.flushOps();
      await Bun.sleep(5);
    }
  };

  // @req LIB-SYNC-07[badger-desktop]
  // @req LIB-SYNC-07[runtime]
  it("a long viewing session of progress ops publishes no snapshot; the same number of structural ops does", async () => {
    const { db, mediaId } = await bootstrapWithMovie();
    const publishedAtStart = snapshotsPublished();
    const versionAtStart = fake.version;
    log("phase:LIB-SYNC-07 bootstrap done", { publishedAtStart, versionAtStart });

    log("phase:LIB-SYNC-07 progress-class ops: distinct episode resume settings + media progress, well past the threshold");
    for (let i = 0; i < SNAPSHOT_THRESHOLD + 50; i += 1) {
      db.setSetting(`episode_resume_v1:ep-${i}`, JSON.stringify({ positionSeconds: i }));
    }
    for (let pct = 1; pct <= 60; pct += 1) db.setProgress(mediaId, pct);
    await flushUntilDrained(db);
    log("phase:LIB-SYNC-07 after progress-class ops", {
      serverVersions: fake.version - versionAtStart,
      snapshotsPublished: snapshotsPublished() - publishedAtStart,
      calls: fake.calls.slice(-5),
    });
    expect(fake.version - versionAtStart).toBeGreaterThan(SNAPSHOT_THRESHOLD);
    expect(snapshotsPublished() - publishedAtStart).toBe(0);

    log("phase:LIB-SYNC-07 structural ops: setting.set with ordinary keys");
    for (let i = 0; i < SNAPSHOT_THRESHOLD + 10; i += 1) db.setSetting(`ui.pref.${i}`, String(i));
    await flushUntilDrained(db);
    await waitFor("snapshot published after the threshold", () => snapshotsPublished() - publishedAtStart >= 1, 30_000);
    log("phase:LIB-SYNC-07 after structural ops", { snapshotsPublished: snapshotsPublished() - publishedAtStart });
    expect(snapshotsPublished() - publishedAtStart).toBeGreaterThanOrEqual(1);
    db.close();
  }, 120_000);

  // @bugfix @regression-proof — pre-fix only unprefixed `episode_resume_v1:` keys were progress-class, so a
  // non-main profile's playback saves (`p:<pid>:episode_resume_v1:`, `p:<pid>:media_progress_v1:`) counted
  // toward the threshold and published a snapshot.
  // @req LIB-SYNC-07[badger-desktop]
  // @req LIB-SYNC-07[runtime]
  it("a non-main profile's progress saves publish no snapshot and never count", async () => {
    const { db } = await bootstrapWithMovie();
    const publishedAtStart = snapshotsPublished();
    const versionAtStart = fake.version;
    const countedAtStart = internalsOf(db).opsSinceSnapshot.count;
    log("phase:LIB-SYNC-07 profile bootstrap done", { publishedAtStart, versionAtStart, countedAtStart });
    for (let i = 0; i < SNAPSHOT_THRESHOLD + 50; i += 1) {
      const key = i % 2 === 0 ? `p:prof-2:episode_resume_v1:ep-${i}` : `p:prof-2:media_progress_v1:media-${i}`;
      db.setSetting(key, JSON.stringify({ progressPct: i % 100, updatedAt: new Date().toISOString() }));
    }
    await flushUntilDrained(db);
    log("phase:LIB-SYNC-07 after profile progress ops", {
      serverVersions: fake.version - versionAtStart,
      snapshotsPublished: snapshotsPublished() - publishedAtStart,
      opsSinceSnapshot: internalsOf(db).opsSinceSnapshot,
    });
    expect(fake.version - versionAtStart).toBeGreaterThan(SNAPSHOT_THRESHOLD);
    expect(snapshotsPublished() - publishedAtStart).toBe(0);
    expect(internalsOf(db).opsSinceSnapshot.count).toBe(countedAtStart);
    db.close();
  }, 120_000);

  const metaCalls = () => fake.calls.filter((call) => call.startsWith("getLibraryMeta")).length;
  // @bugfix @regression-proof — pre-fix every op flush downloaded GET /library/db/meta only to
  // return because progress ops never reach the snapshot threshold (86.5 MB per device in the 2 h
  // playback bench before #744; one wasted request per flush after it).
  // @req LIB-STORE-05[badger-desktop]
  // @req LIB-STORE-05[runtime]
  // @req LIB-SYNC-07[badger-desktop]
  // @req LIB-SYNC-07[runtime]
  it("50 progress saves, each its own flush, download no meta: below the threshold nothing is asked of the server", async () => {
    const FLUSHES = 50;
    const { db, mediaId } = await bootstrapWithMovie();
    const metaCallsAtStart = metaCalls();
    const metaBytesAtStart = fake.metaBytes;
    const versionAtStart = fake.version;
    log("phase:LIB-STORE-05 progress flushes start", { metaCallsAtStart, opsSinceSnapshot: internalsOf(db).opsSinceSnapshot });

    for (let pct = 1; pct <= FLUSHES; pct += 1) {
      db.setProgress(mediaId, pct);
      await flushUntilDrained(db);
    }

    const measured = {
      flushes: FLUSHES,
      opsUploaded: fake.version - versionAtStart,
      metaRequests: metaCalls() - metaCallsAtStart,
      metaBytes: fake.metaBytes - metaBytesAtStart,
      opsSinceSnapshot: internalsOf(db).opsSinceSnapshot,
      snapshotsPublished: snapshotsPublished(),
    };
    log("measure:LIB-STORE-05 progress flushes", { ...measured, lastCalls: fake.calls.slice(-6) });
    expect(measured.opsUploaded).toBe(FLUSHES);
    expect(measured.metaRequests).toBe(0);
    expect(measured.metaBytes).toBe(0);
    db.close();
  }, 60_000);

  // @req LIB-STORE-05[badger-desktop]
  // @req LIB-STORE-05[runtime]
  // @req LIB-SYNC-07[badger-desktop]
  // @req LIB-SYNC-07[runtime]
  it("the structural op that reaches the threshold still reads meta and publishes the compaction snapshot", async () => {
    const { db } = await bootstrapWithMovie();
    const counted = internalsOf(db).opsSinceSnapshot.count;
    const belowThreshold = SNAPSHOT_THRESHOLD - 1 - counted;
    const metaCallsAtStart = metaCalls();
    const publishedAtStart = snapshotsPublished();
    log("phase:LIB-STORE-05 threshold edge start", { counted, belowThreshold, metaCallsAtStart, publishedAtStart });
    expect(belowThreshold).toBeGreaterThan(0);

    for (let i = 0; i < belowThreshold; i += 1) db.setSetting(`ui.pref.${i}`, String(i));
    await flushUntilDrained(db);
    const below = {
      opsSinceSnapshot: internalsOf(db).opsSinceSnapshot,
      metaRequests: metaCalls() - metaCallsAtStart,
      snapshotsPublished: snapshotsPublished() - publishedAtStart,
    };
    log("measure:LIB-STORE-05 one op below the threshold", below);
    expect(below.opsSinceSnapshot.count).toBe(SNAPSHOT_THRESHOLD - 1);
    expect(below.metaRequests).toBe(0);
    expect(below.snapshotsPublished).toBe(0);

    db.setSetting("ui.pref.threshold", "reached");
    await flushUntilDrained(db);
    await waitFor("compaction snapshot published at the threshold", () => snapshotsPublished() - publishedAtStart >= 1, 30_000);
    const crossed = {
      metaRequests: metaCalls() - metaCallsAtStart,
      snapshotsPublished: snapshotsPublished() - publishedAtStart,
      serverSnapshotVersion: fake.snapshotVersion,
      lastCalls: fake.calls.slice(-8),
    };
    log("measure:LIB-STORE-05 threshold crossed", crossed);
    expect(crossed.metaRequests).toBe(1);
    expect(crossed.snapshotsPublished).toBe(1);
    db.close();
  }, 60_000);
});

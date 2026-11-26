/**
 * @test-id LIB-PROGRESS-SURVIVES-REOPEN-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb, in-memory fake API)
 * @bugfix @regression-proof issue #25 P7
 *
 * Playback progress written locally must survive a close + LibraryDb.open
 * (the runtime's `sf-library-db-open` after a desktop app-kill) and must not
 * be regressed by a sync that echoes this device's OWN op back at it.
 *
 * c004 shape (ultimate run): renderer saves progress every ~0.5 s, the
 * runtime writes core sqlite synchronously and queues `media.progress` ops,
 * but under ingest load putLibraryOp lags. The app is killed, the runtime
 * survives, reopens the library, and resume lands on the FIRST save of the
 * session (47.4801 %) instead of the last (~50.8 %).
 *
 * Mechanism proven here: `syncFromRemoteIfNewer` pulls every server op with
 * version > `remoteVersion` and applies it to the local DB. An op this device
 * uploaded but whose response has not been processed by the CURRENT instance
 * (still in flight, or uploaded by the just-closed instance whose flushOps
 * loop keeps running after close()) is indistinguishable from a remote
 * change, so it is applied over newer local rows. The newer local writes
 * stay in `pendingOps`, get uploaded, but are never re-applied locally:
 * the server ends at 50.8 while the local DB (what resume reads) stays 47.48.
 *
 * The fake API is a faithful in-memory port of the API's library routes:
 * strict baseVersion === version on
 * op / snapshot PUT (409 otherwise), lineage check on prevStateHash, and
 * `getLibraryOps` returning only ops newer than the snapshot. putLibraryOp
 * calls can be held BEFORE commit (slow request) or AFTER commit (slow
 * response) to model the loaded API.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { LibraryOp } from "@space/shared/libraryOps";
import * as realApi from "../src/api";
import type { LibraryMeta } from "../src/api";
import { encryptBytesToBytes } from "../src/crypto";
import { decryptLibraryPayload } from "../src/payloadCodec";

const TAG = "[progress-survives-reopen]";
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
  // Number of upcoming putLibraryOp calls to hold before / after the commit.
  holdBeforeCommit: 0,
  holdAfterCommit: 0,
  held: [] as HeldCall[],
  calls: [] as string[],
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
    this.holdBeforeCommit = 0;
    this.holdAfterCommit = 0;
    this.held = [];
    this.calls = [];
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
    fake.calls.push(`getLibraryMeta -> v=${fake.version}`);
    return fake.meta();
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
    // Port of the API's getLibraryOps: only ops newer than the snapshot.
    const history = fake.ops.filter((op) => op.version > fake.snapshotVersion);
    const minVersion = history.length ? Math.min(...history.map((op) => op.version)) : fake.snapshotVersion;
    const earliestAllowed = Math.max(fake.snapshotVersion, minVersion - 1);
    const tooOld = since < earliestAllowed;
    const ops = tooOld ? [] : history.filter((op) => op.version > since);
    fake.calls.push(`getLibraryOps since=${since} -> ${tooOld ? "tooOld" : `[${ops.map((op) => op.version).join(",")}]`}`);
    return {
      version: fake.version,
      snapshotVersion: fake.snapshotVersion,
      tooOld,
      ops: ops.map((op) => ({ ...op, objectKey: `library/ops/${op.opId}`, size: 0 })),
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
    lastOpId?: string | null
  ) => {
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

// Dynamic import on purpose: libraryDb must be loaded AFTER mock.module so its
// `./api` bindings resolve to the fake (module-loading boundary under test).
const { LibraryDb } = await import("../src/libraryDb");
type Db = typeof LibraryDb.prototype;
const defaultProgressOpsFlushDelayMs = LibraryDb.progressOpsFlushDelayMs;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TOKEN = "token-progress-reopen";
const KEY = randomBytes(32).toString("base64");
let root = "";

// Private LibraryDb fields read for diagnostics/conditions only; there is no
// public accessor and the test must observe the sync engine's real state.
type Internals = {
  version: number;
  remoteVersion: number;
  opsFlushInFlight: boolean;
  pendingOps: Array<{ type: string; payload: { progressPct?: number } }>;
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

/** Bootstrap a synced library with one movie, all ops uploaded. */
const bootstrapWithMovie = async () => {
  log("phase:bootstrap LibraryDb.open on empty fake API");
  const db = await LibraryDb.open(TOKEN, KEY);
  db.setSyncEnabled(true);
  const mediaId = await db.addMediaFromCatalog({
    id: 25_007,
    type: "movie",
    title: "P7 Resume Movie",
    originalTitle: null,
    originalLanguage: "en",
    overview: null,
    year: "2026",
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast: [],
    trailers: [],
    totalEpisodes: null,
    seasons: [],
    episodes: [],
  });
  log("phase:bootstrap seeded movie", { mediaId });
  await waitFor("seed ops flushed", () => drained(db));
  dumpState("after-bootstrap", db, mediaId);
  return { db, mediaId };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-progress-reopen-"));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("issue #25 P7 — playback progress survives close + reopen with lagging op uploads", () => {
  it("@bugfix @regression-proof reopen keeps the newest local progress when the closed instance's lagging upload lands after reopen (c004)", async () => {
    const { db, mediaId } = await bootstrapWithMovie();
    const serverVersionBeforeSession = fake.version;

    log("phase:first-save setProgress 47.4801 — its upload is held before commit (API slow under ingest load)");
    fake.holdBeforeCommit = 1;
    db.setProgress(mediaId, 47.4801);
    await waitFor("first-save upload in flight and held", () => fake.held.length === 1);

    log("phase:playback later saves queue behind the stuck upload");
    for (const pct of [48.1, 48.9, 49.6, 50.2, 50.8]) {
      db.setProgress(mediaId, pct);
    }
    dumpState("before-kill", db, mediaId);
    expect(progressOf(db, mediaId)).toBe(50.8);

    log("phase:kill+reopen runtime closes LibraryDb then LibraryDb.open (sf-library-db-open)");
    db.close();
    const reopened = await LibraryDb.open(TOKEN, KEY);
    reopened.setSyncEnabled(true);
    dumpState("after-reopen (old instance's first-save upload still held)", reopened, mediaId);
    expect(progressOf(reopened, mediaId)).toBe(50.8);

    log("phase:zombie the CLOSED instance's held upload commits after reopen read meta (a guarded closed instance then stops uploading; an unguarded one fires a next upload, held too)");
    fake.holdBeforeCommit = 1;
    fake.releaseOldestHeld();
    await waitFor(
      "zombie committed first-save op",
      () => fake.version === serverVersionBeforeSession + 1,
    );
    // A closed instance that stopped uploading never consumed the hold: disarm
    // it so it does not stall the reopened instance's own uploads instead.
    log("zombie-follow-up", { heldAfterZombieCommit: fake.held.length, holdBeforeCommit: fake.holdBeforeCommit });
    if (fake.held.length === 0) fake.holdBeforeCommit = 0;
    dumpState("after-zombie-commit", reopened, mediaId);

    log("phase:reopened-sync first syncFromRemoteIfNewer of the reopened instance (renderer refresh / SSE meta)");
    await reopened.syncFromRemoteIfNewer();
    dumpState("after-first-sync", reopened, mediaId);

    await waitFor("reopened instance uploaded its pendingOps", () => drained(reopened), 20_000);
    log("phase:zombie-dies the closed instance's next upload lands late and 409s");
    fake.releaseAllHeld();
    await waitFor("no held calls", () => fake.held.length === 0);
    await reopened.syncFromRemoteIfNewer();

    const local = progressOf(reopened, mediaId);
    const server = await serverProgress(mediaId);
    dumpState("final", reopened, mediaId);
    log("final:progress", { local, server, expected: 50.8 });

    try {
      expect(server).toBe(50.8);
      expect(local).toBe(50.8);
    } finally {
      reopened.close();
    }
  }, 30_000);

  it("@bugfix @regression-proof syncFromRemoteIfNewer during an in-flight own op upload does not regress local progress", async () => {
    const { db, mediaId } = await bootstrapWithMovie();

    log("phase:save-1 setProgress 47.4801 — server commits it but the HTTP response is slow");
    fake.holdAfterCommit = 1;
    db.setProgress(mediaId, 47.4801);
    await waitFor("op committed and response held", () => fake.held.length === 1);

    log("phase:save-2 setProgress 50.8 while the first upload's response is held");
    db.setProgress(mediaId, 50.8);
    dumpState("before-concurrent-sync", db, mediaId);

    log("phase:concurrent syncFromRemoteIfNewer (SSE meta / renderer refresh)", {
      remoteVersion: internalsOf(db).remoteVersion,
      serverVersion: fake.version,
    });
    await db.syncFromRemoteIfNewer();
    dumpState("after-concurrent-sync", db, mediaId);

    fake.releaseAllHeld();
    await waitFor("ops drained", () => drained(db));
    await db.syncFromRemoteIfNewer();

    const local = progressOf(db, mediaId);
    const server = await serverProgress(mediaId);
    dumpState("final", db, mediaId);
    log("final:progress", { local, server, expected: 50.8 });

    try {
      expect(server).toBe(50.8);
      expect(local).toBe(50.8);
    } finally {
      db.close();
    }
  }, 30_000);

  it("@bugfix @regression-proof reopen via the REMOTE branch (server ahead of cache.json) keeps newest local progress", async () => {
    const { db, mediaId } = await bootstrapWithMovie();

    log("phase:first-save setProgress 47.4801 (uploads fast)");
    db.setProgress(mediaId, 47.4801);
    await waitFor("first-save uploaded", () => drained(db));

    log("phase:lag later saves; their uploads are held before commit");
    fake.holdBeforeCommit = 1;
    for (const pct of [48.1, 48.9, 49.6, 50.2, 50.8]) {
      db.setProgress(mediaId, pct);
    }
    await waitFor("lagging upload held", () => fake.held.length === 1);
    const versionBeforeKill = internalsOf(db).version;
    dumpState("before-kill", db, mediaId);

    log("phase:kill runtime closes LibraryDb; the held request never commits (dropped under load)");
    db.close();
    fake.held = [];

    log("phase:other-device while the app is dead, another device appends 20 setting ops (server version passes cache.json)");
    for (let i = 0; i < 20; i += 1) {
      const op: LibraryOp = {
        id: `other-device-${i}`,
        type: "setting.set",
        createdAt: new Date().toISOString(),
        payload: { key: `other.device.${i}`, value: "x", updatedAt: new Date().toISOString() },
      };
      const encrypted = await encryptBytesToBytes(KEY, new TextEncoder().encode(JSON.stringify(op)));
      fake.version += 1;
      fake.stateHash = `other-device-hash-${i}`;
      fake.lastOpId = op.id;
      fake.ops.push({
        version: fake.version,
        opId: op.id,
        payloadCiphertext: Buffer.from(encrypted).toString("base64"),
        createdAt: op.createdAt,
      });
    }
    dumpState("server-ahead-of-cache", null, mediaId);

    log("phase:reopen LibraryDb.open (pickBlob selects remote: cache.version < meta.version)");
    const reopened = await LibraryDb.open(TOKEN, KEY);
    reopened.setSyncEnabled(true);
    dumpState("after-reopen", reopened, mediaId);
    const versionAfterReopen = internalsOf(reopened).version;

    await waitFor("reopened instance uploaded its pendingOps", () => drained(reopened), 20_000);
    await reopened.syncFromRemoteIfNewer();

    const local = progressOf(reopened, mediaId);
    const server = await serverProgress(mediaId);
    dumpState("final", reopened, mediaId);
    log("final:progress", { local, server, expected: 50.8, versionBeforeKill, versionAfterReopen });

    try {
      expect(server).toBe(50.8);
      // versionAfterReopen < versionBeforeKill (local counter reset to the
      // snapshotVersion) is the c004 "1216 -> 1186" signature; logged, not
      // asserted — it is a separate counter-mixing issue, not the data loss.
      expect(local).toBe(50.8);
    } finally {
      reopened.close();
    }
  }, 30_000);

  it("guard: a genuine progress change from ANOTHER device still applies locally when this device has nothing pending", async () => {
    const { db, mediaId } = await bootstrapWithMovie();
    db.setProgress(mediaId, 47.4801);
    await waitFor("local save uploaded", () => drained(db));

    log("phase:other-device another device watches further and uploads media.progress 80");
    const op: LibraryOp = {
      id: "other-device-progress",
      type: "media.progress",
      createdAt: new Date().toISOString(),
      payload: { mediaId, progressPct: 80, lastWatchedAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    };
    const encrypted = await encryptBytesToBytes(KEY, new TextEncoder().encode(JSON.stringify(op)));
    fake.version += 1;
    fake.stateHash = "other-device-progress-hash";
    fake.lastOpId = op.id;
    fake.ops.push({
      version: fake.version,
      opId: op.id,
      payloadCiphertext: Buffer.from(encrypted).toString("base64"),
      createdAt: op.createdAt,
    });

    await db.syncFromRemoteIfNewer();
    dumpState("after-remote-progress", db, mediaId);
    try {
      expect(progressOf(db, mediaId)).toBe(80);
    } finally {
      db.close();
    }
  }, 30_000);
});

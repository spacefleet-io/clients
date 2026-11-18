/**
 * #25 N4 focused load reproduction — library commands queueing behind the
 * BadgerLibraryDbService op gate. NOT part of any suite: it only runs with
 * SF_N4_LOAD=1, under bun's runner (mock.module + bun:sqlite), e.g.
 *
 *   cd apps/runtime
 *   SF_N4_LOAD=1 systemd-run --user --scope -p CPUQuota=200% \
 *     taskset -c 0-3 bun test ./scripts/n4-library-gate-load.test.ts
 *
 * It drives the REAL service + REAL LibraryDb (per-group SQLite on disk)
 * with the traffic mix the ultimate run produced during an import on a
 * low-end PC, against a fake API whose latencies model a saturated uplink:
 *   - 4 renderer read loops (getMediaDetails / hasPendingSync /
 *     listMediaFormats / getVersion), 100 ms think time;
 *   - a playback progress save every second;
 *   - an ingest commit (runBatch: add title + progress) every 4 s;
 *   - another device committing an op every 1.5 s, each followed by the
 *     renderer's single-flight stream sync (syncFromRemoteIfNewer).
 * Scenario B also plants the stale pending compaction snapshot that made
 * every sync re-upload a snapshot (the hasPendingSync loop).
 *
 * Prints per-command latency percentiles. Wall-clock sleeps are the point
 * here (real contention under a CPU quota), so no fake timers.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "bun:test";
import * as realApi from "../../../packages/library-db-runtime/src/api";
import type { LibraryMeta } from "../../../packages/library-db-runtime/src/api";
import { encryptBytesToBytes } from "../../../packages/library-db-runtime/src/crypto";
// The service loads LibraryDb lazily on open(), i.e. after mock.module below.
import { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";

const RUN = process.env.SF_N4_LOAD === "1";
const DURATION_MS = Number(process.env.SF_N4_DURATION_MS ?? 40_000);
const TAG = "[n4-gate-load]";
const log = (msg: string, data?: unknown) =>
  console.info(`${TAG} ${msg}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);
const sleep = (ms: number) => Bun.sleep(ms);
const jitter = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));

// Saturated-uplink latency model (uploads slow, downloads moderate).
const LATENCY = {
  meta: 300,
  getOps: 800,
  putOp: 1_500,
  uploadChunk: 4_000,
  putDb: 2_000,
  list: 300,
};

type FakeOp = { version: number; opId: string; payloadCiphertext: string; createdAt: string };
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
  counts: {} as Record<string, number>,
  count(name: string) {
    fake.counts[name] = (fake.counts[name] ?? 0) + 1;
  },
  meta(): LibraryMeta {
    return {
      exists: fake.exists,
      bootstrapRequired: !fake.exists,
      syncUnavailable: false,
      version: fake.version,
      snapshotVersion: fake.snapshotVersion,
      hash: null,
      stateHash: fake.stateHash,
      lastOpId: fake.lastOpId,
      consistency: fake.exists ? "ok" : "missing_snapshot",
      updatedAt: new Date().toISOString(),
      keyProbe: null,
      keyProbeUpdatedAt: null,
      blobEncoding: "binary",
      storageFormatVersion: 1,
      opStreamVersion: 1,
      snapshotId: fake.snapshotId,
      manifestKey: fake.manifestKey,
      chunkSize: null,
      snapshotHistory: [],
      opsHistory: [],
    };
  },
};
const conflict = () => new realApi.ApiError(409, { error: "version_conflict", version: fake.version });

mock.module("../../../packages/library-db-runtime/src/api", () => ({
  ...realApi,
  getLibraryMeta: async () => {
    fake.count("getLibraryMeta");
    await sleep(jitter(LATENCY.meta));
    return fake.meta();
  },
  getLibraryDb: async () => {
    fake.count("getLibraryDb");
    await sleep(jitter(LATENCY.meta));
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
    fake.count("getLibraryOps");
    await sleep(jitter(LATENCY.getOps));
    const history = fake.ops.filter((op) => op.version > fake.snapshotVersion);
    const minVersion = history.length ? Math.min(...history.map((op) => op.version)) : fake.snapshotVersion;
    const tooOld = since < Math.max(fake.snapshotVersion, minVersion - 1);
    const ops = tooOld ? [] : history.filter((op) => op.version > since);
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
    fake.count("putLibraryOp");
    await sleep(jitter(LATENCY.putOp));
    if (baseVersion !== fake.version) throw conflict();
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
      createdAt: new Date().toISOString(),
    });
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
    fake.count("putLibraryDb");
    await sleep(jitter(LATENCY.putDb));
    if (expectedVersion !== fake.version) {
      fake.count("putLibraryDb:409");
      throw conflict();
    }
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
    fake.count("uploadStorageObject");
    await sleep(jitter(LATENCY.uploadChunk));
    fake.objects.set(objectKey, Uint8Array.from(payload));
    return { ok: true };
  },
  downloadStorageObjectViaTunnel: async (_token: string, objectKey: string) => {
    const bytes = fake.objects.get(objectKey);
    if (!bytes) throw new realApi.ApiError(404, { error: "not_found" });
    return bytes;
  },
  listStorageObjects: async () => {
    await sleep(jitter(LATENCY.list));
    return { keys: [...fake.objects.keys()] };
  },
  deleteStorageObjects: async (_token: string, keys: string[]) => {
    for (const key of keys) fake.objects.delete(key);
    return { deleted: keys.length };
  },
}));

const TOKEN = "token-n4-load";
const KEY = randomBytes(32).toString("base64");

const movie = (id: number, title: string) => ({
  id,
  type: "movie" as const,
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
  totalEpisodes: null,
  seasons: [],
  episodes: [],
});

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

const runScenario = async (name: string, options: { stalePendingSnapshot: boolean }) => {
  const root = mkdtempSync(join(tmpdir(), "sf-n4-load-"));
  process.env.SF_USER_DATA_PATH = root;
  Object.assign(fake, {
    exists: false, version: 0, snapshotVersion: 0, stateHash: null, lastOpId: null,
    manifestKey: null, snapshotId: null, ops: [], objects: new Map(), counts: {},
  });
  const service = new BadgerLibraryDbService();
  log(`${name}: open`, { root });
  await service.open(TOKEN, KEY, { userId: "user-n4-load" });
  const mediaIds: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    mediaIds.push((await service.call("addMediaFromCatalog", [movie(90_000 + i, `N4 Seed ${i}`)])) as string);
  }
  // Let the seed ops upload so the run starts from a synced library.
  await service.call("syncFromRemoteIfNewer", [null]);

  if (options.stalePendingSnapshot) {
    const snapshotPath = join(root, "n4-pending-snapshot.bin");
    const manifestPath = join(root, "n4-pending-manifest.bin");
    writeFileSync(snapshotPath, randomBytes(6 * 1024 * 1024));
    writeFileSync(manifestPath, randomBytes(512));
    // Test seam: the stale compaction snapshot an interrupted uploadSnapshot leaves.
    const db = (service as unknown as { db: { pendingSync: unknown } }).db;
    db.pendingSync = {
      baseVersion: 0, snapshotId: "n4-stale", chunkSize: 4 * 1024 * 1024, snapshotPath, manifestPath,
      updatedAt: new Date().toISOString(), keyProbe: null, stateHash: null, lastOpId: null,
    };
  }

  const latencies: Record<string, number[]> = {};
  const errors: Record<string, number> = {};
  const timed = async (kind: string, fn: () => Promise<unknown>) => {
    const started = performance.now();
    try {
      await fn();
    } catch (error) {
      errors[kind] = (errors[kind] ?? 0) + 1;
      if ((errors[kind] ?? 0) <= 3) log(`${name}: ${kind} failed`, { message: error instanceof Error ? error.message : String(error) });
    } finally {
      (latencies[kind] ??= []).push(performance.now() - started);
    }
  };

  const deadline = Date.now() + DURATION_MS;
  const readMethods: Array<[string, () => unknown[]]> = [
    ["getMediaDetails", () => [mediaIds[Math.floor(Math.random() * mediaIds.length)]]],
    ["hasPendingSync", () => []],
    ["listMediaFormats", () => [mediaIds[Math.floor(Math.random() * mediaIds.length)]]],
    ["getVersion", () => []],
  ];
  const readLoop = async (offset: number) => {
    let i = offset;
    while (Date.now() < deadline) {
      const [method, args] = readMethods[i % readMethods.length];
      await timed(`read:${method}`, () => service.call(method, args()));
      i += 1;
      await sleep(100);
    }
  };
  const progressLoop = async () => {
    let pct = 1;
    while (Date.now() < deadline) {
      await timed("write:setProgress", () => service.call("setProgress", [mediaIds[0], pct]));
      pct = (pct + 1.7) % 100;
      await sleep(1_000);
    }
  };
  const commitLoop = async () => {
    let n = 0;
    while (Date.now() < deadline) {
      n += 1;
      const id = 95_000 + n;
      await timed("commit:runBatch", () =>
        service.runBatch(`commit:n4-${n}`, async () => {
          const mediaId = (await service.call("addMediaFromCatalog", [movie(id, `N4 Import ${n}`)])) as string;
          await service.call("setProgress", [mediaId, 0.5]);
        })
      );
      await sleep(4_000);
    }
  };
  const remoteLoop = async () => {
    let n = 0;
    while (Date.now() < deadline) {
      n += 1;
      const op = {
        id: randomBytes(16).toString("hex"),
        type: "media.progress",
        createdAt: new Date().toISOString(),
        payload: { mediaId: mediaIds[1], progressPct: n % 100, updatedAt: new Date().toISOString() },
      };
      const encrypted = await encryptBytesToBytes(KEY, new TextEncoder().encode(JSON.stringify(op)));
      fake.version += 1;
      fake.stateHash = `other-device-${fake.version}`;
      fake.lastOpId = op.id;
      fake.ops.push({ version: fake.version, opId: op.id, payloadCiphertext: Buffer.from(encrypted).toString("base64"), createdAt: op.createdAt });
      // Renderer stream sync is single-flight: await it before the next event.
      await timed("sync:syncFromRemoteIfNewer", () => service.call("syncFromRemoteIfNewer", [fake.meta()]));
      await sleep(1_500);
    }
  };

  log(`${name}: load start`, { durationMs: DURATION_MS });
  await Promise.all([readLoop(0), readLoop(1), readLoop(2), readLoop(3), progressLoop(), commitLoop(), remoteLoop()]);
  // Let in-flight work settle before measuring end state.
  await service.call("syncFromRemoteIfNewer", [null]).catch(() => undefined);

  const rows = Object.entries(latencies)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        kind,
        n: sorted.length,
        p50: Math.round(percentile(sorted, 50)),
        p90: Math.round(percentile(sorted, 90)),
        p99: Math.round(percentile(sorted, 99)),
        max: Math.round(sorted[sorted.length - 1] ?? 0),
        over1s: sorted.filter((v) => v > 1_000).length,
        errors: errors[kind] ?? 0,
      };
    });
  const all = Object.values(latencies).flat().sort((a, b) => a - b);
  const gateStats = "getGateStats" in service ? (service as { getGateStats: () => unknown }).getGateStats() : "n/a (pre-fix)";
  console.info(`${TAG} ${name}: RESULT (ms)`);
  console.table(rows);
  log(`${name}: all-commands`, {
    n: all.length,
    p50: Math.round(percentile(all, 50)),
    p90: Math.round(percentile(all, 90)),
    p99: Math.round(percentile(all, 99)),
    max: Math.round(all[all.length - 1] ?? 0),
    over1s: all.filter((v) => v > 1_000).length,
  });
  log(`${name}: api calls`, fake.counts);
  log(`${name}: gate stats`, gateStats);
  await service.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
};

describe.skipIf(!RUN)("#25 N4 library op-gate load", () => {
  it("A: ops-only sync traffic", async () => {
    await runScenario("A-ops", { stalePendingSnapshot: false });
  }, DURATION_MS + 180_000);
  it("B: plus a stale pending compaction snapshot (hasPendingSync loop)", async () => {
    await runScenario("B-stale-snapshot", { stalePendingSnapshot: true });
  }, DURATION_MS + 300_000);
});

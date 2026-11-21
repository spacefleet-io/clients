/**
 * @test-id MOBILE-LIBRARY-SYNC-BANDWIDTH-001
 * @level unit
 * @req LIB-SYNC-06
 * @req LIB-SYNC-07
 * @req LIB-STORE-05
 *
 * Why this exists (#663): the library is a per-user encrypted database and bandwidth is the
 * dominant cost, so the mobile client must not
 *  - fetch the whole snapshot because the op list was empty (LIB-SYNC-06: only `tooOld` earns one);
 *  - count playback progress toward the snapshot threshold (LIB-SYNC-07);
 *  - re-encrypt the whole library after every write, or copy the snapshot into the split DBs row
 *    by row over the bridge (LIB-STORE-05: per-change cost independent of library size).
 * These tests drive the real LibraryDb class over an in-memory filesystem and fake transport.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { LibraryDb } from "../src/lib/libraryDb";
import { buildSplitCopyPlan, declaredSplitColumns, SPLIT_SOURCE_ALIAS } from "../src/lib/library/libraryCopy";
import type { SplitCopyGroup } from "../src/lib/library/libraryCopy";
import { systemPlaylistHealStatements } from "@space/library-db-definition/systemPlaylists";
import {
  CACHE_JSON,
  fx,
  handlesNamed,
  LIB_DIR,
  mediaUpsertOp,
  readCacheJson,
  resetFixture,
  seedSplitCache,
  setServer,
  settingOp,
  settle,
  SNAPSHOT_HANDLE,
  sleep,
} from "./library-db-fixture";

const TAG = "[library-sync-bandwidth]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const seedCombinedCache = () => {
  fx.files.set(
    CACHE_JSON,
    JSON.stringify({
      version: 7,
      snapshotVersion: 7,
      blobPath: `${LIB_DIR}/cache.blob`,
      encrypted: true,
      encoding: "binary",
      updatedAt: "2026-10-15T00:00:00.000Z",
      mode: "combined",
    })
  );
  fx.files.set(`${LIB_DIR}/cache.blob`, "blob");
};

vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined } }));
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("../src/lib/library/opsPage", async (importOriginal) => (await import("./library-db-fixture")).opsPageMock(await importOriginal()));
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => (await import("./library-db-fixture")).transportMock());
vi.mock("../src/lib/library/dbFiles", async () => (await import("./library-db-fixture")).dbFilesMock());
vi.mock("../src/lib/library/snapshot", async () => (await import("./library-db-fixture")).snapshotMock());
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({}));

// Pick<…, keyof …> drops the private members, which the seam below re-declares as public for the test.
type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & {
  secondaryOpsInFlight: Promise<void> | null;
  remoteVersion: number;
  durableVersion: number;
  version: number;
  queueOp(op: unknown, flushDelayMs?: number): Promise<void>;
  flushOps(): Promise<void>;
};

const openLocal = async () => (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("LIB-SYNC-06: a snapshot sync only on tooOld", () => {
  it("@req LIB-SYNC-06 an empty op list advances the cursor without fetching the snapshot", async () => {
    log("phase:start empty op list");
    // Head moved (a compaction or an op this device already holds) but no op is newer than our cursor.
    setServer({ version: 5, snapshotVersion: 5 });
    seedSplitCache({ version: 3 });
    const db = await openLocal();
    const changed = await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
    log("state", { changed, opsSince: fx.opsSince, snapshotFetches: fx.remoteSnapshotFetches, cache: readCacheJson() });
    expect(fx.opsSince, "the op list was asked for once").toEqual([3]);
    expect(fx.remoteSnapshotFetches, "an empty list is not a reason to download the snapshot").toBe(0);
    expect(changed).toBe(false);
    expect(readCacheJson()?.version, "the cursor follows the server head so the next open is a local hit").toBe(5);
  });

  it("@req LIB-SYNC-06 tooOld is the one case that fetches the snapshot", async () => {
    log("phase:start tooOld");
    setServer({ version: 900, snapshotVersion: 800 });
    seedSplitCache({ version: 3 });
    fx.opsTooOld = true;
    const db = await openLocal();
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined).catch((error) => log("snapshot fetch attempted", String(error)));
    log("state", { opsSince: fx.opsSince, snapshotFetches: fx.remoteSnapshotFetches });
    expect(fx.remoteSnapshotFetches).toBe(1);
  });

  it("@req LIB-SYNC-06 a non-empty op list is applied from the op stream, no snapshot", async () => {
    setServer({
      version: 5,
      snapshotVersion: 1,
      ops: [4, 5].map((version) => ({ opId: `op-${version}`, version, op: settingOp(`op-${version}`, `k${version}`, "v") })),
    });
    seedSplitCache({ version: 3 });
    const db = await openLocal();
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
    await settle(db);
    log("state", { snapshotFetches: fx.remoteSnapshotFetches, cache: readCacheJson() });
    expect(fx.remoteSnapshotFetches).toBe(0);
    expect(readCacheJson()?.version).toBe(5);
  });
});

describe("LIB-SYNC-07: progress ops do not count toward the snapshot threshold", () => {
  const progressOp = (id: string, i: number) =>
    ({
      id,
      type: "media.progress",
      createdAt: "2026-10-15T00:00:00.000Z",
      payload: { mediaId: "media-1", progressPct: i % 100, lastWatchedAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" },
    }) as unknown;

  it("@req LIB-SYNC-07 a long watch session never asks for a snapshot", async () => {
    setServer({ version: 2000, snapshotVersion: 1 }); // 1999 versions past the snapshot, all progress
    seedSplitCache({ version: 2000 });
    fx.nextPutVersion = 2001;
    const db = await openLocal();
    for (let i = 0; i < 600; i += 1) {
      await db.queueOp(progressOp(`p-${i}`, i), 0);
      fx.nextPutVersion += 1;
      await db.flushOps();
    }
    log("state", { putOpCalls: fx.putOpCalls, putDbCalls: fx.putDbCalls, encryptTargets: fx.encryptTargets });
    expect(fx.putOpCalls, "every progress op reached the server").toBeGreaterThan(500);
    expect(fx.putDbCalls, "600 progress ops must not publish a snapshot").toBe(0);
    expect(fx.encryptTargets, "nor encrypt one").toEqual([]);
  });

  it("@req LIB-SYNC-07 structural ops do count: the 500th publishes a snapshot", async () => {
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.files.set(`${LIB_DIR}/snapshot_ops.json`, JSON.stringify({ snapshotVersion: 10, count: 0 }));
    fx.nextPutVersion = 11;
    const db = await openLocal();
    for (let i = 0; i < 500; i += 1) {
      await db.queueOp(settingOp(`s-${i}`, `k${i}`, "v"), 0);
      fx.nextPutVersion += 1;
      await db.flushOps();
    }
    log("state", { putOpCalls: fx.putOpCalls, putDbCalls: fx.putDbCalls, encryptTargets: fx.encryptTargets });
    expect(fx.putDbCalls, "500 structural ops cross the threshold").toBe(1);
  });

  // @bugfix @regression-proof — pre-fix only unprefixed `episode_resume_v1:` keys were progress-class, so a
  // non-main profile's playback saves (`p:<pid>:episode_resume_v1:`, `p:<pid>:media_progress_v1:`) counted and
  // published a snapshot after 500 saves.
  it("@req LIB-SYNC-07 a non-main profile's progress saves never publish a snapshot", async () => {
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.files.set(`${LIB_DIR}/snapshot_ops.json`, JSON.stringify({ snapshotVersion: 10, count: 0 }));
    fx.nextPutVersion = 11;
    const db = await openLocal();
    for (let i = 0; i < 600; i += 1) {
      const key = i % 2 === 0 ? `p:prof-2:episode_resume_v1:ep-${i}` : `p:prof-2:media_progress_v1:media-${i}`;
      await db.queueOp(settingOp(`pp-${i}`, key, JSON.stringify({ progressPct: i % 100, updatedAt: "2026-10-15T00:00:00.000Z" })), 0);
      fx.nextPutVersion += 1;
      await db.flushOps();
    }
    const counted = fx.files.get(`${LIB_DIR}/snapshot_ops.json`);
    log("state:profile-progress", { putOpCalls: fx.putOpCalls, putDbCalls: fx.putDbCalls, counted });
    expect(fx.putOpCalls, "every profile progress op reached the server").toBeGreaterThan(500);
    expect(fx.putDbCalls, "600 profile progress saves must not publish a snapshot").toBe(0);
    expect(JSON.parse(String(counted)).count, "none of them counted").toBe(0);
  });

  it("@req LIB-SYNC-07 a count with no recorded snapshot adopts the server's and never publishes on it", async () => {
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.nextPutVersion = 11;
    const db = await openLocal();
    for (let i = 0; i < 500; i += 1) {
      await db.queueOp(settingOp(`s-${i}`, `k${i}`, "v"), 0);
      fx.nextPutVersion += 1;
      await db.flushOps();
    }
    log("state", { putDbCalls: fx.putDbCalls, counted: fx.files.get(`${LIB_DIR}/snapshot_ops.json`) });
    expect(fx.putDbCalls, "untagged count: no snapshot upload").toBe(0);
    expect(JSON.parse(String(fx.files.get(`${LIB_DIR}/snapshot_ops.json`)))).toMatchObject({ snapshotVersion: 10 });
  });

  it("@req LIB-SYNC-07 a remote batch that is rewound and fetched again counts once", async () => {
    log("phase:start rewound batch");
    setServer({ version: 4, snapshotVersion: 4, ops: [{ opId: "op-4", version: 4, op: mediaUpsertOp("op-4", "media-1") }] });
    seedSplitCache({ version: 3 });
    fx.files.set(`${LIB_DIR}/snapshot_ops.json`, JSON.stringify({ snapshotVersion: 4, count: 0 }));
    const db = await openLocal();
    fx.batchShouldFail.add("library.metadata.sqlite");
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined).catch((error) => log("sync rejected", String(error)));
    await settle(db);
    log("after failed apply", { counted: fx.files.get(`${LIB_DIR}/snapshot_ops.json`) });
    fx.batchShouldFail.clear();
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
    await settle(db);
    log("after retry", { counted: fx.files.get(`${LIB_DIR}/snapshot_ops.json`), cache: readCacheJson() });
    expect(JSON.parse(String(fx.files.get(`${LIB_DIR}/snapshot_ops.json`))).count, "one op, counted once").toBe(1);
  });
});

describe("LIB-SYNC-12: a large op tail is snapshotted below the op count", () => {
  const TAIL_BYTES = 16 * 1024 * 1024; // SNAPSHOT_TAIL_BYTES_THRESHOLD
  const COUNTER = `${LIB_DIR}/snapshot_ops.json`;
  const counted = () => JSON.parse(String(fx.files.get(COUNTER))) as { count: number; bytes: number; bytesThreshold: number };
  const pushOne = async (db: LibraryDbSeam, id: string) => {
    await db.queueOp(settingOp(id, id, "v"), 0);
    fx.nextPutVersion += 1;
    await db.flushOps();
  };

  it("@req LIB-SYNC-12 a pushed op counts its ciphertext bytes", async () => {
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.files.set(COUNTER, JSON.stringify({ snapshotVersion: 10, count: 0 }));
    fx.nextPutVersion = 11;
    const db = await openLocal();
    await pushOne(db, "s-0");
    log("state:pushed", { counted: counted(), posted: fx.postedOps.map((bytes) => bytes.length), putDbCalls: fx.putDbCalls });
    expect(fx.postedOps[0]!.length).toBeGreaterThan(0);
    expect(counted()).toMatchObject({ count: 1, bytes: fx.postedOps[0]!.length, bytesThreshold: TAIL_BYTES });
    expect(fx.putDbCalls).toBe(0);
  });

  it("@req LIB-SYNC-12 pulled ops count the sizes the server lists", async () => {
    const ops = [4, 5].map((version) => ({ opId: `op-${version}`, version, op: settingOp(`op-${version}`, `k${version}`, "v") }));
    setServer({ version: 5, snapshotVersion: 3, ops });
    seedSplitCache({ version: 3 });
    fx.files.set(COUNTER, JSON.stringify({ snapshotVersion: 3, count: 0, bytes: 0 }));
    const db = await openLocal();
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
    await settle(db);
    const listed = ops.reduce((sum, entry) => sum + JSON.stringify(entry.op).length, 0);
    log("state:pulled", { counted: counted(), listed });
    expect(counted()).toMatchObject({ count: 2, bytes: listed });
  });

  it("@req LIB-SYNC-12 crossing 16 MiB of tail publishes a snapshot far below 500 ops", async () => {
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.files.set(COUNTER, JSON.stringify({ snapshotVersion: 10, count: 3, bytes: TAIL_BYTES - 1 }));
    fx.nextPutVersion = 11;
    fx.snapshotBytes = 4 * 1024 * 1024;
    const db = await openLocal();
    await pushOne(db, "s-0");
    log("state:crossed", { putDbCalls: fx.putDbCalls, counted: counted() });
    expect(fx.putDbCalls, "4 ops, 16 MiB of tail: one snapshot").toBe(1);
    expect(counted(), "the count restarts on the new snapshot").toMatchObject({ count: 0, bytes: 0 });
  });

  it("@req LIB-SYNC-12 a snapshot larger than the tail is not published; the byte threshold rises to its size", async () => {
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.files.set(COUNTER, JSON.stringify({ snapshotVersion: 10, count: 3, bytes: TAIL_BYTES - 1 }));
    fx.nextPutVersion = 11;
    fx.snapshotBytes = 40 * 1024 * 1024;
    const db = await openLocal();
    await pushOne(db, "s-0");
    const afterFirst = { putDbCalls: fx.putDbCalls, builds: fx.encryptTargets.length, counted: counted() };
    await pushOne(db, "s-1");
    const afterSecond = { putDbCalls: fx.putDbCalls, builds: fx.encryptTargets.length, counted: counted() };
    log("state:larger-than-tail", { afterFirst, afterSecond });
    expect(afterFirst.putDbCalls, "a 40 MiB snapshot never replaces a 16 MiB tail").toBe(0);
    expect(afterFirst.builds).toBe(1);
    expect(afterFirst.counted.bytesThreshold).toBe(40 * 1024 * 1024);
    expect(afterSecond.putDbCalls).toBe(0);
    expect(afterSecond.builds, "below the raised threshold no snapshot is even built").toBe(1);
  });
});

describe("LIB-STORE-05: per-change cost does not grow with the library", () => {
  it("@req LIB-STORE-05 a local write never re-encrypts the library", async () => {
    setServer({ version: 5, snapshotVersion: 5 });
    seedSplitCache({ version: 5 });
    fx.nextPutVersion = 6;
    const db = await openLocal();
    log("phase:write");
    await db.createPlaylist("favorites-2");
    await db.setProgress("media-1", 42);
    await db.flushOps();
    await settle(db);
    await sleep(700); // longer than the old 500 ms persist debounce
    log("state", { encryptTargets: fx.encryptTargets, cache: readCacheJson() });
    expect(fx.encryptTargets, "no encryptDbToBinaryFile call for a local write").toEqual([]);
    expect(fx.files.get(`${LIB_DIR}/cache.blob`), "the seeded blob is left untouched").toBe("blob");
  });

  it("@req LIB-STORE-05 applying remote ops never re-encrypts the library", async () => {
    setServer({
      version: 5,
      snapshotVersion: 1,
      ops: [4, 5].map((version) => ({ opId: `op-${version}`, version, op: settingOp(`op-${version}`, `k${version}`, "v") })),
    });
    seedSplitCache({ version: 3 });
    const db = await openLocal();
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
    await settle(db);
    await sleep(700);
    log("state", { encryptTargets: fx.encryptTargets, cache: readCacheJson() });
    expect(fx.encryptTargets).toEqual([]);
  });

  it("@req LIB-STORE-05 the snapshot copy into the split DBs is ATTACH + one INSERT..SELECT batch per DB", async () => {
    seedCombinedCache();
    setServer({ version: 7, snapshotVersion: 7 });
    await openLocal();
    const split = ["library.core.sqlite", "library.metadata.sqlite", "library.playback.sqlite", "library.ingest.sqlite"].map(
      (name) => handlesNamed(name)[0]
    );
    log(
      "state",
      split.map((handle) => ({ name: handle?.name, statements: handle?.statements.length, batches: handle?.batches.map((b) => b.length) }))
    );
    for (const handle of split) {
      expect(handle, "split DB opened").toBeTruthy();
      const copied = handle.statements.filter((sql) => sql.includes(SPLIT_SOURCE_ALIAS));
      expect(copied.map((sql) => sql.split(" ")[0]), `${handle.name}: only ATTACH then DETACH cross the bridge`).toEqual([
        "ATTACH",
        "DETACH",
      ]);
      // Core then runs one more batch: the LIB-SYNC-10 heal of Favorites / Watchlist onto their fixed ids.
      const expectedBatches = handle === split[0] ? 2 : 1;
      expect(handle.batches, `${handle.name}: the whole copy is one native batch`).toHaveLength(expectedBatches);
      if (expectedBatches === 2) {
        expect(handle.batches[1].map((entry) => (typeof entry === "string" ? entry : entry[0]))).toEqual(
          systemPlaylistHealStatements("").map(([sql]) => sql)
        );
      }
    }
    // The batches are exactly the copy plan for a current snapshot (every declared column): INSERT..SELECT, never a bound row.
    const declared = declaredSplitColumns();
    const plan = buildSplitCopyPlan(flatColumns(declared), declared);
    const batchSql = (handle: (typeof split)[number]) => handle.batches[0].map((entry) => (typeof entry === "string" ? entry : entry[0]));
    expect(batchSql(split[0])).toEqual(plan.core);
    expect(batchSql(split[1])).toEqual(plan.metadata);
    expect(batchSql(split[2])).toEqual(plan.playback);
    expect(batchSql(split[3])).toEqual(plan.ingest);
    for (const sql of Object.values(plan).flat()) {
      expect(sql).toMatch(/^INSERT OR REPLACE INTO main\.\w+/);
      expect(sql).not.toContain("?");
    }
  });

  it("@req LIB-STORE-05 an old snapshot's missing tables and columns are left out of the copy, not failed on", () => {
    const declared = declaredSplitColumns();
    const plan = buildSplitCopyPlan(oldSnapshotColumns(declared), declared);
    log("state", { plan });
    const sqlFor = (group: keyof typeof plan, table: string) => plan[group].find((sql) => sql.startsWith(`INSERT OR REPLACE INTO main.${table} `));
    // Columns the old snapshot lacks are not named; the ones it has are.
    expect(sqlFor("playback", "media_formats")).not.toMatch(/bitrate_kbps|init_key/);
    expect(sqlFor("playback", "media_formats")).toMatch(/codec_string/);
    expect(sqlFor("playback", "media_format_chunks")).not.toMatch(/size_bytes|start_seconds/);
    expect(sqlFor("playback", "media_subtitles")).not.toMatch(/\bformat\b/);
    expect(sqlFor("metadata", "media_trailers")).not.toMatch(/language/);
    // Tables it lacks are skipped.
    expect(sqlFor("metadata", "media_skip_markers")).toBeUndefined();
    expect(plan.ingest).toEqual([]);
    // The audio-track `created_at` comes from the media row, so it needs no source column.
    expect(sqlFor("playback", "media_audio_tracks")).toMatch(/m\.updated_at/);
  });

  it("@req LIB-STORE-05 a column the snapshot has but the split DB does not is not selected", () => {
    const declared = declaredSplitColumns();
    const targets = { ...declared, playback: new Map(declared.playback).set("media_formats", new Set(["id", "media_id", "quality"])) };
    const plan = buildSplitCopyPlan(flatColumns(declared), targets);
    log("state", { formats: plan.playback[0] });
    expect(plan.playback[0]).toContain("main.media_formats (id, media_id, quality) SELECT id, media_id, quality FROM");
  });

  it("@req LIB-STORE-05 the copy plan runs on a real SQLite against a snapshot from before an ALTER", () => {
    const declared = declaredSplitColumns();
    const oldColumns = oldSnapshotColumns(declared);
    const dir = mkdtempSync(join(tmpdir(), "split-copy-"));
    const snapshotPath = join(dir, "snapshot.sqlite");
    const snapshot = new DatabaseSync(snapshotPath);
    const target = new DatabaseSync(":memory:");
    for (const [table, columns] of oldColumns) snapshot.exec(`CREATE TABLE ${table} (${[...columns].join(", ")});`);
    for (const [table, columns] of declared.playback) target.exec(`CREATE TABLE ${table} (${[...columns].join(", ")});`);
    snapshot.exec(`
      INSERT INTO media_items (id, updated_at) VALUES ('m1', '2026-01-01T00:00:00Z');
      INSERT INTO media_formats (id, media_id, quality, codec_string) VALUES ('f1', 'm1', '1080p', 'avc1');
      INSERT INTO media_format_chunks (id, format_id, chunk_key, order_index) VALUES ('c1', 'f1', 'k', 0);
      INSERT INTO media_audio_tracks (id, media_id, language) VALUES ('a1', 'm1', 'en');
      INSERT INTO media_subtitles (id, media_id, language) VALUES ('s1', 'm1', 'fr');`);
    // The snapshot's PRAGMA, read exactly as the runtime reads it.
    const read = new Map(
      [...oldColumns.keys()].map((table) => [
        table,
        new Set((snapshot.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>).map((row) => row.name)),
      ])
    );
    const plan = buildSplitCopyPlan(read, declared);
    log("state", { statements: plan.playback.length });
    snapshot.close();
    target.exec(`ATTACH '${snapshotPath}' AS ${SPLIT_SOURCE_ALIAS};`);
    for (const sql of plan.playback) target.exec(sql);
    const rows = (table: string) => target.prepare(`SELECT * FROM ${table};`).all();
    log("state", { formats: rows("media_formats"), audio: rows("media_audio_tracks"), subtitles: rows("media_subtitles") });
    expect(rows("media_formats")).toEqual([expect.objectContaining({ id: "f1", quality: "1080p", codec_string: "avc1", bitrate_kbps: null })]);
    expect(rows("media_format_chunks")).toEqual([expect.objectContaining({ id: "c1", chunk_key: "k", size_bytes: null })]);
    expect(rows("media_audio_tracks")).toEqual([expect.objectContaining({ id: "a1", language: "en", created_at: "2026-01-01T00:00:00Z" })]);
    expect(rows("media_subtitles")).toEqual([expect.objectContaining({ id: "s1", language: "fr", format: null })]);
    target.close();
    rmSync(dir, { recursive: true });
  });

  it("@req LIB-STORE-05 opening an old snapshot copies only shared columns into the split DBs", async () => {
    fx.tableColumns.set(SNAPSHOT_HANDLE, oldSnapshotColumns(declaredSplitColumns()));
    seedCombinedCache();
    setServer({ version: 7, snapshotVersion: 7 });
    await openLocal();
    const [metadata, playback, ingest] = ["library.metadata.sqlite", "library.playback.sqlite", "library.ingest.sqlite"].map((name) => handlesNamed(name)[0]);
    const sql = [metadata, playback].flatMap((handle) => handle.batches[0].map((entry) => (typeof entry === "string" ? entry : entry[0])));
    log("state", { statements: sql.length, ingestBatches: ingest.batches.length });
    expect(sql.join("\n")).not.toMatch(/main\.media_formats \([^)]*(bitrate_kbps|init_key)|media_skip_markers|ingest_jobs/);
    expect(ingest.batches[0] ?? [], "the old snapshot has no ingest tables").toHaveLength(0);
  });
});

/** A snapshot written before these tables/columns were added (what `PRAGMA table_info` reports for it). */
const OLD_SNAPSHOT_MISSING_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  media_formats: ["bitrate_kbps", "init_key"],
  media_format_chunks: ["size_bytes", "start_seconds"],
  media_subtitles: ["format"],
  media_trailers: ["language"],
};
const OLD_SNAPSHOT_MISSING_TABLES = ["media_skip_markers", "ingest_jobs", "ingest_job_events"];

/** One table -> columns map out of the per-DB declared ones: what a current snapshot reports. */
const flatColumns = (declared: Record<SplitCopyGroup, Map<string, Set<string>>>) =>
  new Map(Object.values(declared).flatMap((tables) => [...tables]));

const oldSnapshotColumns = (declared: Record<SplitCopyGroup, Map<string, Set<string>>>) =>
  new Map(
    [...flatColumns(declared)]
      .filter(([table]) => !OLD_SNAPSHOT_MISSING_TABLES.includes(table))
      .map(([table, columns]) => [table, new Set([...columns].filter((column) => !OLD_SNAPSHOT_MISSING_COLUMNS[table]?.includes(column)))])
  );

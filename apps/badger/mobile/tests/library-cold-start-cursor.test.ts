/**
 * @test-id MOBILE-LIBRARY-COLD-START-CURSOR-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: on the phone every cold start re-downloaded and re-applied
 * the WHOLE op stream (~3 MB, ~19 s) so "Loading library…" lasted 30–60 s and
 * the local version stayed at 1. Root causes, all in `LibraryDb`:
 *  1. The warm-start cache path took `meta.snapshotVersion` (the SERVER's last
 *     compaction snapshot) as the cache's version, so a cache already at v3
 *     was treated as "stale" whenever ops existed past the server snapshot and
 *     the cursor was rewound to the snapshot version.
 *  2. `pickBlob` compared the device clock (`cache.updatedAt`) with the server
 *     clock (`meta.updatedAt`); equal versions with a few seconds of skew were
 *     discarded and the whole snapshot was re-downloaded.
 *  3. A cache that is merely BEHIND the server (another device wrote) threw
 *     the local DB away instead of fetching only the ops after the cursor.
 *  4. The cursor (cache.json version) was only written by `persist()` — the
 *     slow combined-snapshot encrypt — and never after our own ops were
 *     flushed, so anything that interrupted persist() left the cursor behind.
 * These tests drive the real LibraryDb class over an in-memory filesystem.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { LibraryDb } from "../src/lib/libraryDb";
import {
  fx,
  mediaUpsertOp,
  readCacheJson,
  resetFixture,
  seedSplitCache,
  setServer,
  settingOp,
  settle,
} from "./library-db-fixture";

const TAG = "[library-cold-start-cursor]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

// vi.mock factories are hoisted above the static imports, so they cannot use
// them: the dynamic imports are the only way to reach the shared fixture.
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined } }));
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => (await import("./library-db-fixture")).transportMock());
vi.mock("../src/lib/library/dbFiles", async () => (await import("./library-db-fixture")).dbFilesMock());
vi.mock("../src/lib/library/snapshot", async () => (await import("./library-db-fixture")).snapshotMock());
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({}));

/** Private members the tests drive; LibraryDb exposes no public seam for them. */
// Pick<…, keyof …> drops the private members, which the seam below re-declares as public for the test.
type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & {
  secondaryOpsInFlight: Promise<void> | null;
  remoteVersion: number;
  version: number;
  queueOp(op: unknown): Promise<void>;
  flushOps(): Promise<void>;
};

const openLocal = async () => (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("mobile cold start resumes from the persisted cursor", () => {
  it("@bugfix @regression-proof a cache at the server version is a local hit even when the server snapshot is older", async () => {
    // Server: version 3 built from snapshot v1 + ops 2,3. Cache: already at 3.
    setServer({
      version: 3,
      snapshotVersion: 1,
      ops: [
        { opId: "op-2", version: 2, op: settingOp("op-2", "a", "1") },
        { opId: "op-3", version: 3, op: settingOp("op-3", "b", "2") },
      ],
    });
    seedSplitCache({ version: 3 });
    const startedAt = Date.now();
    const db = await openLocal();
    const syncChanged = await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
    log("cold start", { ms: Date.now() - startedAt, localVersion: db.getVersion(), opsSince: fx.opsSince, syncChanged });
    expect(db.getVersion(), "local version must resume from the persisted cursor, not the server snapshot").toBe(3);
    expect(fx.opsSince, "no op may be re-downloaded when the cursor equals the server version").toEqual([]);
    expect(fx.remoteSnapshotFetches).toBe(0);
    expect(syncChanged).toBe(false);
  });

  it("@bugfix @regression-proof clock skew between phone and server never discards an up-to-date cache", async () => {
    // Server wrote version 3 at 02:46:10Z; the phone clock saved the cache at 02:46:03Z (7 s behind).
    setServer({ version: 3, snapshotVersion: 3, updatedAt: "2026-10-15T02:46:10.000Z" });
    seedSplitCache({ version: 3, updatedAt: "2026-10-15T02:46:03.000Z" });
    const db = await openLocal();
    log("skewed clocks", { localVersion: db.getVersion(), remoteSnapshotFetches: fx.remoteSnapshotFetches });
    expect(fx.remoteSnapshotFetches, "an equal-version cache must not trigger a snapshot download").toBe(0);
    expect(db.getVersion()).toBe(3);
  });

  it("@bugfix @regression-proof a cache behind the server fetches only the ops after the cursor", async () => {
    setServer({
      version: 5,
      snapshotVersion: 1,
      ops: [2, 3, 4, 5].map((version) => ({
        opId: `op-${version}`,
        version,
        op: settingOp(`op-${version}`, `k${version}`, "v"),
      })),
    });
    seedSplitCache({ version: 3 });
    const db = await openLocal();
    expect(fx.remoteSnapshotFetches, "a delta must not re-download the snapshot").toBe(0);
    const changed = await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
    await settle(db);
    log("delta sync", { opsSince: fx.opsSince, cache: readCacheJson(), localVersion: db.getVersion(), changed });
    expect(fx.opsSince).toEqual([3]);
    expect(changed).toBe(true);
    expect(db.getVersion()).toBe(5);
    expect(readCacheJson()?.version, "the persisted cursor must advance to the applied version").toBe(5);
  });

  it("@bugfix @regression-proof the cursor is persisted even when the combined-snapshot persist never completes", async () => {
    setServer({
      version: 5,
      snapshotVersion: 5,
      ops: [4, 5].map((version) => ({ opId: `op-${version}`, version, op: settingOp(`op-${version}`, `k${version}`, "v") })),
    });
    seedSplitCache({ version: 3 });
    fx.encryptShouldFail = true; // persist() dies mid-way, like a JS reload during the 6 MB encrypt
    const db = await openLocal();
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined).catch((error) => log("sync rejected (persist killed)", String(error)));
    await settle(db);
    log("after interrupted persist", { cache: readCacheJson() });
    expect(readCacheJson()?.version, "cursor must not depend on the slow snapshot encrypt").toBe(5);
  });

  it("@bugfix @regression-proof the cursor waits for the secondary (metadata/playback) apply of media.upsert ops", async () => {
    setServer({
      version: 4,
      snapshotVersion: 4,
      ops: [{ opId: "op-4", version: 4, op: mediaUpsertOp("op-4", "media-1") }],
    });
    seedSplitCache({ version: 3 });
    fx.encryptShouldFail = true;
    const db = await openLocal();
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined).catch((error) => log("sync rejected", String(error)));
    await settle(db);
    const metadataBatches = fx.handles.filter((handle) => handle.name === "library.metadata.sqlite").flatMap((handle) => handle.batches);
    const playbackBatches = fx.handles.filter((handle) => handle.name === "library.playback.sqlite").flatMap((handle) => handle.batches);
    log("media.upsert applied", { metadataBatches: metadataBatches.length, playbackBatches: playbackBatches.length, cache: readCacheJson() });
    expect(metadataBatches.length).toBeGreaterThan(0);
    expect(playbackBatches.length).toBeGreaterThan(0);
    expect(readCacheJson()?.version).toBe(4);
  });

  it("@bugfix @regression-proof flushing our own op advances the persisted cursor so the next cold start is a local hit", async () => {
    setServer({ version: 5, snapshotVersion: 5 });
    seedSplitCache({ version: 5 });
    fx.nextPutVersion = 6;
    const db = await openLocal();
    await db.queueOp(settingOp("local-1", "resume", "42"));
    await db.flushOps();
    log("own op flushed", { localVersion: db.getVersion(), cache: readCacheJson() });
    expect(readCacheJson()?.version, "cache.json must follow the server version after our own op was accepted").toBe(6);
    // Next cold start: server is at 6 (our own op) -> cache at 6 must be a local hit.
    setServer({ version: 6, snapshotVersion: 5, updatedAt: "2026-10-15T09:00:00.000Z" });
    fx.remoteSnapshotFetches = 0;
    const restarted = await openLocal();
    expect(fx.remoteSnapshotFetches).toBe(0);
    expect(restarted.getVersion()).toBe(6);
  });
});

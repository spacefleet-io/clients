/**
 * @test-id MOBILE-LIBRARY-OPS-FLUSH-RESILIENCE-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: found on a OnePlus 6 against the dev stack. Show-level progress reverted after a
 * cold relaunch and never reached other devices. The API log showed a stream of `PUT /library/db 409`
 * (a compaction snapshot published on a stale base version) and the phone never flushed another op:
 *
 *  1. `flushPending` answered that 409 with `syncEnabled = false` for the rest of the session and left
 *     the stale pending snapshot on disk. Every later cold start / foreground sync re-uploaded the
 *     whole snapshot, got the same 409 and disabled sync again; `flushOps`, `persist` and
 *     `syncFromRemoteIfNewer` all early-return on `!syncEnabled`. Desktop (#25 N4) discards the stale
 *     compaction snapshot instead.
 *  2. While sync was disabled `queueOp` / `queueSupersedingProgressOp` dropped new progress ops
 *     instead of queueing them, so the older queued `media.progress` stayed in `pending_ops.json` and
 *     was replayed over the newer local value on the next open.
 *  3. `flushOps` swallowed every upload failure without a log line, which is why logcat showed nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { LibraryDb } from "../src/lib/libraryDb";
import { fx, resetFixture, seedSplitCache, setServer, settingOp, sleep } from "./library-db-fixture";

const TAG = "[library-ops-flush-resilience]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
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

const PENDING_JSON = "/docs/library/pending.json";
const PENDING_SNAPSHOT = "/docs/library/pending.snapshot";
const PENDING_MANIFEST = "/docs/library/pending.manifest";
const PENDING_OPS = "/docs/library/pending_ops.json";

/** Private members the tests drive; LibraryDb exposes no public seam for them. */
// Pick<…, keyof …> drops the private members, which the seam below re-declares as public for the test.
type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & {
  pendingSync: { baseVersion: number; snapshotId: string } | null;
  pendingOps: Array<{ id: string; type: string; payload: Record<string, unknown> }>;
  syncEnabled: boolean;
  queueOp(op: unknown): Promise<void>;
  flushOps(): Promise<void>;
};

const openLocal = async () => (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;

const seedStalePendingSnapshot = (baseVersion: number) => {
  fx.files.set(PENDING_SNAPSHOT, "snapshot");
  fx.files.set(PENDING_MANIFEST, "manifest");
  fx.files.set(
    PENDING_JSON,
    JSON.stringify({
      baseVersion,
      snapshotId: "stale-snapshot",
      chunkSize: 4 * 1024 * 1024,
      snapshotPath: PENDING_SNAPSHOT,
      manifestPath: PENDING_MANIFEST,
      updatedAt: "2026-10-15T00:00:00.000Z",
      keyProbe: "probe",
      chunkRefs: [],
    })
  );
};

const queuedOnDisk = (): Array<{ id: string; type: string; payload: Record<string, unknown> }> =>
  JSON.parse(fx.files.get(PENDING_OPS) ?? "[]");

const dump = (label: string, db: LibraryDbSeam) =>
  console.error(
    `${TAG} FAIL ${label} ${JSON.stringify({
      putDbCalls: fx.putDbCalls,
      putOpCalls: fx.putOpCalls,
      syncEnabled: db.syncEnabled,
      pendingSync: db.pendingSync,
      pendingOps: db.pendingOps,
      files: [...fx.files.keys()],
    })}`
  );

let warnSpy: MockInstance<typeof console.warn>;

beforeEach(() => {
  resetFixture();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("mobile op flush survives a stale pending snapshot", () => {
  it("@bugfix @regression-proof a stale pending snapshot (409, or a server already past it) is discarded and keeps sync (and op flushing) enabled", async () => {
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    seedStalePendingSnapshot(5); // built on v5; our own ops moved the server to v10
    fx.putDbError = { status: 409, payload: { error: "version_conflict", version: 10 } };
    fx.nextPutVersion = 11;
    const db = await openLocal();
    expect(db.pendingSync?.baseVersion, "fixture sanity: the stale pending snapshot is loaded").toBe(5);

    await db.flushPending();
    log("after 409", { putDbCalls: fx.putDbCalls, syncEnabled: db.syncEnabled, pendingSync: db.pendingSync, files: [...fx.files.keys()] });
    try {
      // LIB-SYNC-14: the version read right before the PUT (10) is past what the snapshot covers (5), so it is dropped
      // without uploading it; the 409 configured above is the answer it would have met.
      expect(fx.putDbCalls, "a snapshot the server has moved past is never uploaded").toBe(0);
      expect(db.syncEnabled, "a stale compaction snapshot must not switch off sync for the session").toBe(true);
      expect(db.pendingSync, "the stale snapshot is dropped (its data already reached the server as ops)").toBeNull();
      expect(fx.files.has(PENDING_JSON), "pending.json must be removed so the next cold start does not retry").toBe(false);
      expect(fx.files.has(PENDING_SNAPSHOT)).toBe(false);

      await db.flushPending();
      expect(fx.putDbCalls, "no later full-snapshot upload attempt for a discarded snapshot").toBe(0);

      await db.queueOp(settingOp("local-1", "episode_resume_v1:e1", "{}"));
      await db.flushOps();
      log("own op after 409", { putOpCalls: fx.putOpCalls, queued: queuedOnDisk().length });
      expect(fx.putOpCalls, "own ops must still be uploaded after the snapshot 409").toBe(1);
      expect(queuedOnDisk()).toEqual([]);
    } catch (error) {
      dump("stale pending snapshot", db);
      throw error;
    } finally {
      await db.close();
    }
  });
});

describe("mobile progress ops are queued even while sync is switched off", () => {
  const progress = (db: LibraryDbSeam, pct: number) =>
    db.setPlaybackProgress("movie-1", null, pct, { positionSeconds: pct, durationSeconds: 100 });

  it("@bugfix @regression-proof the newest progress replaces the queued one and is the only one replayed on the next open", async () => {
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.nextPutVersion = 11;
    const db = await openLocal();
    try {
      await progress(db, 20); // sync on: queued, flush debounced
      db.setSyncEnabled(false);
      await progress(db, 60); // sync off: must still be queued, superseding the 20 %
      const queued = queuedOnDisk().filter((op) => op.type === "media.progress");
      log("progress queued while disabled", { queued: queued.map((op) => op.payload.progressPct), putOpCalls: fx.putOpCalls });
      try {
        expect(
          queued.map((op) => op.payload.progressPct),
          "pending_ops.json must hold only the newest progress; an older one replayed on open regresses it"
        ).toEqual([60]);
      } catch (error) {
        dump("progress queue while disabled", db);
        throw error;
      }
      expect(fx.putOpCalls, "nothing is uploaded while sync is disabled").toBe(0);

      await db.setSyncEnabledAndFlush(true);
      log("re-enabled", { putOpCalls: fx.putOpCalls, queued: queuedOnDisk().length });
      expect(fx.putOpCalls, "re-enabling uploads the queued progress").toBe(1);
      expect(queuedOnDisk()).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe("mobile op flush failures are logged", () => {
  it("@bugfix @regression-proof a rejected op upload emits library.ops.flush.error with status and op id", async () => {
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.putOpError = { status: 500, payload: { error: "library_op_failed" } };
    const db = await openLocal();
    try {
      await db.queueOp(settingOp("local-err", "episode_resume_v1:e1", "{}"));
      await db.flushOps();
      await sleep(0);
      const lines = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      log("warn lines", lines);
      expect(lines, "the failed upload must be visible in logcat").toContain("library.ops.flush.error");
      const payload = warnSpy.mock.calls.find((call: unknown[]) => call[0] === "library.ops.flush.error")?.[1];
      expect(JSON.parse(String(payload))).toMatchObject({ status: 500, opId: "local-err", error: "library_op_failed" });
      expect(queuedOnDisk().map((op) => op.id), "the failed op stays queued for retry").toEqual(["local-err"]);
    } finally {
      await db.close();
    }
  });
});

describe("mobile op flush stops on a signed-out session", () => {
  it("@bugfix @regression-proof a 401 on the op upload stops the 2 s retries until sign-in opens a new library", async () => {
    // Signed out, the phone retried the pending settings op every 2 s; every retry got a 401 and froze the JS thread
    // for up to ~1.2 s (encrypt + upload + compaction check).
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.putOpError = { status: 401, payload: { error: "unauthorized" } };
    const db = await openLocal();
    try {
      await db.queueOp(settingOp("local-401", "episode_resume_v1:e1", "{}"));
      await db.flushOps();
      const afterFirst = fx.putOpCalls;
      await sleep(2_300); // past the 2 s retry
      await db.flushOps();
      log("after 401", { afterFirst, putOpCalls: fx.putOpCalls, queued: queuedOnDisk().map((op) => op.id) });
      expect(afterFirst, "fixture sanity: the first upload was attempted").toBe(1);
      expect(fx.putOpCalls, "no retry with a token the server refused").toBe(1);
      expect(queuedOnDisk().map((op) => op.id), "the op stays queued for the next signed-in session").toEqual(["local-401"]);
    } finally {
      await db.close();
    }

    fx.putOpError = null;
    fx.nextPutVersion = 11;
    const next = await openLocal();
    try {
      await next.flushOps();
      log("next session", { putOpCalls: fx.putOpCalls, queued: queuedOnDisk().length });
      expect(fx.putOpCalls, "the next signed-in library uploads the queued op").toBe(2);
      expect(queuedOnDisk()).toEqual([]);
    } finally {
      await next.close();
    }
  });
});

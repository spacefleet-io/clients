/**
 * @test-id MOBILE-LIBRARY-SYNC-SINGLE-FLIGHT-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: an iOS 18.6 simulator log showed the same 925-op batch applied twice at load.
 * The foreground sync (AppState -> active) and the library stream's meta handler both call
 * `LibraryDb.syncFromRemoteIfNewer`, and nothing stopped two runs from overlapping: both read
 * `remoteVersion` before either moved it, both fetched `GET /library/db/ops?since=<same>`, both
 * downloaded, decrypted and applied the batch, and both persisted.
 *
 * Contract: one sync runs at a time per LibraryDb. A request made while one runs never starts a
 * parallel run; it waits for exactly one follow-up sync that starts after the running one ends,
 * so remote state that arrived after the running sync read its meta is still taken in. Any number
 * of requests during one run share that single follow-up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
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
  sleep,
} from "./library-db-fixture";

const TAG = "[library-sync-single-flight]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

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

// Pick<…, keyof …> drops the private members, which the seam below re-declares as public for the test.
type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & {
  secondaryOpsInFlight: Promise<void> | null;
  remoteVersion: number;
  pendingOps: Array<{ id: string }>;
  queueOp(op: unknown): Promise<void>;
};

const openLocal = async () => (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;

let warnSpy: MockInstance<typeof console.warn>;

/** One `library.ops.sync.timing` line is logged per applied op batch. */
const appliedBatches = () =>
  warnSpy.mock.calls
    .filter((call: unknown[]) => call[0] === "library.ops.sync.timing")
    .map((call: unknown[]) => JSON.parse(String(call[1])) as { count: number });

const dump = (label: string, db: LibraryDbSeam) =>
  console.error(
    `${TAG} FAIL ${label} ${JSON.stringify({
      opsSince: fx.opsSince,
      appliedBatches: appliedBatches(),
      remoteVersion: db.remoteVersion,
      version: db.getVersion(),
      cache: readCacheJson(),
      pendingOps: db.pendingOps.map((op) => op.id),
      putOpCalls: fx.putOpCalls,
    })}`
  );

beforeEach(() => {
  resetFixture();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("library sync is single-flight", () => {
  it("@bugfix @regression-proof a foreground sync overlapping a stream sync applies the remote batch once", async () => {
    setServer({
      version: 5,
      snapshotVersion: 3,
      ops: [
        { opId: "op-4", version: 4, op: settingOp("op-4", "k4", "v4") },
        { opId: "op-5", version: 5, op: settingOp("op-5", "k5", "v5") },
      ],
    });
    seedSplitCache({ version: 3 });
    const db = await openLocal();
    log("opened", { remoteVersion: db.remoteVersion, version: db.getVersion() });
    try {
      // Stream meta handler passes the meta it received; the foreground scheduler passes none.
      const stream = db.syncFromRemoteIfNewer(fx.meta ?? undefined);
      const foreground = db.syncFromRemoteIfNewer();
      const results = await Promise.all([stream, foreground]);
      await settle(db);
      log("both settled", { results, opsSince: fx.opsSince, batches: appliedBatches() });
      expect(fx.opsSince, "only one op-list fetch for the batch (pre-fix: [3, 3])").toEqual([3]);
      expect(appliedBatches(), "the 2-op batch is applied exactly once").toEqual([expect.objectContaining({ count: 2 })]);
      expect(results, "both callers learn the library changed so each refreshes its lists").toEqual([true, true]);
      expect(db.getVersion()).toBe(5);
      expect(readCacheJson()?.version).toBe(5);
    } catch (error) {
      dump("overlapping foreground + stream", db);
      throw error;
    } finally {
      await db.close();
    }
  });

  it("@bugfix @regression-proof requests made during a running sync share one follow-up that picks up newer remote state", async () => {
    setServer({
      version: 4,
      snapshotVersion: 3,
      ops: [{ opId: "op-4", version: 4, op: mediaUpsertOp("op-4", "media-1") }],
    });
    seedSplitCache({ version: 3 });
    const db = await openLocal();
    // Keeps the first sync running (it awaits the metadata apply) while the server moves on.
    fx.statementDelayMs.set("library.metadata.sqlite", 40);
    try {
      const first = db.syncFromRemoteIfNewer(fx.meta ?? undefined);
      for (let i = 0; i < 200 && !db.secondaryOpsInFlight; i += 1) await sleep(1);
      expect(db.secondaryOpsInFlight, "test needs the first sync to be mid-apply").not.toBeNull();
      log("first sync mid-apply", { opsSince: fx.opsSince });

      // A new remote op lands and three more triggers fire (stream meta, foreground, push).
      setServer({
        version: 5,
        snapshotVersion: 3,
        ops: [
          { opId: "op-4", version: 4, op: mediaUpsertOp("op-4", "media-1") },
          { opId: "op-5", version: 5, op: settingOp("op-5", "k5", "v5") },
        ],
      });
      const joiners = [
        db.syncFromRemoteIfNewer(fx.meta ?? undefined),
        db.syncFromRemoteIfNewer(),
        db.syncFromRemoteIfNewer({ exists: true, version: 4 }),
      ];
      const results = await Promise.all([first, ...joiners]);
      await settle(db);
      log("all settled", { results, opsSince: fx.opsSince, batches: appliedBatches() });
      expect(fx.opsSince, "first run fetches since 3, ONE follow-up fetches since 4 (pre-fix: parallel fetches)").toEqual([3, 4]);
      expect(appliedBatches().map((batch) => batch.count), "each remote op applied once").toEqual([1, 1]);
      expect(results).toEqual([true, true, true, true]);
      expect(db.getVersion()).toBe(5);
      expect(readCacheJson()?.version).toBe(5);
    } catch (error) {
      dump("joiners during a running sync", db);
      throw error;
    } finally {
      await db.close();
    }
  });

  it("a sync started after the previous one finished runs again (single-flight is not a cache)", async () => {
    setServer({ version: 4, snapshotVersion: 3, ops: [{ opId: "op-4", version: 4, op: settingOp("op-4", "k4", "v4") }] });
    seedSplitCache({ version: 3 });
    const db = await openLocal();
    try {
      expect(await db.syncFromRemoteIfNewer(fx.meta ?? undefined)).toBe(true);
      setServer({
        version: 5,
        snapshotVersion: 3,
        ops: [
          { opId: "op-4", version: 4, op: settingOp("op-4", "k4", "v4") },
          { opId: "op-5", version: 5, op: settingOp("op-5", "k5", "v5") },
        ],
      });
      expect(await db.syncFromRemoteIfNewer(fx.meta ?? undefined)).toBe(true);
      expect(await db.syncFromRemoteIfNewer(fx.meta ?? undefined), "nothing new: no change").toBe(false);
      log("sequential", { opsSince: fx.opsSince });
      expect(fx.opsSince).toEqual([3, 4]);
    } catch (error) {
      dump("sequential syncs", db);
      throw error;
    } finally {
      await db.close();
    }
  });

  it("a 409 on our own op flushed inside a sync does not deadlock on the sync it is part of", async () => {
    setServer({ version: 4, snapshotVersion: 3, ops: [{ opId: "op-4", version: 4, op: settingOp("op-4", "k4", "v4") }] });
    seedSplitCache({ version: 3 });
    const db = await openLocal();
    try {
      await db.queueOp(settingOp("local-1", "resume", "42"));
      fx.putOpError = { status: 409, payload: { error: "version_conflict", version: 4 } };
      // A deadlock here (the flush waiting on the sync that is waiting on the flush) fails as the test timeout.
      const changed = await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
      await settle(db);
      log("409 inside sync", { changed, opsSince: fx.opsSince, putOpCalls: fx.putOpCalls });
      expect(fx.putOpCalls, "the queued op was attempted").toBeGreaterThan(0);
      expect(changed, "the sync still takes in the newer remote ops after the conflict").toBe(true);
      expect(fx.opsSince).toEqual([3]);
      expect(db.pendingOps.map((op) => op.id), "the rejected op stays queued for retry").toEqual(["local-1"]);
    } catch (error) {
      dump("409 inside sync", db);
      throw error;
    } finally {
      await db.close();
    }
  });
});

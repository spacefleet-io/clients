/**
 * @test-id MOBILE-LIBRARY-CURSOR-INTEGRITY-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: cold open resumes exactly at cache.json `version`, so the
 * cursor must never move past an op whose rows are not on disk. Before the
 * fix `persist()` saved `max(version, remoteVersion)` (remoteVersion is already
 * the NEW ops version) and flushOps' `persistCursor("own_op")` did the same
 * while a secondary (metadata/playback) apply was still running, so a failed or
 * interrupted media.upsert apply dropped those rows for good.
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
  sleep,
} from "./library-db-fixture";

const TAG = "[library-cursor-integrity]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

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
  queueOp(op: unknown): Promise<void>;
  flushOps(): Promise<void>;
};

const openLocal = async () => (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("library sync cursor never passes unapplied rows", () => {
  it("@bugfix @regression-proof a failed secondary apply leaves cache.json at the old cursor (persist() must not advance it)", async () => {
    setServer({
      version: 4,
      snapshotVersion: 4,
      ops: [{ opId: "op-4", version: 4, op: mediaUpsertOp("op-4", "media-1") }],
    });
    seedSplitCache({ version: 3 });
    fx.batchShouldFail.add("library.metadata.sqlite");
    const db = await openLocal();
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined).catch((error) => log("sync rejected", String(error)));
    await settle(db);
    log("secondary apply failed", { cache: readCacheJson(), opsSince: fx.opsSince });
    expect(readCacheJson()?.version, "metadata rows of op 4 never landed: the cursor must stay at 3").toBe(3);
  });

  it("@bugfix @regression-proof after a failed secondary apply the next sync re-fetches the failed ops and then advances", async () => {
    setServer({
      version: 4,
      snapshotVersion: 4,
      ops: [{ opId: "op-4", version: 4, op: mediaUpsertOp("op-4", "media-1") }],
    });
    seedSplitCache({ version: 3 });
    fx.batchShouldFail.add("library.metadata.sqlite");
    const db = await openLocal();
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined).catch(() => undefined);
    await settle(db);
    expect(readCacheJson()?.version).toBe(3);

    fx.batchShouldFail.clear();
    fx.opsSince = [];
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined).catch((error) => log("retry rejected", String(error)));
    await settle(db);
    log("retry after failure", { cache: readCacheJson(), opsSince: fx.opsSince });
    expect(fx.opsSince, "the failed batch must be fetched again from the durable cursor").toEqual([3]);
    expect(readCacheJson()?.version).toBe(4);
  });

  it("@bugfix @regression-proof flushing our own op while a secondary apply is in flight does not move the cursor", async () => {
    setServer({
      version: 4,
      snapshotVersion: 4,
      ops: [{ opId: "op-4", version: 4, op: mediaUpsertOp("op-4", "media-1") }],
    });
    seedSplitCache({ version: 3 });
    fx.nextPutVersion = 5;
    const db = await openLocal();
    fx.statementDelayMs.set("library.metadata.sqlite", 40);
    const sync = db.syncFromRemoteIfNewer(fx.meta ?? undefined).catch(() => undefined);
    for (let i = 0; i < 200 && !db.secondaryOpsInFlight; i += 1) await sleep(1);
    expect(db.secondaryOpsInFlight, "test needs the secondary apply to be running").not.toBeNull();
    await db.queueOp(settingOp("local-1", "resume", "42"));
    await db.flushOps();
    const midFlight = readCacheJson()?.version;
    log("own op flushed mid secondary apply", { midFlight, putOpCalls: fx.putOpCalls });
    expect(fx.putOpCalls).toBeGreaterThan(0);
    expect(midFlight, "ops <= 4 are not fully applied yet: cursor must stay at 3").toBe(3);
    await sync;
    await settle(db);
    // Conservative on purpose: 4 is the last version whose rows are known to be
    // on disk; our own op 5 is simply replayed (idempotent) on the next cold start.
    expect(readCacheJson()?.version, "once the secondary apply settled the cursor reaches the applied remote version").toBe(4);
  });
});

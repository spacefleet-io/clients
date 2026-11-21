/**
 * @test-id MOBILE-LIBRARY-OPS-PAGING-001
 * @level unit
 * @bugfix
 * @regression-proof
 * @req LIB-SYNC-06
 *
 * Why this exists (#663): the API pages a long op tail (1000 ops per response, `hasMore`; `version` of a partial
 * page is its last op). Mobile applied the first page and stopped, so a phone far behind caught up 1000 ops per
 * *trigger* (an SSE event, an app foreground) and sat on a stale library in between. A sync must walk every page
 * in the same run, apply them as one batch, and only then move the cursor; a page that turns `tooOld` falls back to
 * the snapshot like any other `tooOld`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import type { LibraryOp } from "@space/shared/libraryOps";
import { LibraryDb } from "../src/lib/libraryDb";
import { fx, readCacheJson, resetFixture, seedSplitCache, setServer, settingOp, settle } from "./library-db-fixture";

const TAG = "[library-ops-paging]";
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

type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & {
  secondaryOpsInFlight: Promise<void> | null;
  remoteVersion: number;
  applyLibraryOps(ops: LibraryOp[]): Promise<void>;
};

const settingOps = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const version = from + i;
    return { opId: `op-${version}`, version, op: settingOp(`op-${version}`, `k${version}`, "v") };
  });

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("an op tail longer than one page is walked in one sync", () => {
  it("@bugfix @regression-proof every page is fetched in the same run and the cursor lands on the head", async () => {
    log("phase:start 7 ops, pages of 3");
    setServer({ version: 10, snapshotVersion: 1, ops: settingOps(4, 10) });
    seedSplitCache({ version: 3 });
    fx.opsPageSize = 3;
    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
    try {
      const changed = await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
      await settle(db);
      log("state", { changed, opsSince: fx.opsSince, remoteVersion: db.remoteVersion, cache: readCacheJson() });
      expect(fx.opsSince, "each page asks from the previous page's last version").toEqual([3, 6, 9]);
      expect(db.remoteVersion, "the cursor is the head, not the first page's last op").toBe(10);
      expect(readCacheJson()?.version).toBe(10);
      expect(fx.remoteSnapshotFetches, "paging never costs a snapshot").toBe(0);
      expect(changed).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("@bugfix every op of every page is applied", async () => {
    log("phase:start 5 ops, pages of 2");
    setServer({ version: 8, snapshotVersion: 1, ops: settingOps(4, 8) });
    seedSplitCache({ version: 3 });
    fx.opsPageSize = 2;
    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
    const applied = vi.spyOn(db, "applyLibraryOps");
    try {
      await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
      await settle(db);
      const batches = applied.mock.calls.map(([ops]) => ops.map((op) => op.id));
      log("state", { opsSince: fx.opsSince, batches });
      expect(fx.opsSince).toEqual([3, 5, 7]);
      expect(batches, "one batch, every page's ops in version order").toEqual([["op-4", "op-5", "op-6", "op-7", "op-8"]]);
    } finally {
      await db.close();
    }
  });

  it("@bugfix a page that turns tooOld falls back to the snapshot", async () => {
    log("phase:start second page tooOld");
    setServer({ version: 10, snapshotVersion: 8, ops: settingOps(4, 10) });
    seedSplitCache({ version: 3 });
    fx.opsPageSize = 3;
    fx.opsTooOldFrom = 6;
    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
    try {
      await db.syncFromRemoteIfNewer(fx.meta ?? undefined).catch((error) => log("snapshot fetch attempted", String(error)));
      log("state", { opsSince: fx.opsSince, snapshotFetches: fx.remoteSnapshotFetches });
      expect(fx.opsSince).toEqual([3, 6]);
      expect(fx.remoteSnapshotFetches).toBe(1);
    } finally {
      await db.close();
    }
  });
});

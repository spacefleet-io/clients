/**
 * @test-id MOBILE-LIBRARY-CREATE-SNAPSHOT-RACE-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists (Android TV box, issue #1074): on the onboarding key screen Continue was pressed twice
 * while the first library create was still running (the JS thread stalled 2-3 s at a time, so nothing
 * showed for ~20 s). Both runs failed with
 * `ENOENT: .../databases/library.snapshot.sqlite: open failed` from `RNFS.readFile`, after
 * `library.db.snapshot.stale_handle_close_failed {"where":"remove","error":"database cannot be closed
 * while a transaction is in progress"}`.
 *
 * Root cause: the "no library on the server yet" branch of `LibraryDb.open` built the combined snapshot
 * (`buildCombinedSnapshotDb`: remove library.snapshot.sqlite, open it, copy the split dbs in one
 * transaction) and read it back for encryption WITHOUT `withSnapshotLock`, unlike every other snapshot
 * build. The second run's remove hit the first run's handle mid-transaction: the close failed, the file
 * was unlinked anyway, the second open reused the same native connection (the plugin keys connections
 * by name) so no new file appeared, and both runs' `encryptDbToBinaryFile` read a path that was gone.
 *
 * Drives the real `LibraryDb.open` and the real `openSnapshotDb` / `removeSnapshotDbFile` over a fake
 * sqlite plugin that, like the real one, reuses an open connection by name and refuses to close a
 * connection while a transaction (sqlBatch) runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import type * as DbFiles from "../src/lib/library/dbFiles";
import { LibraryDb } from "../src/lib/libraryDb";
import { getSnapshotDbPath } from "../src/lib/libraryStorage";
import { fx, resetFixture } from "./library-db-fixture";

const TAG = "[library-create-snapshot-race]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const plugin = vi.hoisted(() => ({
  /** Native connections keyed by db name, like the plugin's openDBs. */
  native: new Map<string, { id: number; inTransaction: boolean }>(),
  nextId: 1,
}));

// vi.mock factories are hoisted above the static imports, so they reach the fixture through dynamic imports.
vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", async () => {
  const { fx: files, sleep: wait } = await import("./library-db-fixture");
  const { getSnapshotDbPath: snapshotPath } = await import("../src/lib/libraryStorage");
  const notOpen = { message: "database not open", code: 0 };
  return {
    default: {
      enablePromise: () => undefined,
      // Only the combined snapshot goes through the real openSqliteDb here; the split dbs use the fixture's fakes.
      openDatabase: async ({ name }: { name: string }) => {
        let conn = plugin.native.get(name);
        if (!conn) {
          conn = { id: plugin.nextId++, inTransaction: false };
          plugin.native.set(name, conn);
          files.files.set(snapshotPath(), "sqlite");
        }
        const bound = conn;
        const assertOpen = () => {
          if (plugin.native.get(name) !== bound) throw notOpen;
        };
        return {
          executeSql: async () => {
            assertOpen();
            return [{ rows: { length: 0, item: () => ({}) } }];
          },
          // The ATTACH + INSERT..SELECT copy: one native transaction that takes a while on a slow box.
          sqlBatch: async () => {
            assertOpen();
            bound.inTransaction = true;
            await wait(20);
            bound.inTransaction = false;
          },
          close: async () => {
            assertOpen();
            if (bound.inTransaction) {
              throw { message: "database cannot be closed while a transaction is in progress", code: 0 };
            }
            plugin.native.delete(name);
          },
        };
      },
    },
  };
});
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => (await import("./library-db-fixture")).transportMock());
vi.mock("../src/lib/library/dbFiles", async () => {
  const actual = await vi.importActual<typeof DbFiles>("../src/lib/library/dbFiles");
  return {
    ...(await import("./library-db-fixture")).dbFilesMock(),
    openSnapshotDb: actual.openSnapshotDb,
    removeSnapshotDbFile: actual.removeSnapshotDbFile,
  };
});
vi.mock("../src/lib/library/snapshot", async () => {
  const fixture = await import("./library-db-fixture");
  return {
    ...fixture.snapshotMock(),
    // Reads the combined snapshot like the real one (RNFS.readFile): ENOENT when the file is gone.
    encryptDbToBinaryFile: async (dbPath: string, _key: string, target: string) => {
      await fixture.fakeRnfs.readFile(dbPath);
      fixture.fx.files.set(target, "blob");
    },
  };
});
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({
  ensureSchema: async () => undefined,
  ensureCoreSchema: async () => undefined,
  ensureMetadataSchema: async () => undefined,
  ensurePlaybackSchema: async () => undefined,
  ensureIngestSchema: async () => undefined,
}));

beforeEach(() => {
  resetFixture();
  plugin.native.clear();
  plugin.nextId = 1;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // A fresh account: no library on the server, so LibraryDb.open takes the create branch.
  fx.meta = { exists: false, version: 0, snapshotVersion: 0, updatedAt: null, keyProbe: null };
  fx.nextPutVersion = 1;
});

describe("creating a library while another create runs", () => {
  it("@bugfix @regression-proof two overlapping creates never remove the snapshot file under each other", async () => {
    const results = await Promise.allSettled([LibraryDb.open("token", "key"), LibraryDb.open("token", "key")]);
    const warnings = vi.mocked(console.warn).mock.calls.map(([event]) => String(event));
    const errors = results.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : JSON.stringify(result.reason)]
        : []
    );
    log("two creates settled", { errors, warnings: warnings.filter((event) => event.includes("snapshot")) });

    expect(errors, "neither create may fail reading library.snapshot.sqlite").toEqual([]);
    expect(warnings, "no create may close a snapshot handle another create is still copying into").not.toContain(
      "library.db.snapshot.stale_handle_close_failed"
    );
    expect(fx.putDbCalls).toBe(2);
    expect(fx.files.has(getSnapshotDbPath()), "the snapshot file is removed once both creates are done").toBe(false);
    expect(plugin.native.size, "no snapshot connection is left open").toBe(0);
  });

  it("a single create still builds, encrypts and removes the snapshot", async () => {
    const db = await LibraryDb.open("token", "key");
    log("single create", { putDbCalls: fx.putDbCalls, version: db.getVersion() });
    expect(fx.putDbCalls).toBe(1);
    expect(db.getVersion()).toBe(1);
    expect(fx.files.has(getSnapshotDbPath())).toBe(false);
    expect(plugin.native.size).toBe(0);
  });
});

/**
 * @test-id MOBILE-LIBRARY-SNAPSHOT-STALE-HANDLE-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists (iPhone, ticket #304): after the app came back from the background every library
 * sync ended in `library.stream.sync.failed`, the device log showing "disk I/O error" on
 * `PRAGMA journal_mode=WAL;`.
 *
 * Root cause: react-native-sqlite-storage keys connections by db name in BOTH layers (JS
 * `SQLitePlugin.open` resolves with the existing object while the name is open; native `open`
 * reuses the existing `sqlite3*`). Every combined-snapshot rebuild (persist, flush, export, split)
 * closes its handle only on success, so one that threw left `library.snapshot.sqlite` open. The next
 * rebuild's `removeSnapshotDbFile()` unlinked db/-wal/-shm under it, `openSnapshotDb()` got the same
 * stale connection back, and its first statement (the WAL pragma) failed with "disk I/O error" —
 * for that and every later persist. On the simulator `lsof` showed the app holding fds to the
 * deleted library.snapshot.sqlite, -wal and -shm.
 *
 * The test drives the real dbFiles module over a fake plugin that models the by-name reuse and
 * fails the WAL pragma on a connection whose files were unlinked, as iOS does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// vi.mock calls below are hoisted above this import, so it loads over the fakes.
import { openSnapshotDb, removeSnapshotDbFile } from "../src/lib/library/dbFiles";

const TAG = "[library-snapshot-stale-handle]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const DOCS = "/docs";

type Conn = { id: number; name: string; unlinked: boolean };

const state = vi.hoisted(() => ({
  files: new Set<string>(),
  /** Native connections keyed by db name, like SQLite.m's openDBs. */
  native: new Map<string, { id: number; name: string; unlinked: boolean }>(),
  nextId: 1,
  opened: [] as number[],
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("react-native-fs", () => ({
  default: {
    DocumentDirectoryPath: "/docs",
    CachesDirectoryPath: "/caches",
    exists: async (path: string) => state.files.has(path),
    mkdir: async () => undefined,
    unlink: async (path: string) => {
      state.files.delete(path);
      for (const conn of state.native.values()) {
        if (path.startsWith(`/docs/${conn.name}`)) conn.unlinked = true;
      }
    },
  },
}));
vi.mock("react-native-sqlite-storage", () => ({
  default: {
    openDatabase: async ({ name }: { name: string }) => {
      let conn = state.native.get(name);
      if (!conn) {
        conn = { id: state.nextId++, name, unlinked: false };
        state.native.set(name, conn);
        for (const suffix of ["", "-wal", "-shm"]) state.files.add(`/docs/${name}${suffix}`);
      }
      state.opened.push(conn.id);
      const bound = conn;
      return {
        conn: bound,
        executeSql: async (sql: string) => {
          if (state.native.get(name) !== bound) throw { message: "database not open", code: 0 };
          // iOS: the reused connection's db/-wal/-shm were unlinked under it.
          if (bound.unlinked && sql.startsWith("PRAGMA journal_mode")) throw { message: "disk I/O error", code: 0 };
          return [{ rows: { length: 0, item: () => ({}) } }];
        },
        close: async () => {
          if (state.native.get(name) !== bound) throw { message: "database not open", code: 0 };
          state.native.delete(name);
        },
      };
    },
  },
}));
vi.mock("../src/lib/librarySchema", () => ({
  // applyPerfPragmas' first statement is the one the device log shows failing.
  ensureSchema: async (db: { executeSql: (sql: string) => Promise<unknown> }) => {
    await db.executeSql("PRAGMA journal_mode=WAL;");
  },
  ensureCoreSchema: async () => undefined,
  ensureMetadataSchema: async () => undefined,
  ensurePlaybackSchema: async () => undefined,
  ensureIngestSchema: async () => undefined,
}));


const connOf = (db: unknown): Conn => {
  if (db && typeof db === "object" && "conn" in db) return db.conn as Conn; // the fake plugin's own handle
  throw new Error(`${TAG} not a fake sqlite handle`);
};

beforeEach(() => {
  state.files.clear();
  state.native.clear();
  state.nextId = 1;
  state.opened = [];
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("combined snapshot DB handle lifecycle", () => {
  it("@bugfix @regression-proof a rebuild that threw before close() does not poison the next openSnapshotDb() with 'disk I/O error'", async () => {
    // Rebuild 1 (e.g. persist): opens the snapshot, then throws before its snapshotDb.close().
    const leaked = await openSnapshotDb();
    log("rebuild 1 opened and failed without closing", { conn: connOf(leaked), native: [...state.native.keys()] });

    // Rebuild 2 (the next sync's persist): buildCombinedSnapshotDb = removeSnapshotDbFile + openSnapshotDb.
    await removeSnapshotDbFile();
    log("after removeSnapshotDbFile", { files: [...state.files], native: [...state.native.values()] });
    let error: unknown;
    const fresh = await openSnapshotDb().catch((caught: unknown) => {
      error = caught;
      return null;
    });
    log("rebuild 2 open", { error, conn: fresh ? connOf(fresh) : null, opened: state.opened });

    expect(error, "the next rebuild must not reuse the connection over unlinked files").toBeUndefined();
    expect(connOf(fresh).id, "a fresh native connection on fresh files").not.toBe(connOf(leaked).id);
    expect(connOf(fresh).unlinked).toBe(false);
    await fresh?.close();
  });

  it("@bugfix @regression-proof a normally closed snapshot handle is not closed twice", async () => {
    const db = await openSnapshotDb();
    await db.close();
    await removeSnapshotDbFile();
    const warn = vi.mocked(console.warn);
    log("warn calls", warn.mock.calls);
    expect(warn.mock.calls.some(([event]) => String(event).startsWith("library.db.snapshot.stale_handle"))).toBe(false);
    const again = await openSnapshotDb();
    expect(connOf(again).unlinked).toBe(false);
  });
});

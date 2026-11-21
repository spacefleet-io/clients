/**
 * Shared fixture for tests that drive the REAL `LibraryDb` class (hot-start
 * cache path, op sync, close) over an in-memory filesystem, fake SQLite
 * handles that mimic react-native-sqlite-storage's "database not open"
 * errors, and a fake library API. `sqliteDbFilesMock` swaps the fake handles
 * for real in-memory SQLite (node:sqlite) when a test asserts on rows.
 *
 * Usage (vi.mock calls are hoisted, so each test file declares them itself):
 *
 *   vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
 *   vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
 *   ... see `tests/library-cold-start-cursor.test.ts` for the full list.
 */
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { LibraryDbGroup } from "@space/library-db-definition/manifest";
import { getGroupDdlStatements } from "@space/library-db-definition/migrations";
import type * as SharedApi from "@space/shared/api";
import type { LibraryWriterFormats } from "@space/shared/api";
import type { LibraryOp } from "@space/shared/libraryOps";
import { declaredSplitColumns } from "../src/lib/library/libraryCopy";

export const DOCS = "/docs";

/** setTimeout-based sleep built on Promise.withResolvers. */
export const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};
export const LIB_DIR = `${DOCS}/library`;
export const CACHE_JSON = `${LIB_DIR}/cache.json`;
export const CORE_DB_PATH = `${DOCS}/library.core.sqlite`;
export const METADATA_DB_PATH = `${DOCS}/library.metadata.sqlite`;
export const PLAYBACK_DB_PATH = `${DOCS}/library.playback.sqlite`;
export const INGEST_DB_PATH = `${DOCS}/library.ingest.sqlite`;

export type FakeMeta = {
  exists: boolean;
  version: number;
  snapshotVersion: number;
  updatedAt: string | null;
  keyProbe: string | null;
};

type OpEntry = { opId: string; version: number; op: LibraryOp };

export const fx = {
  files: new Map<string, string>(),
  /** Every handle ever opened (in open order) so tests can inspect statements. */
  handles: [] as FakeDb[],
  /** Native connection state keyed by db name, like the sqlite plugin's openDBs. */
  nativeOpen: new Map<string, boolean>(),
  meta: null as FakeMeta | null,
  /** Server op stream. `getLibraryOps(since)` returns the entries newer than `since`. */
  serverOps: [] as OpEntry[],
  serverVersion: 0,
  serverSnapshotVersion: 0,
  /** Make `getLibraryOps` answer `tooOld: true` (the cursor predates the server's compaction snapshot). */
  opsTooOld: false,
  opsSince: [] as number[],
  remoteSnapshotFetches: 0,
  putOpCalls: 0,
  /** `getLibraryOps` answers `tooOld: true` once asked from this version on (a later page falls out of the window). */
  opsTooOldFrom: null as number | null,
  /** `getLibraryOps` returns at most this many entries per call (`hasMore` + `version` of the last one); null = unpaged. */
  opsPageSize: null as number | null,
  /** `getLibraryOps` rejects like RN's fetch on a read that broke ("Network request failed") when asked from this version on. */
  opsFailFrom: null as number | null,
  /** Size (bytes) of the encrypted snapshot file `buildChunkIndexFromFile` reports (LIB-SYNC-12). */
  snapshotBytes: 0,
  /** The encrypted bytes of every op `putLibraryOp` received, in call order. */
  postedOps: [] as Uint8Array[],
  nextPutVersion: 0,
  /** Make `putLibraryOp` (POST /library/db/ops) reject with an ApiError of this status + payload. */
  putOpError: null as { status: number; payload: Record<string, unknown> } | null,
  /** `putLibraryDb` (PUT /library/db, the snapshot publish) calls; rejects with `putDbError` when set. */
  putDbCalls: 0,
  putDbError: null as { status: number; payload: Record<string, unknown> } | null,
  /** The `formats` argument of every `putLibraryOp` / `putLibraryDb` call, in call order. */
  declaredFormats: { op: [] as Array<LibraryWriterFormats | undefined>, db: [] as Array<LibraryWriterFormats | undefined> },
  /** When set, opening the named db waits for the promise then rejects/resolves. */
  openGate: new Map<string, { gate: Promise<void>; failWith?: string }>(),
  /** Make `encryptDbToBinaryFile` (the combined-snapshot persist) throw, like a killed process. */
  encryptShouldFail: false,
  /** Every `encryptDbToBinaryFile` target path, in call order. */
  encryptTargets: [] as string[],
  /** Make `encryptBytesToBytes` (op payload encryption in flushOps) throw. */
  opEncryptShouldFail: false,
  /** Delay (ms) applied inside every executeSql of handles named here. */
  statementDelayMs: new Map<string, number>(),
  /** Make `sqlBatch` throw on handles named here (a failing secondary apply). */
  batchShouldFail: new Set<string>(),
  /** Snapshot DBs handed out, in order, by `sqliteDbFilesMock().openSnapshotDb` (then an inert handle). */
  snapshots: [] as SqliteHandle[],
  /** `media_items.updated_at` per media id as the core DB holds it (what the secondary-apply gate reads). */
  coreMediaClocks: new Map<string, string>(),
  /**
   * `PRAGMA table_info` answers: handle name (or `SNAPSHOT_HANDLE`) -> table -> columns. A handle without
   * an entry has every table and column the current schema declares; an entry replaces that wholesale
   * (a table left out of it does not exist).
   */
  tableColumns: new Map<string, ReadonlyMap<string, ReadonlySet<string>>>(),
};

export const SNAPSHOT_HANDLE = "snapshot";

const HANDLE_GROUPS = {
  "library.core.sqlite": "core",
  "library.metadata.sqlite": "metadata",
  "library.playback.sqlite": "playback",
  "library.ingest.sqlite": "ingest",
} as const;

/** Rows for `PRAGMA table_info(<table>)` on `handle`, or null when `sql` is something else. */
const pragmaTableInfoRows = (handle: string, sql: string) => {
  const table = /^PRAGMA table_info\((\w+)\);?$/.exec(sql.trim())?.[1];
  if (!table) return null;
  const declared = declaredSplitColumns();
  const columns =
    fx.tableColumns.get(handle)?.get(table) ??
    (fx.tableColumns.has(handle)
      ? undefined
      : handle === SNAPSHOT_HANDLE
        ? Object.values(declared).find((tables) => tables.has(table))?.get(table)
        : declared[HANDLE_GROUPS[handle as keyof typeof HANDLE_GROUPS]]?.get(table));
  const rows = [...(columns ?? [])].map((name) => ({ name }));
  return [{ rows: { length: rows.length, item: (i: number) => rows[i] as Record<string, unknown> } }];
};

export const resetFixture = () => {
  fx.files.clear();
  fx.handles = [];
  fx.nativeOpen.clear();
  fx.meta = null;
  fx.serverOps = [];
  fx.serverVersion = 0;
  fx.serverSnapshotVersion = 0;
  fx.opsSince = [];
  fx.remoteSnapshotFetches = 0;
  fx.putOpCalls = 0;
  fx.opsTooOld = false;
  fx.opsTooOldFrom = null;
  fx.opsPageSize = null;
  fx.opsFailFrom = null;
  fx.snapshotBytes = 0;
  fx.postedOps = [];
  fx.nextPutVersion = 0;
  fx.putOpError = null;
  fx.putDbCalls = 0;
  fx.putDbError = null;
  fx.declaredFormats = { op: [], db: [] };
  fx.openGate.clear();
  fx.encryptShouldFail = false;
  fx.encryptTargets = [];
  fx.opEncryptShouldFail = false;
  fx.statementDelayMs.clear();
  fx.batchShouldFail.clear();
  fx.snapshots = [];
  sqliteFiles.clear();
  attachedSnapshotFile = null;
  for (const dir of snapshotFiles.splice(0)) rmSync(dir, { recursive: true, force: true });
  fx.coreMediaClocks.clear();
  fx.tableColumns.clear();
  // Split DB files must exist for loadCache() to accept a split-mode cache.
  for (const path of [CORE_DB_PATH, METADATA_DB_PATH, PLAYBACK_DB_PATH, INGEST_DB_PATH]) {
    fx.files.set(path, "");
  }
};

/** Mimics react-native-sqlite-storage: closed handles throw "database not open". */
export class FakeDb {
  closed = false;
  statements: string[] = [];
  batches: Array<Array<[string, unknown[]]>> = [];
  constructor(readonly name: string) {}

  private assertOpen() {
    if (this.closed || fx.nativeOpen.get(this.name) === false) {
      throw new Error("database not open");
    }
  }

  async executeSql(sql: string, params: unknown[] = []): Promise<Array<{ rows: { length: number; item: (i: number) => Record<string, unknown> }; rowsAffected?: number }>> {
    this.assertOpen();
    const delay = fx.statementDelayMs.get(this.name);
    if (delay) {
      await sleep(delay);
      this.assertOpen();
    }
    this.statements.push(sql);
    // The clock read that gates the secondary apply (`SELECT id, updated_at FROM media_items WHERE id IN (...)`).
    if (this.name === "library.core.sqlite" && sql.startsWith("SELECT id, updated_at FROM media_items WHERE id IN")) {
      const rows = params.flatMap((id) => (fx.coreMediaClocks.has(String(id)) ? [{ id, updated_at: fx.coreMediaClocks.get(String(id)) }] : []));
      return [{ rows: { length: rows.length, item: (i: number) => rows[i] as Record<string, unknown> } }];
    }
    return pragmaTableInfoRows(this.name, sql) ?? [{ rows: { length: 0, item: () => ({}) }, rowsAffected: 0 }];
  }

  async sqlBatch(statements: Array<[string, unknown[]]>) {
    this.assertOpen();
    if (fx.batchShouldFail.has(this.name)) throw new Error(`batch failed: ${this.name}`);
    this.batches.push(statements);
    if (this.name === "library.core.sqlite") {
      // Mimic the guarded core upsert (`... WHERE excluded.updated_at >= media_items.updated_at`) so the clock
      // the secondary-apply gate reads is whatever core really ended up with.
      for (const [sql, params] of statements) {
        if (!sql.trimStart().startsWith("INSERT INTO media_items")) continue;
        const [id, updatedAt] = [String(params[0]), String(params[11])];
        const current = fx.coreMediaClocks.get(id);
        if (current === undefined || updatedAt >= current) fx.coreMediaClocks.set(id, updatedAt);
      }
    }
  }

  async close() {
    if (this.closed) throw new Error("database not open");
    this.closed = true;
    fx.nativeOpen.set(this.name, false);
  }
}

export const openFakeDb = async (name: string) => {
  const gated = fx.openGate.get(name);
  if (gated) {
    await gated.gate;
    if (gated.failWith) throw new Error(gated.failWith);
  }
  fx.nativeOpen.set(name, true);
  const handle = new FakeDb(name);
  fx.handles.push(handle);
  return handle;
};

export const handlesNamed = (name: string) => fx.handles.filter((handle) => handle.name === name);

// ── Real SQLite behind the react-native-sqlite-storage surface ───────

const toSqlValue = (value: unknown): SQLInputValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  throw new Error(`unsupported SQL parameter: ${typeof value}`);
};

/** One connection over a real in-memory SQLite db, with the plugin's surface and its "database not open" rule. */
export class SqliteHandle {
  closed = false;
  constructor(
    readonly name: string,
    readonly db: DatabaseSync
  ) {}

  private assertOpen() {
    if (this.closed) throw new Error("database not open");
  }

  async executeSql(inputSql: string, params: unknown[] = []) {
    this.assertOpen();
    const sql = redirectSnapshotAttach(inputSql);
    const statement = this.db.prepare(sql);
    const values = params.map(toSqlValue);
    if (statement.columns().length > 0) {
      const rows = statement.all(...values);
      return [{ rows: { length: rows.length, item: (i: number) => rows[i] }, rowsAffected: 0 }];
    }
    const result = statement.run(...values);
    return [{ rows: { length: 0, item: () => ({}) }, rowsAffected: Number(result.changes) }];
  }

  /** Like the plugin: the whole batch in one transaction. */
  async sqlBatch(statements: Array<string | [string, unknown[]]>) {
    this.assertOpen();
    this.db.exec("BEGIN");
    try {
      for (const statement of statements) {
        const [sql, params] = typeof statement === "string" ? [statement, []] : statement;
        this.db.prepare(sql).run(...params.map(toSqlValue));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async close() {
    this.assertOpen();
    this.closed = true;
  }
}

const SPLIT_DB_GROUPS: Record<string, LibraryDbGroup> = {
  "library.core.sqlite": "core",
  "library.metadata.sqlite": "metadata",
  "library.playback.sqlite": "playback",
  "library.ingest.sqlite": "ingest",
};

/** A new in-memory db holding these groups' schema (the device creates the same through librarySchema). */
export const createLibrarySqlite = (groups: LibraryDbGroup[], options: { foreignKeys: boolean; file?: string }) => {
  const db = new DatabaseSync(options.file ?? ":memory:", { enableForeignKeyConstraints: options.foreignKeys });
  for (const group of groups) {
    for (const sql of getGroupDdlStatements(group)) db.exec(sql);
  }
  return db;
};

/** The split db "files": they outlive close + reopen, and `resetSplitDbFiles` drops them (the device unlinks them). */
const sqliteFiles = new Map<string, DatabaseSync>();

/** The split db of that name, created empty on first use. Only core enforces foreign keys, as on the device. */
export const sqliteFile = (name: string) => {
  const existing = sqliteFiles.get(name);
  if (existing) return existing;
  const group = SPLIT_DB_GROUPS[name];
  if (!group) throw new Error(`not a split library db: ${name}`);
  const db = createLibrarySqlite([group], { foreignKeys: group === "core" });
  sqliteFiles.set(name, db);
  return db;
};

/**
 * The snapshot db handed out last, as a real file: the split dbs ATTACH the snapshot by path and let SQLite copy the
 * rows (INSERT..SELECT), which an in-memory db cannot serve. Their ATTACH of the device's snapshot path is
 * redirected to this file.
 */
let attachedSnapshotFile: string | null = null;
const snapshotFiles: string[] = [];

const SNAPSHOT_ATTACH = /^ATTACH DATABASE '[^']*library\.snapshot\.sqlite' AS (\w+);$/;
const redirectSnapshotAttach = (sql: string) => {
  const alias = SNAPSHOT_ATTACH.exec(sql)?.[1];
  if (!alias || !attachedSnapshotFile) return sql;
  return `ATTACH DATABASE '${attachedSnapshotFile.replace(/'/g, "''")}' AS ${alias};`;
};

/** A combined snapshot db (every mobile group in one file) to queue in `fx.snapshots`. */
export const createSnapshotHandle = () => {
  const dir = mkdtempSync(join(tmpdir(), "library-snapshot-"));
  snapshotFiles.push(dir);
  const file = join(dir, "library.snapshot.sqlite");
  const handle = new SqliteHandle(
    "library.snapshot.sqlite",
    createLibrarySqlite(["core", "metadata", "playback", "ingest"], { foreignKeys: false, file })
  );
  snapshotFileOf.set(handle, file);
  return handle;
};
const snapshotFileOf = new WeakMap<SqliteHandle, string>();

/** Rows of a split db, read straight from its SQLite file. */
export const sqliteRows = (name: string, sql: string, ...params: SQLInputValue[]) =>
  sqliteFile(name).prepare(sql).all(...params);

export const fakeRnfs = {
  DocumentDirectoryPath: DOCS,
  CachesDirectoryPath: "/caches",
  exists: async (path: string) => fx.files.has(path) || path === LIB_DIR,
  mkdir: async () => undefined,
  readFile: async (path: string) => {
    const value = fx.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return value;
  },
  writeFile: async (path: string, data: string) => {
    fx.files.set(path, data);
  },
  unlink: async (path: string) => {
    fx.files.delete(path);
  },
  moveFile: async (from: string, to: string) => {
    const value = fx.files.get(from);
    if (value === undefined) throw new Error(`ENOENT ${from}`);
    fx.files.set(to, value);
    fx.files.delete(from);
  },
};

export const readCacheJson = (): { version: number; snapshotVersion?: number; mode?: string; updatedAt: string | null } | null => {
  const raw = fx.files.get(CACHE_JSON);
  return raw ? JSON.parse(raw) : null;
};

export const seedSplitCache = (cache: { version: number; snapshotVersion?: number; updatedAt?: string | null }) => {
  fx.files.set(
    CACHE_JSON,
    JSON.stringify({
      version: cache.version,
      snapshotVersion: cache.snapshotVersion ?? cache.version,
      blobPath: `${LIB_DIR}/cache.blob`,
      encrypted: true,
      encoding: "binary",
      updatedAt: cache.updatedAt ?? "2026-10-15T00:00:00.000Z",
      mode: "split",
    })
  );
  fx.files.set(`${LIB_DIR}/cache.blob`, "blob");
};

export const setServer = (state: {
  version: number;
  snapshotVersion: number;
  updatedAt?: string | null;
  ops?: OpEntry[];
}) => {
  fx.serverVersion = state.version;
  fx.serverSnapshotVersion = state.snapshotVersion;
  fx.serverOps = state.ops ?? [];
  fx.meta = {
    exists: true,
    version: state.version,
    snapshotVersion: state.snapshotVersion,
    updatedAt: state.updatedAt ?? "2026-10-14T00:00:00.000Z",
    keyProbe: null,
  };
};

export const settingOp = (id: string, key: string, value: string): LibraryOp => ({
  id,
  type: "setting.set",
  createdAt: "2026-10-15T00:00:00.000Z",
  payload: { key, value, updatedAt: "2026-10-15T00:00:00.000Z" },
});

export const mediaUpsertOp = (id: string, mediaId: string): LibraryOp =>
  ({
    id,
    type: "media.upsert",
    createdAt: "2026-10-15T00:00:00.000Z",
    payload: {
      details: {
        id: mediaId,
        type: "movie",
        title: `Movie ${mediaId}`,
        originalTitle: null,
        originalLanguage: null,
        overview: null,
        year: "2001",
        rating: null,
        posterPath: null,
        backdropPath: null,
        addedAt: "2026-10-15T00:00:00.000Z",
        updatedAt: "2026-10-15T00:00:00.000Z",
        hasFiles: true,
        progressPct: 0,
        lastWatchedAt: null,
        totalEpisodes: null,
        catalogId: 120,
        genres: [],
        cast: [],
        trailers: [],
        seasons: [],
        episodes: [],
        files: [],
        formats: [],
        audioTracks: [],
        subtitles: [],
        chapters: [],
        skipMarkers: [],
      },
    },
  }) as unknown as LibraryOp;

/** Server response for GET /library/db/ops?since=N, payloads shipped inline (identity "encryption"). */
export const opsResponse = (since: number) => {
  // Like the server: a cursor older than the compaction snapshot gets no ops, only `tooOld`.
  const tooOld = fx.opsTooOld || (fx.opsTooOldFrom !== null && since >= fx.opsTooOldFrom);
  const newer = tooOld ? [] : fx.serverOps.filter((entry) => entry.version > since);
  const entries = fx.opsPageSize ? newer.slice(0, fx.opsPageSize) : newer;
  const hasMore = entries.length < newer.length;
  return {
    version: hasMore ? (entries[entries.length - 1]?.version ?? fx.serverVersion) : fx.serverVersion,
    snapshotVersion: fx.serverSnapshotVersion,
    tooOld: fx.opsTooOld || (fx.opsTooOldFrom !== null && since >= fx.opsTooOldFrom),
    hasMore,
    storageFormatVersion: 1,
    opStreamVersion: 1,
    ops: entries.map((entry) => {
      const json = JSON.stringify(entry.op);
      return {
        opId: entry.opId,
        version: entry.version,
        createdAt: "2026-10-15T00:00:00.000Z",
        size: json.length,
        objectKey: `library/ops/${entry.opId}`,
        payloadCiphertext: Buffer.from(json, "utf8").toString("base64"),
      };
    }),
  };
};

/** Wait until store-visible background work (secondary ops chain) settles. The chain is private on LibraryDb, so it is
 * read by name: callers pass the LibraryDb itself. */
export const settle = async (db: object) => {
  for (let i = 0; i < 5; i += 1) {
    const inFlight = "secondaryOpsInFlight" in db ? db.secondaryOpsInFlight : null;
    await (inFlight instanceof Promise ? inFlight : Promise.resolve());
    await sleep(0);
  }
};

// ── vi.mock factories ────────────────────────────────────────────────
// vi.mock calls are hoisted above static imports, so test files reach these
// through a dynamic import inside each factory:
//   vi.mock("../src/lib/library/transport", async () => (await import("./library-db-fixture")).transportMock());

export const quickCryptoMock = () => ({ default: { randomBytes, randomUUID } });

export const sharedApiMock = (actual: typeof SharedApi) => ({
  ...actual,
  getLibraryMeta: async () => fx.meta,
  getLibraryOps: async (_token: string, since: number) => {
    fx.opsSince.push(since);
    if (fx.opsFailFrom !== null && since >= fx.opsFailFrom) throw new TypeError("Network request failed");
    return opsResponse(since);
  },
  putLibraryOp: async (
    _token: string,
    _baseVersion: number,
    _opId: string,
    _payload: Uint8Array,
    _lineage?: unknown,
    _appId?: unknown,
    formats?: LibraryWriterFormats
  ) => {
    fx.putOpCalls += 1;
    fx.postedOps.push(_payload);
    fx.declaredFormats.op.push(formats);
    if (fx.putOpError) throw new actual.ApiError(fx.putOpError.status, fx.putOpError.payload);
    return { version: fx.nextPutVersion, stateHash: null, lastOpId: null };
  },
  putLibraryDb: async (
    _token: string,
    _version: number,
    _blobBase64: string,
    _snapshotId: string,
    _chunkSize: number,
    _keyProbe?: string | null,
    _force?: boolean,
    _stateHash?: string | null,
    _lastOpId?: string | null,
    _appId?: unknown,
    _chunkRefs?: string[],
    _chunkRefsSource?: unknown,
    formats?: LibraryWriterFormats
  ) => {
    fx.putDbCalls += 1;
    fx.declaredFormats.db.push(formats);
    if (fx.putDbError) throw new actual.ApiError(fx.putDbError.status, fx.putDbError.payload);
    return { version: fx.nextPutVersion };
  },
});

export const transportMock = () => ({
  CHUNK_SIZE_BYTES: 4 * 1024 * 1024,
  FILE_SLICE_BYTES: 64 * 1024,
  readFileChunk: async () => new Uint8Array(),
  uploadObjectViaTunnel: async () => undefined,
  downloadObjectViaTunnel: async () => new Uint8Array(),
  fetchManifestBytes: async () => new Uint8Array(),
  fetchRemoteManifestWithRetry: async () => {
    fx.remoteSnapshotFetches += 1;
    throw new Error("REMOTE_SNAPSHOT_FETCHED");
  },
  uploadChunksFromFile: async () => undefined,
  downloadChunksToFile: async () => undefined,
});

export const dbFilesMock = () => {
  const fakeSnapshot = {
    executeSql: async (sql: string) => pragmaTableInfoRows(SNAPSHOT_HANDLE, sql) ?? [{ rows: { length: 0, item: () => ({}) } }],
    sqlBatch: async () => undefined,
    close: async () => undefined,
  };
  return {
    CORE_DB_NAME: "library.core.sqlite",
    METADATA_DB_NAME: "library.metadata.sqlite",
    PLAYBACK_DB_NAME: "library.playback.sqlite",
    INGEST_DB_NAME: "library.ingest.sqlite",
    SNAPSHOT_DB_NAME: "library.snapshot.sqlite",
    IntegrityCheckFailedError: class extends Error {},
    openCoreDb: () => openFakeDb("library.core.sqlite"),
    openMetadataDb: () => openFakeDb("library.metadata.sqlite"),
    openPlaybackDb: () => openFakeDb("library.playback.sqlite"),
    openIngestDb: () => openFakeDb("library.ingest.sqlite"),
    openSnapshotDb: async () => fakeSnapshot,
    ensureLibraryDir: async () => undefined,
    removeDbFile: async () => undefined,
    resetSplitDbFiles: async () => undefined,
    removeSnapshotDbFile: async () => undefined,
    runIntegrityCheck: async () => undefined,
  };
};

/**
 * `dbFilesMock` over real SQLite: the split dbs are `sqliteFile`s, each `openSnapshotDb` takes the next
 * `fx.snapshots` entry (an inert handle once they run out, e.g. for the combined-snapshot persist, which
 * ATTACHes files by path).
 */
export const sqliteDbFilesMock = () => {
  const base = dbFilesMock();
  const inertSnapshot = {
    executeSql: async () => [{ rows: { length: 0, item: () => ({}) } }],
    sqlBatch: async () => undefined,
    close: async () => undefined,
  };
  return {
    ...base,
    openCoreDb: async () => new SqliteHandle(base.CORE_DB_NAME, sqliteFile(base.CORE_DB_NAME)),
    openMetadataDb: async () => new SqliteHandle(base.METADATA_DB_NAME, sqliteFile(base.METADATA_DB_NAME)),
    openPlaybackDb: async () => new SqliteHandle(base.PLAYBACK_DB_NAME, sqliteFile(base.PLAYBACK_DB_NAME)),
    openIngestDb: async () => new SqliteHandle(base.INGEST_DB_NAME, sqliteFile(base.INGEST_DB_NAME)),
    openSnapshotDb: async () => {
      const next = fx.snapshots.shift();
      if (!next) return inertSnapshot;
      attachedSnapshotFile = snapshotFileOf.get(next) ?? null;
      return next;
    },
    resetSplitDbFiles: async () => {
      sqliteFiles.clear();
    },
  };
};

export const snapshotMock = () => ({
  isSqliteHeader: () => false,
  decodeUtf8: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  encodeUtf8: (value: string) => new TextEncoder().encode(value),
  buildChunkIndexFromFile: async () => ({ totalSize: fx.snapshotBytes, chunks: [] }),
  hashDbFile: async () => ({ sizeBytes: 0, hash: "hash" }),
  buildManifest: () => ({}),
  decodeStoredManifest: async () => new Uint8Array(),
  fetchManifestChunks: async () => [],
  decryptFileToDb: async () => undefined,
  exportDbBytes: async () => new Uint8Array(),
  createKeyProbe: async () => "probe",
  createSnapshotId: () => "snapshot-id",
  getLatestSnapshotMs: () => 0,
  selectSnapshotsForRetention: () => [],
  // The combined-snapshot persist; failing it simulates a JS reload mid-encrypt.
  encryptDbToBinaryFile: async (_db: string, _key: string, target: string) => {
    fx.encryptTargets.push(target);
    if (fx.encryptShouldFail) throw new Error("PERSIST_INTERRUPTED");
    // The app sandbox: like iOS, a path outside today's Documents folder cannot be written.
    if (!target.startsWith(`${DOCS}/`)) {
      throw new Error(`ENCRYPT_FAILED You don't have permission to save the file "library" in the folder "Documents". (${target})`);
    }
    fx.files.set(target, "blob");
  },
});

export const cryptoMock = () => ({
  encryptBytesToBytes: async (_key: string, bytes: Uint8Array) => {
    if (fx.opEncryptShouldFail) throw new Error("OP_ENCRYPT_FAILED");
    return bytes;
  },
  decryptBytesToBytes: async (_key: string, bytes: Uint8Array) => bytes,
  // The account's key probe opens with the fixture's key (the snapshot guard's check, UX-KEY-01).
  decryptBase64ToBytes: async () => new Uint8Array(),
  encryptBytesToBase64: async () => "",
});

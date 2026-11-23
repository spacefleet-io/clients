/**
 * @test-id MOBILE-LIBRARY-UPDATED-AT-GUARDS-001
 * @level unit
 * @req LIB-SYNC-08
 *
 * Why this exists (#663): a media's details were re-sent whole, including an old progress value, and the
 * change that arrived last won even when it was older, so progress could jump back (LIB-SYNC-08).
 * The shared op builder guards the core rows by their clock; on the phone the metadata and playback
 * files are separate SQLite files that cannot see that guard, so
 *  - the secondary apply must run an upsert's formats/files/episodes only when the core row now carries
 *    that upsert's `updated_at` (an older upsert that lost in core must not replace newer playback rows);
 *  - saving playback progress must not move `media_items.updated_at` (that is the details clock;
 *    progress has `last_watched_at`), or the phone would ignore a newer details edit made elsewhere.
 * The first part drives the real LibraryDb class over fake handles; the second runs the shared op SQL on a
 * real SQLite core database.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import type { LibraryOp } from "@space/shared/libraryOps";
import { buildOpStatements } from "@space/library-db-definition/ops";
import { ensureLibrarySchema, type SqliteDb } from "@space/library-db-definition/migrations";
import { LibraryDb } from "../src/lib/libraryDb";
import { fx, handlesNamed, mediaUpsertOp, resetFixture, seedSplitCache, setServer, settingOp } from "./library-db-fixture";

const TAG = "[library-updated-at-guards]";
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

// Pick<…, keyof …> drops the private members, which the seam below re-declares as public for the test.
type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & {
  secondaryOpsInFlight: Promise<void> | null;
  applyLibraryOps(ops: LibraryOp[]): Promise<void>;
};

const openLocal = async () => (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;

/** An upsert of `mediaId` carrying `updatedAt`, with one format so the playback group has rows to write. */
const upsert = (opId: string, mediaId: string, updatedAt: string) => {
  const op = mediaUpsertOp(opId, mediaId) as unknown as { payload: { details: Record<string, unknown> } };
  op.payload.details.updatedAt = updatedAt;
  op.payload.details.formats = [
    {
      id: `fmt-${mediaId}`,
      mediaId,
      fileId: null,
      quality: "1080p",
      codec: "h264",
      codecString: null,
      bitrateKbps: null,
      sizeMb: null,
      initKey: null,
      initSize: null,
      durationSeconds: null,
      totalSize: null,
      chunks: [],
    },
  ];
  return op as unknown as LibraryOp;
};

/** Every bound parameter of the statements that reached the metadata and playback files. */
const secondaryParams = () =>
  ["library.metadata.sqlite", "library.playback.sqlite"].flatMap((name) =>
    handlesNamed(name).flatMap((handle) => handle.batches.flatMap((batch) => batch.flatMap(([, params]) => params.map(String))))
  );

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setServer({ version: 3, snapshotVersion: 3 });
  seedSplitCache({ version: 3 });
});

describe("LIB-SYNC-08: the secondary apply follows the core clock", () => {
  it("@req LIB-SYNC-08 an upsert older than the core row never rewrites formats, files or episodes", async () => {
    log("phase:start stale upsert");
    fx.coreMediaClocks.set("m-stale", "2026-10-16T00:00:00.000Z"); // core already holds a newer upsert
    const db = await openLocal();
    await db.applyLibraryOps([upsert("op-old", "m-stale", "2026-10-15T00:00:00.000Z")]);
    await db.secondaryOpsInFlight;
    const params = secondaryParams();
    log("state", { secondaryParams: params, statements: handlesNamed("library.core.sqlite")[0]?.statements.length });
    expect(params, "no metadata/playback statement for the losing upsert").not.toContain("m-stale");
    expect(params).not.toContain("fmt-m-stale");
  });

  it("@req LIB-SYNC-08 an upsert the core row now carries is applied to metadata and playback", async () => {
    log("phase:start held upsert");
    fx.coreMediaClocks.set("m-new", "2026-10-15T00:00:00.000Z");
    const db = await openLocal();
    await db.applyLibraryOps([upsert("op-new", "m-new", "2026-10-15T00:00:00.000Z")]);
    await db.secondaryOpsInFlight;
    const params = secondaryParams();
    log("state", { secondaryParams: params });
    expect(params).toContain("m-new");
    expect(params).toContain("fmt-m-new");
  });

  it("@req LIB-SYNC-08 in one batch only the upserts that won in core go on", async () => {
    log("phase:start mixed batch");
    fx.coreMediaClocks.set("m-lost", "2026-10-16T00:00:00.000Z");
    fx.coreMediaClocks.set("m-won", "2026-10-15T00:00:00.000Z");
    const db = await openLocal();
    await db.applyLibraryOps([
      upsert("op-lost", "m-lost", "2026-10-15T00:00:00.000Z"),
      upsert("op-won", "m-won", "2026-10-15T00:00:00.000Z"),
    ]);
    await db.secondaryOpsInFlight;
    const params = secondaryParams();
    log("state", { secondaryParams: params });
    expect(params).toContain("fmt-m-won");
    expect(params).not.toContain("fmt-m-lost");
  });

  it("@req LIB-SYNC-08 the clock of a big batch is read in bounded chunks, not one parameter per upsert", async () => {
    log("phase:start chunked clock read");
    const ops = Array.from({ length: 1200 }, (_, i) => upsert(`op-${i}`, `m-${i}`, "2026-10-15T00:00:00.000Z"));
    for (let i = 0; i < 1200; i += 1) fx.coreMediaClocks.set(`m-${i}`, "2026-10-15T00:00:00.000Z");
    const db = await openLocal();
    await db.applyLibraryOps(ops);
    await db.secondaryOpsInFlight;
    const clockReads = handlesNamed("library.core.sqlite")[0]?.statements.filter((sql) => sql.startsWith("SELECT id, updated_at FROM media_items")) ?? [];
    log("state", { clockReads: clockReads.length });
    expect(clockReads, "1200 ids in chunks of 500").toHaveLength(3);
  });
});

describe("LIB-SYNC-08: saving progress is not a details edit", () => {
  it("@req LIB-SYNC-08 setPlaybackProgress and setProgress leave media_items.updated_at alone", async () => {
    log("phase:start progress writes");
    const db = await openLocal();
    await db.setPlaybackProgress("m1", null, 40, null);
    await db.setProgress("m1", 50);
    const core = handlesNamed("library.core.sqlite")[0];
    const updates = core?.statements.filter((sql) => sql.startsWith("UPDATE media_items")) ?? [];
    log("state", { updates });
    expect(updates).toHaveLength(2);
    for (const sql of updates) expect(sql).not.toMatch(/updated_at/);
  });
});

/** The shared op SQL on a real core database (the phone runs exactly these statements). */
describe("LIB-SYNC-08: the core statements ignore an older change", () => {
  const openCore = () => {
    const db = new DatabaseSync(":memory:");
    // node:sqlite takes SQLInputValue parameters, the shared shape takes unknown: same statements, narrower parameter type.
    ensureLibrarySchema(db as unknown as SqliteDb, "core");
    return db;
  };
  const apply = (db: DatabaseSync, op: LibraryOp) => {
    for (const { sql, params } of buildOpStatements(op, () => crypto.randomUUID()).core ?? []) db.prepare(sql).run(...(params as SQLInputValue[]));
  };
  const progressOp = (mediaId: string, progressPct: number, at: string) =>
    ({
      id: `p-${at}`,
      type: "media.progress",
      createdAt: at,
      payload: { mediaId, progressPct, lastWatchedAt: at, updatedAt: at },
    }) as unknown as LibraryOp;

  it("@req LIB-SYNC-08 an older media.upsert, media.progress or setting.set is ignored; a re-save never carries progress", () => {
    const db = openCore();
    apply(db, upsert("u1", "m1", "2026-10-15T00:00:00.000Z"));
    apply(db, progressOp("m1", 80, "2026-10-17T00:00:00.000Z"));
    // A details re-save newer than the first upsert, carrying an old progress value (0), must not reset progress.
    const resave = upsert("u2", "m1", "2026-10-18T00:00:00.000Z") as unknown as { payload: { details: Record<string, unknown> } };
    resave.payload.details.title = "Renamed";
    apply(db, resave as unknown as LibraryOp);
    const afterResave = db.prepare("SELECT title, progress_pct, last_watched_at, updated_at FROM media_items WHERE id = 'm1'").all();
    log("state:after resave", { afterResave });
    expect(afterResave).toEqual([
      expect.objectContaining({ title: "Renamed", progress_pct: 80, last_watched_at: "2026-10-17T00:00:00.000Z", updated_at: "2026-10-18T00:00:00.000Z" }),
    ]);

    // Older arrivals: an upsert from before the re-save, and a progress from before the stored one.
    const old = upsert("u0", "m1", "2026-10-16T00:00:00.000Z") as unknown as { payload: { details: Record<string, unknown> } };
    old.payload.details.title = "Old title";
    apply(db, old as unknown as LibraryOp);
    apply(db, progressOp("m1", 10, "2026-10-16T12:00:00.000Z"));
    const afterOld = db.prepare("SELECT title, progress_pct, updated_at FROM media_items WHERE id = 'm1'").all();
    log("state:after older changes", { afterOld });
    expect(afterOld).toEqual([expect.objectContaining({ title: "Renamed", progress_pct: 80, updated_at: "2026-10-18T00:00:00.000Z" })]);

    // Progress does not move the details clock.
    apply(db, progressOp("m1", 90, "2026-10-19T00:00:00.000Z"));
    expect(db.prepare("SELECT progress_pct, updated_at FROM media_items WHERE id = 'm1'").all()).toEqual([
      expect.objectContaining({ progress_pct: 90, updated_at: "2026-10-18T00:00:00.000Z" }),
    ]);

    // Settings: newer wins, older ignored.
    const setting = (value: string, at: string) => ({ ...settingOp(`s-${at}`, "k", value), payload: { key: "k", value, updatedAt: at } }) as unknown as LibraryOp;
    apply(db, setting("new", "2026-10-19T00:00:00.000Z"));
    apply(db, setting("old", "2026-10-18T00:00:00.000Z"));
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'k'").all()).toEqual([expect.objectContaining({ value: "new" })]);
    db.close();
  });
});

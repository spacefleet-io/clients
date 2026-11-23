/**
 * @test-id MOBILE-LIBRARY-PREVIEW-SHEETS-001
 * @level unit
 *
 * MPV-PREV-01: the desktop import records the seek-bar preview sheets on the video's source format
 * (`media_formats.preview_sheets`) and sends the title again as a `media.upsert` op. The phone and the TV must keep that
 * record when they apply the op AND hand it back from `getMediaDetails`, or the player never sees a sheet. A malformed
 * record reads as "no previews" (the seek bar stays as it was). The snapshot copy between the split DBs and the
 * combined snapshot must carry the column too, or a device restored from a snapshot loses its previews.
 *
 * Drives the real LibraryDb over real in-memory SQLite dbs (node:sqlite).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import type { LibraryOp } from "@space/shared/libraryOps";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import { LibraryDb } from "../src/lib/libraryDb";
import { buildCombinedCopyStatements, buildSplitCopyPlan, declaredSplitColumns, SPLIT_SOURCE_ALIAS } from "../src/lib/library/libraryCopy";
import { fx, mediaUpsertOp, resetFixture, seedSplitCache, setServer, settle, sqliteRows } from "./library-db-fixture";

const TAG = "[library-preview-sheets]";
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
vi.mock("../src/lib/library/dbFiles", async () => (await import("./library-db-fixture")).sqliteDbFilesMock());
vi.mock("../src/lib/library/snapshot", async () => (await import("./library-db-fixture")).snapshotMock());
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({}));

const MEDIA = "movie-previews";
const PLAYBACK = "library.playback.sqlite";

const PREVIEWS: MediaPreviewSheets = {
  version: 1,
  intervalSeconds: 5,
  pictureWidth: 160,
  pictureHeight: 90,
  columns: 10,
  rows: 10,
  pictureCount: 240,
  sheets: [
    { objectKey: "previews/sheet-0", sizeBytes: 164_000, firstPicture: 0, pictureCount: 100 },
    { objectKey: "previews/sheet-1", sizeBytes: 167_000, firstPicture: 100, pictureCount: 100 },
    { objectKey: "previews/sheet-2", sizeBytes: 68_000, firstPicture: 200, pictureCount: 40 },
  ],
};

/** The desktop's upsert after the preview run: the source format carries the record, the 360p copy does not. */
const upsertWithPreviews = (id: string, previews: unknown): LibraryOp => {
  const op = mediaUpsertOp(id, MEDIA) as unknown as { payload: { details: Record<string, unknown> } };
  // `appendMediaMetadata` (ops.ts) walks each file's desired formats.
  op.payload.details.files = [
    { id: "file-1", mediaId: MEDIA, filename: "movie.mkv", season: null, episode: null, addedAt: "2026-10-30T00:00:00.000Z", status: "ready", desiredFormats: [] },
  ];
  op.payload.details.formats = [
    { id: "fmt-src", mediaId: MEDIA, fileId: "file-1", quality: "1080p", codec: "h264", sizeMb: 600, durationSeconds: 1200, isSource: true, previewSheets: previews, chunks: [] },
    { id: "fmt-360", mediaId: MEDIA, fileId: "file-1", quality: "360p", codec: "h264", sizeMb: 40, durationSeconds: 1200, chunks: [] },
  ];
  return op as unknown as LibraryOp;
};

type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & { secondaryOpsInFlight: Promise<void> | null };

const syncOps = async (ops: LibraryOp[]) => {
  seedSplitCache({ version: 3 });
  setServer({ version: 3 + ops.length, snapshotVersion: 3, ops: ops.map((op, i) => ({ opId: op.id, version: 4 + i, op })) });
  const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
  await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
  await settle(db);
  return db;
};

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("seek-bar preview record in the mobile library (MPV-PREV-01)", () => {
  // @req MPV-PREV-01
  it("a media.upsert with preview sheets lands in media_formats.preview_sheets and getMediaDetails returns it", async () => {
    const db = await syncOps([upsertWithPreviews("op-4", PREVIEWS)]);
    try {
      const rows = sqliteRows(PLAYBACK, "SELECT id, preview_sheets FROM media_formats WHERE media_id = ? ORDER BY id;", MEDIA);
      log("rows", rows);
      expect(rows.find((row) => row.id === "fmt-src")?.preview_sheets, "the op's record is stored").toBeTruthy();
      expect(rows.find((row) => row.id === "fmt-360")?.preview_sheets ?? null).toBeNull();

      const details = await db.getMediaDetails(MEDIA, { chunks: false });
      const source = details?.formats.find((format) => format.id === "fmt-src");
      const copy = details?.formats.find((format) => format.id === "fmt-360");
      log("details formats", details?.formats.map((format) => ({ id: format.id, previewSheets: format.previewSheets })));
      expect(source?.previewSheets).toEqual(PREVIEWS);
      // A format without a record leaves the field out: the mobile's own media.upsert then keeps what the desktop
      // stored instead of sending an explicit null that would erase it (ops.ts `keepPreviews`).
      expect(copy && "previewSheets" in copy).toBe(false);
    } finally {
      await db.close();
    }
  });

  // @req MPV-PREV-01
  it("a malformed record reads as no previews", async () => {
    const db = await syncOps([upsertWithPreviews("op-4", { version: 1, sheets: "nope" })]);
    try {
      const details = await db.getMediaDetails(MEDIA, { chunks: false });
      const source = details?.formats.find((format) => format.id === "fmt-src");
      log("malformed", { previewSheets: source?.previewSheets });
      expect(source && "previewSheets" in source).toBe(false);
    } finally {
      await db.close();
    }
  });

  // @req MPV-PREV-01
  it("the snapshot copies carry preview_sheets both ways", () => {
    const declared = declaredSplitColumns();
    expect(declared.playback.get("media_formats")?.has("preview_sheets")).toBe(true);
    const combined = buildCombinedCopyStatements().find((sql) => sql.includes("INTO main.media_formats"));
    log("combined", combined);
    expect(combined).toMatch(/preview_sheets/);

    // The split copy on a real SQLite: snapshot row with a record -> split playback DB row with the same record.
    const columns = [...(declared.playback.get("media_formats") ?? [])];
    const dir = mkdtempSync(join(tmpdir(), "preview-copy-"));
    try {
      const snapshotPath = join(dir, "snapshot.sqlite");
      const snapshot = new DatabaseSync(snapshotPath);
      snapshot.exec("CREATE TABLE media_items (id TEXT, updated_at TEXT);");
      snapshot.exec(`CREATE TABLE media_formats (${columns.join(", ")});`);
      snapshot.exec("INSERT INTO media_items (id, updated_at) VALUES ('m1', '2026-10-30T00:00:00Z');");
      snapshot.prepare("INSERT INTO media_formats (id, media_id, quality, preview_sheets) VALUES ('f1', 'm1', '1080p', ?);").run(JSON.stringify(PREVIEWS));
      snapshot.close();
      const target = new DatabaseSync(":memory:");
      target.exec(`CREATE TABLE media_formats (${columns.join(", ")});`);
      target.exec(`ATTACH DATABASE '${snapshotPath}' AS ${SPLIT_SOURCE_ALIAS};`);
      const source = new Map([
        ["media_items", new Set(["id", "updated_at"])],
        ["media_formats", new Set(columns)],
      ]);
      const plan = buildSplitCopyPlan(source, { ...declared, playback: new Map([["media_formats", new Set(columns)]]) });
      for (const sql of plan.playback) target.exec(sql);
      const copied = target.prepare("SELECT preview_sheets FROM media_formats WHERE id = 'f1';").get() as { preview_sheets: string } | undefined;
      log("split copy", copied);
      expect(JSON.parse(copied?.preview_sheets ?? "null")).toEqual(PREVIEWS);
      target.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

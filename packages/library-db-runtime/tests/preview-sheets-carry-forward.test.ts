/**
 * @test-id LIB-PREVIEW-SHEETS-002
 * @level integration (real `media.upsert` statements on bun:sqlite)
 *
 * MPV-PREV-02 (record survives foreign writers): `media.upsert` deletes every format row of the media and
 * re-inserts the payload. Writers that do not know `previewSheets` (Kodi addon, mobile `queueMediaUpsert`,
 * older desktops) publish formats WITHOUT the field. Applying such an upsert must keep the record stored
 * for the same format (matched by id, else by file + quality); otherwise the previews vanish and storage
 * GC later deletes the sheets. An explicit `previewSheets` (object or null) still wins.
 *
 * @req MPV-PREV-02[runtime]
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureLibrarySchema, type SqliteDb } from "@space/library-db-definition/migrations";
import { buildOpStatements } from "@space/library-db-definition/ops";
import type { LibraryOp } from "@space/shared/libraryOps";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import { LibraryDb } from "../src/libraryDb";

const SUITE = "LIB-PREVIEW-SHEETS-002";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-preview-carry-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[${SUITE}:setup] root=${root}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const MOVIE = {
  id: 77_102,
  type: "movie" as const,
  title: "Preview Carry Movie",
  originalTitle: null,
  originalLanguage: "en",
  overview: "",
  year: "2026",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  cast: [],
  trailers: [],
  totalEpisodes: null,
  seasons: [],
  episodes: [],
};

const PLACEMENT = "media/fedcba9876543210fedcba9876543210";

const PREVIEWS: MediaPreviewSheets = {
  version: 1,
  intervalSeconds: 5,
  pictureWidth: 160,
  pictureHeight: 90,
  columns: 10,
  rows: 10,
  pictureCount: 101,
  sheets: [
    { objectKey: `${PLACEMENT}/previews/sheet-000`, sizeBytes: 61_000, firstPicture: 0, pictureCount: 100 },
    { objectKey: `${PLACEMENT}/previews/sheet-001`, sizeBytes: 900, firstPicture: 100, pictureCount: 1 },
  ],
};

type UpsertOp = Extract<LibraryOp, { type: "media.upsert" }>;
type Row = { id: string; quality: string; isSource: number; previews: string | null };

/** The desktop's own `media.upsert` for a movie whose source format carries preview sheets. */
const desktopUpsert = async (): Promise<UpsertOp> => {
  const db = await LibraryDb.openLocal("token", "key");
  try {
    db.setSyncEnabled(true);
    const mediaId = await db.addMediaFromCatalog(MOVIE);
    const sourceId = await db.addMediaFormat(
      mediaId,
      "file-1",
      "1080p",
      "h264",
      10,
      [{ key: `${PLACEMENT}/v/c0`, sizeBytes: 5_000_000, startSeconds: 0 }],
      4000,
      { initKey: `${PLACEMENT}/v/init`, initSize: 800, durationSeconds: 503, totalSize: 5_000_800, isSource: true }
    );
    await db.addMediaFormat(
      mediaId,
      "file-1",
      "360p",
      "h264",
      2,
      [{ key: `${PLACEMENT}/f/c0`, sizeBytes: 1_000_000, startSeconds: 0 }],
      800,
      { initKey: `${PLACEMENT}/f/init`, initSize: 700, durationSeconds: 503, totalSize: 1_000_700 }
    );
    const recorded = await db.setMediaFormatPreviewSheets(sourceId, PREVIEWS);
    console.info(`[${SUITE}:fixture] setMediaFormatPreviewSheets(${sourceId})=${recorded}`);
    if (!recorded) throw new Error("preview sheets not recorded on the source format");
    // Test seam: the op queue the sync uploads (PendingOp rows are LibraryOps on the wire).
    const ops = (db as unknown as { pendingOps: LibraryOp[] }).pendingOps;
    const upserts = ops.filter((op): op is UpsertOp => op.type === "media.upsert");
    const last = upserts[upserts.length - 1];
    console.info(`[${SUITE}:fixture] pending=${ops.length} upserts=${upserts.length}`);
    if (!last) throw new Error("no media.upsert queued");
    return JSON.parse(JSON.stringify(last)) as UpsertOp;
  } finally {
    db.close();
  }
};

/** A writer that does not know the field: the same formats with `previewSheets` absent (as on the wire). */
const withoutField = (op: UpsertOp, rename?: (id: string) => string): UpsertOp => {
  const copy = JSON.parse(JSON.stringify(op)) as UpsertOp;
  for (const format of copy.payload.details.formats ?? []) {
    delete format.previewSheets;
    if (rename) format.id = rename(format.id);
  }
  return copy;
};

let seq = 0;
const apply = (db: Database, op: UpsertOp, phase: string) => {
  const statements = buildOpStatements(op, () => `gen-${++seq}`).playback ?? [];
  console.info(`[${SUITE}:${phase}] applying ${statements.length} playback statements`);
  for (const statement of statements) {
    try {
      db.prepare(statement.sql).run(...(statement.params as Array<string | number | null>));
    } catch (err) {
      console.error(`[${SUITE}:${phase}] statement failed sql=${statement.sql} params=${JSON.stringify(statement.params)}`);
      throw err;
    }
  }
  const rows = db
    .prepare("SELECT id, quality, is_source AS isSource, preview_sheets AS previews FROM media_formats ORDER BY quality;")
    .all() as Row[];
  console.info(
    `[${SUITE}:${phase}] rows=${JSON.stringify(rows.map((row) => ({ ...row, previews: row.previews ? JSON.parse(row.previews).sheets.length : null })))}`
  );
  return rows;
};

const sourcePreviews = (rows: Row[]) => JSON.parse(rows.find((row) => row.isSource === 1)?.previews ?? "null");

describe("media.upsert keeps preview sheets a writer did not send (MPV-PREV-02)", () => {
  it("an upsert without the field keeps the stored record; an explicit null clears it", async () => {
    const op = await desktopUpsert();
    const fresh = new Database(":memory:");
    try {
      ensureLibrarySchema(fresh as unknown as SqliteDb, "playback");
      const first = apply(fresh, op, "desktop-upsert");
      expect(sourcePreviews(first)).toEqual(PREVIEWS);

      const kept = apply(fresh, withoutField(op), "foreign-upsert");
      expect(kept).toHaveLength(2);
      expect(sourcePreviews(kept)).toEqual(PREVIEWS);
      expect(kept.find((row) => row.isSource === 0)?.previews).toBeNull();

      const cleared = JSON.parse(JSON.stringify(op)) as UpsertOp;
      for (const format of cleared.payload.details.formats ?? []) format.previewSheets = null;
      const after = apply(fresh, cleared, "explicit-null");
      expect(after).toHaveLength(2);
      expect(after.every((row) => row.previews === null)).toBe(true);
    } finally {
      fresh.close();
    }
  });

  it("falls back to the same file + quality when the writer's format ids differ, and drops stale rows", async () => {
    const op = await desktopUpsert();
    const fresh = new Database(":memory:");
    try {
      ensureLibrarySchema(fresh as unknown as SqliteDb, "playback");
      apply(fresh, op, "desktop-upsert");
      const renamed = apply(fresh, withoutField(op, (id) => `${id}-re`), "renamed-upsert");
      expect(renamed).toHaveLength(2);
      expect(renamed.every((row) => row.id.endsWith("-re"))).toBe(true);
      expect(sourcePreviews(renamed)).toEqual(PREVIEWS);
      expect(renamed.find((row) => row.isSource === 0)?.previews).toBeNull();
    } finally {
      fresh.close();
    }
  });

  it("an upsert with no formats removes every format row", async () => {
    const op = await desktopUpsert();
    const fresh = new Database(":memory:");
    try {
      ensureLibrarySchema(fresh as unknown as SqliteDb, "playback");
      apply(fresh, op, "desktop-upsert");
      const empty = JSON.parse(JSON.stringify(op)) as UpsertOp;
      empty.payload.details.formats = [];
      expect(apply(fresh, empty, "no-formats")).toHaveLength(0);
    } finally {
      fresh.close();
    }
  });
});

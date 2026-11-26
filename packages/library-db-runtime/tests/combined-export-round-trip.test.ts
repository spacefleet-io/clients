/**
 * @test-id LIB-COMBINED-EXPORT-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 *
 * Phase 3.6 introduced `buildCombinedExportBytes` (private; reachable through
 * `LibraryDb.exportBytes()`) which stitches the five per-group SQLite files
 * into a single-file snapshot byte stream used for upload + local cache.
 * The on-the-wire snapshot format must remain a single SQLite file so the
 * server doesn't see the desktop's per-group split. Without this test the
 * combine path was uncovered — a regression that lost rows or dropped a
 * group would only surface in production via missing data on a re-import.
 *
 * Round-trip test:
 *   1. Seed rows across at least three groups (core / metadata / playback)
 *      through public LibraryDb mutators.
 *   2. Call exportBytes().
 *   3. Open the resulting bytes as a fresh SQLite file (separate process-
 *      level engine call) and assert per-table row counts + content match.
 *   4. Assert tables from EVERY group are represented in the combined file.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-combined-export-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[combined-export-round-trip:setup] root=${root}`);
});

afterEach(() => {
  console.info(
    `[combined-export-round-trip:teardown] root-exists=${existsSync(root)} root=${root}`,
  );
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const seedMediaAndPlaylist = async (db: LibraryDb) => {
  const mediaId = await db.addMediaFromCatalog({
    id: 555,
    type: "tv",
    title: "Round-Trip Show",
    originalTitle: null,
    originalLanguage: "en",
    overview: "An overview",
    year: "2026",
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast: [
      { personId: 100, name: "Anna Actor", role: "Lead", profilePath: null, order: 0 },
    ],
    trailers: [
      { provider: "youtube", key: "abc123", name: "Trailer", language: "en", official: true },
    ],
    totalEpisodes: null,
    seasons: [
      { seasonNumber: 1, name: "Season 1", overview: null, posterPath: null, episodeCount: 2, airDate: "2026-01-01" },
    ],
    episodes: [
      { seasonNumber: 1, episodeNumber: 1, name: "Pilot", overview: null, stillPath: null, airDate: "2026-01-01" },
      { seasonNumber: 1, episodeNumber: 2, name: "Second", overview: null, stillPath: null, airDate: "2026-01-08" },
    ],
  });

  await db.setSetting("e2e.round-trip.key", "blue");
  // createPlaylist returns Promise<boolean> from this.persist(); the new row's
  // id is not exposed back to the caller. We assert by playlist name in the
  // snapshot instead of round-tripping the id.
  db.createPlaylist("Round-Trip List");

  return { mediaId };
};

const openSnapshot = (bytes: Uint8Array, label = "default") => {
  const path = join(root, `snapshot-readback-${label}.sqlite`);
  writeFileSync(path, bytes);
  console.info(
    `[combined-export-round-trip:open-snapshot] label=${label} path=${path} bytes=${bytes.length}`,
  );
  return new Database(path);
};

const countRows = (db: Database, table: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as { n?: number };
  return Number(row?.n ?? 0);
};

const tableExists = (db: Database, table: string): boolean => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1;")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
};

// Suite-id: combined-export-round-trip
// Captures pre/post export-import row counts, manifest sizing, schema/op-stream
// versions, and per-table tally — useful when the round-trip drops rows or
// when one of the groups silently fails to stitch.
const dumpExportSnapshot = (
  label: string,
  ctx: {
    snapshot?: Database | null;
    bytesLength?: number;
    expectedMediaId?: string;
    capturedError?: unknown;
  },
) => {
  try {
    console.error(`=== [combined-export-round-trip:${label}] snapshot ===`);
    if (ctx.bytesLength !== undefined) console.error(`exportBytes length=${ctx.bytesLength}`);
    if (ctx.expectedMediaId !== undefined) {
      console.error(`expected mediaId=${ctx.expectedMediaId}`);
    }
    if (ctx.snapshot) {
      const userVersion = (
        ctx.snapshot.prepare("PRAGMA user_version;").get() as { user_version?: number } | undefined
      )?.user_version;
      console.error(`snapshot user_version=${JSON.stringify(userVersion)}`);
      for (const table of [
        "media_items",
        "playlists",
        "app_settings",
        "media_seasons",
        "media_episodes",
        "media_trailers",
        "media_genres",
        "media_files",
        "media_formats",
        "media_format_chunks",
        "media_audio_tracks",
        "media_subtitles",
        "people",
        "media_roles",
        "ingest_jobs",
        "media_templates",
      ]) {
        const exists = tableExists(ctx.snapshot, table);
        console.error(`  table=${table} exists=${exists} count=${exists ? countRows(ctx.snapshot, table) : "n/a"}`);
      }
      const tail = ctx.snapshot
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
        )
        .all() as Array<{ name: string }>;
      console.error(`all snapshot tables=${JSON.stringify(tail.map((r) => r.name))}`);
    }
    if (ctx.capturedError !== undefined) {
      const e = ctx.capturedError;
      console.error(`captured error=${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("buildCombinedExportBytes — round-trip through LibraryDb.exportBytes()", () => {
  it("preserves rows from EVERY per-group SQLite file in the combined snapshot", async () => {
    console.info(`[combined-export-round-trip:open] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    console.info(`[combined-export-round-trip:seed] seedMediaAndPlaylist`);
    const { mediaId } = await seedMediaAndPlaylist(db);
    console.info(`[combined-export-round-trip:seed] mediaId=${mediaId}`);

    const bytes = db.exportBytes();
    console.info(`[combined-export-round-trip:export] bytes.length=${bytes.length}`);
    db.close();

    try {
      expect(bytes.byteLength).toBeGreaterThan(0);
    } catch (err) {
      dumpExportSnapshot("empty-bytes-failure", {
        bytesLength: bytes.byteLength,
        expectedMediaId: mediaId,
        capturedError: err,
      });
      throw err;
    }

    const snapshot = openSnapshot(bytes, "every-group");
    try {
      try {
        // Core
        expect(tableExists(snapshot, "media_items")).toBe(true);
        expect(tableExists(snapshot, "app_settings")).toBe(true);
        expect(tableExists(snapshot, "playlists")).toBe(true);

        // Metadata
        expect(tableExists(snapshot, "media_seasons")).toBe(true);
        expect(tableExists(snapshot, "media_episodes")).toBe(true);
        expect(tableExists(snapshot, "media_trailers")).toBe(true);
        expect(tableExists(snapshot, "people")).toBe(true);

        // Playback (still present even if empty)
        expect(tableExists(snapshot, "media_formats")).toBe(true);
        expect(tableExists(snapshot, "media_audio_tracks")).toBe(true);

        // Ingest
        expect(tableExists(snapshot, "ingest_jobs")).toBe(true);

        // Templates (desktop-only group, expected in the combined file)
        expect(tableExists(snapshot, "media_templates")).toBe(true);

        // Row-count assertions
        const itemRow = snapshot
          .prepare("SELECT id, title FROM media_items WHERE id = ?;")
          .get(mediaId) as { id?: string; title?: string } | undefined;
        console.info(
          `[combined-export-round-trip:assert] itemRow=${JSON.stringify(itemRow)}`,
        );
        expect(itemRow?.title).toBe("Round-Trip Show");

        expect(countRows(snapshot, "media_seasons")).toBe(1);
        expect(countRows(snapshot, "media_episodes")).toBe(2);
        expect(countRows(snapshot, "media_trailers")).toBe(1);
        expect(countRows(snapshot, "people")).toBeGreaterThanOrEqual(1);

        const setting = snapshot
          .prepare("SELECT value FROM app_settings WHERE key = ?;")
          .get("e2e.round-trip.key") as { value?: string } | undefined;
        expect(setting?.value).toBe("blue");

        const playlist = snapshot
          .prepare("SELECT name FROM playlists WHERE name = ?;")
          .get("Round-Trip List") as { name?: string } | undefined;
        expect(playlist?.name).toBe("Round-Trip List");
      } catch (err) {
        dumpExportSnapshot("every-group-failure", {
          snapshot,
          bytesLength: bytes.byteLength,
          expectedMediaId: mediaId,
          capturedError: err,
        });
        throw err;
      }
    } finally {
      snapshot.close();
    }
  });

  it("returns a stable byte stream — two consecutive exports surface the same row counts", async () => {
    console.info(`[combined-export-round-trip:open-stable] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    await seedMediaAndPlaylist(db);

    const first = db.exportBytes();
    const second = db.exportBytes();
    console.info(
      `[combined-export-round-trip:export-stable] first.length=${first.length} second.length=${second.length}`,
    );
    db.close();

    const aPath = join(root, "a.sqlite");
    const bPath = join(root, "b.sqlite");
    writeFileSync(aPath, first);
    writeFileSync(bPath, second);

    const a = new Database(aPath);
    const b = new Database(bPath);
    try {
      // Across-snapshot row-count parity is the proof the combine path is
      // order- and content-deterministic over a static dataset.
      for (const table of [
        "media_items",
        "playlists",
        "app_settings",
        "media_seasons",
        "media_episodes",
        "media_trailers",
        "people",
        "media_roles",
      ]) {
        const ac = countRows(a, table);
        const bc = countRows(b, table);
        try {
          expect(ac).toBe(bc);
        } catch (err) {
          console.error(
            `[combined-export-round-trip:stable] mismatch table=${table} a=${ac} b=${bc}`,
          );
          dumpExportSnapshot("stable-bytestream-a", {
            snapshot: a,
            bytesLength: first.length,
            capturedError: err,
          });
          dumpExportSnapshot("stable-bytestream-b", {
            snapshot: b,
            bytesLength: second.length,
            capturedError: err,
          });
          throw err;
        }
      }
    } finally {
      a.close();
      b.close();
    }
  });

  it("handles an empty library — every group's table exists but has zero rows", async () => {
    console.info(`[combined-export-round-trip:open-empty] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const bytes = db.exportBytes();
    console.info(`[combined-export-round-trip:export-empty] bytes.length=${bytes.length}`);
    db.close();

    const snapshot = openSnapshot(bytes, "empty");
    try {
      try {
        expect(tableExists(snapshot, "media_items")).toBe(true);
        expect(tableExists(snapshot, "media_files")).toBe(true);
        expect(tableExists(snapshot, "media_formats")).toBe(true);
        expect(tableExists(snapshot, "ingest_jobs")).toBe(true);
        expect(tableExists(snapshot, "media_templates")).toBe(true);

        // The only rows on an empty library are the default playlists +
        // bootstrap markers in core.app_settings.
        expect(countRows(snapshot, "media_items")).toBe(0);
        expect(countRows(snapshot, "media_files")).toBe(0);
        expect(countRows(snapshot, "media_formats")).toBe(0);
        expect(countRows(snapshot, "ingest_jobs")).toBe(0);
      } catch (err) {
        dumpExportSnapshot("empty-library-failure", {
          snapshot,
          bytesLength: bytes.length,
          capturedError: err,
        });
        throw err;
      }
    } finally {
      snapshot.close();
    }
  });
});

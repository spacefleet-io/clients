/**
 * @bugfix existing-media-source-delete-button-shows
 * @regression-proof
 *
 * `getMediaDetails` dropped `is_source` from its format projection — the
 * Drizzle `.select({...})` and the `directFormats` map both omitted it, even
 * though `listMediaFormats` (the runtime delete-guard's read path) carried it.
 *
 * Consequence: `selectedDetails.formats[].isSource` was always `undefined` in
 * the renderer, so the MediaDetailsDialog quality chips (`format.isSource ===
 * true ? null : <delete button>`) showed a delete button on EVERY chip,
 * including the source/highest quality — even when the DB row was correctly
 * `is_source = 1`. The user could click delete on their only/highest copy
 * (the runtime guard would refuse, but the button should never have appeared).
 *
 * Pre-fix: `getMediaDetails(id).formats.find(1080p).isSource === undefined`.
 * Post-fix: it equals the DB row's flag (`true` for the source row).
 *
 * library-db-runtime uses Bun's test runner + real better-sqlite3, so this
 * drives the actual projection end-to-end.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

const SUITE = "get-media-details-is-source";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-getmd-issource-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[${SUITE}:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[${SUITE}:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const addMovie = (db: LibraryDb, id: number, title: string) =>
  db.addMediaFromCatalog({
    id,
    type: "movie",
    title,
    originalTitle: null,
    originalLanguage: "en",
    overview: null,
    year: "2026",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast: [],
    trailers: [],
    seasons: [],
    episodes: [],
    totalEpisodes: 0,
  } as any);

// On assertion failure, dump the full media-details projection so the exact
// shape of each format row (the thing the renderer's delete-guard reads) is
// visible offline. Wrapped in try/catch so a dump failure can never mask the
// real assertion failure. CI can grep the block via the `=== [...] ===`
// delimiters.
const dumpIsSourceSnapshot = (db: LibraryDb, label: string, mediaId: string) => {
  try {
    const details = db.getMediaDetails(mediaId);
    const formats = details?.formats ?? [];
    const projection = formats.map((f) => ({
      quality: f.quality,
      isSource: f.isSource,
      isSourceType: typeof f.isSource,
    }));
    console.error(`=== [${SUITE}:${label}] media-details snapshot ===`);
    console.error(`mediaId=${mediaId} formats.length=${formats.length}`);
    console.error(`format isSource projection: ${JSON.stringify(projection)}`);
    console.error(`raw formats:\n${JSON.stringify(formats, null, 2)}`);
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("@bugfix @regression-proof getMediaDetails carries is_source to the renderer", () => {
  it("projects isSource onto each format so the source chip can hide its delete button", async () => {
    console.info(`[${SUITE}:exec] opening LibraryDb (local, sync off)`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    const mediaId = await addMovie(db, 9101, "Source Flag Movie");
    const fileId = await db.linkFileToMedia(mediaId, "source-flag.mkv");
    console.info(`[${SUITE}:exec] mediaId=${mediaId} fileId=${fileId}; adding 1080p(source) + 360p(non-source)`);

    // The source-extracted highest quality — flagged.
    await db.addMediaFormat(
      mediaId,
      fileId,
      "1080p",
      "h264",
      800,
      [{ key: "c-1080-1", sizeBytes: 1000, startSeconds: 0 }],
      5000,
      { isSource: true }
    );
    // A transcoded variant — not the source.
    await db.addMediaFormat(
      mediaId,
      fileId,
      "360p",
      "h264",
      100,
      [{ key: "c-360-1", sizeBytes: 400, startSeconds: 0 }],
      800,
      { isSource: false }
    );

    try {
      const details = db.getMediaDetails(mediaId);
      const formats = details?.formats ?? [];
      const dump = formats.map((f) => ({ quality: f.quality, isSource: f.isSource }));
      console.info(`[${SUITE}:check] getMediaDetails formats=${JSON.stringify(dump)}`);

      const f1080 = formats.find((f) => f.quality === "1080p");
      const f360 = formats.find((f) => f.quality === "360p");

      expect(f1080).toBeDefined();
      expect(f360).toBeDefined();
      // Pre-fix: both were `undefined` (projection dropped is_source) → the
      // delete button rendered on the source chip.
      expect(f1080?.isSource).toBe(true);
      expect(f360?.isSource).toBe(false);
      // Strictly boolean (not the raw integer) — the chip checks `=== true`.
      expect(typeof f1080?.isSource).toBe("boolean");
    } catch (err) {
      console.error(`[${SUITE}:fail] getMediaDetails projection missing/incorrect isSource`);
      dumpIsSourceSnapshot(db, "source-flag-fail", mediaId);
      throw err;
    } finally {
      db.close();
    }
  });

  it("defaults isSource to false for an unflagged format (legacy/v1-op-stream shape)", async () => {
    console.info(`[${SUITE}:exec-unflagged] opening LibraryDb`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    const mediaId = await addMovie(db, 9102, "Unflagged Movie");
    const fileId = await db.linkFileToMedia(mediaId, "unflagged.mkv");
    // The only quality, added WITHOUT a source flag — mirrors a pre-Phase-2 /
    // v1-op-stream row before any backfill heals it.
    await db.addMediaFormat(
      mediaId,
      fileId,
      "1080p",
      "h264",
      800,
      [{ key: "c-unflagged-1", sizeBytes: 1000, startSeconds: 0 }],
      5000,
      { isSource: false }
    );

    try {
      const f = db.getMediaDetails(mediaId)?.formats.find((x) => x.quality === "1080p");
      console.info(`[${SUITE}:check-unflagged] isSource=${String(f?.isSource)} type=${typeof f?.isSource}`);
      // The projection must still return a real boolean (false), never undefined.
      expect(f).toBeDefined();
      expect(f?.isSource).toBe(false);
      expect(typeof f?.isSource).toBe("boolean");
    } catch (err) {
      console.error(`[${SUITE}:fail-unflagged] unflagged format isSource not a real boolean-false`);
      dumpIsSourceSnapshot(db, "unflagged-fail", mediaId);
      throw err;
    } finally {
      db.close();
    }
  });
});

/**
 * @test-id LIB-SET-PROGRESS-CLOCK-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 *
 * Watching never advances a media's details clock. `media_items.updated_at` is
 * what the LIB-SYNC-08 guard compares an incoming `media.upsert` against;
 * progress has its own clock (`last_watched_at`). If a local `setProgress`
 * bumped `updated_at`, a device that just watched a title would ignore a newer
 * details edit (new formats, files, episodes) made elsewhere a moment earlier.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

const log = (phase: string, data?: unknown) =>
  console.info(`[LIB-SET-PROGRESS-CLOCK-001] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-progress-clock-"));
  process.env.SF_USER_DATA_PATH = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

describe("setProgress and the details clock", () => {
  // @req LIB-SYNC-08[badger-desktop]
  // @req LIB-SYNC-08[runtime]
  it("saving progress moves progress and last_watched_at but leaves updated_at alone", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    try {
      const mediaId = await db.addMediaFromCatalog({
        id: 25_401,
        type: "movie",
        title: "Progress Clock Movie",
        originalTitle: null,
        originalLanguage: "en",
        overview: "overview",
        year: "2026",
        posterPath: null,
        backdropPath: null,
        genres: [],
        cast: [],
        trailers: [],
        totalEpisodes: null,
        seasons: [],
        episodes: [],
      });
      const before = db.getMediaDetails(mediaId);
      log("state:before", { updatedAt: before?.updatedAt, lastWatchedAt: before?.lastWatchedAt, progressPct: before?.progressPct });

      await db.setProgress(mediaId, 37);
      const after = db.getMediaDetails(mediaId);
      log("state:after", { updatedAt: after?.updatedAt, lastWatchedAt: after?.lastWatchedAt, progressPct: after?.progressPct });

      expect(after?.progressPct).toBe(37);
      expect(after?.lastWatchedAt).not.toBeNull();
      expect(after?.updatedAt).toBe(before?.updatedAt);
    } finally {
      db.close();
    }
  }, 30_000);
});

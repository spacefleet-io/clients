/**
 * @test-id LIB-TV-SHOW-WATCHED-PCT-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 * @bugfix @regression-proof Chris 2026-10-29 (TV testing): "a tv show's \"watched\" percentage shouldn't be counted off
 * the episodes uploaded to the vault but rather out of all available episodes".
 *
 * @req LIB-PROG-01
 * A show's watched percentage is the summed watched part of its regular episodes over every episode the show has aired:
 * specials (season 0) and episodes that have not aired yet never count, whatever the catalog's episode count says, and the
 * episodes in the vault never set the total while the metadata has one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

const log = (phase: string, data?: unknown) =>
  console.info(`[tv-show-watched-pct] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-show-pct-"));
  process.env.SF_USER_DATA_PATH = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

type SeedEpisode = { seasonNumber: number; episodeNumber: number; airDate: string | null };

const seedShow = (db: LibraryDb, catalogId: number, episodes: SeedEpisode[], totalEpisodes: number | null) =>
  db.addMediaFromCatalog({
    id: catalogId,
    type: "tv",
    title: `Show ${catalogId}`,
    originalTitle: null,
    originalLanguage: "en",
    overview: null,
    year: "2020",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast: [],
    trailers: [],
    seasons: [],
    episodes: episodes.map((episode) => ({ ...episode, name: `S${episode.seasonNumber}E${episode.episodeNumber}`, overview: null, stillPath: null })),
    totalEpisodes,
  } as unknown as Parameters<LibraryDb["addMediaFromCatalog"]>[0]);

// 3 specials, 10 aired regular episodes, 2 announced for next year: the catalog's number_of_episodes says 12.
const RUN: SeedEpisode[] = [
  ...[1, 2, 3].map((episodeNumber) => ({ seasonNumber: 0, episodeNumber, airDate: "2019-12-01" })),
  ...Array.from({ length: 10 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1, airDate: `2020-01-${String(i + 1).padStart(2, "0")}` })),
  ...[1, 2].map((episodeNumber) => ({ seasonNumber: 2, episodeNumber, airDate: "2099-01-01" })),
];

const episodeId = (db: LibraryDb, mediaId: string, seasonNumber: number, episodeNumber: number) =>
  String(db.getMediaDetails(mediaId)?.episodes.find((e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber)?.id);

describe("LIB-PROG-01 — a show's watched % counts every aired episode", () => {
  it("@bugfix @regression-proof 10 aired, 2 watched → 20% (not out of the catalog's 12 with unaired, nor 15 listed with specials)", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    try {
      for (const [index, totalEpisodes] of [12, null].entries()) {
        const mediaId = await seedShow(db, 29_100 + index, RUN, totalEpisodes);
        await db.setProgress(mediaId, 100, episodeId(db, mediaId, 1, 1));
        await db.setProgress(mediaId, 100, episodeId(db, mediaId, 1, 2));
        // A watched special must not move the show's percentage.
        await db.setProgress(mediaId, 100, episodeId(db, mediaId, 0, 1));
        const details = db.getMediaDetails(mediaId);
        const row = db.listMedia("tv").find((item) => String(item.id) === mediaId);
        log("result", { totalEpisodes, details: details?.progressPct, list: row?.progressPct });
        expect(details?.progressPct).toBeCloseTo(20, 9);
        expect(row?.progressPct).toBeCloseTo(20, 9);
      }
    } finally {
      db.close();
    }
  }, 60_000);

  it("uses the catalog's episode count when the episode list has no air dates", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    try {
      const undated = Array.from({ length: 4 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1, airDate: null }));
      const mediaId = await seedShow(db, 29_200, undated, 236);
      await db.setProgress(mediaId, 100, episodeId(db, mediaId, 1, 1));
      const pct = db.getMediaDetails(mediaId)?.progressPct;
      log("undated", { pct });
      expect(pct).toBeCloseTo(100 / 236, 9);
    } finally {
      db.close();
    }
  }, 60_000);
});

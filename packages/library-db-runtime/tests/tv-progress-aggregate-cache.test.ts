/**
 * @test-id LIB-TV-PROGRESS-AGGREGATE-CACHE-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 * @bugfix @regression-proof issue #25 (playback costs more than plain mpv); the
 * "cache-invalidation guard" tests pin behavior that already held and only
 * guard the cache against going stale.
 *
 * Profile of the runtime process during playback (c023, ~2.8 s CPU over a
 * 16 s window): `getTvProgressAggregate` inside every TV episode `setProgress`
 * was ~6-8 % of the samples. Every save selected the show's episode ids,
 * built one `episode_resume_v1:<id>` key per episode, selected that many
 * app_settings rows with an N-parameter IN list and JSON-parsed each value —
 * to recompute a sum that moved by one episode.
 *
 * Contract:
 *   1. The aggregate is cached per show and kept current across the
 *      `setProgress` writes themselves: N saves of an already-seen episode
 *      read the episode / setting tables ZERO more times.
 *   2. Any other write to the library files (episodes replaced, a resume
 *      setting written by sync or `setSetting`, total episodes changed, a
 *      foreign connection) invalidates it — the result is always equal to
 *      recomputing from the rows (property test below).
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

const log = (phase: string, data?: unknown) =>
  console.info(`[tv-progress-aggregate-cache] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-tv-aggregate-"));
  process.env.SF_USER_DATA_PATH = root;
  log("setup", { root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

type Stmt = { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
type Handle = { prepare(sql: string): Stmt; filename: string };
// Test-only peek at private state (no public accessor for the group handles).
type Internals = {
  coreDb: Handle;
  metadataDb: Handle;
  tvProgressStates: Map<string, unknown>;
  tvProgressStamp: unknown;
  parseEpisodeResumeSetting(raw: string | null | undefined): unknown;
};
const internalsOf = (db: LibraryDb) => db as unknown as Internals;

const openDb = async () => {
  const db = await LibraryDb.openLocal("token", "key");
  db.setSyncEnabled(false);
  return db;
};

const seedShow = (db: LibraryDb, tmdbId: number, episodeCount: number, totalEpisodes: number | null) =>
  db.addMediaFromTmdb({
    id: tmdbId,
    type: "tv",
    title: `Aggregate Show ${tmdbId}`,
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
    episodes: Array.from({ length: episodeCount }, (_, index) => ({
      seasonNumber: 1 + Math.floor(index / 10),
      episodeNumber: 1 + (index % 10),
      name: `Episode ${index + 1}`,
      overview: null,
      stillPath: null,
      airDate: null,
    })),
    totalEpisodes,
  } as unknown as Parameters<LibraryDb["addMediaFromTmdb"]>[0]);

const episodeIdsOf = (db: LibraryDb, mediaId: string) =>
  (db.getMediaDetails(mediaId)?.episodes ?? []).map((episode) => String(episode.id));

/** Counts the statements the aggregate's DB reads are made of, on both group handles. */
const countAggregateReads = (db: LibraryDb) => {
  const internals = internalsOf(db);
  const counter = { episodeSelects: 0, settingInSelects: 0 };
  for (const handle of [internals.coreDb, internals.metadataDb]) {
    const original = handle.prepare.bind(handle);
    handle.prepare = (sql: string) => {
      if (/select "id"[^;]* from "media_episodes"/i.test(sql)) counter.episodeSelects += 1;
      if (/from "app_settings"[^;]* in \(/i.test(sql)) counter.settingInSelects += 1;
      return original(sql);
    };
  }
  return counter;
};

/** Independent re-statement of the aggregate, straight from the rows (the pre-cache semantics). */
const referenceAggregate = (db: LibraryDb, mediaId: string) => {
  const internals = internalsOf(db);
  const media = internals.coreDb.prepare("SELECT total_episodes AS total FROM media_items WHERE id = ?;").get(mediaId) as
    | { total: number | null }
    | null;
  const episodes = internals.metadataDb.prepare("SELECT id FROM media_episodes WHERE media_id = ?;").all(mediaId) as Array<{ id: string }>;
  if (episodes.length === 0) return null;
  const configured = Number(media?.total);
  const totalEpisodes = Number.isFinite(configured) && configured > 0 ? configured : episodes.length;
  const keys = episodes.map((episode) => `episode_resume_v1:${episode.id}`).sort();
  let total = 0;
  let latest: string | null = null;
  for (const key of keys) {
    const row = internals.coreDb.prepare("SELECT value FROM app_settings WHERE key = ?;").get(key) as { value: string | null } | null;
    if (!row?.value) continue;
    let parsed: { progressPct?: unknown; updatedAt?: unknown };
    try {
      parsed = JSON.parse(row.value) as { progressPct?: unknown; updatedAt?: unknown };
    } catch {
      continue;
    }
    const value = Number(parsed.progressPct);
    if (!Number.isFinite(value)) continue;
    total += Math.max(0, Math.min(100, value));
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
    if (updatedAt && (!latest || updatedAt > latest)) latest = updatedAt;
  }
  return { progressPct: Math.max(0, Math.min(100, total / totalEpisodes)), lastWatchedAt: latest };
};

describe("issue #25 — TV episode progress saves do not recompute the show aggregate from the tables", () => {
  it("@bugfix @regression-proof 60 saves of one episode read the episode and setting tables at most once", async () => {
    const db = await openDb();
    try {
      const mediaId = await seedShow(db, 25_301, 200, null);
      const episodeIds = episodeIdsOf(db, mediaId);
      expect(episodeIds).toHaveLength(200);
      // Settings of the other episodes: the aggregate sums them on every save.
      for (const id of episodeIds.slice(1, 120)) await db.setProgress(mediaId, 50, id);
      const counter = countAggregateReads(db);

      const started = performance.now();
      for (let index = 0; index < 60; index += 1) {
        await db.setProgress(mediaId, 10 + index * 0.5, episodeIds[0], { positionSeconds: index * 30, durationSeconds: 1500 });
      }
      const ms = performance.now() - started;
      log("result:burst", { saves: 60, ...counter, ms: Math.round(ms) });

      // Pre-cache: 60 episode selects + 60 N-parameter IN selects.
      expect(counter.episodeSelects).toBeLessThanOrEqual(1);
      expect(counter.settingInSelects).toBeLessThanOrEqual(1);
      // 119 episodes at 50 % + this one at 39.5 %, over 200 episodes.
      const aggregate = db.getMediaDetails(mediaId);
      expect(aggregate?.progressPct).toBeCloseTo((119 * 50 + 39.5) / 200, 9);
    } finally {
      db.close();
    }
  }, 60_000);

  it("cache-invalidation guard: cached aggregate equals the rows-derived reference across random episode sets, saves and foreign writes", async () => {
    // Deterministic PRNG so a failure reproduces from the logged seed.
    let seed = 0x25a11;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const db = await openDb();
    try {
      const shapes: Array<{ episodes: number; total: number | null }> = [
        { episodes: 0, total: null },
        { episodes: 1, total: 1 },
        { episodes: 3, total: null },
        { episodes: 7, total: 12 },
        { episodes: 12, total: 5 },
        { episodes: 25, total: 0 },
        { episodes: 40, total: null },
      ];
      let comparisons = 0;
      let cacheHits = 0;
      for (const [shapeIndex, shape] of shapes.entries()) {
        const tmdbId = 25_400 + shapeIndex;
        let mediaId = await seedShow(db, tmdbId, shape.episodes, shape.total);
        let episodeIds = episodeIdsOf(db, mediaId);
        log("shape", { shapeIndex, ...shape, seed });

        const check = (label: string) => {
          const expected = referenceAggregate(db, mediaId);
          const fromDetails = db.getMediaDetails(mediaId);
          const fromList = db.listMedia("tv").find((row) => String(row.id) === mediaId);
          if (expected) {
            expect(fromDetails?.progressPct, `${label}: details.progressPct`).toBeCloseTo(expected.progressPct, 9);
            expect(fromList?.progressPct, `${label}: list.progressPct`).toBeCloseTo(expected.progressPct, 9);
            if (expected.lastWatchedAt) {
              expect(fromDetails?.lastWatchedAt, `${label}: details.lastWatchedAt`).toBe(expected.lastWatchedAt);
              expect(fromList?.lastWatchedAt, `${label}: list.lastWatchedAt`).toBe(expected.lastWatchedAt);
            }
          }
          comparisons += 1;
          // Every 4th check the cache (which several saves have patched in
          // place since its last load) must agree with a cold recompute bit for bit.
          if (comparisons % 4 !== 0) return;
          const warm = db.getMediaDetails(mediaId);
          internalsOf(db).tvProgressStates.clear();
          internalsOf(db).tvProgressStamp = null;
          const cold = db.getMediaDetails(mediaId);
          expect(warm?.progressPct, `${label}: warm vs cold progressPct`).toBe(cold?.progressPct);
          expect(warm?.lastWatchedAt, `${label}: warm vs cold lastWatchedAt`).toBe(cold?.lastWatchedAt);
        };

        check("initial");
        for (let step = 0; step < 40; step += 1) {
          const roll = random();
          const episodeId = episodeIds.length ? episodeIds[Math.floor(random() * episodeIds.length)] : undefined;
          if (roll < 0.6 && episodeId) {
            // Save, sometimes wild values (negative, >100, tiny, zero).
            const pct = [0, 0.00001, 33.3333, 100, 150, -5, random() * 100][Math.floor(random() * 7)];
            await db.setProgress(mediaId, pct, episodeId);
            cacheHits += 1;
          } else if (roll < 0.7 && episodeId) {
            // Foreign write of a resume setting: valid, garbage JSON, no pct, empty.
            const values = [
              JSON.stringify({ progressPct: 77, updatedAt: "2099-01-01T00:00:00.000Z" }),
              "{not json",
              JSON.stringify({ updatedAt: "2098-01-01T00:00:00.000Z" }),
              "",
            ];
            await db.setSetting(`episode_resume_v1:${episodeId}`, values[Math.floor(random() * values.length)]);
          } else if (roll < 0.8) {
            // Episodes replaced (new ids; old resume settings become orphans).
            mediaId = await seedShow(db, tmdbId, Math.max(0, shape.episodes + Math.floor(random() * 5) - 2), shape.total);
            episodeIds = episodeIdsOf(db, mediaId);
          } else if (roll < 0.9) {
            // A movie-style progress save elsewhere touches core without touching the aggregate.
            await db.setProgress(mediaId, random() * 100);
          } else {
            // Re-read between writes so cached reads interleave with the writes.
            check(`step ${step} read`);
          }
          check(`shape ${shapeIndex} step ${step}`);
        }
      }
      log("result:property", { comparisons, saves: cacheHits });
      expect(comparisons).toBeGreaterThan(200);
    } finally {
      db.close();
    }
  }, 120_000);

  it("cache-invalidation guard: a write from another connection to the library files invalidates the cached aggregate", async () => {
    const db = await openDb();
    try {
      const mediaId = await seedShow(db, 25_501, 4, null);
      const [first, second] = episodeIdsOf(db, mediaId);
      await db.setProgress(mediaId, 40, first);
      expect(db.getMediaDetails(mediaId)?.progressPct).toBeCloseTo(10, 9);

      // What the combined-export / recovery tooling or a second process would do.
      const internals = internalsOf(db);
      const foreign = new Database(internals.coreDb.filename);
      try {
        foreign
          .prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);")
          .run(`episode_resume_v1:${second}`, JSON.stringify({ progressPct: 80, updatedAt: "2099-02-02T00:00:00.000Z" }), "2099-02-02T00:00:00.000Z");
      } finally {
        foreign.close();
      }
      const media = db.getMediaDetails(mediaId);
      log("result:foreign-write", { progressPct: media?.progressPct, lastWatchedAt: media?.lastWatchedAt });
      expect(media?.progressPct).toBeCloseTo((40 + 80) / 4, 9);
      expect(media?.lastWatchedAt).toBe("2099-02-02T00:00:00.000Z");
    } finally {
      db.close();
    }
  }, 30_000);

  it("@bugfix @regression-proof a foreign commit landing between the pre-write stamp and the save's re-stamp is not absorbed as the save's own write", async () => {
    const db = await openDb();
    try {
      const mediaId = await seedShow(db, 25_502, 4, null);
      const [first, second] = episodeIdsOf(db, mediaId);
      await db.setProgress(mediaId, 40, first); // loads + caches the show

      // Another process commits `second`'s resume exactly after this save's own
      // upsert and before its re-stamp: parseEpisodeResumeSetting runs in that gap.
      const internals = internalsOf(db);
      const parse = internals.parseEpisodeResumeSetting.bind(db);
      let injected = false;
      internals.parseEpisodeResumeSetting = (raw: string | null | undefined) => {
        if (!injected) {
          injected = true;
          const foreign = new Database(internals.coreDb.filename);
          try {
            foreign
              .prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);")
              .run(`episode_resume_v1:${second}`, JSON.stringify({ progressPct: 80, updatedAt: "2099-03-03T00:00:00.000Z" }), "2099-03-03T00:00:00.000Z");
          } finally {
            foreign.close();
          }
        }
        return parse(raw);
      };

      await db.setProgress(mediaId, 60, first);
      expect(injected).toBe(true);
      const media = db.getMediaDetails(mediaId);
      log("result:foreign-commit-mid-save", { progressPct: media?.progressPct, lastWatchedAt: media?.lastWatchedAt });
      // Stale cache (pre-fix) would report 60 / 4 = 15 and miss the foreign episode.
      expect(media?.progressPct).toBeCloseTo((60 + 80) / 4, 9);
      expect(media?.lastWatchedAt).toBe("2099-03-03T00:00:00.000Z");
    } finally {
      db.close();
    }
  }, 30_000);
});

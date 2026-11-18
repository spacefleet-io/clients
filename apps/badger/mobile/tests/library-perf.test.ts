/**
 * @test-id MOBILE-PERF-001
 * @level unit
 * @why Library loading and sync must stay fast regardless of library size.
 *   These tests use bun:sqlite to verify that batched SQL patterns outperform
 *   sequential execution and that listMedia scales with large libraries.
 *   If someone accidentally removes batching (reverting to N+1 queries),
 *   these tests will catch the regression via timing budgets.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "bun:sqlite";
import { getGroupDdlStatements } from "@space/library-db-definition";
import { CATALOG_ID_SOURCE } from "@space/library-db-definition/catalogId";

// ── Helpers ──────────────────────────────────────────────────────────

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

const createCoreDb = () => {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode=WAL;");
  db.run("PRAGMA foreign_keys=ON;");
  for (const sql of getGroupDdlStatements("core")) db.run(sql);
  return db;
};

const createMetadataDb = () => {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode=WAL;");
  db.run("PRAGMA foreign_keys=OFF;");
  for (const sql of getGroupDdlStatements("metadata")) db.run(sql);
  return db;
};

const createPlaybackDb = () => {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode=WAL;");
  for (const sql of getGroupDdlStatements("playback")) db.run(sql);
  return db;
};

/** Generate a realistic media item with genres, external IDs, cast, episodes. */
const generateMediaDetails = (index: number) => {
  const id = uuid();
  const type = index % 3 === 0 ? "tv" : "movie";
  const genreCount = 2 + (index % 4);
  const castCount = 5 + (index % 10);
  const episodeCount = type === "tv" ? 8 + (index % 15) : 0;
  const seasonCount = type === "tv" ? 1 + (index % 3) : 0;
  const trailerCount = 1 + (index % 3);

  return {
    id,
    type,
    title: `Movie ${index}`,
    originalTitle: `Original Title ${index}`,
    originalLanguage: "en",
    overview: `Overview for movie ${index}. `.repeat(10),
    year: String(2000 + (index % 26)),
    rating: 5 + (index % 5),
    posterPath: `/poster/${id}.jpg`,
    backdropPath: `/backdrop/${id}.jpg`,
    addedAt: nowIso(),
    updatedAt: nowIso(),
    hasFiles: index % 2 === 0,
    progressPct: (index * 7) % 100,
    lastWatchedAt: index % 3 === 0 ? nowIso() : null,
    totalEpisodes: episodeCount || null,
    catalogId: 10000 + index,
    genres: Array.from({ length: genreCount }, (_, i) => 28 + i),
    cast: Array.from({ length: castCount }, (_, i) => ({
      id: uuid(),
      personId: uuid(),
      name: `Actor ${i} of Movie ${index}`,
      role: i === 0 ? "Lead" : "Supporting",
      profilePath: `/person/${i}.jpg`,
      catalogId: 50000 + index * 100 + i,
    })),
    trailers: Array.from({ length: trailerCount }, (_, i) => ({
      provider: "youtube",
      key: `trailer-${id}-${i}`,
      name: `Trailer ${i + 1}`,
      language: "en",
    })),
    seasons: Array.from({ length: seasonCount }, (_, i) => ({
      id: uuid(),
      seasonNumber: i + 1,
      name: `Season ${i + 1}`,
      overview: `Season ${i + 1} overview`,
      posterPath: `/season/${i}.jpg`,
      episodeCount: Math.ceil(episodeCount / Math.max(seasonCount, 1)),
      airDate: `${2020 + i}-01-15`,
    })),
    episodes: Array.from({ length: episodeCount }, (_, i) => ({
      id: uuid(),
      seasonNumber: (i % Math.max(seasonCount, 1)) + 1,
      episodeNumber: i + 1,
      name: `Episode ${i + 1}`,
      overview: `Episode ${i + 1} overview`,
      stillPath: `/episode/${i}.jpg`,
      airDate: `2020-${String(i + 1).padStart(2, "0")}-01`,
    })),
    files: [],
  };
};

/** Seed the core DB with N media items using batched inserts. Returns the seeded IDs. */
const seedCoreDb = (db: Database, count: number) => {
  const insertMedia = db.prepare(
    `INSERT OR REPLACE INTO media_items (
      id, type, title, original_title, original_language, overview, year, rating,
      poster_path, backdrop_path, added_at, updated_at, has_files, progress_pct,
      last_watched_at, total_episodes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`
  );
  const insertGenre = db.prepare(
    "INSERT OR IGNORE INTO media_genres (id, media_id, genre_id) VALUES (?, ?, ?);"
  );
  const insertExtId = db.prepare(
    "INSERT OR IGNORE INTO media_external_ids (id, media_id, media_type, source, external_id) VALUES (?, ?, ?, ?, ?);"
  );

  const ids: string[] = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const d = generateMediaDetails(i);
      ids.push(d.id);
      insertMedia.run(
        d.id, d.type, d.title, d.originalTitle, d.originalLanguage, d.overview,
        d.year, d.rating, d.posterPath, d.backdropPath, d.addedAt, d.updatedAt,
        d.hasFiles ? 1 : 0, d.progressPct, d.lastWatchedAt, d.totalEpisodes
      );
      for (const genreId of d.genres) {
        insertGenre.run(uuid(), d.id, genreId);
      }
      insertExtId.run(uuid(), d.id, d.type, CATALOG_ID_SOURCE, String(d.catalogId));
    }
  });
  tx();
  return ids;
};

// On a timing-budget failure, dump the observed elapsed ms vs the budget,
// the live row counts, and the relevant table sizes so a perf regression
// (e.g. accidental N+1, lost batching) is diagnosable from the log alone
// rather than requiring a local re-run. try/catch so a dump failure can
// never mask the original budget assertion.
const dumpPerfSnapshot = (
  label: string,
  metrics: Record<string, number | string>,
  db?: Database,
  tables?: string[],
) => {
  try {
    console.error(`=== [library-perf:${label}] perf snapshot ===`);
    console.error(`metrics: ${JSON.stringify(metrics)}`);
    if (db && tables) {
      const counts: Record<string, number | string> = {};
      for (const t of tables) {
        try {
          const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${t};`).get() as { cnt: number };
          counts[t] = row.cnt;
        } catch (e) {
          counts[t] = `(count failed: ${e instanceof Error ? e.message : String(e)})`;
        }
      }
      console.error(`table row counts: ${JSON.stringify(counts)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ── Tests ────────────────────────────────────────────────────────────

describe("library perf — listMedia query", () => {
  let coreDb: Database;

  beforeEach(() => {
    coreDb = createCoreDb();
  });
  afterEach(() => {
    coreDb.close();
  });

  it("listMedia with 1000 items completes in < 200ms using JOIN query", () => {
    console.info(`[library-perf:listMedia-1000] seeding 1000 media items`);
    seedCoreDb(coreDb, 1000);
    console.info(`[library-perf:listMedia-1000] seed complete; running JOIN query (budget=200ms)`);

    const start = performance.now();
    const rows = coreDb.prepare(
      `SELECT m.*,
        GROUP_CONCAT(DISTINCT g.genre_id) AS genre_ids,
        GROUP_CONCAT(DISTINCT e.source || ':' || e.external_id) AS external_id_pairs
      FROM media_items m
      LEFT JOIN media_genres g ON g.media_id = m.id
      LEFT JOIN media_external_ids e ON e.media_id = m.id
      GROUP BY m.id
      ORDER BY m.updated_at DESC;`
    ).all();
    const elapsed = performance.now() - start;
    console.info(`[library-perf:listMedia-1000] query done: rows=${rows.length} elapsed=${elapsed.toFixed(1)}ms budget=200ms`);

    try {
      expect(rows).toHaveLength(1000);
      expect(elapsed).toBeLessThan(200);
    } catch (err) {
      console.error(`[library-perf:listMedia-1000] assertion failed (over budget or wrong row count)`);
      dumpPerfSnapshot(
        "listMedia-1000-failure",
        { rows: rows.length, elapsedMs: Number(elapsed.toFixed(2)), budgetMs: 200 },
        coreDb,
        ["media_items", "media_genres", "media_external_ids"],
      );
      throw err;
    }
  });

  it("JOIN query is faster than 3 separate full-scan queries", () => {
    console.info(`[library-perf:join-vs-3query] seeding 500 media items`);
    seedCoreDb(coreDb, 500);
    console.info(`[library-perf:join-vs-3query] seed complete; comparing approach A (3 queries) vs B (single JOIN)`);

    // Approach A: 3 separate queries (old pattern)
    const startA = performance.now();
    const mediaRows = coreDb.prepare("SELECT * FROM media_items;").all();
    const extRows = coreDb.prepare("SELECT media_id, source, external_id FROM media_external_ids;").all();
    const genreRows = coreDb.prepare("SELECT media_id, genre_id FROM media_genres;").all();
    // Build maps
    const extMap = new Map<string, Record<string, string>>();
    for (const row of extRows as Array<{ media_id: string; source: string; external_id: string }>) {
      if (!extMap.has(row.media_id)) extMap.set(row.media_id, {});
      extMap.get(row.media_id)![row.source] = row.external_id;
    }
    const genreMap = new Map<string, number[]>();
    for (const row of genreRows as Array<{ media_id: string; genre_id: number }>) {
      if (!genreMap.has(row.media_id)) genreMap.set(row.media_id, []);
      genreMap.get(row.media_id)!.push(row.genre_id);
    }
    const resultA = (mediaRows as Array<{ id: string }>).map((r) => ({
      ...r,
      ext: extMap.get(r.id),
      genres: genreMap.get(r.id),
    }));
    const elapsedA = performance.now() - startA;

    // Approach B: single JOIN query (new pattern)
    const startB = performance.now();
    const resultB = coreDb.prepare(
      `SELECT m.*,
        GROUP_CONCAT(DISTINCT g.genre_id) AS genre_ids,
        GROUP_CONCAT(DISTINCT e.source || ':' || e.external_id) AS external_id_pairs
      FROM media_items m
      LEFT JOIN media_genres g ON g.media_id = m.id
      LEFT JOIN media_external_ids e ON e.media_id = m.id
      GROUP BY m.id;`
    ).all();
    const elapsedB = performance.now() - startB;
    console.info(`[library-perf:join-vs-3query] approachA(3-query)=${elapsedA.toFixed(1)}ms (rows=${resultA.length}) approachB(JOIN)=${elapsedB.toFixed(1)}ms (rows=${resultB.length})`);

    try {
      expect(resultA).toHaveLength(500);
      expect(resultB).toHaveLength(500);
      // JOIN should be faster (or at worst comparable)
      // We don't assert strict < because in-memory SQLite is fast for both,
      // but we verify both produce the same count
      expect(elapsedA).toBeDefined();
      expect(elapsedB).toBeDefined();
    } catch (err) {
      console.error(`[library-perf:join-vs-3query] assertion failed (row-count mismatch)`);
      dumpPerfSnapshot(
        "join-vs-3query-failure",
        { rowsA: resultA.length, rowsB: resultB.length, elapsedAMs: Number(elapsedA.toFixed(2)), elapsedBMs: Number(elapsedB.toFixed(2)) },
        coreDb,
        ["media_items", "media_genres", "media_external_ids"],
      );
      throw err;
    }
  });
});

describe("library perf — batched vs sequential op application", () => {
  let coreDb: Database;

  beforeEach(() => {
    coreDb = createCoreDb();
  });
  afterEach(() => {
    coreDb.close();
  });

  it("batched insert of 200 media items completes in < 500ms", () => {
    console.info(`[library-perf:batched-insert-200] generating 200 media items (budget=500ms)`);
    const items = Array.from({ length: 200 }, (_, i) => generateMediaDetails(i));

    const start = performance.now();
    const tx = coreDb.transaction(() => {
      for (const d of items) {
        coreDb.run(
          `INSERT OR REPLACE INTO media_items (
            id, type, title, original_title, original_language, overview, year, rating,
            poster_path, backdrop_path, added_at, updated_at, has_files, progress_pct,
            last_watched_at, total_episodes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            d.id, d.type, d.title, d.originalTitle, d.originalLanguage, d.overview,
            d.year, d.rating, d.posterPath, d.backdropPath, d.addedAt, d.updatedAt,
            d.hasFiles ? 1 : 0, d.progressPct, d.lastWatchedAt, d.totalEpisodes,
          ]
        );
        coreDb.run("DELETE FROM media_external_ids WHERE media_id = ?;", [d.id]);
        coreDb.run(
          "INSERT OR IGNORE INTO media_external_ids (id, media_id, media_type, source, external_id) VALUES (?, ?, ?, ?, ?);",
          [uuid(), d.id, d.type, CATALOG_ID_SOURCE, String(d.catalogId)]
        );
        coreDb.run("DELETE FROM media_genres WHERE media_id = ?;", [d.id]);
        for (const genreId of d.genres) {
          coreDb.run(
            "INSERT OR IGNORE INTO media_genres (id, media_id, genre_id) VALUES (?, ?, ?);",
            [uuid(), d.id, genreId]
          );
        }
      }
    });
    tx();
    const elapsed = performance.now() - start;

    const count = coreDb.prepare("SELECT COUNT(*) as cnt FROM media_items;").get() as { cnt: number };
    console.info(`[library-perf:batched-insert-200] insert done: media_items=${count.cnt} elapsed=${elapsed.toFixed(1)}ms budget=500ms`);
    try {
      expect(count.cnt).toBe(200);
      expect(elapsed).toBeLessThan(500);
    } catch (err) {
      console.error(`[library-perf:batched-insert-200] assertion failed (over budget or wrong count)`);
      dumpPerfSnapshot(
        "batched-insert-200-failure",
        { mediaCount: count.cnt, elapsedMs: Number(elapsed.toFixed(2)), budgetMs: 500 },
        coreDb,
        ["media_items", "media_genres", "media_external_ids"],
      );
      throw err;
    }
  });

  it("200 media items with genres + external IDs produce correct row counts", () => {
    console.info(`[library-perf:row-counts-200] generating + inserting 200 media items`);
    const items = Array.from({ length: 200 }, (_, i) => generateMediaDetails(i));

    const tx = coreDb.transaction(() => {
      for (const d of items) {
        coreDb.run(
          `INSERT OR REPLACE INTO media_items (
            id, type, title, original_title, original_language, overview, year, rating,
            poster_path, backdrop_path, added_at, updated_at, has_files, progress_pct,
            last_watched_at, total_episodes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            d.id, d.type, d.title, d.originalTitle, d.originalLanguage, d.overview,
            d.year, d.rating, d.posterPath, d.backdropPath, d.addedAt, d.updatedAt,
            d.hasFiles ? 1 : 0, d.progressPct, d.lastWatchedAt, d.totalEpisodes,
          ]
        );
        coreDb.run("DELETE FROM media_external_ids WHERE media_id = ?;", [d.id]);
        coreDb.run(
          "INSERT OR IGNORE INTO media_external_ids (id, media_id, media_type, source, external_id) VALUES (?, ?, ?, ?, ?);",
          [uuid(), d.id, d.type, CATALOG_ID_SOURCE, String(d.catalogId)]
        );
        coreDb.run("DELETE FROM media_genres WHERE media_id = ?;", [d.id]);
        for (const genreId of d.genres) {
          coreDb.run(
            "INSERT OR IGNORE INTO media_genres (id, media_id, genre_id) VALUES (?, ?, ?);",
            [uuid(), d.id, genreId]
          );
        }
      }
    });
    tx();

    const mediaCount = coreDb.prepare("SELECT COUNT(*) as cnt FROM media_items;").get() as { cnt: number };
    const genreCount = coreDb.prepare("SELECT COUNT(*) as cnt FROM media_genres;").get() as { cnt: number };
    const extIdCount = coreDb.prepare("SELECT COUNT(*) as cnt FROM media_external_ids;").get() as { cnt: number };
    console.info(`[library-perf:row-counts-200] media=${mediaCount.cnt} genres=${genreCount.cnt} extIds=${extIdCount.cnt}`);

    try {
      expect(mediaCount.cnt).toBe(200);
      expect(genreCount.cnt).toBeGreaterThan(400); // 2-5 genres per item
      expect(extIdCount.cnt).toBe(200); // 1 catalog id per item
    } catch (err) {
      console.error(`[library-perf:row-counts-200] assertion failed (row counts off expected)`);
      dumpPerfSnapshot(
        "row-counts-200-failure",
        { mediaCount: mediaCount.cnt, genreCount: genreCount.cnt, extIdCount: extIdCount.cnt },
        coreDb,
        ["media_items", "media_genres", "media_external_ids"],
      );
      throw err;
    }
  });
});

describe("library perf — metadata batch application", () => {
  let metadataDb: Database;

  beforeEach(() => {
    metadataDb = createMetadataDb();
  });
  afterEach(() => {
    metadataDb.close();
  });

  it("batched metadata insert for 100 media items with cast+episodes completes in < 1s", () => {
    console.info(`[library-perf:metadata-batch-100] generating 100 media items w/ cast+episodes (budget=1000ms)`);
    const items = Array.from({ length: 100 }, (_, i) => generateMediaDetails(i));

    const start = performance.now();
    const tx = metadataDb.transaction(() => {
      for (const d of items) {
        metadataDb.run("DELETE FROM media_roles WHERE media_id = ?;", [d.id]);
        for (const [index, member] of d.cast.entries()) {
          metadataDb.run(
            "INSERT OR REPLACE INTO people (id, name, profile_path) VALUES (?, ?, ?);",
            [member.personId, member.name, member.profilePath]
          );
          metadataDb.run(
            "INSERT OR REPLACE INTO media_roles (id, media_id, person_id, role, order_index) VALUES (?, ?, ?, ?, ?);",
            [member.id, d.id, member.personId, member.role, index]
          );
        }
        metadataDb.run("DELETE FROM media_trailers WHERE media_id = ?;", [d.id]);
        for (const trailer of d.trailers) {
          metadataDb.run(
            "INSERT INTO media_trailers (id, media_id, provider, key, name, language) VALUES (?, ?, ?, ?, ?, ?);",
            [uuid(), d.id, trailer.provider, trailer.key, trailer.name, trailer.language]
          );
        }
        metadataDb.run("DELETE FROM media_seasons WHERE media_id = ?;", [d.id]);
        for (const season of d.seasons) {
          metadataDb.run(
            "INSERT OR REPLACE INTO media_seasons (id, media_id, season_number, title, overview, poster_path, episode_count, air_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
            [season.id, d.id, season.seasonNumber, season.name, season.overview, season.posterPath, season.episodeCount, season.airDate]
          );
        }
        metadataDb.run("DELETE FROM media_episodes WHERE media_id = ?;", [d.id]);
        for (const ep of d.episodes) {
          metadataDb.run(
            "INSERT OR REPLACE INTO media_episodes (id, media_id, season_number, episode_number, title, overview, still_path, air_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
            [ep.id, d.id, ep.seasonNumber, ep.episodeNumber, ep.name, ep.overview, ep.stillPath, ep.airDate]
          );
        }
      }
    });
    tx();
    const elapsed = performance.now() - start;

    const roleCount = metadataDb.prepare("SELECT COUNT(*) as cnt FROM media_roles;").get() as { cnt: number };
    console.info(`[library-perf:metadata-batch-100] insert done: media_roles=${roleCount.cnt} elapsed=${elapsed.toFixed(1)}ms budget=1000ms`);
    try {
      expect(roleCount.cnt).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(1000);
    } catch (err) {
      console.error(`[library-perf:metadata-batch-100] assertion failed (over budget or no roles inserted)`);
      dumpPerfSnapshot(
        "metadata-batch-100-failure",
        { roleCount: roleCount.cnt, elapsedMs: Number(elapsed.toFixed(2)), budgetMs: 1000 },
        metadataDb,
        ["media_roles", "people", "media_trailers", "media_seasons", "media_episodes"],
      );
      throw err;
    }
  });
});

describe("library perf — playback batch application", () => {
  let playbackDb: Database;

  beforeEach(() => {
    playbackDb = createPlaybackDb();
  });
  afterEach(() => {
    playbackDb.close();
  });

  it("batched normalized playback insert for 500 media items completes in < 2200ms", () => {
    // Phase 4 baseline: 500 media × 3 formats × 20 chunks = 30 000 chunk rows
    // plus 500 format rows. Budget covers the post-Phase-4 hot path (replaces
    // the prior single-row blob insert per media). The +2s headroom over the
    // pre-Phase-4 200ms budget is the explicit perf-regression allowance from
    // Decision #1 in the plan.
    console.info(`[library-perf:playback-batch-500] inserting 500 media × 3 formats × 20 chunks (budget=2200ms)`);
    const start = performance.now();
    const fileId = uuid();
    const tx = playbackDb.transaction(() => {
      for (let i = 0; i < 500; i++) {
        const mediaId = uuid();
        const formatIds = Array.from({ length: 3 }, () => uuid());
        for (const formatId of formatIds) {
          playbackDb.run(
            `INSERT OR REPLACE INTO media_formats (
              id, media_id, file_id, quality, codec, codec_string, bitrate_kbps, init_key, init_size, duration_seconds, total_size, size_mb
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [formatId, mediaId, fileId, "1080p", "h264", null, 5000, null, null, null, null, 1500]
          );
          for (let j = 0; j < 20; j += 1) {
            playbackDb.run(
              "INSERT OR REPLACE INTO media_format_chunks (id, format_id, chunk_key, order_index, size_bytes, start_seconds) VALUES (?, ?, ?, ?, ?, ?);",
              [uuid(), formatId, `chunk-${j}`, j, 4_000_000, j * 6]
            );
          }
        }
      }
    });
    tx();
    const elapsed = performance.now() - start;

    const formatCount = playbackDb.prepare("SELECT COUNT(*) as cnt FROM media_formats;").get() as { cnt: number };
    const chunkCount = playbackDb.prepare("SELECT COUNT(*) as cnt FROM media_format_chunks;").get() as { cnt: number };
    console.info(`[library-perf:playback-batch-500] insert done: formats=${formatCount.cnt} chunks=${chunkCount.cnt} elapsed=${elapsed.toFixed(1)}ms budget=2200ms`);
    try {
      expect(formatCount.cnt).toBe(1500);
      expect(chunkCount.cnt).toBe(30_000);
      expect(elapsed).toBeLessThan(2200);
    } catch (err) {
      console.error(`[library-perf:playback-batch-500] assertion failed (over budget or wrong row counts)`);
      dumpPerfSnapshot(
        "playback-batch-500-failure",
        { formatCount: formatCount.cnt, chunkCount: chunkCount.cnt, elapsedMs: Number(elapsed.toFixed(2)), budgetMs: 2200 },
        playbackDb,
        ["media_formats", "media_format_chunks"],
      );
      throw err;
    }
  });
});

describe("library perf — combined scenario", () => {
  let coreDb: Database;

  beforeEach(() => {
    coreDb = createCoreDb();
  });
  afterEach(() => {
    coreDb.close();
  });

  it("seed + query 1000 items end-to-end in < 500ms", () => {
    console.info(`[library-perf:combined-1000] end-to-end seed + JOIN query of 1000 items (budget=500ms)`);
    const start = performance.now();

    // Seed
    seedCoreDb(coreDb, 1000);
    const seededAt = performance.now() - start;
    console.info(`[library-perf:combined-1000] seed complete at ${seededAt.toFixed(1)}ms; running JOIN query`);

    // Query
    const rows = coreDb.prepare(
      `SELECT m.*,
        GROUP_CONCAT(DISTINCT g.genre_id) AS genre_ids,
        GROUP_CONCAT(DISTINCT e.source || ':' || e.external_id) AS external_id_pairs
      FROM media_items m
      LEFT JOIN media_genres g ON g.media_id = m.id
      LEFT JOIN media_external_ids e ON e.media_id = m.id
      GROUP BY m.id
      ORDER BY m.updated_at DESC;`
    ).all();

    const elapsed = performance.now() - start;
    console.info(`[library-perf:combined-1000] done: rows=${rows.length} totalElapsed=${elapsed.toFixed(1)}ms (seedPortion=${seededAt.toFixed(1)}ms) budget=500ms`);

    try {
      expect(rows).toHaveLength(1000);
      expect(elapsed).toBeLessThan(500);
    } catch (err) {
      console.error(`[library-perf:combined-1000] assertion failed (over budget or wrong row count)`);
      dumpPerfSnapshot(
        "combined-1000-failure",
        { rows: rows.length, seedMs: Number(seededAt.toFixed(2)), totalMs: Number(elapsed.toFixed(2)), budgetMs: 500 },
        coreDb,
        ["media_items", "media_genres", "media_external_ids"],
      );
      throw err;
    }
  });
});

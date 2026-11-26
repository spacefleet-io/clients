/**
 * @test-id LIB-MULTI-GROUP-ROUTING-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 *
 * Phase 3.6 flipped every LibraryDb mutator from `this.orm` (the legacy
 * single-file ORM) to one of `this.core` / `this.metadata` / `this.playback`
 * / `this.ingest` / `this.templates`. A typo in that flip — pointing a
 * core write at `this.metadata`, for example — silently lands the row in
 * the wrong physical SQLite file. The existing
 * legacy-snapshot-exists-on-upgrade test seeds only one core-group setting,
 * which means cross-routing bugs slip through.
 *
 * This smoke writes through public LibraryDb methods that touch at least
 * three distinct groups, closes the DB, then opens each per-group
 * `library.<group>.sqlite` file directly with bun:sqlite and asserts each
 * row landed in its claimed group AND nowhere else.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";
import {
  getCoreDbPath,
  getIngestDbPath,
  getMetadataDbPath,
  getPlaybackDbPath,
  getTemplatesDbPath,
} from "../src/libraryDbStorage";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-routing-smoke-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[multi-group-orm-routing:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[multi-group-orm-routing:teardown] root-exists=${existsSync(root)} root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const tableExists = (db: Database, table: string): boolean => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1;")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
};

const countRows = (db: Database, table: string): number => {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as { n?: number };
  return Number(row?.n ?? 0);
};

// Suite-id: multi-group-orm-routing
// The whole point of this suite is "did this write land in the right group's
// physical SQLite file". Dump a group-to-attached-table map across every
// per-group file: which tables exist, how many rows, and a route-mismatch
// hint when a table shows up in the wrong group.
const dumpRoutingSnapshot = (
  label: string,
  ctx: {
    dbs?: Readonly<Record<"core" | "metadata" | "playback" | "ingest" | "templates", Database>>;
    expectedTablesByGroup?: Partial<
      Record<"core" | "metadata" | "playback" | "ingest" | "templates", ReadonlyArray<string>>
    >;
    capturedError?: unknown;
    extraNotes?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [multi-group-orm-routing:${label}] snapshot ===`);
    console.error(`root=${root}`);
    console.error(`paths:`);
    console.error(`  core=${getCoreDbPath()} exists=${existsSync(getCoreDbPath())}`);
    console.error(`  metadata=${getMetadataDbPath()} exists=${existsSync(getMetadataDbPath())}`);
    console.error(`  playback=${getPlaybackDbPath()} exists=${existsSync(getPlaybackDbPath())}`);
    console.error(`  ingest=${getIngestDbPath()} exists=${existsSync(getIngestDbPath())}`);
    console.error(`  templates=${getTemplatesDbPath()} exists=${existsSync(getTemplatesDbPath())}`);
    if (ctx.dbs) {
      for (const [group, db] of Object.entries(ctx.dbs) as Array<[
        keyof typeof ctx.dbs,
        Database,
      ]>) {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
          .all() as Array<{ name: string }>;
        console.error(`  group=${group} tables=${JSON.stringify(tables.map((r) => r.name))}`);
      }
      if (ctx.expectedTablesByGroup) {
        for (const [expectedGroup, tables] of Object.entries(ctx.expectedTablesByGroup)) {
          for (const table of tables ?? []) {
            for (const [actualGroup, db] of Object.entries(ctx.dbs) as Array<[
              keyof typeof ctx.dbs,
              Database,
            ]>) {
              const exists = tableExists(db, table);
              if (exists && actualGroup !== expectedGroup) {
                console.error(
                  `  ROUTE-MISMATCH: table=${table} expected-group=${expectedGroup} but exists in group=${actualGroup}`,
                );
              }
              if (!exists && actualGroup === expectedGroup) {
                console.error(
                  `  ROUTE-MISMATCH: table=${table} expected-group=${expectedGroup} but missing there`,
                );
              }
            }
          }
        }
      }
    }
    if (ctx.extraNotes) {
      console.error(`extraNotes=${JSON.stringify(ctx.extraNotes, null, 2)}`);
    }
    if (ctx.capturedError !== undefined) {
      const e = ctx.capturedError;
      console.error(`captured error=${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("Phase 3.6 multi-group ORM routing — every write lands in its claimed group's file only", () => {
  it("core writes (media_items, app_settings, playlists) land in library.core.sqlite", async () => {
    console.info(`[multi-group-orm-routing:core-writes] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    const mediaId = await db.addMediaFromCatalog({
      id: 700,
      type: "movie",
      title: "Routing Test Movie",
      originalTitle: null,
      originalLanguage: "en",
      overview: null,
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
    console.info(`[multi-group-orm-routing:core-writes] addMediaFromCatalog mediaId=${mediaId}`);

    await db.setSetting("routing.test.key", "value-A");
    db.createPlaylist("Routing Test Playlist");
    db.close();
    console.info(`[multi-group-orm-routing:core-writes] writes complete, reopening per-group files`);

    const core = new Database(getCoreDbPath());
    const metadata = new Database(getMetadataDbPath());
    const playback = new Database(getPlaybackDbPath());
    const ingest = new Database(getIngestDbPath());
    const templates = new Database(getTemplatesDbPath());
    try {
      try {
        // Core file: rows landed here.
        const mediaRow = core
          .prepare("SELECT id, title FROM media_items WHERE id = ?;")
          .get(mediaId) as { id?: string; title?: string } | undefined;
        expect(mediaRow?.title).toBe("Routing Test Movie");

        const settingRow = core
          .prepare("SELECT value FROM app_settings WHERE key = ?;")
          .get("routing.test.key") as { value?: string } | undefined;
        expect(settingRow?.value).toBe("value-A");

        const playlistRow = core
          .prepare("SELECT name FROM playlists WHERE name = ?;")
          .get("Routing Test Playlist") as { name?: string } | undefined;
        expect(playlistRow?.name).toBe("Routing Test Playlist");

        // None of the core tables should exist in any other group's file.
        // Cross-group FK references prevent SQLite from enforcing it, so we
        // verify the tables themselves aren't even there.
        for (const other of [metadata, playback, ingest, templates]) {
          expect(tableExists(other, "media_items"), "media_items leaked into a non-core file").toBe(false);
          expect(tableExists(other, "app_settings"), "app_settings leaked into a non-core file").toBe(false);
          expect(tableExists(other, "playlists"), "playlists leaked into a non-core file").toBe(false);
        }
      } catch (err) {
        dumpRoutingSnapshot("core-writes-failure", {
          dbs: { core, metadata, playback, ingest, templates },
          expectedTablesByGroup: {
            core: ["media_items", "app_settings", "playlists"],
          },
          capturedError: err,
          extraNotes: { mediaId },
        });
        throw err;
      }
    } finally {
      core.close();
      metadata.close();
      playback.close();
      ingest.close();
      templates.close();
    }
  });

  it("metadata writes (seasons, episodes, people, trailers) land in library.metadata.sqlite", async () => {
    console.info(`[multi-group-orm-routing:metadata-writes] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    await db.addMediaFromCatalog({
      id: 701,
      type: "tv",
      title: "Routing TV",
      originalTitle: null,
      originalLanguage: "en",
      overview: null,
      year: "2026",
      posterPath: null,
      backdropPath: null,
      genres: [],
      cast: [
        { personId: 200, name: "Routing Actor", role: "Lead", profilePath: null, order: 0 },
      ],
      trailers: [
        { provider: "youtube", key: "rt-1", name: "Trailer", language: "en", official: true },
      ],
      totalEpisodes: null,
      seasons: [
        { seasonNumber: 1, name: "S1", overview: null, posterPath: null, episodeCount: 2, airDate: "2026-01-01" },
      ],
      episodes: [
        { seasonNumber: 1, episodeNumber: 1, name: "E1", overview: null, stillPath: null, airDate: "2026-01-01" },
        { seasonNumber: 1, episodeNumber: 2, name: "E2", overview: null, stillPath: null, airDate: "2026-01-08" },
      ],
    });
    db.close();
    console.info(`[multi-group-orm-routing:metadata-writes] writes complete, reopening per-group files`);

    const core = new Database(getCoreDbPath());
    const metadata = new Database(getMetadataDbPath());
    const playback = new Database(getPlaybackDbPath());
    const ingest = new Database(getIngestDbPath());
    const templates = new Database(getTemplatesDbPath());
    try {
      try {
        expect(countRows(metadata, "media_seasons")).toBe(1);
        expect(countRows(metadata, "media_episodes")).toBe(2);
        expect(countRows(metadata, "media_trailers")).toBe(1);
        expect(countRows(metadata, "people")).toBeGreaterThanOrEqual(1);

        // Metadata tables not present in core/playback/ingest/templates.
        for (const other of [core, playback, ingest, templates]) {
          for (const table of ["media_seasons", "media_episodes", "media_trailers", "people", "media_roles"]) {
            expect(tableExists(other, table), `${table} leaked outside metadata file`).toBe(false);
          }
        }
      } catch (err) {
        dumpRoutingSnapshot("metadata-writes-failure", {
          dbs: { core, metadata, playback, ingest, templates },
          expectedTablesByGroup: {
            metadata: ["media_seasons", "media_episodes", "media_trailers", "people", "media_roles"],
          },
          capturedError: err,
        });
        throw err;
      }
    } finally {
      core.close();
      metadata.close();
      playback.close();
      ingest.close();
      templates.close();
    }
  });

  it("ingest writes (upsertIngestJob, addIngestJobEvent) land in library.ingest.sqlite", async () => {
    console.info(`[multi-group-orm-routing:ingest-writes] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    // Need a media row in core for the FK reference (FK isn't enforced
    // cross-file but the value is meaningful for the assertion).
    const mediaId = await db.addMediaFromCatalog({
      id: 702,
      type: "movie",
      title: "Ingest Routing Movie",
      originalTitle: null,
      originalLanguage: "en",
      overview: null,
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

    db.upsertIngestJob({
      id: "job-route-1",
      mediaId,
      workerPeerId: "peer-route-1",
      kind: "transcode",
      status: "queued",
      progressPct: 0,
    });

    db.addIngestJobEvent({
      jobId: "job-route-1",
      level: "info",
      message: "queued",
    });
    db.close();
    console.info(
      `[multi-group-orm-routing:ingest-writes] writes complete (mediaId=${mediaId} job=job-route-1)`,
    );

    const core = new Database(getCoreDbPath());
    const metadata = new Database(getMetadataDbPath());
    const playback = new Database(getPlaybackDbPath());
    const ingest = new Database(getIngestDbPath());
    const templates = new Database(getTemplatesDbPath());
    try {
      try {
        expect(countRows(ingest, "ingest_jobs")).toBe(1);
        expect(countRows(ingest, "ingest_job_events")).toBe(1);

        const job = ingest
          .prepare("SELECT status, worker_peer_id FROM ingest_jobs WHERE id = ?;")
          .get("job-route-1") as { status?: string; worker_peer_id?: string } | undefined;
        expect(job?.status).toBe("queued");
        expect(job?.worker_peer_id).toBe("peer-route-1");

        for (const other of [core, metadata, playback, templates]) {
          expect(tableExists(other, "ingest_jobs"), "ingest_jobs leaked outside ingest file").toBe(false);
          expect(tableExists(other, "ingest_job_events"), "ingest_job_events leaked outside ingest file").toBe(false);
        }
      } catch (err) {
        dumpRoutingSnapshot("ingest-writes-failure", {
          dbs: { core, metadata, playback, ingest, templates },
          expectedTablesByGroup: {
            ingest: ["ingest_jobs", "ingest_job_events"],
          },
          capturedError: err,
          extraNotes: { mediaId },
        });
        throw err;
      }
    } finally {
      core.close();
      metadata.close();
      playback.close();
      ingest.close();
      templates.close();
    }
  });

  it("playback + templates files start empty but have their full schema in place", async () => {
    // Verifies the files were materialized + schema'd even when no group-
    // specific writes happened. Guards against a regression where a future
    // initialize<Group>Db() bug skipped schema bootstrap for an unused group.
    console.info(`[multi-group-orm-routing:empty-shape] LibraryDb.openLocal (no writes)`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    db.close();

    const playback = new Database(getPlaybackDbPath());
    const templates = new Database(getTemplatesDbPath());
    try {
      try {
        for (const table of ["media_formats", "media_format_chunks", "media_audio_tracks", "media_subtitles"]) {
          expect(tableExists(playback, table), `${table} missing from playback file`).toBe(true);
          expect(countRows(playback, table)).toBe(0);
        }
        for (const table of [
          "media_templates",
          "media_template_formats",
          "media_template_format_chunks",
          "media_skip_analysis",
        ]) {
          expect(tableExists(templates, table), `${table} missing from templates file`).toBe(true);
          expect(countRows(templates, table)).toBe(0);
        }
      } catch (err) {
        // Spoof core/metadata/ingest as same DB to satisfy the dumper shape,
        // since this test only validates playback + templates.
        const core = new Database(getCoreDbPath());
        const metadata = new Database(getMetadataDbPath());
        const ingest = new Database(getIngestDbPath());
        try {
          dumpRoutingSnapshot("empty-shape-failure", {
            dbs: { core, metadata, playback, ingest, templates },
            expectedTablesByGroup: {
              playback: ["media_formats", "media_format_chunks", "media_audio_tracks", "media_subtitles"],
              templates: [
                "media_templates",
                "media_template_formats",
                "media_template_format_chunks",
                "media_skip_analysis",
              ],
            },
            capturedError: err,
          });
        } finally {
          core.close();
          metadata.close();
          ingest.close();
        }
        throw err;
      }
    } finally {
      playback.close();
      templates.close();
    }
  });
});

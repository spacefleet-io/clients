/**
 * @test-id LIB-DB-OPS-GOLDEN-001
 * @level unit
 * @why buildOpStatements is the single shared SQL generator for both desktop
 *   (better-sqlite3 + drizzle) and mobile (react-native-sqlite-storage +
 *   SqlBatcher). An accidental edit to a statement template — a renamed
 *   column, a re-ordered VALUES list, a swapped placeholder — would silently
 *   flow to both clients, with no real-engine test catching it until ingest
 *   or playback breaks in production.
 *
 *   This file pins one deterministic snapshot per LibraryOp variant. The
 *   snapshots ARE the spec for the SQL shape: any drift shows up as a diff
 *   in PR review without anyone running the test. Update with
 *   `bunx vitest run -u` only when the SQL change is deliberate.
 */
import { describe, expect, test } from "vitest";
import type { IngestJob, IngestJobEvent, MediaDetails } from "@space/shared";
import type { LibraryOp } from "@space/shared/libraryOps";
import { buildOpStatements, type IdGenerator } from "../src/ops";

const seededIds = (prefix = "uuid"): IdGenerator => {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(3, "0")}`;
};

const opMeta = { id: "op-1", createdAt: "2024-01-01T00:00:00.000Z" };

// On snapshot mismatch the default Vitest diff already shows the literal that
// drifted, but it does NOT tell you which op variant produced it or give a
// per-group statement census you can eyeball at a glance. This dumper emits a
// compact, greppable census of the ACTUAL generated statements so a failing CI
// run is diagnosable from the log alone (per "Tests log generously"). Wrapped
// in try/catch so a dump failure can never mask the real snapshot assertion.
const dumpOpStatementsSnapshot = (
  label: string,
  op: LibraryOp,
  built: ReturnType<typeof buildOpStatements>,
): void => {
  try {
    const groups = Object.keys(built);
    const census = groups.map((g) => {
      const stmts = (built as Record<string, Array<{ sql: string; params: unknown[] }>>)[g] ?? [];
      return {
        group: g,
        count: stmts.length,
        verbs: stmts.map((s) => String(s.sql).trim().split(/\s+/).slice(0, 3).join(" ")),
      };
    });
    const totalStatements = census.reduce((acc, c) => acc + c.count, 0);
    console.error(`=== [ops-golden:${label}] generated-statements snapshot ===`);
    console.error(`op.type=${op.type} op.id=${op.id} groups=[${groups.join(", ")}] total=${totalStatements}`);
    console.error(`per-group census:\n${JSON.stringify(census, null, 2)}`);
    console.error(`full built output:\n${JSON.stringify(built, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot dump failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Build the statements for an op, emit phase markers around it, and return the
// result so the caller can keep the `toMatchInlineSnapshot` literal at its own
// call site (Vitest's `-u` updater locates the snapshot by that exact call
// site, so it must NOT be hidden behind a helper). The caller wraps the single
// `expect(...).toMatchInlineSnapshot(...)` in try/catch + dumpOpStatementsSnapshot.
const buildForSnapshot = (label: string, op: LibraryOp): ReturnType<typeof buildOpStatements> => {
  console.info(`[ops-golden:${label}] building statements for op.type=${op.type}`);
  const built = buildOpStatements(op, seededIds());
  const groupCounts = Object.fromEntries(
    Object.entries(built as Record<string, unknown[]>).map(([g, stmts]) => [g, Array.isArray(stmts) ? stmts.length : 0]),
  );
  console.info(`[ops-golden:${label}] built groups=${JSON.stringify(groupCounts)}`);
  return built;
};

const fullDetails: MediaDetails = {
  id: "media-1",
  type: "movie",
  tmdbId: 42,
  externalIds: { imdb: "tt0001", tvdb: "9999" },
  title: "Title",
  originalTitle: "OT",
  originalLanguage: "en",
  overview: "Overview",
  year: "2020",
  rating: 8.5,
  posterPath: "/p.png",
  backdropPath: "/b.png",
  genres: [28, 18],
  addedAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-02T00:00:00.000Z",
  hasFiles: true,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: 2,
  episodeCount: 2,
  cast: [
    {
      id: "role-a",
      personId: "p-a",
      tmdbId: 100,
      name: "Actor A",
      role: "lead",
      profilePath: "/a.png",
    },
    {
      id: "role-b",
      personId: "p-b",
      tmdbId: null,
      name: "Actor B",
      role: "supporting",
      profilePath: null,
    },
  ],
  playlistIds: [],
  seasons: [
    {
      id: "season-1",
      seasonNumber: 1,
      name: "Season 1",
      overview: "S1",
      posterPath: "/s1.png",
      episodeCount: 2,
      airDate: "2020-01-01",
    },
  ],
  episodes: [
    {
      id: "ep-1",
      seasonNumber: 1,
      episodeNumber: 1,
      name: "Pilot",
      overview: "E1",
      stillPath: "/e1.png",
      airDate: "2020-01-02",
    },
    {
      id: "ep-2",
      seasonNumber: 1,
      episodeNumber: 2,
      name: "Episode 2",
      overview: "E2",
      stillPath: "/e2.png",
      airDate: "2020-01-09",
    },
  ],
  trailers: [
    {
      provider: "youtube",
      key: "yt-1",
      name: "Trailer 1",
      language: "en",
    },
  ],
  files: [
    {
      id: "file-1",
      filename: "title.mkv",
      season: null,
      episode: null,
      desiredFormats: [
        { quality: "1080p", codec: "h264", bitrateKbps: 5000 },
        { quality: "720p", codec: "h264", bitrateKbps: null },
      ],
    },
  ] as MediaDetails["files"],
  formats: [
    {
      id: "fmt-1",
      mediaId: "media-1",
      fileId: "file-1",
      quality: "1080p",
      codec: "h264",
      codecString: "avc1.640028",
      bitrateKbps: 5000,
      sizeMb: 1500,
      initKey: "init-1",
      initSize: 800,
      durationSeconds: 7200,
      totalSize: 1_500_000_000,
      chunks: [
        { key: "c1", sizeBytes: 100, startSeconds: 0 },
        { key: "c2", sizeBytes: 200, startSeconds: 60 },
      ],
      isSource: true,
    },
  ] as MediaDetails["formats"],
  audioTracks: [
    {
      id: "audio-1",
      mediaId: "media-1",
      fileId: "file-1",
      episodeId: null,
      language: "en",
      label: "English",
      isDefault: true,
      source: "embedded",
      codec: "aac",
      codecString: "mp4a.40.2",
      initKey: "audio-init-1",
      initSize: 400,
      durationSeconds: 7200,
      totalSize: 200_000_000,
      chunks: [{ key: "ac1", sizeBytes: 50, startSeconds: 0 }],
    },
  ] as MediaDetails["audioTracks"],
  subtitleTracks: [],
  subtitles: [
    {
      id: "sub-1",
      mediaId: "media-1",
      fileId: "file-1",
      episodeId: null,
      language: "en",
      label: "English",
      objectKey: "obj-1",
      format: "vtt",
      isDefault: true,
      source: "embedded",
      createdAt: "2024-01-02T00:00:00.000Z",
    },
  ] as MediaDetails["subtitles"],
  chapters: [
    {
      id: "chap-1",
      formatId: "fmt-1",
      title: "Chapter 1",
      startSeconds: 0,
    },
  ] as MediaDetails["chapters"],
  skipMarkers: [
    {
      id: "skip-1",
      mediaId: "media-1",
      episodeId: null,
      type: "intro",
      startSeconds: 0,
      endSeconds: 30,
      source: "user",
      confidence: 0.95,
      createdAt: "2024-01-02T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    },
  ] as MediaDetails["skipMarkers"],
  hasLocalFiles: false,
};

const ingestJob: IngestJob = {
  id: "job-1",
  mediaId: "media-1",
  fileId: "file-1",
  workerPeerId: "peer-1",
  ownerClientId: "client-1",
  kind: "transcode",
  status: "processing",
  progressPct: 42,
  errorCode: null,
  errorMessage: null,
  meta: { foo: "bar" },
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T01:00:00.000Z",
  completedAt: null,
};

const ingestEvent: IngestJobEvent = {
  id: "evt-1",
  jobId: "job-1",
  level: "info",
  message: "started",
  meta: { stage: "upload" },
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("buildOpStatements — golden fixtures", () => {
  test("playlist.create", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "playlist.create",
      payload: {
        id: "pl-1",
        name: "Favs",
        slug: "favs",
        isSystem: false,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    };
    const result = buildForSnapshot("playlist.create", op);
    try {
      expect(result).toMatchInlineSnapshot(`
      {
        "core": [
          {
            "params": [
              "pl-1",
              "Favs",
              "favs",
              0,
              "2024-01-01T00:00:00.000Z",
            ],
            "sql": "INSERT OR REPLACE INTO playlists (id, name, slug, is_system, created_at) VALUES (?, ?, ?, ?, ?);",
          },
        ],
      }
    `);
    } catch (err) {
      dumpOpStatementsSnapshot("playlist.create", op, result);
      throw err;
    }
  });

  test("playlist.delete", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "playlist.delete",
      payload: { id: "pl-1" },
    };
    const result = buildForSnapshot("playlist.delete", op);
    try {
      expect(result).toMatchInlineSnapshot(`
      {
        "core": [
          {
            "params": [
              "pl-1",
            ],
            "sql": "DELETE FROM playlists WHERE id = ? AND is_system = 0;",
          },
        ],
      }
    `);
    } catch (err) {
      dumpOpStatementsSnapshot("playlist.delete", op, result);
      throw err;
    }
  });

  test("playlist.item.add", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "playlist.item.add",
      payload: {
        id: "pli-1",
        playlistId: "pl-1",
        mediaId: "media-1",
        addedAt: "2024-01-01T00:00:00.000Z",
      },
    };
    const result = buildForSnapshot("playlist.item.add", op);
    try {
      expect(result).toMatchInlineSnapshot(`
        {
          "core": [
            {
              "params": [
                "pli-1",
                "pl-1",
                "media-1",
                "2024-01-01T00:00:00.000Z",
                "pl-1",
                "media-1",
              ],
              "sql": "INSERT OR IGNORE INTO playlist_items (id, playlist_id, media_id, added_at)
             SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM playlists WHERE id = ?) AND EXISTS (SELECT 1 FROM media_items WHERE id = ?);",
            },
          ],
        }
      `);
    } catch (err) {
      dumpOpStatementsSnapshot("playlist.item.add", op, result);
      throw err;
    }
  });

  test("playlist.item.remove", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "playlist.item.remove",
      payload: { playlistId: "pl-1", mediaId: "media-1" },
    };
    const result = buildForSnapshot("playlist.item.remove", op);
    try {
      expect(result).toMatchInlineSnapshot(`
      {
        "core": [
          {
            "params": [
              "pl-1",
              "media-1",
            ],
            "sql": "DELETE FROM playlist_items WHERE playlist_id = ? AND media_id = ?;",
          },
        ],
      }
    `);
    } catch (err) {
      dumpOpStatementsSnapshot("playlist.item.remove", op, result);
      throw err;
    }
  });

  test("media.upsert (full payload — every nested array populated)", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: { details: fullDetails },
    };
    const result = buildForSnapshot("media.upsert-full", op);
    try {
      expect(result).toMatchInlineSnapshot(`
        {
          "core": [
            {
              "params": [
                "media-1",
                "movie",
                "Title",
                "OT",
                "en",
                "Overview",
                "2020",
                8.5,
                "/p.png",
                "/b.png",
                "2024-01-01T00:00:00.000Z",
                "2024-01-02T00:00:00.000Z",
                1,
                0,
                null,
                2,
              ],
              "sql": "INSERT INTO media_items (
              id, type, title, original_title, original_language, overview, year, rating, poster_path, backdrop_path,
              added_at, updated_at, has_files, progress_pct, last_watched_at, total_episodes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              type = excluded.type,
              title = excluded.title,
              original_title = excluded.original_title,
              original_language = excluded.original_language,
              overview = excluded.overview,
              year = excluded.year,
              rating = excluded.rating,
              poster_path = excluded.poster_path,
              backdrop_path = excluded.backdrop_path,
              added_at = excluded.added_at,
              updated_at = excluded.updated_at,
              has_files = excluded.has_files,
              total_episodes = excluded.total_episodes
            WHERE excluded.updated_at >= media_items.updated_at;",
            },
            {
              "params": [
                "media-1",
                "media-1",
                "2024-01-02T00:00:00.000Z",
              ],
              "sql": "DELETE FROM media_external_ids WHERE media_id = ? AND EXISTS (SELECT 1 FROM media_items WHERE id = ? AND updated_at = ?);",
            },
            {
              "params": [
                "uuid-001",
                "media-1",
                "movie",
                "tmdb",
                "42",
                "media-1",
                "2024-01-02T00:00:00.000Z",
              ],
              "sql": "INSERT OR IGNORE INTO media_external_ids (id, media_id, media_type, source, external_id)
               SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM media_items WHERE id = ? AND updated_at = ?);",
            },
            {
              "params": [
                "uuid-002",
                "media-1",
                "movie",
                "imdb",
                "tt0001",
                "media-1",
                "2024-01-02T00:00:00.000Z",
              ],
              "sql": "INSERT OR IGNORE INTO media_external_ids (id, media_id, media_type, source, external_id)
               SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM media_items WHERE id = ? AND updated_at = ?);",
            },
            {
              "params": [
                "uuid-003",
                "media-1",
                "movie",
                "tvdb",
                "9999",
                "media-1",
                "2024-01-02T00:00:00.000Z",
              ],
              "sql": "INSERT OR IGNORE INTO media_external_ids (id, media_id, media_type, source, external_id)
               SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM media_items WHERE id = ? AND updated_at = ?);",
            },
            {
              "params": [
                "media-1",
                "media-1",
                "2024-01-02T00:00:00.000Z",
              ],
              "sql": "DELETE FROM media_genres WHERE media_id = ? AND EXISTS (SELECT 1 FROM media_items WHERE id = ? AND updated_at = ?);",
            },
            {
              "params": [
                "uuid-004",
                "media-1",
                28,
                "media-1",
                "2024-01-02T00:00:00.000Z",
              ],
              "sql": "INSERT OR IGNORE INTO media_genres (id, media_id, genre_id)
               SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM media_items WHERE id = ? AND updated_at = ?);",
            },
            {
              "params": [
                "uuid-005",
                "media-1",
                18,
                "media-1",
                "2024-01-02T00:00:00.000Z",
              ],
              "sql": "INSERT OR IGNORE INTO media_genres (id, media_id, genre_id)
               SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM media_items WHERE id = ? AND updated_at = ?);",
            },
          ],
          "metadata": [
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_roles WHERE media_id = ?;",
            },
            {
              "params": [
                "p-a",
                "Actor A",
                "/a.png",
              ],
              "sql": "INSERT OR REPLACE INTO people (id, name, profile_path) VALUES (?, ?, ?);",
            },
            {
              "params": [
                "uuid-006",
                "p-a",
                "tmdb",
                "100",
              ],
              "sql": "INSERT OR IGNORE INTO people_external_ids (id, person_id, source, external_id) VALUES (?, ?, ?, ?);",
            },
            {
              "params": [
                "role-a",
                "media-1",
                "p-a",
                "lead",
                0,
              ],
              "sql": "INSERT OR REPLACE INTO media_roles (id, media_id, person_id, role, order_index) VALUES (?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "p-b",
                "Actor B",
                null,
              ],
              "sql": "INSERT OR REPLACE INTO people (id, name, profile_path) VALUES (?, ?, ?);",
            },
            {
              "params": [
                "role-b",
                "media-1",
                "p-b",
                "supporting",
                1,
              ],
              "sql": "INSERT OR REPLACE INTO media_roles (id, media_id, person_id, role, order_index) VALUES (?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_trailers WHERE media_id = ?;",
            },
            {
              "params": [
                "uuid-007",
                "media-1",
                "youtube",
                "yt-1",
                "Trailer 1",
                "en",
              ],
              "sql": "INSERT INTO media_trailers (id, media_id, provider, key, name, language) VALUES (?, ?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_seasons WHERE media_id = ?;",
            },
            {
              "params": [
                "season-1",
                "media-1",
                1,
                "Season 1",
                "S1",
                "/s1.png",
                2,
                "2020-01-01",
              ],
              "sql": "INSERT OR REPLACE INTO media_seasons (id, media_id, season_number, title, overview, poster_path, episode_count, air_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_episodes WHERE media_id = ?;",
            },
            {
              "params": [
                "ep-1",
                "media-1",
                1,
                1,
                "Pilot",
                "E1",
                "/e1.png",
                "2020-01-02",
              ],
              "sql": "INSERT OR REPLACE INTO media_episodes (id, media_id, season_number, episode_number, title, overview, still_path, air_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "ep-2",
                "media-1",
                1,
                2,
                "Episode 2",
                "E2",
                "/e2.png",
                "2020-01-09",
              ],
              "sql": "INSERT OR REPLACE INTO media_episodes (id, media_id, season_number, episode_number, title, overview, still_path, air_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_file_desired_formats WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_files WHERE media_id = ?;",
            },
            {
              "params": [
                "ed-media-1-x-x",
                "media-1",
                null,
                null,
                "2024-01-02T00:00:00.000Z",
              ],
              "sql": "INSERT OR IGNORE INTO media_editions (id, media_id, season, episode, name, name_user_set, duration_seconds, created_at) VALUES (?, ?, ?, ?, '', 0, NULL, ?);",
            },
            {
              "params": [
                "file-1",
                "media-1",
                "title.mkv",
                null,
                null,
                "2024-01-02T00:00:00.000Z",
                "local",
                "ed-media-1-x-x",
                null,
                null,
              ],
              "sql": "INSERT OR REPLACE INTO media_files (id, media_id, filename, season, episode, added_at, status, edition_id, content_sha256, original_size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "uuid-008",
                "media-1",
                "file-1",
                "1080p",
                "h264",
                5000,
              ],
              "sql": "INSERT OR IGNORE INTO media_file_desired_formats (id, media_id, file_id, quality, codec, bitrate_kbps) VALUES (?, ?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "uuid-009",
                "media-1",
                "file-1",
                "720p",
                "h264",
                null,
              ],
              "sql": "INSERT OR IGNORE INTO media_file_desired_formats (id, media_id, file_id, quality, codec, bitrate_kbps) VALUES (?, ?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_skip_markers WHERE media_id = ?;",
            },
            {
              "params": [
                "skip-1",
                "media-1",
                null,
                "intro",
                0,
                30,
                "user",
                0.95,
                "2024-01-02T00:00:00.000Z",
                "2024-01-02T00:00:00.000Z",
              ],
              "sql": "INSERT OR REPLACE INTO media_skip_markers (
                id, media_id, episode_id, type, start_seconds, end_seconds, source, confidence, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
            },
          ],
          "playback": [
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_format_chunks WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_audio_chunks WHERE track_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_audio_tracks WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_subtitles WHERE media_id = ?;",
            },
            {
              "params": [
                "fmt-1",
                "media-1",
                "file-1",
                "1080p",
                "h264",
                "avc1.640028",
                5000,
                "init-1",
                800,
                7200,
                1500000000,
                1500,
                1,
                "media-1",
                "fmt-1",
                "file-1",
                "1080p",
                "fmt-1",
              ],
              "sql": "INSERT OR REPLACE INTO media_formats (
                id, media_id, file_id, quality, codec, codec_string, bitrate_kbps, init_key, init_size, duration_seconds, total_size, size_mb, is_source,
                preview_sheets
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT preview_sheets FROM media_formats WHERE media_id = ? AND (id = ? OR (file_id = ? AND quality = ?)) ORDER BY id = ? DESC LIMIT 1));",
            },
            {
              "params": [
                "uuid-010",
                "fmt-1",
                "c1",
                0,
                100,
                0,
              ],
              "sql": "INSERT OR REPLACE INTO media_format_chunks (id, format_id, chunk_key, order_index, size_bytes, start_seconds) VALUES (?, ?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "uuid-011",
                "fmt-1",
                "c2",
                1,
                200,
                60,
              ],
              "sql": "INSERT OR REPLACE INTO media_format_chunks (id, format_id, chunk_key, order_index, size_bytes, start_seconds) VALUES (?, ?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "media-1",
                "fmt-1",
              ],
              "sql": "DELETE FROM media_formats WHERE media_id = ? AND id NOT IN (?);",
            },
            {
              "params": [
                "chap-1",
                "fmt-1",
                "Chapter 1",
                0,
              ],
              "sql": "INSERT OR REPLACE INTO media_chapters (id, format_id, title, start_seconds) VALUES (?, ?, ?, ?);",
            },
            {
              "params": [
                "audio-1",
                "media-1",
                "file-1",
                null,
                "en",
                "English",
                1,
                "embedded",
                "aac",
                "mp4a.40.2",
                "audio-init-1",
                400,
                7200,
                200000000,
                "2024-01-02T00:00:00.000Z",
              ],
              "sql": "INSERT OR REPLACE INTO media_audio_tracks (
                id, media_id, file_id, episode_id, language, label, is_default, source, codec, codec_string, init_key, init_size, duration_seconds, total_size, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "uuid-012",
                "audio-1",
                "ac1",
                0,
                50,
                0,
              ],
              "sql": "INSERT OR REPLACE INTO media_audio_chunks (id, track_id, chunk_key, order_index, size_bytes, start_seconds) VALUES (?, ?, ?, ?, ?, ?);",
            },
            {
              "params": [
                "sub-1",
                "media-1",
                "file-1",
                null,
                "en",
                "English",
                "obj-1",
                "vtt",
                1,
                "embedded",
                "2024-01-02T00:00:00.000Z",
                null,
              ],
              "sql": "INSERT OR REPLACE INTO media_subtitles (
                id, media_id, file_id, episode_id, language, label, object_key, format, is_default, source, created_at,
                derived_from_subtitle_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
            },
          ],
          "templates": [
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_skip_analysis WHERE media_id = ?;",
            },
          ],
        }
      `);
    } catch (err) {
      dumpOpStatementsSnapshot("media.upsert-full", op, result);
      throw err;
    }
  });

  test("media.upsert (minimal payload — all nested arrays empty)", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: {
        details: {
          ...fullDetails,
          tmdbId: null,
          externalIds: {},
          genres: [],
          cast: [],
          trailers: [],
          seasons: [],
          episodes: [],
          files: [],
          formats: [],
          audioTracks: [],
          subtitles: [],
          chapters: [],
          skipMarkers: [],
        },
      },
    };
    const result = buildForSnapshot("media.upsert-minimal", op);
    try {
      expect(result).toMatchInlineSnapshot(`
        {
          "core": [
            {
              "params": [
                "media-1",
                "movie",
                "Title",
                "OT",
                "en",
                "Overview",
                "2020",
                8.5,
                "/p.png",
                "/b.png",
                "2024-01-01T00:00:00.000Z",
                "2024-01-02T00:00:00.000Z",
                1,
                0,
                null,
                2,
              ],
              "sql": "INSERT INTO media_items (
              id, type, title, original_title, original_language, overview, year, rating, poster_path, backdrop_path,
              added_at, updated_at, has_files, progress_pct, last_watched_at, total_episodes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              type = excluded.type,
              title = excluded.title,
              original_title = excluded.original_title,
              original_language = excluded.original_language,
              overview = excluded.overview,
              year = excluded.year,
              rating = excluded.rating,
              poster_path = excluded.poster_path,
              backdrop_path = excluded.backdrop_path,
              added_at = excluded.added_at,
              updated_at = excluded.updated_at,
              has_files = excluded.has_files,
              total_episodes = excluded.total_episodes
            WHERE excluded.updated_at >= media_items.updated_at;",
            },
            {
              "params": [
                "media-1",
                "media-1",
                "2024-01-02T00:00:00.000Z",
              ],
              "sql": "DELETE FROM media_external_ids WHERE media_id = ? AND EXISTS (SELECT 1 FROM media_items WHERE id = ? AND updated_at = ?);",
            },
            {
              "params": [
                "media-1",
                "media-1",
                "2024-01-02T00:00:00.000Z",
              ],
              "sql": "DELETE FROM media_genres WHERE media_id = ? AND EXISTS (SELECT 1 FROM media_items WHERE id = ? AND updated_at = ?);",
            },
          ],
          "metadata": [
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_roles WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_trailers WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_seasons WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_episodes WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_file_desired_formats WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_files WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_skip_markers WHERE media_id = ?;",
            },
          ],
          "playback": [
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_format_chunks WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_audio_chunks WHERE track_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_audio_tracks WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_subtitles WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_formats WHERE media_id = ?;",
            },
          ],
          "templates": [
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_skip_analysis WHERE media_id = ?;",
            },
          ],
        }
      `);
    } catch (err) {
      dumpOpStatementsSnapshot("media.upsert-minimal", op, result);
      throw err;
    }
  });

  test("media.delete (cascade across all 5 groups)", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "media.delete",
      payload: { mediaId: "media-1" },
    };
    const result = buildForSnapshot("media.delete", op);
    try {
      expect(result).toMatchInlineSnapshot(`
        {
          "core": [
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_external_ids WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_genres WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM playlist_items WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_items WHERE id = ?;",
            },
          ],
          "ingest": [
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM ingest_job_events WHERE job_id IN (SELECT id FROM ingest_jobs WHERE media_id = ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM ingest_jobs WHERE media_id = ?;",
            },
          ],
          "metadata": [
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_roles WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_crew WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_trailers WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_seasons WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_episodes WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_skip_markers WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_file_desired_formats WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_files WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_editions WHERE media_id = ?;",
            },
          ],
          "playback": [
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_format_chunks WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_formats WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_audio_chunks WHERE track_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ?);",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_audio_tracks WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_subtitles WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_local_downloads WHERE media_id = ?;",
            },
          ],
          "templates": [
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM media_skip_analysis WHERE media_id = ?;",
            },
            {
              "params": [
                "media-1",
              ],
              "sql": "DELETE FROM subtitle_ocr_attempts WHERE media_id = ?;",
            },
          ],
        }
      `);
    } catch (err) {
      dumpOpStatementsSnapshot("media.delete", op, result);
      throw err;
    }
  });

  test("media.progress", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "media.progress",
      payload: {
        mediaId: "media-1",
        progressPct: 75,
        lastWatchedAt: "2024-02-01T00:00:00.000Z",
        updatedAt: "2024-02-01T00:00:00.000Z",
      },
    };
    const result = buildForSnapshot("media.progress", op);
    try {
      expect(result).toMatchInlineSnapshot(`
        {
          "core": [
            {
              "params": [
                75,
                "2024-02-01T00:00:00.000Z",
                "media-1",
                "2024-02-01T00:00:00.000Z",
              ],
              "sql": "UPDATE media_items SET progress_pct = ?, last_watched_at = ?
             WHERE id = ? AND (last_watched_at IS NULL OR last_watched_at <= ?);",
            },
          ],
        }
      `);
    } catch (err) {
      dumpOpStatementsSnapshot("media.progress", op, result);
      throw err;
    }
  });

  test("setting.set", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "setting.set",
      payload: { key: "theme", value: "dark", updatedAt: "2024-01-01" },
    };
    const result = buildForSnapshot("setting.set", op);
    try {
      expect(result).toMatchInlineSnapshot(`
        {
          "core": [
            {
              "params": [
                "theme",
                "dark",
                "2024-01-01",
              ],
              "sql": "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
             WHERE excluded.updated_at >= app_settings.updated_at;",
            },
          ],
        }
      `);
    } catch (err) {
      dumpOpStatementsSnapshot("setting.set", op, result);
      throw err;
    }
  });

  test("ingest.job.upsert", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.upsert",
      payload: { job: ingestJob },
    };
    const result = buildForSnapshot("ingest.job.upsert", op);
    try {
      expect(result).toMatchInlineSnapshot(`
      {
        "ingest": [
          {
            "params": [
              "job-1",
              "media-1",
              "file-1",
              "peer-1",
              "client-1",
              "transcode",
              "processing",
              42,
              null,
              null,
              "{"foo":"bar"}",
              "2024-01-01T00:00:00.000Z",
              "2024-01-01T01:00:00.000Z",
              null,
            ],
            "sql": "INSERT INTO ingest_jobs (
            id, media_id, file_id, worker_peer_id, owner_client_id, kind, status, progress_pct,
            error_code, error_message, meta_json, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            media_id = excluded.media_id,
            file_id = excluded.file_id,
            worker_peer_id = excluded.worker_peer_id,
            owner_client_id = excluded.owner_client_id,
            kind = excluded.kind,
            status = excluded.status,
            progress_pct = excluded.progress_pct,
            error_code = excluded.error_code,
            error_message = excluded.error_message,
            meta_json = excluded.meta_json,
            updated_at = excluded.updated_at,
            completed_at = excluded.completed_at;",
          },
        ],
      }
    `);
    } catch (err) {
      dumpOpStatementsSnapshot("ingest.job.upsert", op, result);
      throw err;
    }
  });

  test("ingest.job.delete", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.delete",
      payload: { jobId: "job-1" },
    };
    const result = buildForSnapshot("ingest.job.delete", op);
    try {
      expect(result).toMatchInlineSnapshot(`
      {
        "ingest": [
          {
            "params": [
              "job-1",
            ],
            "sql": "DELETE FROM ingest_job_events WHERE job_id = ?;",
          },
          {
            "params": [
              "job-1",
            ],
            "sql": "DELETE FROM ingest_jobs WHERE id = ?;",
          },
        ],
      }
    `);
    } catch (err) {
      dumpOpStatementsSnapshot("ingest.job.delete", op, result);
      throw err;
    }
  });

  test("ingest.job.event.add", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.event.add",
      payload: { event: ingestEvent },
    };
    const result = buildForSnapshot("ingest.job.event.add", op);
    try {
      expect(result).toMatchInlineSnapshot(`
      {
        "ingest": [
          {
            "params": [
              "evt-1",
              "job-1",
              "info",
              "started",
              "{"stage":"upload"}",
              "2024-01-01T00:00:00.000Z",
            ],
            "sql": "INSERT OR IGNORE INTO ingest_job_events (id, job_id, level, message, meta_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?);",
          },
        ],
      }
    `);
    } catch (err) {
      dumpOpStatementsSnapshot("ingest.job.event.add", op, result);
      throw err;
    }
  });

  test("ingest.job.history.clear", () => {
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.history.clear",
      payload: { mediaId: "media-1" },
    };
    const result = buildForSnapshot("ingest.job.history.clear", op);
    try {
      expect(result).toMatchInlineSnapshot(`
      {
        "ingest": [
          {
            "params": [
              "media-1",
              "completed",
              "failed",
              "cancelled",
            ],
            "sql": "DELETE FROM ingest_job_events
           WHERE job_id IN (
             SELECT id FROM ingest_jobs WHERE media_id = ? AND status IN (?, ?, ?)
           );",
          },
          {
            "params": [
              "media-1",
              "completed",
              "failed",
              "cancelled",
            ],
            "sql": "DELETE FROM ingest_jobs WHERE media_id = ? AND status IN (?, ?, ?);",
          },
        ],
      }
    `);
    } catch (err) {
      dumpOpStatementsSnapshot("ingest.job.history.clear", op, result);
      throw err;
    }
  });
});

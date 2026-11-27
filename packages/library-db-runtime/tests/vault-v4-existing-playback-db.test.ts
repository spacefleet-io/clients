/**
 * @test-id LIB-DB-VAULT-V4-EXISTING-PLAYBACK-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 * @req LIB-FMT-11
 * @why Vault v4 adds `media_chunk_lists` and `media_file_playback` to the base playback DDL and to `PLAYBACK_TABLES`,
 *   which the combined library image (`exportBytes`, `getLocalCacheBytes`) copies table by table. A playback file
 *   created by a build before LIB-FMT-11 does not have them, and its `user_version` is already this build's, so no
 *   migration step adds them. The image must still build — on an instance opened by this build and from the files
 *   alone, before any instance opened them — and the tables are created empty, without a `user_version` bump
 *   (LIB-FMT-13: nothing changes the layout before the switch).
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";
import { getPlaybackDbPath, loadCache } from "../src/libraryDbStorage";

const SUITE = "vault-v4-existing-playback-db";
const log = (label: string, data?: unknown) =>
  console.info(`[${SUITE}:${label}]${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const PACKED_TABLES = ["media_chunk_lists", "media_file_playback"];

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-vault-v4-existing-"));
  process.env.SF_USER_DATA_PATH = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const tablesIn = (db: Database) =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('media_chunk_lists', 'media_file_playback') ORDER BY name;"
    )
    .all()
    .map((row) => row.name);

const userVersion = (db: Database) => db.query<{ user_version: number }, []>("PRAGMA user_version;").get()?.user_version ?? -1;

/** A library written by this build, then its playback file put back to the pre-LIB-FMT-11 DDL. */
const preVaultV4Library = async () => {
  const db = await LibraryDb.openLocal("token", "key");
  db.setSyncEnabled(false);
  const mediaId = await db.addMediaFromCatalog({
    id: 25_411,
    type: "movie",
    title: "Pre Vault V4 Movie",
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
    totalEpisodes: null,
    seasons: [],
    episodes: [],
  });
  await db.setProgress(mediaId, 12);
  const started = Date.now();
  while ((await loadCache()) === null) {
    if (Date.now() - started > 5_000) throw new Error(`[${SUITE}:setup] persist never stamped the cache`);
    // Polls the real idle persist of LibraryDb.
    await Bun.sleep(10);
  }
  db.close();

  const playback = new Database(getPlaybackDbPath());
  try {
    for (const table of PACKED_TABLES) playback.exec(`DROP TABLE ${table};`);
    const state = { tables: tablesIn(playback), userVersion: userVersion(playback) };
    log("pre-v4-playback-file", state);
    expect(state.tables).toEqual([]);
    return { mediaId, userVersion: state.userVersion };
  } finally {
    playback.close();
  }
};

/** Opens a combined image and reads what the test needs from it. */
const readImage = (label: string, bytes: Uint8Array | null, mediaId: string) => {
  expect(bytes).not.toBeNull();
  const imagePath = join(root, `${label}.sqlite`);
  writeFileSync(imagePath, bytes ?? new Uint8Array());
  const image = new Database(imagePath, { readonly: true });
  try {
    const row = image.query<{ title: string }, [string]>("SELECT title FROM media_items WHERE id = ?;").get(mediaId);
    const state = { bytes: bytes?.byteLength ?? 0, title: row?.title ?? null, tables: tablesIn(image) };
    log(`image:${label}`, state);
    return state;
  } finally {
    image.close();
  }
};

describe("an existing playback file without the packed tables (LIB-FMT-11)", () => {
  it("getLocalCacheBytes builds the image from the files alone, creating the empty tables without a version bump", async () => {
    const { mediaId, userVersion: before } = await preVaultV4Library();

    const image = readImage("local-cache", await LibraryDb.getLocalCacheBytes(), mediaId);
    expect(image.title).toBe("Pre Vault V4 Movie");
    expect(image.tables).toEqual(PACKED_TABLES);

    const playback = new Database(getPlaybackDbPath(), { readonly: true });
    try {
      const after = { tables: tablesIn(playback), userVersion: userVersion(playback) };
      log("playback-after-local-cache", { before, ...after });
      expect(after).toEqual({ tables: PACKED_TABLES, userVersion: before });
      expect(playback.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media_chunk_lists;").get()?.n).toBe(0);
    } finally {
      playback.close();
    }
  }, 30_000);

  it("an instance opened by this build creates them on open; exportBytes and getLocalCacheBytes both work", async () => {
    const { mediaId, userVersion: before } = await preVaultV4Library();

    const db = await LibraryDb.openLocal("token", "key");
    try {
      db.setSyncEnabled(false);
      const exported = readImage("export", db.exportBytes(), mediaId);
      expect(exported.title).toBe("Pre Vault V4 Movie");
      expect(exported.tables).toEqual(PACKED_TABLES);
      const cached = readImage("local-cache-open", await LibraryDb.getLocalCacheBytes(), mediaId);
      expect(cached.title).toBe("Pre Vault V4 Movie");
      expect(cached.tables).toEqual(PACKED_TABLES);
    } finally {
      db.close();
    }

    const playback = new Database(getPlaybackDbPath(), { readonly: true });
    try {
      const after = { tables: tablesIn(playback), userVersion: userVersion(playback) };
      log("playback-after-open", { before, ...after });
      expect(after).toEqual({ tables: PACKED_TABLES, userVersion: before });
    } finally {
      playback.close();
    }
  }, 30_000);
});

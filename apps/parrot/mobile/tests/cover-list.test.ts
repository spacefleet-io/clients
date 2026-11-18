/**
 * @test-id PARROT-MOBILE-COVER-LIST-001
 * @level unit
 * @req PAR-META-04[parrot]
 * @why PAR-META-04: the first album list no longer waits for covers. The phone's library module opens a real SQLite
 *   snapshot (node:sqlite standing in for the phone's SQLite): one published before the small cover copy existed
 *   (schema v1) is brought to the current schema in the phone's own copy on open, and the album, artist and song
 *   lists resolve with each album's two cover keys while not one cover has been downloaded (the download never
 *   answers here). Tiles take the small copy, falling back to the large one for albums imported before small copies.
 *   Network, key and files are replaced; the queries, the migration and the cover cache are the real code.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALBUM_COVERS_SQL, parrotCoverThumbKey } from "@space/parrot-core";
import { PARROT_LIBRARY_MIGRATIONS, PARROT_LIBRARY_SCHEMA_VERSION } from "@space/parrot-library-db-definition/migrations";

const state = vi.hoisted(() => ({
  db: null as null | DatabaseSync,
  downloads: [] as string[],
  batches: [] as string[][],
}));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-COVER-LIST-001] ${step}`, JSON.stringify(detail));

// The phone's crypto native module; node's own crypto has the same createHash/randomUUID calls the library uses.
// vi.mock factories are hoisted above imports, so the real module is loaded through vi.importActual.
vi.mock("react-native-quick-crypto", async () => ({ default: await vi.importActual("node:crypto") }));
vi.mock("react-native-fs", () => ({
  default: {
    DocumentDirectoryPath: "/data/app/files",
    CachesDirectoryPath: "/data/app/cache",
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    unlink: async () => undefined,
    exists: async () => false,
  },
}));
vi.mock("react-native-sqlite-storage", () => ({
  default: {
    enablePromise: () => undefined,
    // The phone's SQLite, played by node:sqlite over the snapshot the test built.
    openDatabase: async () => {
      const db = state.db!;
      return {
        executeSql: async (sql: string, params: unknown[] = []) => {
          const rows = db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
          return [{ rows: { length: rows.length, item: (i: number) => rows[i] }, rowsAffected: 0 }];
        },
        sqlBatch: async (statements: string[]) => {
          state.batches.push(statements);
          db.exec("BEGIN");
          for (const sql of statements) db.exec(sql);
          db.exec("COMMIT");
        },
        close: async () => undefined,
      };
    },
  },
}));
// The cover-copy maker (PAR-META-16) reads a picture's size and resizes it with the phone's image codec; no cover is
// picked here, so both natives only need to exist. Platform picks where the library file lives (src/lib/dbPath.ts).
vi.mock("react-native", () => ({ Image: { getSize: async () => ({ width: 0, height: 0 }) }, Platform: { OS: "android" } }));
vi.mock("@bam.tech/react-native-image-resizer", () => ({ default: { createResizedImage: async () => ({ path: "" }) } }));
vi.mock("@space/shared/api", () => ({
  getLibraryDb: async () => ({}),
  // The app's API config (src/config.ts) sets these once at load.
  setApiBaseUrl: () => undefined,
  setApiClientType: () => undefined,
  setStorageTunnelOptions: () => undefined,
  // A cover download that never answers: a list waiting for covers would never resolve.
  downloadStorageObjectViaTunnel: (_token: string, objectKey: string) => {
    state.downloads.push(objectKey);
    return new Promise<Uint8Array>(() => undefined);
  },
}));
vi.mock("@space/mobile-shell/librarySnapshot", () => ({
  openRemoteLibrarySnapshot: async () => ({ dbBytes: new Uint8Array([1]), snapshotVersion: 7 }),
}));
vi.mock("@space/mobile-shell/libraryEnvelope", () => ({ decryptBytesToBytes: async (_key: string, bytes: Uint8Array) => bytes }));
vi.mock("@space/library-db-definition/storageFormat", () => ({ STORAGE_FORMAT_VERSION: 1 }));

import { coverUri, keptCoverUri, listAlbums, listArtistAlbums, listSongs, openLibrary } from "../src/lib/library";
import { phoneCoverSource } from "../src/lib/covers";

/** A snapshot at `version` with three albums: one cover from before small copies, one with both, one with none. */
const snapshot = (version: number) => {
  const db = new DatabaseSync(":memory:");
  for (const sql of PARROT_LIBRARY_MIGRATIONS.slice(0, version).flat()) db.exec(sql);
  db.exec(`PRAGMA user_version = ${version}`);
  db.exec(`INSERT INTO artists (id, name, sort_name) VALUES ('ar-1', 'Juniper Skies', 'Juniper Skies')`);
  const album = db.prepare(`INSERT INTO albums (id, title, album_artist_id, year, cover_object_key, created_at) VALUES (?, ?, 'ar-1', ?, ?, 0)`);
  album.run("al-old", "Apogee", 2019, "assets/large-old");
  album.run("al-new", "Low Orbit", 2021, "assets/large-new");
  album.run("al-none", "No Picture", 2023, null);
  if (version >= 2) db.exec(`UPDATE albums SET cover_thumb_object_key = 'assets/small-new' WHERE id = 'al-new'`);
  const track = db.prepare(`INSERT INTO tracks (id, album_id, number, title, artist_id, duration_ms) VALUES (?, ?, 1, ?, 'ar-1', 1000)`);
  track.run("tr-old", "al-old", "Perigee");
  track.run("tr-new", "al-new", "Escape Velocity");
  track.run("tr-none", "al-none", "Plain");
  return db;
};

describe("the phone's album lists", () => {
  beforeEach(() => {
    state.downloads = [];
    state.batches = [];
  });

  it("brings a snapshot published before small covers to the current schema in the phone's own copy", async () => {
    state.db = snapshot(1);
    const columnsBefore = (state.db.prepare("PRAGMA table_info(albums)").all() as Array<{ name: string }>).map((c) => c.name);
    await openLibrary("token", "library-key");
    const version = (state.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const columnsAfter = (state.db.prepare("PRAGMA table_info(albums)").all() as Array<{ name: string }>).map((c) => c.name);
    log("migrated", { version, batches: state.batches, columnsBefore, columnsAfter });
    expect(columnsBefore).not.toContain("cover_thumb_object_key");
    expect(version).toBe(PARROT_LIBRARY_SCHEMA_VERSION);
    expect(columnsAfter).toContain("cover_thumb_object_key");
    expect(state.batches).toHaveLength(1);
    // The covers query the tiles use now runs on it.
    expect(state.db.prepare(ALBUM_COVERS_SQL).all()).toHaveLength(2);

    const albums = await listAlbums();
    log("albums from v1", albums);
    expect(albums.find((album) => album.id === "al-old")).toMatchObject({ coverObjectKey: "assets/large-old", coverThumbObjectKey: null });
    // An album from before small copies shows its large one in the tile.
    expect(parrotCoverThumbKey(albums.find((album) => album.id === "al-old")!)).toBe("assets/large-old");
    expect(state.downloads).toEqual([]);
  });

  it("resolves the album, artist and song lists with the cover keys while no cover has downloaded yet", async () => {
    state.db = snapshot(PARROT_LIBRARY_SCHEMA_VERSION);
    await openLibrary("token", "library-key");
    expect(state.batches).toHaveLength(0);

    const started = Date.now();
    const albums = await listAlbums();
    const artistAlbums = await listArtistAlbums("ar-1");
    const songs = await listSongs();
    log("lists", { ms: Date.now() - started, albums, artistAlbums: artistAlbums.length, songs, downloads: state.downloads });
    expect(albums.map((album) => album.id)).toEqual(["al-old", "al-new", "al-none"]);
    expect(albums[1]).toMatchObject({ coverObjectKey: "assets/large-new", coverThumbObjectKey: "assets/small-new" });
    expect(albums[2]).toMatchObject({ coverObjectKey: null, coverThumbObjectKey: null });
    expect(artistAlbums).toHaveLength(3);
    expect(songs.find((song) => song.id === "tr-new")).toMatchObject({ coverObjectKey: "assets/large-new", coverThumbObjectKey: "assets/small-new" });
    expect(parrotCoverThumbKey(albums[1]!)).toBe("assets/small-new");
    // Not one cover was asked for: the grid is ready before any picture.
    expect(state.downloads).toEqual([]);

    // A tile then asks for its own (small) picture through the screens' cover source; the list does not wait for it.
    const source = phoneCoverSource();
    expect(source).not.toBeNull();
    void source!.uriFor(parrotCoverThumbKey(albums[1]!));
    // A second tile with the same album shares the download.
    void coverUri("assets/small-new");
    await vi.waitFor(() => expect(state.downloads).toEqual(["assets/small-new"]));
    log("after a tile asked", { downloads: state.downloads, kept: keptCoverUri("assets/small-new") });
    expect(state.downloads).toEqual(["assets/small-new"]);
    expect(keptCoverUri("assets/small-new")).toBeNull();
    expect(await listAlbums()).toHaveLength(3);
  });
});

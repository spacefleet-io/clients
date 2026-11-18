/**
 * @test-id PARROT-INGEST-UPGRADE-001
 * @level integration (real engine, node:sqlite, the driver Parrot desktop's main process uses)
 * @why Updating Parrot desktop from version N to N+1 must keep the user's library. The library file on the computer is
 *   the sealed offline copy (`<userData>/offline/library.sealed`, PAR-OFFL-03) and every snapshot the server hands back
 *   was written by whichever build published it, so build N+1 opens files at an older layout. These tests build each
 *   older layout by running the real migration list cut at that version (no checked-in binary), fill it with
 *   representative rows, then open it through the production opener (`openParrotLibrary`, the call
 *   `apps/parrot/desktop/src/main/index.ts` makes for both the server snapshot and the kept copy) and check it reaches
 *   the current layout with every row intact. A file from a NEWER build is refused with `ParrotLibraryTooNewError`
 *   and its bytes stay untouched.
 * @covers packages/parrot-ingest/src/library.ts
 * @covers packages/parrot-ingest/src/kept.ts
 * @covers packages/parrot-library-db-definition/src/migrations.ts
 * @req LIB-FMT-02 (Parrot equivalent: no Parrot-specific layout rule exists yet)
 * @req PAR-OFFL-03[parrot]
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "bun:test";
import {
  PARROT_LEGACY_ID_COLUMNS,
  PARROT_LIBRARY_MIGRATIONS,
  PARROT_LIBRARY_SCHEMA_VERSION,
  ParrotLibraryTooNewError,
} from "@space/parrot-library-db-definition";
import { openParrotLibraryCopy, saveParrotLibraryCopy } from "../src/kept";
import {
  getParrotFile,
  getParrotLyrics,
  listParrotAlbums,
  listParrotArtists,
  listParrotPlaylists,
  listParrotTracks,
  openParrotLibrary,
  serializeParrotLibrary,
  type ParrotLibraryDb,
} from "../src/library";
import { makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-UPGRADE-001");

/** A library file exactly as a build whose newest step was `version` wrote it: the real steps 1..version, no more. */
const libraryAtVersion = (version: number): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  db.exec("BEGIN");
  for (const sql of PARROT_LIBRARY_MIGRATIONS.slice(0, version).flat()) db.exec(sql);
  db.exec(`PRAGMA user_version = ${version}`);
  db.exec("COMMIT");
  return db;
};

const columnsOf = (db: DatabaseSync | ParrotLibraryDb, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

const userVersion = (db: DatabaseSync | ParrotLibraryDb) =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

/** Rows in every table a version-1 file has: one song with its file, chunks and a setting. Files before schema 10 name
 * their catalog id columns as `PARROT_LEGACY_ID_COLUMNS` says; from schema 10 on they carry the neutral names. */
const seedV1 = (db: DatabaseSync) => {
  const legacy = columnsOf(db, "artists").includes(PARROT_LEGACY_ID_COLUMNS.artists.music_id!);
  const neutral = { artists: { music_id: "music_id" }, albums: { music_id: "music_id", music_edition_id: "music_edition_id" }, tracks: { music_id: "music_id" } };
  const { artists, albums, tracks } = legacy ? PARROT_LEGACY_ID_COLUMNS : neutral;
  db.prepare(`INSERT INTO artists (id, ${artists.music_id}, name, sort_name) VALUES (?, ?, ?, ?)`).run("ar-lp", "artist-lp", "Linnet Park", "Linnet Park");
  db.prepare(
    `INSERT INTO albums (id, title, album_artist_id, year, kind, ${albums.music_id}, ${albums.music_edition_id}, cover_object_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("al-meltway", "Meltway", "ar-lp", 2003, "studio", "album-meltway", "edition-meltway", "media/p1/cover-large", 1_700_000_000_000);
  db.prepare(`INSERT INTO tracks (id, album_id, disc, number, title, artist_id, duration_ms, ${tracks.music_id}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "t-nook",
    "al-meltway",
    1,
    13,
    "Nook",
    "ar-lp",
    187_000,
    "song-nook"
  );
  db.prepare(
    "INSERT INTO track_files (id, track_id, codec, container, mime, lossless, bitrate_kbps, sample_rate, size_bytes, light_copy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("f-nook", "t-nook", "flac", "flac", "audio/flac", 1, 900, 44_100, 2_621_440, 0, 1_700_000_000_000);
  const chunk = db.prepare("INSERT INTO track_file_chunks (track_file_id, idx, object_key, plain_offset, plain_size) VALUES (?, ?, ?, ?, ?)");
  chunk.run("f-nook", 0, "media/p1/nook-0", 0, 2_097_152);
  chunk.run("f-nook", 1, "media/p1/nook-1", 2_097_152, 524_288);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("library.sort", "artist");
};

/** Rows for what versions 2..7 added (cover thumb, playlists, year/genre/lyrics, edited flags, loudness, artist photo). */
const seedV2toV7 = (db: DatabaseSync) => {
  db.prepare("UPDATE albums SET cover_thumb_object_key = ?, genre = ?, year_edited = 1 WHERE id = ?").run("media/p1/cover-thumb", "Nu metal", "al-meltway");
  db.prepare("UPDATE tracks SET year = ?, genre = ?, genre_edited = 1, gain_db = ?, peak = ?, album_gain_db = ?, album_peak = ? WHERE id = ?").run(
    2003,
    "Nu metal",
    -9.5,
    0.98,
    -9.1,
    0.99,
    "t-nook"
  );
  db.prepare("INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run("pl-road", "Road trip", 1_700_000_000_000, 1_700_000_100_000);
  db.prepare("INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES (?, ?, ?)").run("pl-road", 0, "t-nook");
  db.prepare("INSERT INTO lyrics (track_id, plain, synced, source, fetched_at) VALUES (?, ?, ?, ?, ?)").run(
    "t-nook",
    "I left the porch light on for you",
    "[00:22.00] I left the porch light on for you",
    "fetched",
    1_700_000_200_000
  );
  db.prepare(
    "UPDATE artists SET picture_object_key = ?, picture_thumb_object_key = ?, picture_author = ?, picture_licence = ?, picture_licence_url = ?, picture_tried_at = ? WHERE id = ?"
  ).run("media/p1/lp-large", "media/p1/lp-thumb", "Photographer", "CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/", 1_700_000_300_000, "ar-lp");
};

/** What the desktop window reads from the library (main's `libraryResult`), plus one file and one lyrics row. */
const readEverything = (db: ParrotLibraryDb) => ({
  artists: listParrotArtists(db),
  albums: listParrotAlbums(db),
  tracks: listParrotTracks(db),
  playlists: listParrotPlaylists(db),
  file: getParrotFile(db, "f-nook"),
  lyrics: getParrotLyrics(db, "t-nook"),
  settings: db.prepare("SELECT key, value FROM settings ORDER BY key").all(),
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("Parrot library across an app update", () => {
  it("a version-7 library (the layout before this build) opens at the current layout with every row kept", () => {
    expect(PARROT_LIBRARY_SCHEMA_VERSION).toBeGreaterThan(7);
    const old = libraryAtVersion(7);
    seedV1(old);
    seedV2toV7(old);
    const before = {
      version: userVersion(old),
      albumColumns: columnsOf(old, "albums"),
      trackColumns: columnsOf(old, "tracks"),
    };
    log("phase old-file", before);
    expect(before.version).toBe(7);
    expect(before.albumColumns).not.toContain("tracklist");
    expect(before.trackColumns).not.toContain("unidentified");
    const bytes = new Uint8Array(old.serialize());
    old.close();

    const db = openParrotLibrary(bytes);
    const after = { version: userVersion(db), albumColumns: columnsOf(db, "albums"), trackColumns: columnsOf(db, "tracks") };
    const state = readEverything(db);
    log("phase opened-by-new-build", { ...after, state });
    expect(after.version).toBe(PARROT_LIBRARY_SCHEMA_VERSION);
    expect(after.albumColumns).toContain("tracklist");
    expect(after.trackColumns).toContain("unidentified");

    expect(state.artists).toEqual([
      {
        id: "ar-lp",
        name: "Linnet Park",
        albumCount: 1,
        trackCount: 1,
        pictureObjectKey: "media/p1/lp-large",
        pictureThumbObjectKey: "media/p1/lp-thumb",
        pictureAuthor: "Photographer",
        pictureLicence: "CC BY-SA 4.0",
        pictureLicenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      },
    ]);
    expect(state.albums).toEqual([
      {
        id: "al-meltway",
        title: "Meltway",
        artistId: "ar-lp",
        artistName: "Linnet Park",
        year: 2003,
        trackCount: 1,
        coverObjectKey: "media/p1/cover-large",
        coverThumbObjectKey: "media/p1/cover-thumb",
        addedAt: 1_700_000_000_000,
        tracklist: null,
      },
    ]);
    expect(state.tracks).toHaveLength(1);
    expect(state.tracks[0]).toMatchObject({
      id: "t-nook",
      title: "Nook",
      albumId: "al-meltway",
      artistId: "ar-lp",
      number: 13,
      durationMs: 187_000,
      unidentified: false,
    });
    // Columns the listing does not expose are checked on the row itself.
    expect(db.prepare("SELECT year, genre, genre_edited, gain_db, peak, album_gain_db, album_peak, unidentified FROM tracks WHERE id = 't-nook'").get()).toEqual({
      year: 2003,
      genre: "Nu metal",
      genre_edited: 1,
      gain_db: -9.5,
      peak: 0.98,
      album_gain_db: -9.1,
      album_peak: 0.99,
      unidentified: null,
    });
    expect(db.prepare("SELECT genre, year_edited, genre_edited FROM albums WHERE id = 'al-meltway'").get()).toEqual({
      genre: "Nu metal",
      year_edited: 1,
      genre_edited: 0,
    });
    expect(state.playlists.find((playlist) => playlist.id === "pl-road")).toMatchObject({ name: "Road trip", trackIds: ["t-nook"] });
    expect(state.file).toMatchObject({ id: "f-nook", trackId: "t-nook", mime: "audio/flac", sizeBytes: 2_621_440 });
    expect(state.file?.chunks).toEqual([
      { idx: 0, objectKey: "media/p1/nook-0", plainOffset: 0, plainSize: 2_097_152 },
      { idx: 1, objectKey: "media/p1/nook-1", plainOffset: 2_097_152, plainSize: 524_288 },
    ]);
    expect(state.lyrics).toMatchObject({
      fetched: true,
      plain: "I left the porch light on for you",
      synced: [{ ms: 22_000, text: "I left the porch light on for you" }],
    });
    expect(state.settings).toEqual([{ key: "library.sort", value: "artist" }]);

    // The upgraded file round-trips: what N+1 keeps (and publishes) opens again unchanged, with no further step.
    const again = openParrotLibrary(serializeParrotLibrary(db));
    log("phase reopen", { version: userVersion(again) });
    expect(userVersion(again)).toBe(PARROT_LIBRARY_SCHEMA_VERSION);
    expect(readEverything(again)).toEqual(state);
    again.close();
    db.close();
  });

  it("every older layout, from version 1 on, opens at the current layout and keeps its songs", () => {
    for (let version = 1; version < PARROT_LIBRARY_SCHEMA_VERSION; version += 1) {
      const old = libraryAtVersion(version);
      seedV1(old);
      const db = openParrotLibrary(new Uint8Array(old.serialize()));
      old.close();
      const state = readEverything(db);
      log(`phase from-v${version}`, {
        version: userVersion(db),
        tracks: state.tracks.map((t) => t.title),
        chunks: state.file?.chunks.length,
        settings: state.settings,
      });
      expect(userVersion(db)).toBe(PARROT_LIBRARY_SCHEMA_VERSION);
      expect(state.artists.map((a) => a.name)).toEqual(["Linnet Park"]);
      expect(state.albums.map((a) => [a.title, a.coverObjectKey])).toEqual([["Meltway", "media/p1/cover-large"]]);
      expect(state.tracks.map((t) => [t.title, t.number, t.durationMs])).toEqual([["Nook", 13, 187_000]]);
      expect(state.file?.chunks.map((c) => c.objectKey)).toEqual(["media/p1/nook-0", "media/p1/nook-1"]);
      expect(state.settings).toEqual([{ key: "library.sort", value: "artist" }]);
      // @req META-SRC-09[parrot]: the catalog ids an older file kept under its old column names survive in the neutral ones.
      expect(
        db
          .prepare(
            "SELECT ar.music_id AS artist, al.music_id AS album, al.music_edition_id AS edition, t.music_id AS song FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.artist_id"
          )
          .get()
      ).toEqual({ artist: "artist-lp", album: "album-meltway", edition: "edition-meltway", song: "song-nook" });
      db.close();
    }
  });

  it("the sealed offline copy an older build kept opens with the library key after the update and reaches the current layout", async () => {
    const dir = await makeTempDir("upgrade-kept-copy");
    const key = randomBytes(32).toString("base64");
    const old = libraryAtVersion(7);
    seedV1(old);
    seedV2toV7(old);
    const oldBytes = new Uint8Array(old.serialize());
    old.close();
    // Build N kept it (what `keepLibraryCopy` in apps/parrot/desktop/src/main/index.ts does), snapshot version 41.
    await saveParrotLibraryCopy(dir, key, oldBytes, 41);
    log("phase kept-by-old-build", { files: await fs.readdir(dir), bytes: oldBytes.length });

    // Build N+1 starts with no connection: the offline branch of `loadLibrary`.
    const copy = await openParrotLibraryCopy(dir, key);
    log("phase opened-copy", { version: copy?.version, bytes: copy?.dbBytes.length });
    expect(copy?.version).toBe(41);
    expect(sha(copy!.dbBytes)).toBe(sha(oldBytes));
    const db = openParrotLibrary(copy!.dbBytes);
    const state = readEverything(db);
    log("phase migrated-copy", { version: userVersion(db), tracks: state.tracks.length, playlists: state.playlists.length });
    expect(userVersion(db)).toBe(PARROT_LIBRARY_SCHEMA_VERSION);
    expect(state.tracks.map((t) => t.title)).toEqual(["Nook"]);
    expect(state.playlists.find((p) => p.id === "pl-road")?.trackIds).toEqual(["t-nook"]);
    expect(state.lyrics?.plain).toBe("I left the porch light on for you");
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a library from a newer build is refused, not migrated, and its kept copy stays byte for byte", async () => {
    const dir = await makeTempDir("upgrade-too-new");
    const key = randomBytes(32).toString("base64");
    const newer = libraryAtVersion(PARROT_LIBRARY_SCHEMA_VERSION);
    seedV1(newer);
    // A future step this build does not know: one more column and the next version number.
    newer.exec("ALTER TABLE tracks ADD COLUMN future_column TEXT");
    newer.exec(`PRAGMA user_version = ${PARROT_LIBRARY_SCHEMA_VERSION + 1}`);
    const newerBytes = new Uint8Array(newer.serialize());
    newer.close();
    await saveParrotLibraryCopy(dir, key, newerBytes, 99);
    const sealedBefore = sha(new Uint8Array(await fs.readFile(path.join(dir, "library.sealed"))));

    let refused: unknown = null;
    try {
      openParrotLibrary(newerBytes).close();
    } catch (error) {
      refused = error;
    }
    log("phase refused", { error: refused instanceof Error ? `${refused.name}: ${refused.message}` : refused });
    expect(refused).toBeInstanceOf(ParrotLibraryTooNewError);
    expect(refused instanceof ParrotLibraryTooNewError ? refused.fileVersion : null).toBe(PARROT_LIBRARY_SCHEMA_VERSION + 1);

    // Nothing was written back: the kept copy is the newer build's, so updating again opens it.
    const sealedAfter = sha(new Uint8Array(await fs.readFile(path.join(dir, "library.sealed"))));
    const copy = await openParrotLibraryCopy(dir, key);
    log("phase kept-copy-untouched", { sealedBefore, sealedAfter, sameBytes: copy ? sha(copy.dbBytes) === sha(newerBytes) : null });
    expect(sealedAfter).toBe(sealedBefore);
    expect(sha(copy!.dbBytes)).toBe(sha(newerBytes));
    await fs.rm(dir, { recursive: true, force: true });
  });
});

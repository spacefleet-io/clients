/**
 * @test-id PARROT-LIB-DB-001
 * @level unit
 * @why Every Parrot client builds its library file from these DDL strings and applies changes
 *   with `buildParrotOpStatements`. These tests run both on a real SQLite engine, pin the DDL to
 *   the Drizzle schema, and pin that a song's original file maps to ordered whole-file chunks.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  buildParrotOpStatements,
  createParrotOp,
  PARROT_LIBRARY_SCHEMA_VERSION,
  PARROT_LIBRARY_WHOLE_FILES_SCHEMA_VERSION,
  isSplitTrackFile,
  parrotLibraryMigrationStatements,
  parseParrotTracklist,
  ParrotLibraryTooNewError,
  parrotTableGroups,
  parrotTables,
  UnknownParrotOpTypeError,
  type ParrotLibraryOp,
} from "../src";

const meta = { id: "op-1", createdAt: "2026-11-06T00:00:00.000Z" };

const openLibrary = (target?: number) => {
  const db = new Database(":memory:");
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  db.transaction(() => {
    for (const sql of parrotLibraryMigrationStatements(version, target)) db.run(sql);
  })();
  return db;
};

const userVersion = (db: Database) => db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;

const apply = (db: Database, op: ParrotLibraryOp) =>
  db.transaction(() => {
    for (const statements of Object.values(buildParrotOpStatements(op))) {
      for (const { sql, params } of statements ?? []) db.prepare(sql).run(...(params as never[]));
    }
  })();

const count = (db: Database, table: string) =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;

const nook = {
  artist: { id: "ar-lp", musicId: null, name: "Linnet Park", sortName: "Linnet Park" },
  album: {
    id: "al-meltway",
    title: "Meltway",
    albumArtistId: "ar-lp",
    year: 2003,
    kind: "studio" as const,
    musicId: null,
    musicEditionId: null,
    coverObjectKey: null,
    coverThumbObjectKey: null,
    createdAt: 1_762_387_200_000,
  },
  track: {
    id: "tr-nook",
    albumId: "al-meltway",
    disc: 1,
    number: 13,
    title: "Nook",
    artistId: "ar-lp",
    durationMs: 185_000,
    musicId: null,
  },
  file: {
    id: "tf-nook",
    trackId: "tr-nook",
    codec: "mp3",
    container: "mp3",
    mime: "audio/mpeg",
    lossless: false,
    bitrateKbps: 320,
    sampleRate: 44_100,
    sizeBytes: 2_621_440,
    lightCopy: false,
    createdAt: 1_762_387_200_000,
  },
  chunks: [
    { idx: 0, objectKey: "media/p1/nook-0", plainOffset: 0, plainSize: 1_048_576 },
    { idx: 1, objectKey: "media/p1/nook-1", plainOffset: 1_048_576, plainSize: 1_048_576 },
    { idx: 2, objectKey: "media/p1/nook-2", plainOffset: 2_097_152, plainSize: 524_288 },
  ],
};

const seedNook = (db: Database) => {
  apply(db, createParrotOp("artist.upsert", nook.artist, meta));
  apply(db, createParrotOp("album.upsert", nook.album, meta));
  apply(db, createParrotOp("track.upsert", nook.track, meta));
  apply(db, createParrotOp("track_file.upsert", { file: nook.file, chunks: nook.chunks }, meta));
};

describe("parrot library schema", () => {
  it("builds a current file whose tables and columns match the Drizzle schema", () => {
    const db = openLibrary(PARROT_LIBRARY_SCHEMA_VERSION);
    expect(userVersion(db)).toBe(PARROT_LIBRARY_SCHEMA_VERSION);
    for (const table of Object.values(parrotTables) as SQLiteTable[]) {
      const config = getTableConfig(table);
      const columns = db
        .query<{ name: string; notnull: number }, []>(`PRAGMA table_info(${config.name})`)
        .all()
        .map((c) => `${c.name}:${c.notnull}`)
        .sort();
      const expected = config.columns
        .map((c) => `${c.name}:${c.notNull || c.primary ? 1 : 0}`)
        .sort();
      // A composite primary key leaves its columns `notNull` in Drizzle; SQLite reports them as such.
      expect({ table: config.name, columns }).toEqual({ table: config.name, columns: expected });
    }
  });

  it("puts every table in exactly one library group", () => {
    const names = (Object.values(parrotTables) as SQLiteTable[]).map((t) => getTableConfig(t).name).sort();
    expect(Object.keys(parrotTableGroups).sort()).toEqual(names);
  });

  // @req API-VER-01: a library stays at schema 10 until an import stores a song in parts, so an account that is not
  // switched to songs in parts never reaches the schema released apps refuse.
  it("opens a new file at the whole-file schema by default and moves to the current one only when asked", () => {
    const db = openLibrary();
    expect(userVersion(db)).toBe(PARROT_LIBRARY_WHOLE_FILES_SCHEMA_VERSION);
    expect(parrotLibraryMigrationStatements(PARROT_LIBRARY_WHOLE_FILES_SCHEMA_VERSION)).toEqual([]);
    db.transaction(() => {
      for (const sql of parrotLibraryMigrationStatements(PARROT_LIBRARY_WHOLE_FILES_SCHEMA_VERSION, PARROT_LIBRARY_SCHEMA_VERSION)) db.run(sql);
    })();
    expect(userVersion(db)).toBe(PARROT_LIBRARY_SCHEMA_VERSION);
  });

  it("migrates nothing on a current file and refuses a newer one", () => {
    expect(parrotLibraryMigrationStatements(PARROT_LIBRARY_SCHEMA_VERSION)).toEqual([]);
    expect(() => parrotLibraryMigrationStatements(PARROT_LIBRARY_SCHEMA_VERSION + 1)).toThrow(ParrotLibraryTooNewError);
  });
});

describe("parrot library ops", () => {
  // @bugfix @req PAR-META-04: every song's import carries its album row with no cover; it must not wipe the cover an
  // earlier song's picture gave the album, while a new cover still replaces the old one.
  it("keeps an album's cover when a later upsert carries none, and takes a new one", () => {
    const db = openLibrary();
    const cover = () =>
      db.query<{ cover: string | null }, [string]>("SELECT cover_object_key AS cover FROM albums WHERE id = ?").get(nook.album.id)?.cover;
    apply(db, createParrotOp("artist.upsert", nook.artist, meta));
    apply(db, createParrotOp("album.upsert", { ...nook.album, coverObjectKey: "assets/cover-1" }, meta));
    console.info("[parrot-ops] cover after first song", cover());
    apply(db, createParrotOp("album.upsert", { ...nook.album, coverObjectKey: null, year: 2004 }, meta));
    console.info("[parrot-ops] cover after a song without a picture", cover());
    expect(cover()).toBe("assets/cover-1");
    expect(db.query<{ year: number }, []>("SELECT year FROM albums").get()?.year).toBe(2004);
    apply(db, createParrotOp("album.upsert", { ...nook.album, coverObjectKey: "assets/cover-2" }, meta));
    expect(cover()).toBe("assets/cover-2");
  });

  // @req PAR-META-04: the small copy travels with the large one: kept when an upsert carries no cover, replaced (or
  // cleared, for a picture too small to need one) when a new cover comes.
  it("keeps the small cover copy with the large one", () => {
    const db = openLibrary();
    const covers = () =>
      db
        .query<{ large: string | null; thumb: string | null }, [string]>(
          "SELECT cover_object_key AS large, cover_thumb_object_key AS thumb FROM albums WHERE id = ?"
        )
        .get(nook.album.id);
    apply(db, createParrotOp("artist.upsert", nook.artist, meta));
    apply(db, createParrotOp("album.upsert", { ...nook.album, coverObjectKey: "assets/l1", coverThumbObjectKey: "assets/t1" }, meta));
    apply(db, createParrotOp("album.upsert", { ...nook.album, coverObjectKey: null, coverThumbObjectKey: null }, meta));
    console.info("[parrot-ops] covers after a song without a picture", covers());
    expect(covers()).toEqual({ large: "assets/l1", thumb: "assets/t1" });
    apply(db, createParrotOp("album.upsert", { ...nook.album, coverObjectKey: "assets/l2", coverThumbObjectKey: null }, meta));
    console.info("[parrot-ops] covers after a small new cover", covers());
    expect(covers()).toEqual({ large: "assets/l2", thumb: null });
  });

  // @req PAR-META-15: an artist's photo, its credit and the time it was asked for survive an import's upsert, which
  // carries none of them; a new photo replaces both copies and the credit.
  it("keeps an artist's photo, credit and asked time when a later upsert carries none, and takes a new photo", () => {
    const db = openLibrary();
    const picture = () =>
      db
        .query<{ large: string | null; thumb: string | null; author: string | null; licence: string | null; url: string | null; tried: number | null }, [string]>(
          `SELECT picture_object_key AS large, picture_thumb_object_key AS thumb, picture_author AS author, picture_licence AS licence,
                  picture_licence_url AS url, picture_tried_at AS tried FROM artists WHERE id = ?`
        )
        .get(nook.artist.id);
    apply(db, createParrotOp("artist.upsert", nook.artist, meta));
    expect(picture()).toEqual({ large: null, thumb: null, author: null, licence: null, url: null, tried: null });
    apply(db, createParrotOp("artist.upsert", { ...nook.artist, pictureTriedAt: 100 }, meta));
    expect(picture()?.tried).toBe(100);
    const credit = { author: "Jane Doe", licence: "CC BY-SA 4.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0" };
    apply(db, createParrotOp("artist.upsert", { ...nook.artist, pictureObjectKey: "assets/p1", pictureThumbObjectKey: "assets/pt1", pictureCredit: credit, pictureTriedAt: 200 }, meta));
    apply(db, createParrotOp("artist.upsert", { ...nook.artist, name: "Linnet Park" }, meta));
    console.info("[parrot-ops] artist picture after an import's upsert", picture());
    expect(picture()).toEqual({ large: "assets/p1", thumb: "assets/pt1", author: "Jane Doe", licence: "CC BY-SA 4.0", url: credit.licenceUrl, tried: 200 });
    apply(db, createParrotOp("artist.upsert", { ...nook.artist, pictureObjectKey: "assets/p2", pictureThumbObjectKey: null, pictureCredit: null, pictureTriedAt: 300 }, meta));
    expect(picture()).toEqual({ large: "assets/p2", thumb: null, author: null, licence: null, url: null, tried: 300 });
  });

  it("@req PAR-FMT-01 stores a song's original file as ordered whole-file chunks", () => {
    const db = openLibrary();
    seedNook(db);
    const row = db
      .query<{ title: string; artist: string; album: string; mime: string; size_bytes: number }, []>(
        `SELECT t.title, ar.name AS artist, al.title AS album, f.mime, f.size_bytes
         FROM tracks t JOIN artists ar ON ar.id = t.artist_id JOIN albums al ON al.id = t.album_id
         JOIN track_files f ON f.track_id = t.id`
      )
      .get();
    expect(row).toEqual({ title: "Nook", artist: "Linnet Park", album: "Meltway", mime: "audio/mpeg", size_bytes: 2_621_440 });
    const chunks = db
      .query<{ object_key: string; plain_offset: number; plain_size: number }, []>(
        "SELECT object_key, plain_offset, plain_size FROM track_file_chunks WHERE track_file_id = 'tf-nook' ORDER BY idx"
      )
      .all();
    expect(chunks.map((c) => c.object_key)).toEqual(["media/p1/nook-0", "media/p1/nook-1", "media/p1/nook-2"]);
    expect(chunks.reduce((sum, c) => sum + c.plain_size, 0)).toBe(nook.file.sizeBytes);
  });

  it("upserts idempotently and replaces a file's chunk rows", () => {
    const db = openLibrary();
    seedNook(db);
    seedNook(db);
    expect([count(db, "artists"), count(db, "albums"), count(db, "tracks"), count(db, "track_files")]).toEqual([1, 1, 1, 1]);
    expect(count(db, "track_file_chunks")).toBe(3);

    apply(db, createParrotOp("track.upsert", { ...nook.track, title: "Nook (Live)" }, meta));
    expect(db.query<{ title: string }, []>("SELECT title FROM tracks").get()?.title).toBe("Nook (Live)");

    apply(db, createParrotOp("track_file.upsert", { file: nook.file, chunks: nook.chunks.slice(0, 1) }, meta));
    expect(count(db, "track_file_chunks")).toBe(1);
  });

  it("deletes an album with its tracks, files and chunks", () => {
    const db = openLibrary();
    seedNook(db);
    apply(db, createParrotOp("album.delete", { id: "al-meltway" }, meta));
    expect([count(db, "albums"), count(db, "tracks"), count(db, "track_files"), count(db, "track_file_chunks")]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(count(db, "artists")).toBe(1);
  });

  it("@req PAR-META-16 keeps a song's and an album's year and genre when a later upsert carries none", () => {
    const db = openLibrary();
    seedNook(db);
    apply(db, createParrotOp("track.upsert", { ...nook.track, year: 2004, genre: "Nu metal" }, meta));
    apply(db, createParrotOp("album.upsert", { ...nook.album, genre: "Rock" }, meta));
    // A re-import carries the rows without year or genre: the user's values stay (PAR-META-11).
    seedNook(db);
    const track = db.query("SELECT year, genre FROM tracks WHERE id = 'tr-nook'").get();
    const album = db.query("SELECT genre FROM albums WHERE id = 'al-meltway'").get();
    console.log("[PARROT-OPS-GENRE] track", track, "album", album);
    expect(track).toEqual({ year: 2004, genre: "Nu metal" });
    expect(album).toEqual({ genre: "Rock" });
  });

  it("@req PAR-LIB-03 stores, replaces and deletes a song's lyrics, and drops them with the song or its album", () => {
    const db = openLibrary();
    seedNook(db);
    const lyrics = { trackId: "tr-nook", plain: "I'm tired", synced: null, source: "fetched", fetchedAt: 1 };
    apply(db, createParrotOp("lyrics.set", lyrics, meta));
    apply(db, createParrotOp("lyrics.set", { ...lyrics, synced: "[00:01.00]I'm awake", fetchedAt: 2 }, meta));
    const row = db.query("SELECT plain, synced, source, fetched_at FROM lyrics").get();
    console.log("[PARROT-OPS-LYRICS] row", row);
    expect(row).toEqual({ plain: "I'm tired", synced: "[00:01.00]I'm awake", source: "fetched", fetched_at: 2 });
    apply(db, createParrotOp("lyrics.delete", { trackId: "tr-nook" }, meta));
    expect(count(db, "lyrics")).toBe(0);
    apply(db, createParrotOp("lyrics.set", lyrics, meta));
    apply(db, createParrotOp("track.delete", { id: "tr-nook" }, meta));
    expect(count(db, "lyrics")).toBe(0);
    seedNook(db);
    apply(db, createParrotOp("lyrics.set", lyrics, meta));
    apply(db, createParrotOp("album.delete", { id: "al-meltway" }, meta));
    expect(count(db, "lyrics")).toBe(0);
  });

  it("deletes a track or a single file with its chunks", () => {
    const db = openLibrary();
    seedNook(db);
    apply(db, createParrotOp("track_file.delete", { id: "tf-nook" }, meta));
    expect([count(db, "tracks"), count(db, "track_files"), count(db, "track_file_chunks")]).toEqual([1, 0, 0]);
    seedNook(db);
    apply(db, createParrotOp("track.delete", { id: "tr-nook" }, meta));
    expect([count(db, "tracks"), count(db, "track_files"), count(db, "track_file_chunks")]).toEqual([0, 0, 0]);
  });

  // @req PAR-PL-01
  it("creates, renames, fills and deletes a playlist", () => {
    const db = openLibrary();
    seedNook(db);
    apply(db, createParrotOp("playlist.upsert", { id: "pl-1", name: "Road", createdAt: 1, updatedAt: 1 }, meta));
    apply(db, createParrotOp("playlist.upsert", { id: "pl-1", name: "Road trip", createdAt: 9, updatedAt: 2 }, meta));
    expect(db.query<{ name: string; created_at: number }, []>("SELECT name, created_at FROM playlists").all()).toEqual([{ name: "Road trip", created_at: 1 }]);
    apply(db, createParrotOp("playlist_tracks.set", { playlistId: "pl-1", trackIds: ["tr-nook", "tr-x", "tr-nook"] }, meta));
    apply(db, createParrotOp("playlist_tracks.set", { playlistId: "pl-1", trackIds: ["tr-x", "tr-nook"] }, meta));
    const order = () => db.query<{ track_id: string }, []>("SELECT track_id FROM playlist_tracks ORDER BY position").all().map((r) => r.track_id);
    expect(order()).toEqual(["tr-x", "tr-nook"]);
    // A song that leaves the library leaves the playlists too.
    apply(db, createParrotOp("track.delete", { id: "tr-nook" }, meta));
    expect(order()).toEqual(["tr-x"]);
    apply(db, createParrotOp("playlist.delete", { id: "pl-1" }, meta));
    expect([count(db, "playlists"), count(db, "playlist_tracks")]).toEqual([0, 0]);
  });

  it("@req PAR-LIB-05[parrot] stores an album's tracklist, keeps it when a later upsert carries none, and keeps a song's unidentified flag", () => {
    const db = openLibrary();
    const tracklist = [
      { disc: 1, number: 1, title: "Forecast", durationMs: 13_000 },
      { disc: 1, number: 13, title: "Nook", durationMs: 185_000 },
    ];
    const readAlbum = () => db.query<{ tracklist: string | null }, []>("SELECT tracklist FROM albums WHERE id = 'al-meltway'").get();
    const readFlag = () => db.query<{ unidentified: number | null }, []>("SELECT unidentified FROM tracks WHERE id = 'tr-nook'").get();
    seedNook(db);
    console.info("[PARROT-LIB-DB-001 tracklist] after seed:", readAlbum(), readFlag());
    expect(readAlbum()?.tracklist).toBeNull();
    expect(readFlag()?.unidentified).toBeNull();
    // An album stored without a tracklist takes the one a later match brings.
    apply(db, createParrotOp("album.upsert", { ...nook.album, tracklist }, meta));
    expect(parseParrotTracklist(readAlbum()?.tracklist)).toEqual(tracklist);
    // A later song without a match (no tracklist, or an empty one) leaves it.
    apply(db, createParrotOp("album.upsert", nook.album, meta));
    apply(db, createParrotOp("album.upsert", { ...nook.album, tracklist: [] }, meta));
    console.info("[PARROT-LIB-DB-001 tracklist] after upserts without one:", readAlbum());
    expect(parseParrotTracklist(readAlbum()?.tracklist)).toEqual(tracklist);
    apply(db, createParrotOp("track.upsert", { ...nook.track, unidentified: true }, meta));
    expect(readFlag()?.unidentified).toBe(1);
    // An edit carries no flag and keeps it; identifying the song clears it.
    apply(db, createParrotOp("track.upsert", nook.track, meta));
    expect(readFlag()?.unidentified).toBe(1);
    apply(db, createParrotOp("track.upsert", { ...nook.track, unidentified: false }, meta));
    console.info("[PARROT-LIB-DB-001 tracklist] flag after identify:", readFlag());
    expect(readFlag()?.unidentified).toBe(0);
  });

  it("reads a tracklist column leniently: unknown, broken or empty JSON is no tracklist", () => {
    expect(parseParrotTracklist(null)).toBeNull();
    expect(parseParrotTracklist("not json")).toBeNull();
    expect(parseParrotTracklist("[]")).toBeNull();
    expect(parseParrotTracklist('{"disc":1}')).toBeNull();
    expect(parseParrotTracklist('[{"disc":1,"number":2,"title":"B","durationMs":null,"extra":1},{"disc":"x"}]')).toEqual([
      { disc: 1, number: 2, title: "B", durationMs: null },
    ]);
  });

  it("sets a setting and overwrites it", () => {
    const db = openLibrary();
    apply(db, createParrotOp("setting.set", { key: "volume.normalize", value: "on" }, meta));
    apply(db, createParrotOp("setting.set", { key: "volume.normalize", value: "off" }, meta));
    expect(db.query<{ value: string }, []>("SELECT value FROM settings").all()).toEqual([{ value: "off" }]);
  });

  it("refuses an op type it has no builder for", () => {
    const op = { ...meta, type: "track.rate", payload: {} } as unknown as ParrotLibraryOp;
    expect(() => buildParrotOpStatements(op)).toThrow(UnknownParrotOpTypeError);
  });

  it("routes catalog and playback rows to their groups", () => {
    const built = buildParrotOpStatements(
      createParrotOp("track_file.upsert", { file: nook.file, chunks: nook.chunks.slice(0, 1) }, meta)
    );
    expect(built).toMatchInlineSnapshot(`
      {
        "playback": [
          {
            "params": [
              "tf-nook",
              "tr-nook",
              "mp3",
              "mp3",
              "audio/mpeg",
              0,
              320,
              44100,
              2621440,
              0,
              1762387200000,
            ],
            "sql": 
      "INSERT INTO track_files (id, track_id, codec, container, mime, lossless, bitrate_kbps, sample_rate, size_bytes, light_copy, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET track_id = excluded.track_id, codec = excluded.codec, container = excluded.container,
        mime = excluded.mime, lossless = excluded.lossless, bitrate_kbps = excluded.bitrate_kbps,
        sample_rate = excluded.sample_rate, size_bytes = excluded.size_bytes, light_copy = excluded.light_copy"
      ,
          },
          {
            "params": [
              "tf-nook",
            ],
            "sql": "DELETE FROM track_file_chunks WHERE track_file_id = ?",
          },
          {
            "params": [
              "tf-nook",
              0,
              "media/p1/nook-0",
              0,
              1048576,
            ],
            "sql": "INSERT INTO track_file_chunks (track_file_id, idx, object_key, plain_offset, plain_size) VALUES (?, ?, ?, ?, ?)",
          },
        ],
      }
    `);
    expect(Object.keys(buildParrotOpStatements(createParrotOp("track.delete", { id: "t" }, meta))).sort()).toEqual([
      "catalog",
      "playback",
    ]);
  });

  // @req API-VER-01: a song stored whole touches only schema 10's columns, so it applies to a library still at
  // schema 10; a song in parts writes its layout and needs schema 11.
  it("writes a song stored whole with schema 10's columns and a song in parts with its layout", () => {
    const split = { ...nook.file, headerBytes: 56_022, sourceSizeBytes: 8_793_338, tagsObjectKey: "media/p1/nook-tags" };
    expect(isSplitTrackFile(nook.file)).toBe(false);
    expect(isSplitTrackFile(split)).toBe(true);

    const atTen = openLibrary();
    seedNook(atTen);
    expect(userVersion(atTen)).toBe(PARROT_LIBRARY_WHOLE_FILES_SCHEMA_VERSION);
    expect(atTen.query("SELECT id, size_bytes FROM track_files").all()).toEqual([{ id: "tf-nook", size_bytes: 2_621_440 }]);
    expect(() => apply(atTen, createParrotOp("track_file.upsert", { file: split, chunks: nook.chunks }, meta))).toThrow(/header_bytes/);

    const atEleven = openLibrary(PARROT_LIBRARY_SCHEMA_VERSION);
    seedNook(atEleven);
    apply(atEleven, createParrotOp("track_file.upsert", { file: split, chunks: nook.chunks }, meta));
    expect(atEleven.query("SELECT header_bytes, source_size_bytes, tags_object_key FROM track_files").all()).toEqual([
      { header_bytes: 56_022, source_size_bytes: 8_793_338, tags_object_key: "media/p1/nook-tags" },
    ]);
  });
});

/**
 * @test-id PARROT-LIB-DB-LEGACY-001
 * @level unit
 * @why Library files written by released builds (schema 9 and older) keep their catalog ids under the old column names.
 *   Step 10 must carry every id into the neutral columns, drop the old ones and keep the indexes, so an old library
 *   still opens with its matches intact.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { PARROT_LEGACY_ID_COLUMNS } from "../src/legacyFormat";
import { PARROT_LIBRARY_MIGRATIONS, PARROT_LIBRARY_SCHEMA_VERSION, parrotLibraryMigrationStatements } from "../src";

const userVersion = (db: Database) => db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
const columnsOf = (db: Database, table: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((column) => column.name);

/** A library file as schema 9 left it, with an id in every old id column. */
const schema9Library = () => {
  const db = new Database(":memory:");
  db.transaction(() => {
    for (const sql of PARROT_LIBRARY_MIGRATIONS.slice(0, 9).flat()) db.run(sql);
    db.run("PRAGMA user_version = 9");
  })();
  const ids = PARROT_LEGACY_ID_COLUMNS;
  db.run(`INSERT INTO artists (id, ${ids.artists.music_id}, name, sort_name) VALUES ('ar-1', '0a7e3c1e-0000-4000-8000-0000000000a1', 'Linnet Park', 'Linnet Park')`);
  db.run(
    `INSERT INTO albums (id, title, album_artist_id, ${ids.albums.music_id}, ${ids.albums.music_edition_id}, created_at) VALUES ('al-1', 'Meltway', 'ar-1', '0a7e3c1e-0000-4000-8000-0000000000b1', '0a7e3c1e-0000-4000-8000-0000000000b2', 1)`
  );
  db.run(`INSERT INTO albums (id, title, album_artist_id, created_at) VALUES ('al-2', 'Loose Tapes', 'ar-1', 2)`);
  db.run(`INSERT INTO tracks (id, album_id, title, artist_id, number, ${ids.tracks.music_id}) VALUES ('tr-1', 'al-1', 'Nook', 'ar-1', 13, '0a7e3c1e-0000-4000-8000-0000000000c1')`);
  db.run(`INSERT INTO tracks (id, album_id, title, artist_id, number) VALUES ('tr-2', 'al-2', 'Demo', 'ar-1', 1)`);
  return db;
};

describe("Parrot library legacy format", () => {
  it("@req META-SRC-09[parrot] moves a schema-9 library's ids into the neutral columns and keeps every row", () => {
    const db = schema9Library();
    db.transaction(() => {
      for (const sql of parrotLibraryMigrationStatements(9)) db.run(sql);
    })();
    expect(userVersion(db)).toBe(PARROT_LIBRARY_SCHEMA_VERSION);
    expect(db.query("SELECT id, music_id, name FROM artists").all()).toEqual([{ id: "ar-1", music_id: "0a7e3c1e-0000-4000-8000-0000000000a1", name: "Linnet Park" }]);
    expect(db.query("SELECT id, music_id, music_edition_id, title FROM albums ORDER BY id").all()).toEqual([
      { id: "al-1", music_id: "0a7e3c1e-0000-4000-8000-0000000000b1", music_edition_id: "0a7e3c1e-0000-4000-8000-0000000000b2", title: "Meltway" },
      { id: "al-2", music_id: null, music_edition_id: null, title: "Loose Tapes" },
    ]);
    expect(db.query("SELECT id, music_id, number FROM tracks ORDER BY id").all()).toEqual([
      { id: "tr-1", music_id: "0a7e3c1e-0000-4000-8000-0000000000c1", number: 13 },
      { id: "tr-2", music_id: null, number: 1 },
    ]);
    for (const [table, renamed] of Object.entries(PARROT_LEGACY_ID_COLUMNS)) {
      const columns = columnsOf(db, table);
      console.log(`[PARROT-LEGACY] ${table} columns`, columns.join(","));
      for (const [neutral, old] of Object.entries(renamed)) {
        expect(columns).toContain(neutral);
        expect(columns).not.toContain(old);
      }
    }
    const indexes = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_idx' ORDER BY name").all().map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(["albums_album_artist_id_idx", "tracks_album_id_idx", "tracks_artist_id_idx"]));
  });

  it("@req META-SRC-09[parrot] builds a new library with only the neutral id columns", () => {
    const db = new Database(":memory:");
    db.transaction(() => {
      for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);
    })();
    for (const [table, renamed] of Object.entries(PARROT_LEGACY_ID_COLUMNS)) {
      const columns = columnsOf(db, table);
      for (const [neutral, old] of Object.entries(renamed)) {
        expect(columns).toContain(neutral);
        expect(columns).not.toContain(old);
      }
    }
  });
});

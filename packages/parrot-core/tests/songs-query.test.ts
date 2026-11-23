/**
 * @test-id PARROT-CORE-SONGS-QUERY-001
 * @level unit
 * @req PAR-LOOK-01[parrot]
 * @why The phone's library gets a Songs view (Albums / Artists / Songs, as in the approved mockup): every song, by
 *   title, each with its artist and its album's title so the player can say what it plays from. Runs the real query
 *   on the real library schema.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { parrotLibraryMigrationStatements } from "@space/parrot-library-db-definition";
import { SONGS_SQL, type SongRow } from "../src";

const openLibrary = () => {
  const db = new Database(":memory:");
  for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);
  db.run(`INSERT INTO artists (id, name, sort_name) VALUES ('ar-j', 'Juniper Skies', 'Juniper Skies'), ('ar-s', 'Scott Joplin', 'Joplin, Scott')`);
  db.run(`INSERT INTO albums (id, title, album_artist_id, year, created_at) VALUES ('al-lo', 'Low Orbit', 'ar-j', 2021, 1), ('al-pr', 'Piano Rags', 'ar-s', 1902, 2)`);
  db.run(`INSERT INTO tracks (id, album_id, disc, number, title, artist_id, duration_ms) VALUES
    ('t1', 'al-lo', 1, 1, 'signal Fires', 'ar-j', 228000),
    ('t2', 'al-pr', 1, 1, 'Maple Leaf Rag', 'ar-s', 190000),
    ('t3', 'al-lo', 1, 2, 'Apogee', 'ar-j', NULL)`);
  return db;
};

describe("SONGS_SQL", () => {
  it("lists every song by title (any case), with its artist and its album's title", () => {
    const rows = openLibrary().query<SongRow, []>(SONGS_SQL).all();
    console.info("[PARROT-CORE-SONGS-QUERY-001] rows", JSON.stringify(rows));
    expect(rows.map((row) => row.title)).toEqual(["Apogee", "Maple Leaf Rag", "signal Fires"]);
    expect(rows[1]).toEqual({
      id: "t2",
      albumId: "al-pr",
      disc: 1,
      number: 1,
      title: "Maple Leaf Rag",
      artistName: "Scott Joplin",
      artistId: "ar-s",
      durationMs: 190000,
      albumTitle: "Piano Rags",
      gainDb: null,
      peak: null,
      albumGainDb: null,
      albumPeak: null,
    });
    expect(rows[0].durationMs).toBeNull();
  });
});

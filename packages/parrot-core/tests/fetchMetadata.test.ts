/**
 * @test-id PARROT-CORE-FETCH-METADATA-001
 * @level unit (real SQLite library, fake lookup)
 * @why PAR-META-18: "Fetch metadata" asks our music library with the song's or the album's names and length only,
 *   fills the edit dialog with the best answer next to the library's values, keeps what the lookup does not know
 *   (genre), and asks nothing when there is no artist or title to ask with.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { buildParrotOpStatements, createParrotOp, parrotLibraryMigrationStatements, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import type { MusicAlbum, MusicAlbumsQuery, MusicRecording, MusicRecordingsQuery } from "@space/shared/api";
import { fetchParrotMetadata } from "../src/fetchMetadata";
import type { ParrotLibraryQuery } from "../src/manage";

const T = "[PARROT-CORE-FETCH-METADATA]";
const meta = { id: "seed", createdAt: "2026-11-09T00:00:00.000Z" };

const apply = (db: Database, ops: readonly ParrotLibraryOp[]) =>
  db.transaction(() => {
    for (const op of ops)
      for (const statements of Object.values(buildParrotOpStatements(op)))
        for (const { sql, params } of statements ?? []) db.prepare(sql).run(...(params as never[]));
  })();

const queryOf =
  (db: Database): ParrotLibraryQuery =>
  <Row,>(sql: string, params: readonly (string | number | null)[] = []) =>
    db.prepare(sql).all(...(params as never[])) as Row[];

/** A badly tagged file: "nook" by "linnet park" on "meltway" with no year, and a song whose artist has a blank name. */
const seed = () => {
  const db = new Database(":memory:");
  db.transaction(() => {
    for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);
  })();
  apply(db, [
    createParrotOp("artist.upsert", { id: "ar-lp", musicId: null, name: "linnet park", sortName: "linnet park" }, meta),
    createParrotOp("artist.upsert", { id: "ar-blank", musicId: null, name: " ", sortName: " " }, meta),
    createParrotOp(
      "album.upsert",
      { id: "al-meltway", title: "meltway", albumArtistId: "ar-lp", year: null, kind: "studio", musicId: null, musicEditionId: null, coverObjectKey: null, coverThumbObjectKey: null, createdAt: 1 },
      meta
    ),
    createParrotOp("track.upsert", { id: "t-nook", albumId: "al-meltway", disc: 1, number: null, title: "nook", artistId: "ar-lp", durationMs: 185_000, musicId: null }, meta),
    createParrotOp("track.upsert", { id: "t-anon", albumId: "al-meltway", disc: 1, number: 1, title: "Untitled", artistId: "ar-blank", durationMs: 1000, musicId: null }, meta),
  ]);
  return db;
};

const LP = { id: "artist-lp", name: "Linnet Park" };
const NOOK: MusicRecording = {
  id: "song-nook",
  title: "Nook",
  durationMs: 185_000,
  artist: LP,
  album: { id: "album-meltway", title: "Meltway", year: 2003, trackNumber: 13, disc: 1 },
};
const MELTWAY: MusicAlbum = { id: "album-meltway", title: "Meltway", year: 2003, kind: "album", artist: LP, tracks: [] };

const lookup = (recordings: MusicRecording[], albums: MusicAlbum[]) => {
  const asked: { recordings: MusicRecordingsQuery[]; albums: MusicAlbumsQuery[] } = { recordings: [], albums: [] };
  return {
    asked,
    recordings: async (question: MusicRecordingsQuery) => (asked.recordings.push(question), { results: recordings }),
    albums: async (question: MusicAlbumsQuery) => (asked.albums.push(question), { results: albums }),
  };
};

// @req PAR-META-18[parrot]
describe("[parrot] fetch metadata", () => {
  it("asks about a song with its names and length, and fills the dialog with the best recording", async () => {
    const db = seed();
    const fake = lookup([NOOK], []);
    const result = await fetchParrotMetadata({ query: queryOf(db), target: { kind: "track", id: "t-nook" }, ...fake });
    console.info(T, "track", fake.asked.recordings, result);
    expect(fake.asked.recordings).toEqual([{ artist: "linnet park", title: "nook", album: "meltway", durationMs: 185_000, limit: 1 }]);
    expect(result).toEqual({
      kind: "track",
      found: { title: "Nook", artist: "Linnet Park", album: "Meltway", number: 13, disc: 1, year: 2003, genre: null },
      current: { title: "nook", artist: "linnet park", album: "meltway", number: null, disc: 1, year: null, genre: null },
    });
  });

  it("asks about an album with its artist and title, and keeps the album's id for the cover", async () => {
    const db = seed();
    const fake = lookup([], [MELTWAY]);
    const result = await fetchParrotMetadata({ query: queryOf(db), target: { kind: "album", id: "al-meltway" }, ...fake });
    console.info(T, "album", fake.asked.albums, result);
    expect(fake.asked.albums).toEqual([{ artist: "linnet park", album: "meltway", limit: 1 }]);
    expect(result).toEqual({
      kind: "album",
      found: { title: "Meltway", albumArtist: "Linnet Park", year: 2003, genre: null },
      current: { title: "meltway", albumArtist: "linnet park", year: null, genre: null },
      coverId: "album-meltway",
    });
  });

  it("says none when the lookup knows nothing, and asks nothing without an artist or a title", async () => {
    const db = seed();
    const fake = lookup([], []);
    expect(await fetchParrotMetadata({ query: queryOf(db), target: { kind: "track", id: "t-nook" }, ...fake })).toEqual({ kind: "none" });
    expect(await fetchParrotMetadata({ query: queryOf(db), target: { kind: "album", id: "al-meltway" }, ...fake })).toEqual({ kind: "none" });
    expect(await fetchParrotMetadata({ query: queryOf(db), target: { kind: "track", id: "t-anon" }, ...fake })).toEqual({ kind: "missing" });
    expect(await fetchParrotMetadata({ query: queryOf(db), target: { kind: "track", id: "gone" }, ...fake })).toEqual({ kind: "missing" });
    expect(fake.asked.recordings).toHaveLength(1);
  });
});

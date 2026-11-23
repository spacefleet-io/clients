import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import path from "node:path";
import { fetchParrotMetadata, parrotAlbumEditValues, parrotAlbumId, parrotArtistId, saveParrotEdit, parrotTrackEditValues, type ParrotLibraryQuery } from "@space/parrot-core";
import { buildParrotOpStatements, parrotLibraryMigrationStatements, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import type { MusicAlbum } from "@space/shared/api";
import { buildParrotTrackOps } from "../src/importer";
import type { ParrotTrackInfo } from "../src/readTrack";
import { parrotTrackIds } from "../src/ids";
import { makeParrotCoverCopies } from "../src/covers";
import { makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-EDIT-CLEAR-001");

const apply = (db: Database, ops: readonly ParrotLibraryOp[]) =>
  db.transaction(() => {
    for (const op of ops)
      for (const statements of Object.values(buildParrotOpStatements(op)))
        for (const { sql, params } of statements ?? []) db.prepare(sql).run(...(params as never[]));
  })();

const query =
  (db: Database): ParrotLibraryQuery =>
  <Row,>(sql: string, params: readonly (string | number | null)[] = []) =>
    db.prepare(sql).all(...(params as never[])) as Row[];

const open = (file: string) => {
  const db = new Database(file);
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  db.transaction(() => {
    for (const sql of parrotLibraryMigrationStatements(version)) db.run(sql);
  })();
  return db;
};

/** A song as the importer reads it from its tags: Meltway, 2003, Nu metal. */
const info = (title: string, number: number): ParrotTrackInfo => ({
  file: `/music/${title}.mp3`,
  artist: "Linnet Park",
  albumArtist: "Linnet Park",
  album: "Meltway",
  title,
  disc: 1,
  number,
  year: 2003,
  genre: "Nu metal",
  durationMs: 185_000,
  bitrateKbps: 320,
  sampleRate: 44_100,
  format: { codec: "mp3", container: "mp3", mime: "audio/mpeg", lossless: false },
});

const importOps = (song: ParrotTrackInfo, fileHash: string) =>
  buildParrotTrackOps({ info: song, fileHash, sizeBytes: 10, chunks: [{ idx: 0, objectKey: `${fileHash}/chunk-0`, plainOffset: 0, plainSize: 10 }], now: 1 });

const ALBUM = parrotAlbumId(parrotArtistId("Linnet Park"), "Meltway");
const NOOK = parrotTrackIds({ ...info("Nook", 13), fileHash: "a" }).trackId;

const values = async (db: Database) => {
  const album = await parrotAlbumEditValues(query(db), ALBUM);
  const track = await parrotTrackEditValues(query(db), NOOK);
  return { album: { year: album?.year, genre: album?.genre }, track: { year: track?.year, genre: track?.genre } };
};

const save = (db: Database, published: ParrotLibraryOp[], edit: { year: number | null; genre: string | null }) =>
  saveParrotEdit({
    target: { kind: "album", id: ALBUM, edit: { title: "Meltway", albumArtist: "Linnet Park", ...edit } },
    cover: null,
    db,
    query,
    makeCoverCopies: (bytes) => makeParrotCoverCopies(bytes, log),
    storeCover: async () => "unused",
    publish: async (ops) => {
      published.push(...ops);
      apply(db, ops);
      return { ok: true as const };
    },
    deleteObjects: async () => ({}),
    newId: () => crypto.randomUUID(),
    log,
    fail: log,
  });

describe("PAR-META-17: an emptied year or genre is cleared", () => {
  it("@req PAR-META-17 clearing an album's year and genre survives a reload, a sync, a re-import, and only Fetch metadata brings the year back", async () => {
    const file = path.join(await makeTempDir("edit-clear"), "library.sqlite");
    const imported = importOps(info("Nook", 13), "a");
    const db = open(file);
    apply(db, imported);
    log("after import", await values(db));
    expect(await values(db)).toEqual({ album: { year: 2003, genre: "Nu metal" }, track: { year: 2003, genre: "Nu metal" } });

    // The user empties the year and the genre and saves.
    const published: ParrotLibraryOp[] = [];
    expect(await save(db, published, { year: null, genre: null })).toEqual({ ok: true });
    log("after clearing", await values(db));
    const cleared = { album: { year: null, genre: null }, track: { year: null, genre: null } };
    expect(await values(db)).toEqual(cleared);
    db.close();

    // Reload: the library file opened again shows nothing.
    const reopened = open(file);
    log("after reload", await values(reopened));
    expect(await values(reopened)).toEqual(cleared);

    // Sync: another device replaying the same ops lands on the same empty fields.
    const other = open(":memory:");
    apply(other, [...imported, ...published]);
    log("other device", await values(other));
    expect(await values(other)).toEqual(cleared);

    // Re-import: another copy of Nook and a new song of Meltway, both tagged 2003 / Nu metal, refill nothing.
    apply(reopened, [...importOps(info("Nook", 13), "b"), ...importOps(info("Fable", 7), "c")]);
    log("after re-import", await values(reopened), reopened.query("SELECT year, genre, year_edited, genre_edited FROM albums").all());
    expect(await values(reopened)).toEqual(cleared);

    // Fetch metadata, asked by the user, finds 2003: saving the dialog it fills puts the year back.
    const found = await fetchParrotMetadata({
      query: query(reopened),
      target: { kind: "album", id: ALBUM },
      recordings: async () => ({ results: [] }),
      albums: async (question) => {
        log("lookup asked", question);
        return { results: [{ id: "album-meltway", title: "Meltway", artist: { name: "Linnet Park" }, year: 2003 } as unknown as MusicAlbum] };
      },
    });
    log("fetch metadata", found);
    if (found.kind !== "album") throw new Error(`expected an album match, got ${found.kind}`);
    expect(found.found).toEqual({ title: "Meltway", albumArtist: "Linnet Park", year: 2003, genre: null });
    expect(await save(reopened, [], found.found)).toEqual({ ok: true });
    log("after fetch metadata", await values(reopened));
    expect(await values(reopened)).toEqual({ album: { year: 2003, genre: null }, track: { year: 2003, genre: null } });

    // The genre comes back when the user types it; an import tagged otherwise still changes neither.
    expect(await save(reopened, [], { year: 2003, genre: "Rock" })).toEqual({ ok: true });
    apply(reopened, importOps({ ...info("Nook", 13), year: 1999, genre: "Pop" }, "d"));
    log("after typing the genre and another import", await values(reopened));
    expect(await values(reopened)).toEqual({ album: { year: 2003, genre: "Rock" }, track: { year: 2003, genre: "Rock" } });
    reopened.close();
  });
});

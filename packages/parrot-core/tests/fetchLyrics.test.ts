/**
 * @test-id PARROT-CORE-FETCH-LYRICS-001
 * @level unit (real SQLite library, fake lookup)
 * @why PAR-LYR-05: "Fetch lyrics" asks our lyrics library with the song's names, length and metadata id only, keeps a
 *   found answer as the song's lyrics (marked as fetched), records the final "no lyrics" state when none is found
 *   (PAR-LYR-04), asks again over that state, and never replaces the lyrics the song's own file carries (PAR-LYR-01).
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { buildParrotOpStatements, createParrotOp, parrotLibraryMigrationStatements, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import type { MusicLyrics, MusicLyricsQuery } from "@space/shared/api";
import { fetchParrotLyrics, parrotLyricsQuery, planParrotLyrics } from "../src/fetchLyrics";
import { readParrotLyrics } from "../src/lyrics";
import type { ParrotLibraryQuery } from "../src/manage";

const T = "[PARROT-CORE-FETCH-LYRICS]";
const meta = { id: "seed", createdAt: "2026-11-09T00:00:00.000Z" };
const NOW = 1_762_646_400_000;

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

/** Linnet Park's Nook (with an id in the metadata and a length), Fable (file lyrics) and a song whose artist has a blank name. */
const seed = () => {
  const db = new Database(":memory:");
  db.transaction(() => {
    for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);
  })();
  apply(db, [
    createParrotOp("artist.upsert", { id: "ar-lp", musicId: null, name: "Linnet Park", sortName: "Linnet Park" }, meta),
    createParrotOp("artist.upsert", { id: "ar-blank", musicId: null, name: " ", sortName: " " }, meta),
    createParrotOp(
      "album.upsert",
      { id: "al-meltway", title: "Meltway", albumArtistId: "ar-lp", year: 2003, kind: "studio", musicId: null, musicEditionId: null, coverObjectKey: null, coverThumbObjectKey: null, createdAt: 1 },
      meta
    ),
    createParrotOp("track.upsert", { id: "t-nook", albumId: "al-meltway", disc: 1, number: 13, title: "Nook", artistId: "ar-lp", durationMs: 185_000, musicId: "song-nook" }, meta),
    createParrotOp("track.upsert", { id: "t-fable", albumId: "al-meltway", disc: 1, number: 7, title: "Fable", artistId: "ar-lp", durationMs: null, musicId: null }, meta),
    createParrotOp("track.upsert", { id: "t-anon", albumId: "al-meltway", disc: 1, number: 1, title: "Untitled", artistId: "ar-blank", durationMs: 1000, musicId: null }, meta),
    createParrotOp("lyrics.set", { trackId: "t-fable", plain: "Fable words from the file", synced: null, source: "file", fetchedAt: 1 }, meta),
  ]);
  return db;
};

const lookupOf = (answer: MusicLyrics) => {
  const asked: MusicLyricsQuery[] = [];
  return { asked, lookup: async (question: MusicLyricsQuery) => (asked.push(question), answer) };
};
let n = 0;
const args = (db: Database, trackId: string, lookup: (q: MusicLyricsQuery) => Promise<MusicLyrics>) => ({
  query: queryOf(db),
  trackId,
  lookup,
  now: () => NOW,
  newId: () => `op-${++n}`,
});

// @req PAR-LYR-05[parrot]
describe("[parrot] fetch lyrics", () => {
  it("asks with the song's names, length and metadata id only", async () => {
    const db = seed();
    const question = await parrotLyricsQuery(queryOf(db), "t-nook");
    console.info(T, "question", question);
    expect(question).toEqual({ artist: "Linnet Park", title: "Nook", album: "Meltway", durationMs: 185_000, id: "song-nook" });
    expect(await parrotLyricsQuery(queryOf(db), "t-fable")).toEqual({ artist: "Linnet Park", title: "Fable", album: "Meltway" });
    expect(await parrotLyricsQuery(queryOf(db), "t-anon")).toBeNull();
    expect(await parrotLyricsQuery(queryOf(db), "gone")).toBeNull();
  });

  it("keeps found synced lyrics as the song's lyrics, marked as fetched", async () => {
    const db = seed();
    const { asked, lookup } = lookupOf({ plain: "Nook words", synced: "[00:01.00]Nook words" });
    const found = await fetchParrotLyrics(args(db, "t-nook", lookup));
    console.info(T, "found", found.kind, asked);
    expect(asked).toHaveLength(1);
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    apply(db, [found.op]);
    const read = readParrotLyrics((sql, params) => db.prepare(sql).all(...(params as never[])) as never[], "t-nook");
    console.info(T, "read back", read);
    expect(read).toEqual({ synced: [{ ms: 1000, text: "Nook words" }], plain: "Nook words", fetched: true });
  });

  it("records 'no lyrics' when the lookup has no words, asks again over it, and asks nothing for a song with its own lyrics or no artist", async () => {
    const db = seed();
    const empty = lookupOf({ plain: "  ", synced: null });
    const none = await fetchParrotLyrics(args(db, "t-nook", empty.lookup));
    expect(none.kind).toBe("none");
    if (none.kind !== "none") return;
    expect(none.op.type === "lyrics.set" ? none.op.payload : null).toMatchObject({ trackId: "t-nook", plain: null, synced: null, source: "none" });
    apply(db, [none.op]);
    const read = readParrotLyrics((sql, params) => db.prepare(sql).all(...(params as never[])) as never[], "t-nook");
    console.info(T, "not found read back", read);
    expect(read).toEqual({ synced: null, plain: null, fetched: true, notFound: true });
    // PAR-LYR-05: "Fetch lyrics" over the "no lyrics" state asks again, and a later find replaces it.
    const later = lookupOf({ plain: "Nook words", synced: null });
    const found = await fetchParrotLyrics(args(db, "t-nook", later.lookup));
    expect(later.asked).toHaveLength(1);
    expect(found.kind).toBe("found");
    if (found.kind === "found") apply(db, [found.op]);
    expect(readParrotLyrics((sql, params) => db.prepare(sql).all(...(params as never[])) as never[], "t-nook")).toEqual({ synced: null, plain: "Nook words", fetched: true });
    const own = lookupOf({ plain: "other words", synced: null });
    expect((await fetchParrotLyrics(args(db, "t-fable", own.lookup))).kind).toBe("present");
    expect((await fetchParrotLyrics(args(db, "t-anon", own.lookup))).kind).toBe("missing");
    console.info(T, "asked for own/anon", own.asked.length);
    expect(own.asked).toHaveLength(0);
  });

  it("passes a lookup failure on to the caller", async () => {
    const db = seed();
    await expect(fetchParrotLyrics(args(db, "t-nook", () => Promise.reject(new Error("offline"))))).rejects.toThrow("offline");
  });

  it("plans plain-only answers and drops empty ones", async () => {
    const plain = planParrotLyrics("t-nook", { plain: "words", synced: " " }, { now: NOW, newId: () => "op" });
    expect(plain && plain.type === "lyrics.set" ? plain.payload : null).toMatchObject({ trackId: "t-nook", plain: "words", synced: null, source: "fetched", fetchedAt: NOW });
    expect(planParrotLyrics("t-nook", { plain: null, synced: null }, { now: NOW, newId: () => "op" })).toBeNull();
  });
});

// @req PAR-LYR-05[parrot]
describe("[parrot] fetch lyrics on a library read asynchronously (the phone's SQLite)", () => {
  it("asks and keeps the answer the same way when every read returns a promise", async () => {
    const db = seed();
    const reads: string[] = [];
    const asyncQuery = async <Row,>(sql: string, params: readonly (string | number | null)[] = []) => {
      await null;
      reads.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      return db.prepare(sql).all(...(params as never[])) as Row[];
    };
    const { asked, lookup } = lookupOf({ plain: "Nook words", synced: "[00:02.50]Nook words" });
    const found = await fetchParrotLyrics({ query: asyncQuery, trackId: "t-nook", lookup, now: () => NOW, newId: () => "op-async" });
    console.info(T, "async found", found.kind, asked, reads);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(asked).toEqual([{ artist: "Linnet Park", title: "Nook", album: "Meltway", durationMs: 185_000, id: "song-nook" }]);
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    apply(db, [found.op]);
    const read = readParrotLyrics((sql, params) => db.prepare(sql).all(...(params as never[])) as never[], "t-nook");
    expect(read).toEqual({ synced: [{ ms: 2500, text: "Nook words" }], plain: "Nook words", fetched: true });
    const own = lookupOf({ plain: "x", synced: null });
    expect((await fetchParrotLyrics({ query: asyncQuery, trackId: "t-fable", lookup: own.lookup, now: () => NOW, newId: () => "op" })).kind).toBe("present");
    expect(own.asked).toHaveLength(0);
  });
});

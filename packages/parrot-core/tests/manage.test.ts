import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  buildParrotOpStatements,
  createParrotOp,
  parrotLibraryMigrationStatements,
  type ParrotLibraryOp,
} from "@space/parrot-library-db-definition";
import { parrotLibraryStatementsForOps } from "../src/librarySchema";
import { parrotAlbumEditValues, parrotTrackEditValues, planParrotDelete, planParrotEdit, planParrotTrackLoudness, type ParrotLibraryQuery, type ParrotManageContext } from "../src/manage";
import { albumPageRows } from "../src/missingTracks";

const T = "[PARROT-CORE-MANAGE]";
let n = 0;
const ctx: ParrotManageContext = {
  now: 1_762_646_400_000,
  newId: () => `op-${++n}`,
  ids: { artistId: (name) => `ar-${name.toLowerCase()}`, albumId: (artist, title) => `al-${artist}-${title.toLowerCase()}` },
};
const meta = { id: "seed", createdAt: "2026-11-09T00:00:00.000Z" };

/** Applies ops as every Parrot client does: a song stored in parts first takes the library to schema 11. */
const apply = (db: Database, ops: readonly ParrotLibraryOp[]) =>
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    for (const sql of parrotLibraryStatementsForOps(version, ops)) db.run(sql);
    for (const op of ops)
      for (const statements of Object.values(buildParrotOpStatements(op)))
        for (const { sql, params } of statements ?? []) db.prepare(sql).run(...(params as never[]));
  })();

const queryOf =
  (db: Database): ParrotLibraryQuery =>
  <Row,>(sql: string, params: readonly (string | number | null)[] = []) =>
    db.prepare(sql).all(...(params as never[])) as Row[];

const album = (id: string, title: string, albumArtistId: string, cover: string | null = null) =>
  createParrotOp(
    "album.upsert",
    { id, title, albumArtistId, year: 2003, kind: "studio", musicId: null, musicEditionId: null, coverObjectKey: cover, coverThumbObjectKey: cover ? `${cover}-thumb` : null, createdAt: 1 },
    meta
  );
const track = (id: string, albumId: string, artistId: string, number: number): ParrotLibraryOp[] => [
  createParrotOp("track.upsert", { id, albumId, disc: 1, number, title: id, artistId, durationMs: 1000, musicId: null }, meta),
  createParrotOp(
    "track_file.upsert",
    {
      file: { id: `tf-${id}`, trackId: id, codec: "mp3", container: "mp3", mime: "audio/mpeg", lossless: false, bitrateKbps: 320, sampleRate: 44100, sizeBytes: 10, lightCopy: false, createdAt: 1 },
      chunks: [
        { idx: 0, objectKey: `${id}/chunk-0`, plainOffset: 0, plainSize: 5 },
        { idx: 1, objectKey: `${id}/chunk-1`, plainOffset: 5, plainSize: 5 },
      ],
    },
    meta
  ),
];

/** Linnet Park: Meltway (Nook, Fable, and Guest by "Guest"), Hollow Signal (Paperboat); Jun-O: Crossing (Reprise by LP, Dirt by Jun-O). */
const seed = () => {
  const db = new Database(":memory:");
  db.transaction(() => {
    for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);
  })();
  apply(db, [
    createParrotOp("artist.upsert", { id: "ar-linnet park", musicId: null, name: "Linnet Park", sortName: "Linnet Park" }, meta),
    createParrotOp("artist.upsert", { id: "ar-guest", musicId: null, name: "Guest", sortName: "Guest" }, meta),
    createParrotOp("artist.upsert", { id: "ar-jun-o", musicId: null, name: "Jun-O", sortName: "Jun-O" }, meta),
    album("al-meltway", "Meltway", "ar-linnet park", "cover/meltway"),
    album("al-hybrid", "Hollow Signal", "ar-linnet park", "cover/hybrid"),
    album("al-crossing", "Crossing Current", "ar-jun-o"),
    ...track("nook", "al-meltway", "ar-linnet park", 1),
    ...track("fable", "al-meltway", "ar-linnet park", 2),
    ...track("guest", "al-meltway", "ar-guest", 3),
    ...track("paperboat", "al-hybrid", "ar-linnet park", 1),
    ...track("encore", "al-crossing", "ar-linnet park", 1),
    ...track("dirt", "al-crossing", "ar-jun-o", 2),
  ]);
  apply(db, [createParrotOp("lyrics.set", { trackId: "nook", plain: "x", synced: null, source: "fetched", fetchedAt: 1 }, meta)]);
  return db;
};

const ids = (db: Database, table: string) => (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
const snapshot = (db: Database) => ({ artists: ids(db, "artists"), albums: ids(db, "albums"), tracks: ids(db, "tracks") });

describe("planParrotDelete", () => {
  it("@req PAR-LIB-03 deleting an album's last song removes the album and its cover copies, keeping the artist", async () => {
    const db = seed();
    const plan = await planParrotDelete(queryOf(db), { kind: "track", id: "paperboat" }, ctx);
    console.log(T, "track plan", plan.ops.map((o) => `${o.type}:${JSON.stringify(o.payload)}`), plan.objectKeys);
    expect(plan.trackCount).toBe(1);
    expect(plan.albumCount).toBe(1);
    expect(plan.objectKeys).toEqual(["paperboat/chunk-0", "paperboat/chunk-1", "cover/hybrid", "cover/hybrid-thumb"]);
    apply(db, plan.ops);
    console.log(T, "after", snapshot(db));
    expect(snapshot(db).albums).toEqual(["al-crossing", "al-meltway"]);
    expect(snapshot(db).artists).toContain("ar-linnet park");
  });

  it("@req PAR-LIB-03 deleting an album removes its songs, lyrics and the guest artist nothing else points at", async () => {
    const db = seed();
    const plan = await planParrotDelete(queryOf(db), { kind: "album", id: "al-meltway" }, ctx);
    console.log(T, "album plan", plan.ops.map((o) => o.type), plan.objectKeys);
    expect(plan.trackCount).toBe(3);
    expect(plan.objectKeys).toContain("cover/meltway-thumb");
    expect(plan.objectKeys.filter((k) => k.includes("chunk"))).toHaveLength(6);
    apply(db, plan.ops);
    console.log(T, "after", snapshot(db));
    expect(snapshot(db)).toEqual({
      artists: ["ar-jun-o", "ar-linnet park"],
      albums: ["al-crossing", "al-hybrid"],
      tracks: ["dirt", "encore", "paperboat"],
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM lyrics").get()).toEqual({ n: 0 });
  });

  it("@req PAR-LIB-03 deleting an artist removes its albums and its songs on other artists' albums", async () => {
    const db = seed();
    const plan = await planParrotDelete(queryOf(db), { kind: "artist", id: "ar-linnet park" }, ctx);
    console.log(T, "artist plan", plan.ops.map((o) => `${o.type}:${JSON.stringify(o.payload)}`));
    expect(plan.trackCount).toBe(5);
    expect(plan.albumCount).toBe(2);
    apply(db, plan.ops);
    console.log(T, "after", snapshot(db));
    expect(snapshot(db)).toEqual({ artists: ["ar-jun-o"], albums: ["al-crossing"], tracks: ["dirt"] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM track_file_chunks").get()).toEqual({ n: 2 });
  });

  it("@req PAR-META-15 deleting an artist also frees both stored copies of its photo", async () => {
    const db = seed();
    apply(db, [
      createParrotOp(
        "artist.upsert",
        { id: "ar-guest", musicId: null, name: "Guest", sortName: "Guest", pictureObjectKey: "photo/guest", pictureThumbObjectKey: "photo/guest-thumb", pictureCredit: null, pictureTriedAt: 1 },
        meta
      ),
    ]);
    const plan = await planParrotDelete(queryOf(db), { kind: "album", id: "al-meltway" }, ctx);
    console.log(T, "album plan with guest photo", plan.objectKeys);
    expect(plan.objectKeys).toEqual(expect.arrayContaining(["photo/guest", "photo/guest-thumb"]));
    const kept = await planParrotDelete(queryOf(db), { kind: "track", id: "paperboat" }, ctx);
    expect(kept.objectKeys.filter((k) => k.startsWith("photo/"))).toEqual([]);
  });

  it("@req PAR-FMT-01 deleting a song stored in parts frees its header, every piece and its tags object", async () => {
    const db = seed();
    apply(db, [
      createParrotOp(
        "track_file.upsert",
        {
          file: {
            id: "tf-paperboat",
            trackId: "paperboat",
            codec: "aac",
            container: "m4a",
            mime: "audio/mp4",
            lossless: false,
            bitrateKbps: 256,
            sampleRate: 44100,
            sizeBytes: 300,
            lightCopy: false,
            createdAt: 1,
            headerBytes: 100,
            sourceSizeBytes: 13_000,
            tagsObjectKey: "tf-paperboat/tags",
          },
          chunks: [
            { idx: 0, objectKey: "tf-paperboat/header", plainOffset: 0, plainSize: 100 },
            { idx: 1, objectKey: "tf-paperboat/piece-1", plainOffset: 100, plainSize: 100 },
            { idx: 2, objectKey: "tf-paperboat/piece-2", plainOffset: 200, plainSize: 100 },
          ],
        },
        meta
      ),
    ]);
    const plan = await planParrotDelete(queryOf(db), { kind: "track", id: "paperboat" }, ctx);
    console.log(T, "split song plan", plan.objectKeys);
    expect(plan.objectKeys).toEqual([
      "tf-paperboat/header",
      "tf-paperboat/piece-1",
      "tf-paperboat/piece-2",
      "tf-paperboat/tags",
      "cover/hybrid",
      "cover/hybrid-thumb",
    ]);
    apply(db, plan.ops);
    expect(db.prepare("SELECT COUNT(*) AS n FROM track_files WHERE id = 'tf-paperboat'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM track_file_chunks WHERE track_file_id = 'tf-paperboat'").get()).toEqual({ n: 0 });
  });
});

describe("planParrotEdit", () => {
  it("@req PAR-META-16 an album's year and genre go to the album and every song on it", async () => {
    const db = seed();
    const q = queryOf(db);
    const values = await parrotAlbumEditValues(q, "al-meltway");
    console.log(T, "album values", values);
    expect(values).toMatchObject({ title: "Meltway", albumArtist: "Linnet Park", year: 2003, genre: null });
    const plan = await planParrotEdit(q, { kind: "album", id: "al-meltway", edit: { title: "Meltway", albumArtist: "Linnet Park", year: 2004, genre: "Nu metal" } }, ctx);
    apply(db, plan.ops);
    const rows = db.prepare("SELECT id, year, genre FROM tracks WHERE album_id = 'al-meltway' ORDER BY id").all();
    console.log(T, "tracks after", rows, db.prepare("SELECT year, genre, cover_object_key AS c FROM albums WHERE id = 'al-meltway'").get());
    expect(rows).toEqual([
      { id: "fable", year: 2004, genre: "Nu metal" },
      { id: "guest", year: 2004, genre: "Nu metal" },
      { id: "nook", year: 2004, genre: "Nu metal" },
    ]);
    expect(db.prepare("SELECT year, genre, cover_object_key AS c FROM albums WHERE id = 'al-meltway'").get()).toEqual({ year: 2004, genre: "Nu metal", c: "cover/meltway" });
    expect(await parrotTrackEditValues(q, "nook")).toMatchObject({ year: 2004, genre: "Nu metal", album: "Meltway", artist: "Linnet Park" });
  });

  it("@req PAR-META-16 a new cover replaces the old copies, which are returned for deletion", async () => {
    const db = seed();
    const plan = await planParrotEdit(
      queryOf(db),
      { kind: "album", id: "al-hybrid", edit: { title: "Hollow Signal", albumArtist: "Linnet Park", year: 2000, genre: null, cover: { coverObjectKey: "cover/new", coverThumbObjectKey: "cover/new-thumb" } } },
      ctx
    );
    console.log(T, "cover plan keys", plan.objectKeys);
    expect(plan.objectKeys).toEqual(["cover/hybrid", "cover/hybrid-thumb"]);
    apply(db, plan.ops);
    expect(db.prepare("SELECT cover_object_key AS c, cover_thumb_object_key AS t FROM albums WHERE id = 'al-hybrid'").get()).toEqual({ c: "cover/new", t: "cover/new-thumb" });
  });

  it("@req PAR-META-16 a song's new artist is found or created; its new album is created; emptied rows go; ids stay", async () => {
    const db = seed();
    const q = queryOf(db);
    const plan = await planParrotEdit(
      q,
      { kind: "track", id: "guest", edit: { title: "Guest (Live)", artist: "Celeste", album: "Live in Tarvo", number: 7, disc: 1, year: 2003, genre: "Rock" } },
      ctx
    );
    console.log(T, "track plan", plan.ops.map((o) => `${o.type}:${JSON.stringify(o.payload)}`));
    apply(db, plan.ops);
    console.log(T, "after", snapshot(db));
    expect(db.prepare("SELECT id, title, artist_id AS a, album_id AS al, number, year, genre FROM tracks WHERE id = 'guest'").get()).toEqual({
      id: "guest",
      title: "Guest (Live)",
      a: "ar-celeste",
      al: "al-ar-linnet park-live in tarvo",
      number: 7,
      year: 2003,
      genre: "Rock",
    });
    // "Guest" no longer has a song or album: gone. Meltway keeps its other songs.
    expect(snapshot(db).artists).toEqual(["ar-celeste", "ar-jun-o", "ar-linnet park"]);
    expect(snapshot(db).albums).toContain("al-meltway");

    // Moving Paperboat to an existing album empties Hollow Signal: it goes with its cover copies.
    const move = await planParrotEdit(q, { kind: "track", id: "paperboat", edit: { title: "paperboat", artist: "Jun-O", album: "Meltway", number: 4, disc: 1, year: null, genre: null } }, {
      ...ctx,
      ids: { ...ctx.ids, albumId: (_artist, title) => (title === "Meltway" ? "al-meltway" : "nope") },
    });
    console.log(T, "move plan", move.ops.map((o) => o.type), move.objectKeys);
    expect(move.ops.filter((o) => o.type === "artist.upsert")).toHaveLength(0);
    expect(move.objectKeys).toEqual(["cover/hybrid", "cover/hybrid-thumb"]);
    apply(db, move.ops);
    expect(snapshot(db).albums).toEqual(["al-ar-linnet park-live in tarvo", "al-crossing", "al-meltway"]);
    expect(db.prepare("SELECT artist_id AS a, album_id AS al FROM tracks WHERE id = 'paperboat'").get()).toEqual({ a: "ar-jun-o", al: "al-meltway" });
  });

  it("@req PAR-META-17 a song's emptied year and genre stay empty, even when its album has them", async () => {
    const db = seed();
    const q = queryOf(db);
    apply(db, (await planParrotEdit(q, { kind: "album", id: "al-meltway", edit: { title: "Meltway", albumArtist: "Linnet Park", year: 2003, genre: "Nu metal" } }, ctx)).ops);
    // The album's year was left as it was: still not the user's; its new genre is.
    expect(db.prepare("SELECT year_edited AS y, genre_edited AS g FROM albums WHERE id = 'al-meltway'").get()).toEqual({ y: 0, g: 1 });
    expect(await parrotTrackEditValues(q, "nook")).toMatchObject({ year: 2003, genre: "Nu metal" });
    const plan = await planParrotEdit(q, { kind: "track", id: "nook", edit: { title: "nook", artist: "Linnet Park", album: "Meltway", number: 1, disc: 1, year: null, genre: null } }, ctx);
    console.log(T, "clear plan", plan.ops.map((o) => `${o.type}:${JSON.stringify(o.payload)}`));
    apply(db, plan.ops);
    console.log(T, "nook after", db.prepare("SELECT year, genre, year_edited, genre_edited FROM tracks WHERE id = 'nook'").get());
    expect(await parrotTrackEditValues(q, "nook")).toMatchObject({ year: null, genre: null });
    expect(await parrotTrackEditValues(q, "fable")).toMatchObject({ year: 2003, genre: "Nu metal" });
    // A title-only edit of another song leaves its year and genre following imports.
    apply(db, (await planParrotEdit(q, { kind: "track", id: "fable", edit: { title: "Fable!", artist: "Linnet Park", album: "Meltway", number: 2, disc: 1, year: 2003, genre: "Nu metal" } }, ctx)).ops);
    expect(db.prepare("SELECT year_edited AS y, genre_edited AS g FROM tracks WHERE id = 'fable'").get()).toEqual({ y: 0, g: 1 });
  });

  /**
   * @bugfix @regression-proof issue #2507: a user's Fable was imported onto the live "Meltway Hamburg" (track 8 there);
   * moving it to Meltway kept number 8, so Meltway's page showed a "Not in your library" Fable at 7 and theirs at the end.
   */
  it("@req PAR-LIB-05 a song moved to an album with a tracklist takes its own slot; a number the user typed is kept", async () => {
    const listed = ["Forecast", "Don't Linger", "Somewhere I Wander", "Hiding From You", "Hit the Gravel", "Easier to Swim", "Fable", "Figure.17"].map((title, i) => ({
      disc: 1,
      number: i + 1,
      title,
      durationMs: null,
    }));
    const setup = () => {
      const db = seed();
      apply(db, [
        createParrotOp("album.upsert", { ...album("al-meltway", "Meltway", "ar-linnet park", "cover/meltway").payload, tracklist: listed }, meta),
        album("al-hamburg", "Meltway Hamburg", "ar-linnet park"),
        ...track("fable-hamburg", "al-hamburg", "ar-linnet park", 8),
        // The seed's lowercase "fable" sits at Meltway's track 2 and is left alone: only the slot by title matters.
      ]);
      db.run("UPDATE tracks SET title = 'Fable' WHERE id = 'fable-hamburg'");
      return db;
    };
    const meltwayIds = { ...ctx, ids: { ...ctx.ids, albumId: (_artist: string, title: string) => (title === "Meltway" ? "al-meltway" : `al-${title}`) } };
    const pageOf = (db: Database) => {
      const owned = db.prepare("SELECT id, title, disc, number FROM tracks WHERE album_id = 'al-meltway' ORDER BY disc, number").all() as { id: string; title: string; disc: number; number: number }[];
      return albumPageRows(owned, listed).map((row) => (row.kind === "owned" ? `${row.track.number} ${row.track.title}` : `${row.listed.number} ${row.listed.title} (missing)`));
    };

    const db = setup();
    const q = queryOf(db);
    const opened = await parrotTrackEditValues(q, "fable-hamburg");
    console.log(T, "#2507 Fable opens with", opened);
    const plan = await planParrotEdit(q, { kind: "track", id: "fable-hamburg", edit: { ...opened!, album: "Meltway" } }, meltwayIds);
    console.log(T, "#2507 plan", plan.ops.filter((o) => o.type === "track.upsert").map((o) => JSON.stringify(o.payload)));
    apply(db, plan.ops);
    const page = pageOf(db);
    console.log(T, "#2507 Meltway page after the edit", page);
    expect(db.prepare("SELECT album_id AS al, disc, number FROM tracks WHERE id = 'fable-hamburg'").get()).toEqual({ al: "al-meltway", disc: 1, number: 7 });
    expect(page.filter((row) => row.includes("Fable"))).toEqual(["7 Fable"]);

    // The same move with a number the user typed: his number stands.
    const typed = setup();
    const tq = queryOf(typed);
    apply(typed, (await planParrotEdit(tq, { kind: "track", id: "fable-hamburg", edit: { ...(await parrotTrackEditValues(tq, "fable-hamburg"))!, album: "Meltway", number: 12 } }, meltwayIds)).ops);
    console.log(T, "#2507 typed number page", pageOf(typed));
    expect(typed.prepare("SELECT number FROM tracks WHERE id = 'fable-hamburg'").get()).toEqual({ number: 12 });
  });
});

describe("planParrotTrackLoudness", () => {
  it("@req PAR-PLAY-03 a song's measured loudness is stored once, kept through an edit, and never overwrites a value", async () => {
    const db = seed();
    const q = queryOf(db);
    const op = await planParrotTrackLoudness(q, "nook", { gainDb: -7.5, peak: 0.98 }, ctx);
    console.log(T, "loudness op", op?.payload);
    expect(op).not.toBeNull();
    apply(db, [op!]);
    const stored = () => db.prepare("SELECT title, gain_db AS g, peak AS p FROM tracks WHERE id = 'nook'").get();
    expect(stored()).toEqual({ title: "nook", g: -7.5, p: 0.98 });
    expect(await planParrotTrackLoudness(q, "nook", { gainDb: 3, peak: 0.5 }, ctx)).toBeNull();
    expect(await planParrotTrackLoudness(q, "gone", { gainDb: 3, peak: 0.5 }, ctx)).toBeNull();
    apply(db, (await planParrotEdit(q, { kind: "track", id: "nook", edit: { title: "Nook!", artist: "Linnet Park", album: "Meltway", number: 13, disc: 1, year: 2003, genre: null } }, ctx)).ops);
    expect(stored()).toEqual({ title: "Nook!", g: -7.5, p: 0.98 });
  });
});

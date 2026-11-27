/**
 * @test-id PARROT-CORE-RETRY-UNIDENTIFIED-001
 * @level unit (in-memory library, fake lookups)
 * @tags @bugfix @regression-proof
 * @why Issue #2531 (Chris 2026-11-15): a song imported "as is" because the music lookup could not be reached was never
 *   identified later unless the user pressed a button. The pass now asks again on its own, with the library as
 *   context, and moves a song only when the match is confident; a filled slot, an unsure match or a failed lookup
 *   leaves the song as it is (the failed one is asked at the next pass).
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { MusicAlbum, MusicAlbumsQuery, MusicRecording, MusicRecordingsQuery } from "@space/shared/api";
import { buildParrotOpStatements, createParrotOp, parrotLibraryMigrationStatements, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { planParrotTrackPlacements, type ParrotLibraryQuery, type ParrotManageContext, type ParrotTrackPlacement } from "../src/manage";
import { parrotImportLibraryAlbums, runParrotRetryUnidentified, type ParrotRetryUnidentifiedReport } from "../src/retryUnidentified";

const T = "[PARROT-CORE-RETRY-UNIDENTIFIED-001]";
const meta = { id: "seed", createdAt: "2026-11-15T00:00:00.000Z" };
let n = 0;
const ctx: ParrotManageContext = {
  now: 1_763_164_800_000,
  newId: () => `op-${++n}`,
  ids: { artistId: (name) => `ar-${name.toLowerCase()}`, albumId: (artist, title) => `al-${artist}-${title.toLowerCase()}` },
};

const LP = { id: "lp-id", name: "Linnet Park" };
const MELTWAY_TRACKS: Array<[string, number]> = [
  ["Forecast", 13_000],
  ["Don't Linger", 187_000],
  ["Somewhere I Wander", 213_000],
  ["Hiding From You", 175_000],
  ["Hit the Gravel", 164_000],
  ["Easier to Swim", 204_000],
  ["Fable", 162_100],
  ["Figure.17", 197_000],
  ["Breaking the Tide", 196_000],
  ["From the Hillside", 175_000],
  ["Nobody's Watching", 178_000],
  ["Interlude", 144_000],
  ["Nook", 185_000],
];
const MELTWAY: MusicAlbum = {
  // Our copy's id: the import asks an album by id only when the id is our copy's (PAR-META-26).
  id: "00000000-0000-4000-8000-00000000b001",
  title: "Meltway",
  year: 2003,
  kind: "Album",
  artist: LP,
  tracks: MELTWAY_TRACKS.map(([title, durationMs], index) => ({ disc: 1, number: index + 1, title, durationMs, id: `meltway-${index + 1}` })),
};

const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The fake lookups and the questions they were asked. */
type FakeLookups = {
  asked: string[];
  recordings: (question: MusicRecordingsQuery) => Promise<{ results: MusicRecording[] }>;
  albums: (question: MusicAlbumsQuery) => Promise<{ results: MusicAlbum[] }>;
};

/** The lookup knows Meltway only; `down` makes every question throw, as when the lookup cannot be reached. */
const lookups = (options: { down?: boolean } = {}): FakeLookups => {
  const asked: string[] = [];
  return {
    asked,
    recordings: async (question: MusicRecordingsQuery): Promise<{ results: MusicRecording[] }> => {
      asked.push(`recordings ${question.title}`);
      if (options.down) throw new Error("music lookup unreachable");
      const results = MELTWAY.tracks
        .filter((track) => fold(track.title) === fold(question.title))
        .map((track) => ({
          id: track.id,
          title: track.title,
          durationMs: track.durationMs,
          artist: LP,
          album: { id: MELTWAY.id, title: MELTWAY.title, year: MELTWAY.year, trackNumber: track.number, disc: 1, kind: "Album", official: true },
        }));
      return { results };
    },
    albums: async (question: MusicAlbumsQuery): Promise<{ results: MusicAlbum[] }> => {
      asked.push(`albums ${question.album}`);
      if (options.down) throw new Error("music lookup unreachable");
      return { results: fold(question.album) === "meltway" ? [MELTWAY] : [] };
    },
  };
};

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

const ARTIST = "ar-linnet park";
const library = (ops: (ParrotLibraryOp | ParrotLibraryOp[])[]) => {
  const db = new Database(":memory:");
  db.transaction(() => {
    for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);
  })();
  apply(db, [createParrotOp("artist.upsert", { id: ARTIST, musicId: null, name: "Linnet Park", sortName: "Linnet Park" }, meta), ...ops.flat()]);
  return db;
};
const album = (id: string, title: string, options: { tracklist?: boolean; cover?: string } = {}) =>
  createParrotOp(
    "album.upsert",
    {
      id,
      title,
      albumArtistId: ARTIST,
      year: 2003,
      kind: "studio",
      musicId: null,
      musicEditionId: null,
      coverObjectKey: options.cover ?? null,
      coverThumbObjectKey: null,
      createdAt: 1,
      tracklist: options.tracklist ? MELTWAY.tracks.map(({ disc, number, title: name, durationMs }) => ({ disc, number, title: name, durationMs })) : null,
    },
    meta
  );
const song = (id: string, albumId: string, title: string, number: number | null, durationMs: number, unidentified: boolean) =>
  createParrotOp("track.upsert", { id, albumId, disc: 1, number, title, artistId: ARTIST, durationMs, musicId: null, ...(unidentified ? { unidentified: true } : {}) }, meta);

type Row = { id: string; albumId: string; number: number | null; title: string; musicId: string | null; unidentified: number | null };
const tracks = (db: Database) =>
  db.prepare("SELECT id, album_id AS albumId, number, title, music_id AS musicId, unidentified FROM tracks ORDER BY id").all() as Row[];
const albums = (db: Database) => db.prepare("SELECT id, title, tracklist IS NOT NULL AS listed, music_id AS musicId FROM albums ORDER BY id").all();

/** Runs the pass with the planner publishing straight into `db`, as the desktop's save chain does. */
const runPass = async (db: Database, look: FakeLookups, tried = new Set<string>()) => {
  const lines: string[] = [];
  const deleted: string[] = [];
  const report: ParrotRetryUnidentifiedReport = await runParrotRetryUnidentified({
    query: () => queryOf(db),
    recordings: look.recordings,
    albums: look.albums,
    publish: async (placements: ParrotTrackPlacement[]) => {
      const plan = await planParrotTrackPlacements(queryOf(db), placements, ctx);
      apply(db, plan.ops);
      deleted.push(...plan.objectKeys);
      console.log(`${T} published ${plan.ops.map((op) => op.type).join(", ")}; objects to delete: ${plan.objectKeys.join(", ") || "none"}`);
      return true;
    },
    tried,
    sleep: async () => {},
    log: (line) => {
      lines.push(line);
      if (line.startsWith("[retry-unidentified]") || line.includes("library album")) console.log(`${T} ${line}`);
    },
  });
  console.log(`${T} report ${JSON.stringify(report)}; asked ${look.asked.length}: ${look.asked.join(" | ")}`);
  console.log(`${T} tracks ${JSON.stringify(tracks(db))}`);
  console.log(`${T} albums ${JSON.stringify(albums(db))}`);
  return { report, lines, deleted, tried };
};

describe(`${T} songs kept as is are looked up again automatically (#2531)`, () => {
  it("@bugfix @regression-proof places a Meltway kept as is once the lookup answers: same album row, now with its tracklist", async () => {
    const asIs = "al-ar-linnet park-meltway";
    const db = library([
      album(asIs, "Meltway"),
      song("t-nook", asIs, "Nook", 13, 185_400, true),
      song("t-fable", asIs, "Fable", 7, 168_200, true),
      song("t-interlude", asIs, "Interlude", 12, 144_300, true),
    ]);
    const { report } = await runPass(db, lookups());
    expect(report).toMatchObject({ asked: 3, placed: 3, failed: 0, stopped: false });
    expect(tracks(db).map((t) => [t.id, t.albumId, t.number, t.unidentified])).toEqual([
      ["t-fable", asIs, 7, 0],
      ["t-interlude", asIs, 12, 0],
      ["t-nook", asIs, 13, 0],
    ]);
    expect(tracks(db).find((t) => t.id === "t-fable")?.musicId).toBe("meltway-7");
    expect(albums(db)).toEqual([{ id: asIs, title: "Meltway", listed: 1, musicId: null }]);
  });

  it("@bugfix @regression-proof moves a lone Fable into the owned Meltway's empty slot 7 and removes the emptied album with its cover", async () => {
    const owned = "al-ar-linnet park-meltway";
    const lone = "al-ar-linnet park-unknown album";
    const db = library([
      album(owned, "Meltway", { tracklist: true }),
      song("t-nook", owned, "Nook", 13, 185_000, false),
      song("t-hit", owned, "Hit the Gravel", 5, 164_000, false),
      album(lone, "Unknown Album", { cover: "cover-unknown" }),
      // No album tag and no track number: only the library's empty slot and the length point at Meltway.
      song("t-fable", lone, "Fable", null, 162_500, true),
    ]);
    const { report, deleted } = await runPass(db, lookups());
    expect(report).toMatchObject({ placed: 1 });
    expect(tracks(db).find((t) => t.id === "t-fable")).toMatchObject({ albumId: owned, number: 7, unidentified: 0 });
    expect(albums(db).map((a) => (a as { id: string }).id)).toEqual([owned]);
    expect(deleted).toEqual(["cover-unknown"]);
  });

  it("@bugfix @regression-proof leaves a second copy of an owned song as is: the library already fills that slot", async () => {
    const owned = "al-ar-linnet park-meltway";
    const lone = "al-ar-linnet park-unknown album";
    const db = library([
      album(owned, "Meltway", { tracklist: true }),
      song("t-fable", owned, "Fable", 7, 162_000, false),
      album(lone, "Unknown Album"),
      song("t-fable-copy", lone, "Fable", null, 162_300, true),
    ]);
    const { report } = await runPass(db, lookups());
    expect(report.placed).toBe(0);
    expect(tracks(db).find((t) => t.id === "t-fable-copy")).toMatchObject({ albumId: lone, unidentified: 1 });
    expect(albums(db)).toHaveLength(2);
  });

  it("@bugfix @regression-proof leaves an unsure match as is (a Nook a minute too long), and does not ask it again this session", async () => {
    const lone = "al-ar-linnet park-unknown album";
    const db = library([album(lone, "Unknown Album"), song("t-nook-long", lone, "Nook", null, 245_000, true)]);
    const tried = new Set<string>();
    const first = await runPass(db, lookups(), tried);
    expect(first.report).toMatchObject({ asked: 1, placed: 0 });
    expect(first.report.unsure + first.report.none).toBe(1);
    expect(tracks(db)[0]).toMatchObject({ albumId: lone, unidentified: 1 });
    expect(tried.has("t-nook-long")).toBe(true);
    const again = lookups();
    const second = await runPass(db, again, tried);
    expect(second.report.asked).toBe(0);
    expect(again.asked).toEqual([]);
  });

  it("@bugfix @regression-proof stops when the lookup is still out of reach, changes nothing and asks the songs again on the next pass", async () => {
    const asIs = "al-ar-linnet park-meltway";
    const db = library([album(asIs, "Meltway"), song("t-fable", asIs, "Fable", 7, 168_200, true)]);
    const tried = new Set<string>();
    const down = await runPass(db, lookups({ down: true }), tried);
    expect(down.report).toMatchObject({ asked: 0, placed: 0, failed: 1, stopped: true });
    expect(tried.size).toBe(0);
    expect(tracks(db)[0]).toMatchObject({ unidentified: 1 });
    const up = await runPass(db, lookups(), tried);
    expect(up.report).toMatchObject({ asked: 1, placed: 1 });
    expect(tracks(db)[0]).toMatchObject({ albumId: asIs, number: 7, unidentified: 0 });
  });

  it("@bugfix @regression-proof never moves a song the user edited meanwhile (no longer unidentified)", async () => {
    const asIs = "al-ar-linnet park-meltway";
    const db = library([album(asIs, "Meltway"), song("t-fable", asIs, "Fable (my edit)", 3, 168_200, false)]);
    const plan = await planParrotTrackPlacements(queryOf(db), [{ trackId: "t-fable", album: MELTWAY, disc: 1, number: 7 }], ctx);
    console.log(`${T} edited song plan: ${plan.ops.length} op(s)`);
    expect(plan.ops).toEqual([]);
  });

  it("lists the library's albums with a tracklist and the slots their placed songs fill, not the songs kept as is", async () => {
    const owned = "al-ar-linnet park-meltway";
    const db = library([album(owned, "Meltway", { tracklist: true }), song("t-nook", owned, "Nook", 13, 185_000, false), song("t-fable", owned, "Fable", 7, 168_000, true)]);
    const listed = await parrotImportLibraryAlbums(queryOf(db));
    console.log(`${T} library albums ${JSON.stringify(listed.map((a) => ({ ...a, tracklist: a.tracklist.length })))}`);
    expect(listed).toEqual([{ musicId: null, title: "Meltway", artist: "Linnet Park", tracklist: expect.any(Array), owned: [{ disc: 1, number: 13 }] }]);
  });
});

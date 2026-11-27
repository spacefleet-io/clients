/**
 * @test-id PARROT-CORE-OWN-LYRICS-001
 * @level unit (real SQLite library, fake lookup)
 * @why PAR-LYR-08..11: a song with no lyrics found can get the user's own, from a dropped LRC/text file matched to the
 *   song by its header or name (never a guess), or typed and timed in the editor; they win over every found source, the
 *   lookups never write over them, broken files and times going back are reported with their line and never reordered,
 *   and removing them lets the song's lyrics be looked up again.
 * @covers packages/parrot-core/src/ownLyrics.ts, packages/parrot-core/src/lyrics.ts
 * @req PAR-LYR-08[parrot]
 * @req PAR-LYR-09[parrot]
 * @req PAR-LYR-10[parrot]
 * @req PAR-LYR-11[parrot]
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { buildParrotOpStatements, createParrotOp, parrotLibraryMigrationStatements, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { PARROT_LYRICS_UNASKED_SQL } from "../src/autoLyrics";
import { fetchParrotLyrics, planParrotLyrics } from "../src/fetchLyrics";
import { readParrotLyrics } from "../src/lyrics";
import type { ParrotLibraryQuery } from "../src/manage";
import {
  clearParrotEditorTimes,
  matchParrotLyricsFile,
  nudgeParrotEditorLine,
  PARROT_LYRICS_FILE_MAX_BYTES,
  PARROT_LYRICS_KEEP_SQL,
  PARROT_LYRICS_SONGS_SQL,
  parrotEditorLines,
  parrotOwnLyricsText,
  placeParrotLyricsFile,
  parrotEditorLinesText,
  parrotEditorText,
  parrotLyricsOpsToKeep,
  parseParrotLyricsFile,
  planParrotOwnLyrics,
  planParrotRemoveOwnLyrics,
  saveParrotEditorLyrics,
  tapParrotEditorLine,
  type ParrotLyricsImportSong,
  type ParrotLyricsSong,
} from "../src/ownLyrics";

const T = "[PARROT-CORE-OWN-LYRICS]";
const meta = { id: "seed", createdAt: "2026-11-27T00:00:00.000Z" };
const NOW = 1_795_000_000_000;
let n = 0;
const ctx = { now: NOW, newId: () => `op-${++n}` };

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

/** The rows of a query with no parameters, read at once (the library query may answer later). */
const rows = <Row,>(db: Database, sql: string) => db.prepare(sql).all() as Row[];

const read = (db: Database, trackId: string) => readParrotLyrics((sql, params) => db.prepare(sql).all(...(params as never[])) as never[], trackId);

/** Linnet Park's Nook and Fable, and a second "Nook" (live, longer) by Linnet Park, plus Juniper Hale's "Fable". */
const seed = () => {
  const db = new Database(":memory:");
  db.transaction(() => {
    for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);
  })();
  apply(db, [
    createParrotOp("artist.upsert", { id: "ar-lp", musicId: null, name: "Linnet Park", sortName: "Linnet Park" }, meta),
    createParrotOp("artist.upsert", { id: "ar-jh", musicId: null, name: "Juniper Hale", sortName: "Hale, Juniper" }, meta),
    createParrotOp(
      "album.upsert",
      { id: "al-meltway", title: "Meltway", albumArtistId: "ar-lp", year: 2003, kind: "studio", musicId: null, musicEditionId: null, coverObjectKey: null, coverThumbObjectKey: null, createdAt: 1 },
      meta
    ),
    createParrotOp(
      "album.upsert",
      { id: "al-live", title: "Live at the Pier", albumArtistId: "ar-lp", year: 2005, kind: "live", musicId: null, musicEditionId: null, coverObjectKey: null, coverThumbObjectKey: null, createdAt: 2 },
      meta
    ),
    createParrotOp("track.upsert", { id: "t-nook", albumId: "al-meltway", disc: 1, number: 13, title: "Nook", artistId: "ar-lp", durationMs: 185_000, musicId: null }, meta),
    createParrotOp("track.upsert", { id: "t-nook-live", albumId: "al-live", disc: 1, number: 2, title: "Nook", artistId: "ar-lp", durationMs: 241_000, musicId: null }, meta),
    createParrotOp("track.upsert", { id: "t-fable", albumId: "al-meltway", disc: 1, number: 7, title: "Fable", artistId: "ar-lp", durationMs: 200_000, musicId: null }, meta),
    createParrotOp("track.upsert", { id: "t-fable-jh", albumId: "al-live", disc: 1, number: 9, title: "Fable", artistId: "ar-jh", durationMs: 200_000, musicId: null }, meta),
    createParrotOp("lyrics.set", { trackId: "t-fable", plain: null, synced: null, source: "none", fetchedAt: 1 }, meta),
  ]);
  return db;
};

describe("reading a lyrics file", () => {
  it("reads LRC lines, its header and offset, strips word tags and keeps the plain words", () => {
    console.log(T, "phase: LRC with header");
    const file = parseParrotLyricsFile(
      "\uFEFF[ar: Linnet Park]\n[ti:Nook]\n[al:Meltway]\n[length: 03:05]\n[offset:+200]\n[by:someone]\n\n[00:01.00]<00:01.00>First <00:01.50>line\n[00:04.50][00:30.00] Chorus\n[00:10.25]Third\n",
      "nook.lrc"
    );
    console.log(T, JSON.stringify(file));
    expect(file.problems).toEqual([]);
    expect(file.tags).toEqual({ artist: "Linnet Park", title: "Nook", album: "Meltway", lengthMs: 185_000 });
    expect(file.synced).toEqual([
      { ms: 800, text: "First line" },
      { ms: 4300, text: "Chorus" },
      { ms: 10_050, text: "Third" },
      { ms: 29_800, text: "Chorus" },
    ]);
    expect(file.plain).toBe("First line\nChorus\nThird\nChorus");
  });

  it("reads a .txt file, or an LRC with no time, as plain lyrics", () => {
    console.log(T, "phase: plain files");
    expect(parseParrotLyricsFile("Verse one\n\n[00:01.00] not a time here, a .txt\n", "song.txt")).toEqual({
      synced: null,
      plain: "Verse one\n\n[00:01.00] not a time here, a .txt",
      tags: { artist: null, title: null, album: null, lengthMs: null },
      problems: [],
    });
    const lrc = parseParrotLyricsFile("[ti:Nook]\nVerse one\nVerse two", "x.lrc");
    expect(lrc.synced).toBeNull();
    expect(lrc.plain).toBe("Verse one\nVerse two");
    expect(lrc.tags.title).toBe("Nook");
  });

  it("reports a broken time, an untimed line and times going back with their line, and never reorders", () => {
    console.log(T, "phase: problems with line numbers");
    expect(parseParrotLyricsFile("[00:01.00] a\n[0x:02.00] b\n[00:75.00] c", "a.lrc").problems).toEqual([
      { kind: "badTime", line: 2 },
      { kind: "badTime", line: 3 },
    ]);
    expect(parseParrotLyricsFile("[00:01.00] a\nno time\n[00:03.00] c", "a.lrc").problems).toEqual([{ kind: "untimedLine", line: 2 }]);
    const back = parseParrotLyricsFile("[ti:x]\n[00:05.00] a\n[00:03.00] b\n[00:09.00] c", "a.lrc");
    console.log(T, JSON.stringify(back));
    expect(back.problems).toEqual([{ kind: "outOfOrder", line: 3 }]);
    expect(back.synced).toBeNull();
  });

  it("refuses an empty or oversized file", () => {
    console.log(T, "phase: size cap and empty");
    expect(parseParrotLyricsFile("[ti:x]\n\n", "a.lrc").problems).toEqual([{ kind: "empty" }]);
    expect(parseParrotLyricsFile("   ", "a.txt").problems).toEqual([{ kind: "empty" }]);
    expect(parseParrotLyricsFile("a".repeat(PARROT_LYRICS_FILE_MAX_BYTES + 1), "a.txt").problems).toEqual([{ kind: "tooBig" }]);
  });
});

describe("matching a dropped file to a song", () => {
  const songs = () => rows<ParrotLyricsSong>(seed(), PARROT_LYRICS_SONGS_SQL);
  const none = { artist: null, title: null, album: null, lengthMs: null };

  it("matches by the header, using album and length to tell same-named songs apart", async () => {
    console.log(T, "phase: header match");
    const all = await songs();
    expect(matchParrotLyricsFile({ name: "x.lrc", tags: { ...none, artist: "linnet park", title: "FABLE" } }, all)).toEqual({ kind: "matched", trackId: "t-fable" });
    expect(matchParrotLyricsFile({ name: "x.lrc", tags: { ...none, artist: "Linnet Park", title: "Nook", lengthMs: 240_000 } }, all)).toEqual({ kind: "matched", trackId: "t-nook-live" });
    expect(matchParrotLyricsFile({ name: "x.lrc", tags: { ...none, title: "Nook", album: "Meltway" } }, all)).toEqual({ kind: "matched", trackId: "t-nook" });
  });

  it("matches by file name when the file has no title, normalized as every Parrot name", async () => {
    console.log(T, "phase: file name match");
    const all = await songs();
    expect(matchParrotLyricsFile({ name: "/home/me/Juniper Hale - Fáble!.lrc", tags: none }, all)).toEqual({ kind: "matched", trackId: "t-fable-jh" });
    expect(matchParrotLyricsFile({ name: "07 - Fable.lrc", tags: { ...none, artist: "Linnet Park" } }, all)).toEqual({ kind: "matched", trackId: "t-fable" });
  });

  it("never guesses: several fitting songs or none go to the user", async () => {
    console.log(T, "phase: ambiguous and unmatched");
    const all = await songs();
    expect(matchParrotLyricsFile({ name: "Nook.lrc", tags: none }, all)).toEqual({ kind: "ambiguous", trackIds: ["t-nook", "t-nook-live"] });
    expect(matchParrotLyricsFile({ name: "Somebody Else - Nook.lrc", tags: none }, all)).toEqual({ kind: "ambiguous", trackIds: ["t-nook", "t-nook-live"] });
    expect(matchParrotLyricsFile({ name: "Unknown Song.lrc", tags: none }, all)).toEqual({ kind: "unmatched" });
  });
});

describe("placing a file in the import review", () => {
  const none = { artist: null, title: null, album: null, lengthMs: null };
  const library = () => rows<ParrotLyricsSong>(seed(), PARROT_LYRICS_SONGS_SQL);
  const song = (file: string, title: string, album = "Tide Lines"): ParrotLyricsImportSong => ({ id: file, file, title, artist: "Sea Owls", album, durationMs: 180_000 });
  const imported = [song("/m/Sea Owls/Tide Lines/01 Shore.flac", "Shore"), song("/m/Sea Owls/Tide Lines/02 Undertow.flac", "Undertow"), song("/m/Sea Owls/Other/01 Shore.flac", "Shore", "Other")];

  it("puts a file on the same-named audio file, then on a song of its folder, then of the import", async () => {
    console.log(T, "phase: import placement");
    const all = await library();
    expect(placeParrotLyricsFile({ path: "/m/Sea Owls/Tide Lines/01 Shore.lrc", tags: none }, imported, all)).toEqual({ source: "import", id: imported[0]!.id, sure: true });
    expect(placeParrotLyricsFile({ path: "/m/Sea Owls/Tide Lines/Shore.lrc", tags: none }, imported, all)).toEqual({ source: "import", id: imported[0]!.id, sure: true });
    expect(placeParrotLyricsFile({ path: "/m/lyrics/x.lrc", tags: { ...none, title: "Undertow" } }, imported, all)).toEqual({ source: "import", id: imported[1]!.id, sure: true });
  });

  it("then on the library, the folders telling same-named songs apart", async () => {
    console.log(T, "phase: library placement");
    const all = await library();
    expect(placeParrotLyricsFile({ path: "/l/Linnet Park/Meltway/Nook.lrc", tags: none }, imported, all)).toEqual({ source: "library", id: "t-nook", sure: true });
    expect(placeParrotLyricsFile({ path: "/l/Nook.lrc", tags: none }, imported, all)).toEqual({ source: "library", id: "t-nook", sure: false });
  });

  it("offers a loose fit unsure, and nothing for a file that fits no song", async () => {
    console.log(T, "phase: loose and none");
    const all = await library();
    expect(placeParrotLyricsFile({ path: "/m/Undertow (demo).lrc", tags: none }, imported, all)).toEqual({ source: "import", id: imported[1]!.id, sure: false });
    expect(placeParrotLyricsFile({ path: "/m/notes.txt", tags: none }, imported, all)).toBeNull();
  });
});

describe("the text kept for the user's own lyrics", () => {
  it("heads synced lyrics with the song's names and length, so a file written from them matches again", async () => {
    console.log(T, "phase: header");
    const words = { synced: [{ ms: 1000, text: "Mine" }], plain: null };
    const text = parrotOwnLyricsText(words, { title: "Nook", artist: "Linnet Park", album: "Meltway", durationMs: 185_000 })!;
    console.log(T, JSON.stringify(text));
    expect(text).toEqual({ synced: "[ar:Linnet Park]\n[al:Meltway]\n[ti:Nook]\n[length:03:05]\n[00:01.00] Mine", plain: "Mine" });
    const back = parseParrotLyricsFile(text.synced!, "x.lrc");
    expect(back.synced).toEqual([{ ms: 1000, text: "Mine" }]);
    expect(matchParrotLyricsFile({ name: "x.lrc", tags: back.tags }, await rows<ParrotLyricsSong>(seed(), PARROT_LYRICS_SONGS_SQL))).toEqual({ kind: "matched", trackId: "t-nook" });
    expect(parrotOwnLyricsText({ synced: null, plain: "words" }, { title: "Nook", artist: null, album: null, durationMs: null })).toEqual({ synced: null, plain: "words" });
  });
});

describe("the user's own lyrics in the library", () => {
  it("are kept marked as the user's, shown over everything, and the lookup never asks or writes over them", async () => {
    console.log(T, "phase: precedence");
    const db = seed();
    const file = parseParrotLyricsFile("[00:01.00] Mine\n[00:02.00] Two", "nook.lrc");
    const op = planParrotOwnLyrics("t-fable", file, ctx)!;
    console.log(T, JSON.stringify(op.payload));
    expect(op.payload).toMatchObject({ trackId: "t-fable", source: "user", synced: "[00:01.00] Mine\n[00:02.00] Two", plain: "Mine\nTwo" });
    apply(db, [op]);
    expect(read(db, "t-fable")).toEqual({ synced: [{ ms: 1000, text: "Mine" }, { ms: 2000, text: "Two" }], plain: "Mine\nTwo", fetched: false, own: true });
    // They replace "No lyrics" and leave the automatic pass nothing to ask.
    expect(rows<{ id: string }>(db, PARROT_LYRICS_UNASKED_SQL).map((row) => row.id)).not.toContain("t-fable");
    const asked: string[] = [];
    const fetched = await fetchParrotLyrics({ query: queryOf(db), trackId: "t-fable", lookup: async (q) => (asked.push(q.title), { synced: "[00:01.00] found", plain: "found" }), now: () => NOW, newId: ctx.newId });
    expect(fetched).toEqual({ kind: "present" });
    expect(asked).toEqual([]);
  });

  it("drop a lookup's answer that lands after the user saved theirs, but keep the user's own ops", () => {
    console.log(T, "phase: keep filter race");
    const db = seed();
    const lookedUp = planParrotLyrics("t-nook", { synced: null, plain: "found words" }, ctx)!;
    const forGone = planParrotLyrics("t-gone", { synced: null, plain: "found" }, ctx)!;
    const own = planParrotOwnLyrics("t-nook", { synced: null, plain: "my words" }, ctx)!;
    apply(db, [own]);
    const keep = parrotLyricsOpsToKeep([lookedUp, forGone, own], rows<{ id: string; source: string | null }>(db, PARROT_LYRICS_KEEP_SQL));
    console.log(T, keep.map((op) => op.id));
    expect(keep).toEqual([own]);
    // Before the user saved anything, the lookup's answer is kept as always.
    expect(parrotLyricsOpsToKeep([lookedUp], rows<{ id: string; source: string | null }>(seed(), PARROT_LYRICS_KEEP_SQL))).toEqual([lookedUp]);
  });

  it("removed, give the song back to the lookups", async () => {
    console.log(T, "phase: remove");
    const db = seed();
    apply(db, [planParrotOwnLyrics("t-fable", { synced: null, plain: "mine" }, ctx)!]);
    apply(db, [planParrotRemoveOwnLyrics("t-fable", ctx)]);
    expect(read(db, "t-fable")).toBeNull();
    expect(rows<{ id: string }>(db, PARROT_LYRICS_UNASKED_SQL).map((row) => row.id)).toContain("t-fable");
    const fetched = await fetchParrotLyrics({ query: queryOf(db), trackId: "t-fable", lookup: async () => ({ synced: null, plain: "found" }), now: () => NOW, newId: ctx.newId });
    expect(fetched.kind).toBe("found");
  });

  it("keep nothing for no words", () => {
    expect(planParrotOwnLyrics("t-nook", { synced: null, plain: "  " }, ctx)).toBeNull();
  });
});

describe("the lyrics editor", () => {
  it("times lines with taps and nudges, and saves synced when every line is timed", () => {
    console.log(T, "phase: timing mode");
    let lines = parrotEditorLines("First\n\nSecond\nThird");
    expect(lines).toEqual([{ text: "First", ms: null }, { text: "Second", ms: null }, { text: "Third", ms: null }]);
    lines = tapParrotEditorLine(lines, 0, 1200.4);
    lines = tapParrotEditorLine(lines, 1, 3000);
    lines = nudgeParrotEditorLine(lines, 1, -100);
    lines = nudgeParrotEditorLine(lines, 0, -5000);
    // Not every line timed: saved as plain words.
    const partial = saveParrotEditorLyrics(parrotEditorLinesText(lines));
    console.log(T, JSON.stringify(partial));
    expect(partial).toEqual({ ok: true, lyrics: { synced: null, plain: "First\nSecond\nThird" } });
    lines = tapParrotEditorLine(lines, 2, 5000);
    const text = parrotEditorLinesText(lines);
    expect(text).toBe("[00:00.00] First\n[00:02.90] Second\n[00:05.00] Third");
    expect(saveParrotEditorLyrics(text)).toEqual({
      ok: true,
      lyrics: { synced: [{ ms: 0, text: "First" }, { ms: 2900, text: "Second" }, { ms: 5000, text: "Third" }], plain: "First\nSecond\nThird" },
    });
    expect(clearParrotEditorTimes(lines).every((line) => line.ms === null)).toBe(true);
  });

  it("keeps pasted plain lyrics with their verse breaks and refuses times going back", () => {
    console.log(T, "phase: paste and order");
    expect(saveParrotEditorLyrics("Verse one\nline two\n\n\n\nVerse two\n")).toEqual({ ok: true, lyrics: { synced: null, plain: "Verse one\nline two\n\nVerse two" } });
    expect(saveParrotEditorLyrics("[00:05.00] a\n[00:03.00] b")).toEqual({ ok: false, problem: { kind: "outOfOrder", line: 2 } });
    expect(saveParrotEditorLyrics("\n  \n")).toEqual({ ok: false, problem: { kind: "empty" } });
  });

  it("opens on the song's current lyrics", () => {
    expect(parrotEditorText({ synced: [{ ms: 1000, text: "a" }, { ms: 2000, text: "" }], plain: "a", fetched: true })).toBe("[00:01.00] a");
    expect(parrotEditorText({ synced: null, plain: "words", fetched: false })).toBe("words");
    expect(parrotEditorText(null)).toBe("");
  });
});

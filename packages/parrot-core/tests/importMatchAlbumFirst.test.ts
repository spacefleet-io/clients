/**
 * @test-id PARROT-CORE-IMPORT-ALBUM-FIRST-001
 * @level unit (made-up releases shaped like Linkin Park's Hybrid Theory and three other albums sharing its songs)
 * @why PAR-UP-10 (Chris 2026-11-27, "(A) looks best"): a dropped folder is one album. A folder of Hybrid Theory's 12
 *   songs, three of which the metadata's Hybrid Theory spells otherwise and which are also on other albums (the single
 *   "In the End", the "Papercuts" collection, the 20th anniversary edition), used to show four albums: one of the three
 *   placed sure elsewhere, two in doubt, and Hybrid Theory itself short of the 0.8 share set coherence asked for.
 *   Album first keeps all 12 on Hybrid Theory and remembers where each of the three is also found, so the review can
 *   offer "Move there".
 * @req PAR-UP-10
 */
import { describe, expect, it } from "bun:test";
import type { MusicAlbum, MusicAlbumsQuery, MusicRecording, MusicRecordingsQuery } from "@space/shared/api";
import { matchParrotImport, type ParrotImportFileQuestion, type ParrotImportMatch } from "../src/importMatch";

const T = "[PARROT-CORE-IMPORT-ALBUM-FIRST-001]";

const ARTIST = { id: "lp", name: "Linkin Park" };
const album = (n: number, title: string, year: number, kind: string, tracks: Array<[string, number]>): MusicAlbum => {
  // Our copy's ids (PAR-META-26: the import asks an album by id only when the id is our copy's).
  const id = `00000000-0000-4000-8000-00000000b00${n}`;
  return { id, title, year, kind, artist: ARTIST, tracks: tracks.map(([name, durationMs], index) => ({ disc: 1, number: index + 1, title: name, durationMs, id: `${id}-${index + 1}` })) };
};
const HYBRID_THEORY = album(1, "Hybrid Theory", 2000, "Album", [
  ["Papercut", 184_000],
  ["One Step Closer", 157_000],
  ["With You", 203_000],
  ["Points of Athority", 200_000],
  ["Crawlin'", 209_000],
  ["Runaway", 184_000],
  ["By Myself", 190_000],
  ["In tha End", 216_000],
  ["A Place for My Head", 185_000],
  ["Forgotten", 194_000],
  ["Cure for the Itch", 157_000],
  ["Pushing Me Away", 191_000],
]);
const IN_THE_END_SINGLE = album(2, "In the End", 2001, "Single", [
  ["In the End", 216_000],
  ["Points of Authority (live)", 210_000],
  ["A Place for My Head (live)", 190_000],
  ["In the End (video)", 218_000],
]);
const PAPERCUTS = album(3, "Papercuts (Singles Collection 2000–2023)", 2024, "Album + Compilation", [
  ["Crawling", 209_000],
  ...Array.from({ length: 19 }, (_, index): [string, number] => [`Single ${index + 2}`, 180_000 + index * 1000]),
]);
/** The user's tags spell the three as everyone does; the metadata's Hybrid Theory lists them otherwise (as artishaw's "A Man I Love"). */
const TAGGED: Record<string, string> = { "Points of Athority": "Points of Authority", "Crawlin'": "Crawling", "In tha End": "In the End" };

const ANNIVERSARY = album(4, "Hybrid Theory (20th Anniversary Edition)", 2020, "Album", [
  ...HYBRID_THEORY.tracks.map((track): [string, number] => [track.title === "Points of Athority" ? "Points of Authority" : `${TAGGED[track.title] ?? track.title} - 2020 Remaster`, track.durationMs!]),
  ["She Couldn't", 254_000],
]);
const CATALOG = [HYBRID_THEORY, IN_THE_END_SINGLE, PAPERCUTS, ANNIVERSARY];
const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const fakeLookups = () => ({
  recordings: async (question: MusicRecordingsQuery) => ({
    results: CATALOG.flatMap((one) =>
      one.tracks
        .filter((track) => fold(track.title) === fold(question.title))
        .map(
          (track): MusicRecording => ({
            id: `${one.id}-${track.number}`,
            title: track.title,
            durationMs: track.durationMs,
            artist: ARTIST,
            album: { id: one.id, title: one.title, year: one.year, trackNumber: track.number, disc: 1, kind: one.kind, official: true },
          })
        )
    ),
  }),
  albums: async (question: MusicAlbumsQuery) => ({ results: CATALOG.filter((one) => (question.id ? one.id === question.id : fold(one.title) === fold(question.album))) }),
});

const folder = (tracks = HYBRID_THEORY.tracks): ParrotImportFileQuestion[] =>
  tracks.map((track) => ({
    file: `/music/Linkin Park/Hybrid Theory/${String(track.number).padStart(2, "0")} ${TAGGED[track.title] ?? track.title}.mp3`,
    title: TAGGED[track.title] ?? track.title,
    artist: "Linkin Park",
    album: "Hybrid Theory",
    durationMs: track.durationMs! + 300,
    disc: 1,
    number: track.number,
  }));

const run = (files: ParrotImportFileQuestion[]) => matchParrotImport(files, fakeLookups());
const fileOf = (result: ParrotImportMatch, title: string) => result.albums.flatMap((found) => found.files).find((one) => one.file.endsWith(` ${title}.mp3`))!;

describe(`${T} a dropped folder stays one album`, () => {
  it("Hybrid Theory: all 12 songs land on Hybrid Theory, sure, nothing to check", async () => {
    const result = await run(folder());
    expect(result.albums.map((found) => found.album.id)).toEqual([HYBRID_THEORY.id]);
    expect(result.albums[0]!.files.length).toBe(12);
    expect(result.albums[0]!.files.every((one) => one.sure)).toBe(true);
    expect(result.unidentified).toEqual([]);
    for (const one of result.albums[0]!.files) {
      const track = HYBRID_THEORY.tracks.find((listed) => listed.number === one.number)!;
      expect(one.file.endsWith(` ${TAGGED[track.title] ?? track.title}.mp3`)).toBe(true);
    }
  });

  it("remembers where each of the three is also found, so Move there can put it on that album's track", async () => {
    const result = await run(folder());
    const also = (title: string) => {
      const one = fileOf(result, title).alsoOn!;
      return { id: one.album.id, track: one.album.tracks.find((track) => track.disc === one.disc && track.number === one.number)!.title, size: one.album.tracks.length, sure: one.sure };
    };
    // The user picks Move there, so each is sure: the library (none here) has no song on that slot.
    expect(also("In the End")).toEqual({ id: IN_THE_END_SINGLE.id, track: "In the End", size: 4, sure: true });
    expect(also("Crawling")).toEqual({ id: PAPERCUTS.id, track: "Crawling", size: 20, sure: true });
    expect(also("Points of Authority")).toEqual({ id: ANNIVERSARY.id, track: "Points of Authority", size: 13, sure: true });
    expect(fileOf(result, "Papercut").alsoOn).toBeUndefined();
    expect(result.albums[0]!.files.filter((one) => one.alsoOn).length).toBe(3);
  });

  it("a song whose other album's slot the library already has keeps Move there in doubt, so moving it asks for a Check", async () => {
    const library = [{
      musicId: IN_THE_END_SINGLE.id!,
      title: IN_THE_END_SINGLE.title,
      artist: ARTIST.name,
      tracklist: IN_THE_END_SINGLE.tracks.map(({ disc, number, title, durationMs }) => ({ disc, number, title, durationMs })),
      owned: [{ disc: 1, number: 1 }],
    }];
    const result = await matchParrotImport(folder(), { ...fakeLookups(), library });
    const one = fileOf(result, "In the End").alsoOn;
    expect(one?.album.id).toBe(IN_THE_END_SINGLE.id);
    expect(one?.sure).toBe(false);
    expect(fileOf(result, "Crawling").alsoOn?.sure).toBe(true);
  });

  it("a folder of only 6 of the 12, 3 of them answered elsewhere, is no clear album and keeps each song's own match", async () => {
    const six = HYBRID_THEORY.tracks.filter((track) => ["Papercut", "One Step Closer", "With You", "In tha End", "Crawlin'", "Points of Athority"].includes(track.title));
    const result = await run(folder(six));
    expect(fileOf(result, "In the End").alsoOn).toBeUndefined();
    expect(result.albums.find((found) => found.album.id === IN_THE_END_SINGLE.id)!.files.length).toBe(1);
  });

  it("a live take in the folder stays on its live release, though the studio album's same track is free", async () => {
    const files = folder(HYBRID_THEORY.tracks.filter((track) => track.title !== "A Place for My Head"));
    files.push({ file: "/music/Linkin Park/Hybrid Theory/09 A Place for My Head (live).mp3", title: "A Place for My Head (live)", artist: "Linkin Park", album: "Hybrid Theory", durationMs: 190_300, disc: 1, number: 9 });
    const result = await run(files);
    const live = result.albums.flatMap((found) => found.files.map((one) => ({ id: found.album.id, one }))).find(({ one }) => one.file.endsWith("(live).mp3"));
    expect(live?.id).toBe(IN_THE_END_SINGLE.id);
    expect(result.albums.find((found) => found.album.id === HYBRID_THEORY.id)!.files.length).toBe(11);
  });
});

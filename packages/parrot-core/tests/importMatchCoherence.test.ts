/**
 * @test-id PARROT-CORE-IMPORT-COHERENCE-001
 * @level unit (the real lookups recorded for one folder, replayed; and made-up releases shaped like the same trap)
 * @why PAR-UP-10 (Chris 2026-11-26): importing ~/Musique/artishaw (24 songs, exactly "Dancing on the Ceiling" by Artie
 *   Shaw and His Gramercy Five) showed three albums: Dancing on the Ceiling 22 of 24, plus "Artie Shaw and his
 *   Orchestra" 1 of 18 and "Blues in the Night" 1 of 21, each with Check. The two strays were "The Man I Love" (the
 *   metadata lists track 8 as "A Man I Love") and "Just Floatin' Along" (listed as "Just Floating' Along"): their
 *   titles never equal the album's, so each was scored alone and went to another album. Files dropped together that
 *   nearly fill one album must keep their leftovers on that album's free tracks when title and length fit.
 * @req PAR-UP-10
 * @bugfix @regression-proof
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MusicAlbum, MusicAlbumsQuery, MusicRecording, MusicRecordingsQuery } from "@space/shared/api";
import { matchParrotImport, type ParrotImportFileQuestion, type ParrotImportMatch } from "../src/importMatch";

const T = "[PARROT-CORE-IMPORT-COHERENCE-001]";

type Recorded = {
  questions: ParrotImportFileQuestion[];
  recordings: Array<{ query: MusicRecordingsQuery; answer: { results: MusicRecording[] } }>;
  albums: Array<{ query: MusicAlbumsQuery; ids: string[] }>;
  releases: Record<string, MusicAlbum>;
};

/** The lookups recorded on 2026-11-26 for ~/Musique/artishaw (big compilations cut to the tracks named like a file). */
const ARTISHAW = JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures/artishaw-lookups.json"), "utf8")) as Recorded;

/** Answers each question exactly as recorded; a question never recorded fails the test rather than guessing. */
const replay = (recorded: Recorded) => {
  const recordings = new Map(recorded.recordings.map((one) => [JSON.stringify(one.query), one.answer]));
  const albums = new Map(recorded.albums.map((one) => [JSON.stringify(one.query), { results: one.ids.map((id) => recorded.releases[id]!) }]));
  return {
    recordings: async (query: MusicRecordingsQuery) => {
      const answer = recordings.get(JSON.stringify(query));
      if (!answer) throw new Error(`${T} unrecorded recordings question ${JSON.stringify(query)}`);
      return answer;
    },
    albums: async (query: MusicAlbumsQuery) => {
      const answer = albums.get(JSON.stringify(query));
      if (!answer) throw new Error(`${T} unrecorded albums question ${JSON.stringify(query)}`);
      return answer;
    },
  };
};

const summary = (result: ParrotImportMatch) =>
  result.albums.map((found) => `${found.album.title} ${found.files.length}/${found.album.tracks.length} sure=${found.files.filter((one) => one.sure).length}`);

describe(`${T} a folder that nearly fills one album keeps its leftovers on it`, () => {
  it("artishaw: all 24 songs land on Dancing on the Ceiling, 24 of 24, nothing to check", async () => {
    const lines: string[] = [];
    const result = await matchParrotImport(ARTISHAW.questions, { ...replay(ARTISHAW), lanes: 1, log: (line) => lines.push(line) });
    console.info(`${T} artishaw\n  ${summary(result).join("\n  ")}\n  unidentified ${JSON.stringify(result.unidentified)}\n  ${lines.filter((line) => /coherence|Man I Love|Floatin/u.test(line)).join("\n  ")}`);
    expect(result.unidentified).toEqual([]);
    expect(result.albums.map((found) => found.album.id)).toEqual(["7547c058-5441-4336-a77d-ed0ed5d95808"]);
    const [album] = result.albums;
    expect(album!.files.length).toBe(24);
    expect(album!.files.filter((one) => !one.sure)).toEqual([]);
    const at = (title: string) => album!.files.find((one) => one.file.includes(title))!;
    const track = (placed: { disc: number; number: number }) => album!.album.tracks.find((one) => one.disc === placed.disc && one.number === placed.number)!.title;
    expect(track(at("The Man I Love"))).toBe("A Man I Love");
    expect(track(at("Just Floatin"))).toBe("Just Floating' Along");
    expect(lines.some((line) => line.startsWith("[import-match] coherence:"))).toBe(true);
  });
});

const ARTIST = { id: "ln", name: "Linnet Park" };
const album = (id: string, title: string, kind: string, tracks: Array<[string, number]>): MusicAlbum => ({
  id,
  title,
  year: 2003,
  kind,
  artist: ARTIST,
  tracks: tracks.map(([title, durationMs], index) => ({ disc: 1, number: index + 1, title, durationMs, id: `${id}-${index + 1}` })),
});
// Our copy's ids (PAR-META-26: the import asks an album by id only when the id is our copy's).
const MELTWAY = album("00000000-0000-4000-8000-00000000a001", "Meltway", "Album", [
  ["Forecast", 13_000],
  ["Don't Linger", 187_000],
  ["Somewhere I Wander", 213_000],
  ["Hiding From You", 175_000],
  ["Hit the Gravel", 164_000],
  ["Easier to Swim", 204_000],
  ["Fable", 162_000],
  ["Figure.17", 197_000],
  ["Breaking the Tide", 196_000],
  ["From the Hillside", 175_000],
  ["Nobody's Watching", 178_000],
  ["Interlude", 143_000],
  ["Nook", 187_000],
]);
/** Releases listing a song under the spelling the user's tags carry, so that spelling is never answered on Meltway. */
const RARITIES = album("00000000-0000-4000-8000-00000000a002", "Rarities", "Album + Compilation", [
  ["Nobody's Watchin'", 178_000],
  ["Lost Ferry", 201_000],
]);
const UNDERGROUND = album("00000000-0000-4000-8000-00000000a003", "Underground 4.0", "EP", [
  ["Easier 2 Swim", 205_000],
  ["Pale Gate", 190_000],
]);
const CATALOG = [MELTWAY, RARITIES, UNDERGROUND];

/** A lookup answering every recording whose title is the asked one (loosely), and every album by its name. */
const fakeLookups = () => {
  const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
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
  };
};

const meltwayFolder = (songs: Array<[string, number]>): ParrotImportFileQuestion[] =>
  songs.map(([title, durationMs]) => ({ file: `/music/Linnet Park/Meltway/${title}.mp3`, title, artist: "Linnet Park", album: "Meltway", durationMs, disc: 1, number: 0 }));

const run = async (files: ParrotImportFileQuestion[], name: string) => {
  const lines: string[] = [];
  const result = await matchParrotImport(files, { ...fakeLookups(), log: (line) => lines.push(line) });
  console.info(`${T} ${name}\n  ${summary(result).join("\n  ")}\n  unidentified ${JSON.stringify(result.unidentified)}\n  ${lines.join("\n  ")}`);
  return result;
};

describe(`${T} made-up releases with the same trap`, () => {
  it("a Meltway folder whose two songs are spelled like other releases lands whole on Meltway, 13 of 13", async () => {
    const songs = MELTWAY.tracks.map((track): [string, number] => [track.title, track.durationMs! + 400]);
    songs[5] = ["Easier 2 Swim", 204_600];
    songs[10] = ["Nobody's Watchin'", 178_300];
    const result = await run(meltwayFolder(songs), "spelled like other releases");
    expect(result.albums.map((found) => found.album.id)).toEqual([MELTWAY.id]);
    expect(result.albums[0]!.files.length).toBe(13);
    expect(result.albums[0]!.files.every((one) => one.sure)).toBe(true);
    expect(result.unidentified).toEqual([]);
  });

  it("a stray song whose title is not one of the album's free tracks stays where its own match put it", async () => {
    const songs = MELTWAY.tracks.filter((track) => track.title !== "Easier to Swim").map((track): [string, number] => [track.title, track.durationMs! + 400]);
    songs.push(["Pale Gate", 190_400]);
    const result = await run(meltwayFolder(songs), "unrelated stray");
    const byId = Object.fromEntries(result.albums.map((found) => [found.album.id, found.files.length]));
    expect(byId).toEqual({ [MELTWAY.id!]: 12, [UNDERGROUND.id!]: 1 });
  });

  it("a stray song with the right title but a length far off the free track stays where its own match put it", async () => {
    const songs = MELTWAY.tracks.map((track): [string, number] => [track.title, track.durationMs! + 400]);
    songs[10] = ["Nobody's Watchin'", 320_000];
    const result = await run(meltwayFolder(songs), "length far off");
    expect(result.albums.find((found) => found.album.id === MELTWAY.id)!.files.length).toBe(12);
  });
});

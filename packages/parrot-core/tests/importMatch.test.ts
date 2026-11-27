/**
 * @test-id PARROT-CORE-IMPORT-MATCH-001
 * @level unit (fake lookups)
 * @why PAR-UP-05 (Chris 2026-11-11): each file of an import is matched on its own and grouped under the album it
 *   really matches (a Meltway-tagged "At the Gate" lands under Hollow Signal, a live take under its live release);
 *   a file matching nothing is unidentified, never an album's extra; an unsure match is marked to check; each matched
 *   album is asked once for its full tracklist, so its missing tracks are known; a failed lookup never blocks.
 */
import { describe, expect, it } from "bun:test";
import type { MusicAlbum, MusicAlbumsQuery, MusicRecording, MusicRecordingsQuery } from "@space/shared/api";
import {
  matchParrotImport,
  matchParrotImportTracks,
  parrotAlbumArtists,
  parrotAlbumKey,
  parrotImportFromMatch,
  parrotImportMissingTracks,
  PARROT_LOOKUP_RETRY_AFTER_CAP_MS,
  PARROT_LOOKUP_RETRY_DELAYS_MS,
  type ParrotImportFileQuestion,
} from "../src/importMatch";

const T = "[PARROT-CORE-IMPORT-MATCH-001]";
const LP = { id: "lp", name: "Linnet Park" };
/** An album id our copy knows (a release group's UUID, PAR-META-26), spelled from a readable name. */
const rg = (name: string) => {
  const hex = [...name].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("").slice(0, 32).padEnd(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const album = (id: string, title: string, year: number, tracks: Array<[string, number]>): MusicAlbum => ({
  id,
  title,
  year,
  kind: "album",
  artist: LP,
  tracks: tracks.map(([name, durationMs], index) => ({ disc: 1, number: index + 1, title: name, durationMs, id: `${id}-${index + 1}` })),
});

const HYBRID = album(rg("hybrid"), "Hollow Signal", 2000, [
  ["Paperboat", 185_000],
  ["One Step Farther", 157_000],
  ["Near You", 203_000],
  ["At the Gate", 216_000],
]);
const MELTWAY = album(rg("meltway"), "Meltway", 2003, [
  ["Forecast", 13_000],
  ["Don't Linger", 188_000],
  ["Somewhere I Wander", 214_000],
  ["Fable", 162_000],
  ["Nook", 185_000],
]);
const LIVE = album(rg("live"), "Live in Tarvo", 2003, [
  ["Somewhere I Wander (Live)", 220_000],
  ["Nook (Live)", 190_000],
]);
// A compilation carrying the very same song, to make a close competing album.
const BEST_OF = album(rg("best"), "Greatest Hits", 2010, [["Fable", 162_000]]);
const ALBUMS = [HYBRID, MELTWAY, LIVE, BEST_OF];

const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const base = (text: string) => fold(text.replace(/\(.*?\)/g, ""));

/** The fake lookups and what they were asked; `failFor` titles throw. */
const fakeLookups = (options: { failFor?: string[]; albumsFail?: boolean; rivalFable?: boolean; failFirst?: () => Error; failFirstTimes?: number } = {}) => {
  let failsLeft = options.failFirstTimes ?? 0;
  const asked = { recordings: [] as MusicRecordingsQuery[], albums: [] as MusicAlbumsQuery[] };
  let running = 0;
  const peak = { value: 0 };
  return {
    asked,
    peak,
    recordings: async (question: MusicRecordingsQuery) => {
      asked.recordings.push(question);
      running += 1;
      peak.value = Math.max(peak.value, running);
      for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
      running -= 1;
      if (options.failFor?.includes(question.title)) throw new Error("music lookup answered 501");
      if (options.failFirst && failsLeft > 0) {
        failsLeft -= 1;
        throw options.failFirst();
      }
      const results: MusicRecording[] = [];
      for (const found of ALBUMS) {
        if (found === BEST_OF && !options.rivalFable) continue;
        for (const track of found.tracks) {
          const exact = fold(track.title) === fold(question.title);
          const loose = /\(/.test(question.title) && base(track.title) === base(question.title);
          if (!exact && !loose) continue;
          results.push({
            id: track.id!,
            title: track.title,
            durationMs: track.durationMs,
            artist: LP,
            album: { id: found.id, title: found.title, year: found.year, trackNumber: track.number, disc: 1 },
          });
        }
      }
      return { results };
    },
    albums: async (question: MusicAlbumsQuery) => {
      asked.albums.push(question);
      if (options.albumsFail) throw new Error("albums down");
      return { results: ALBUMS.filter((found) => fold(found.title) === fold(question.album)) };
    },
  };
};

const file = (name: string, title: string, albumTag: string, durationMs: number | null, number = 0): ParrotImportFileQuestion => ({
  file: `/m/${name}`,
  title,
  artist: "linnet park",
  album: albumTag,
  durationMs,
  disc: 1,
  number,
});

describe(`${T} per-file matching`, () => {
  it("groups each file under the album it really matches, live takes under their live release, junk unidentified", async () => {
    const lookups = fakeLookups();
    const lines: string[] = [];
    const result = await matchParrotImport(
      [
        file("nook.mp3", "nook", "meltway", 185_400, 13),
        file("fable.mp3", "Fable", "Meltway", 161_000, 7),
        file("end.mp3", "At the Gate", "Meltway", 216_500, 3), // mislabeled: tagged Meltway, really on Hollow Signal
        file("nook-live.mp3", "Nook (Live)", "Meltway", 190_200),
        file("junk.mp3", "Untitled Noise", "Meltway", 30_000),
        { ...file("blank.mp3", "", "", null), artist: "" },
      ],
      { ...lookups, lanes: 2, log: (line) => lines.push(line) }
    );
    console.info(`${T} result ${JSON.stringify(result)}\n${lines.join("\n")}`);
    const byAlbum = Object.fromEntries(result.albums.map((found) => [found.album.title, found.files.map((placed) => placed.file)]));
    expect(byAlbum).toEqual({
      "Hollow Signal": ["/m/end.mp3"],
      "Live in Tarvo": ["/m/nook-live.mp3"],
      Meltway: ["/m/fable.mp3", "/m/nook.mp3"],
    });
    expect(result.unidentified).toEqual([
      { file: "/m/junk.mp3", reason: "no-match" },
      { file: "/m/blank.mp3", reason: "no-names" },
    ]);
    const meltway = result.albums.find((found) => found.album.title === "Meltway")!;
    expect(meltway.tracklistKnown).toBe(true);
    expect(meltway.files).toMatchObject([
      { file: "/m/fable.mp3", disc: 1, number: 4, sure: true },
      { file: "/m/nook.mp3", disc: 1, number: 5, sure: true },
    ]);
    // The album tag is sent as a hint only, with the length; each album is asked once by its id for its tracklist, and
    // once by name, being the song's own artist's (PAR-META-03).
    expect(lookups.asked.recordings[0]).toMatchObject({ artist: "linnet park", title: "nook", album: "meltway", durationMs: 185_400 });
    expect(lookups.asked.albums.filter((question) => question.id).map((question) => question.album).sort()).toEqual(["Hollow Signal", "Live in Tarvo", "Meltway"]);
    expect(lookups.asked.albums.filter((question) => !question.id).map((question) => question.album).sort()).toEqual(["Hollow Signal", "Live in Tarvo", "Meltway"]);
    expect(lookups.peak.value).toBe(2);
  });

  it("knows an incomplete album's missing tracks and its n of m", async () => {
    const result = await matchParrotImport([file("fable.mp3", "Fable", "Meltway", 162_000), file("nook.mp3", "Nook", "Meltway", 185_000)], fakeLookups());
    const meltway = result.albums[0]!;
    expect(`${meltway.files.length} of ${meltway.album.tracks.length}`).toBe("2 of 5");
    expect(parrotImportMissingTracks(meltway.album, meltway.files).map((track) => track.title)).toEqual(["Forecast", "Don't Linger", "Somewhere I Wander"]);
  });

  it("marks unsure matches to check: a loose title, a length far off, or a close album on another release", async () => {
    const result = await matchParrotImport(
      [
        file("belong.mp3", "Somewhere I Wander (live)", "", 220_000), // sure: the live take, same title once case is set aside
        file("paperboat.mp3", "Paperboat (Demo)", "Hollow Signal", 185_000), // only the base title matches, and it names another take
        // Weighed with its tag and folder, a remaster's loose title confirms on the album (Main, 2026-11-15).
        file("nearyou.mp3", "Near You (Remastered)", "Hollow Signal", 203_000),
        file("closer.mp3", "One Step Farther", "Hollow Signal", 20_000), // 20 s file against a 157 s track
      ],
      { ...fakeLookups(), log: (line) => console.info(`${T} ${line}`) }
    );
    const sure = Object.fromEntries(result.albums.flatMap((found) => found.files.map((placed) => [placed.file, placed.sure])));
    console.info(`${T} sure ${JSON.stringify(sure)}`);
    expect(sure).toEqual({ "/m/belong.mp3": true, "/m/paperboat.mp3": false, "/m/nearyou.mp3": true, "/m/closer.mp3": false });

    const rival = await matchParrotImport([file("fable.mp3", "Fable", "", 162_000)], fakeLookups({ rivalFable: true }));
    expect(rival.albums.flatMap((found) => found.files.map((placed) => placed.sure))).toEqual([false]);
  });

  it("never blocks on a failed lookup: that file is lookup-failed, an album whose lookup fails keeps its recordings", async () => {
    const failing = await matchParrotImport([file("fable.mp3", "Fable", "Meltway", 162_000), file("nook.mp3", "Nook", "Meltway", 185_000)], fakeLookups({ failFor: ["Nook"] }));
    expect(failing.unidentified).toEqual([{ file: "/m/nook.mp3", reason: "lookup-failed" }]);
    expect(failing.albums.map((found) => found.album.title)).toEqual(["Meltway"]);

    const noAlbums = await matchParrotImport([file("fable.mp3", "Fable", "Meltway", 162_000)], fakeLookups({ albumsFail: true }));
    expect(noAlbums.albums[0]).toMatchObject({ tracklistKnown: false, files: [{ file: "/m/fable.mp3", number: 4, sure: true }] });
    expect(noAlbums.albums[0]!.album.tracks.map((track) => track.title)).toEqual(["Fable"]);
  });

  it("a second copy of the same song finds no free track and is unidentified, never an extra", async () => {
    const result = await matchParrotImport([file("a.mp3", "Fable", "Meltway", 162_000), file("b.mp3", "Fable", "Meltway", 150_000)], fakeLookups());
    expect(result.albums[0]!.files.map((placed) => placed.file)).toEqual(["/m/a.mp3"]);
    expect(result.unidentified).toEqual([{ file: "/m/b.mp3", reason: "no-track" }]);
  });
});

describe(`${T} tracks the user picks`, () => {
  it("pairs moved songs by title first, then by place, each free track once", () => {
    const matched = matchParrotImportTracks(
      [
        { file: "/m/x.flac", title: "dont linger", disc: 1, number: 9 },
        { file: "/m/y.flac", title: "Track 01", disc: 0, number: 1 },
        { file: "/m/z.flac", title: "Bonus", disc: 1, number: 9 },
      ],
      MELTWAY,
      [{ disc: 1, number: 1 }]
    );
    expect(matched.get("/m/x.flac")?.number).toBe(2);
    // Track 1 is taken already, so the untitled song at place 1 gets no track.
    expect(matched.get("/m/y.flac")).toBeNull();
    expect(matched.get("/m/z.flac")).toBeNull();
  });

  it("fills a song's names from the album and its track", () => {
    expect(parrotImportFromMatch(MELTWAY, MELTWAY.tracks[4]!)).toEqual({ artist: "Linnet Park", album: "Meltway", year: 2003, title: "Nook", number: 5, disc: 1 });
  });
});

describe(`${T} the album's artists`, () => {
  // @req PAR-UP-06[parrot]
  it("names every credited artist in credit order, else the one artist", () => {
    const juno = { id: "juno", name: "Jun-O" };
    const collab = { ...MELTWAY, title: "Crossing Current", artists: [LP, juno] };
    console.info(`${T} one artist: ${JSON.stringify(parrotAlbumArtists(MELTWAY))}; two: ${JSON.stringify(parrotAlbumArtists(collab))}`);
    expect(parrotAlbumArtists(MELTWAY)).toEqual([LP]);
    expect(parrotAlbumArtists(collab)).toEqual([LP, juno]);
    expect(parrotAlbumArtists({ ...MELTWAY, artists: [] })).toEqual([LP]);
  });
});

describe(`${T} albums only an outside source knows`, () => {
  // @req PAR-META-19[parrot] @req META-SRC-09[parrot] @req PAR-META-26[parrot]
  // @bugfix: "Ella and Louis" (11 songs, prod 2026-11-26) asked each of 30 outside candidate albums by its outside
  // id; the copy never knows such an id, so each became a paced outside read, 3 min 5 s in all.
  it("matches files on such an album from the song answers, never asking it by id, never mixing two such albums", async () => {
    const opaqueAlbum = (id: string, title: string, tracks: string[]): MusicAlbum => ({
      id,
      title,
      year: 2024,
      kind: "album",
      artist: { id: "artist-opaque-lp", name: "Linnet Park" },
      tracks: tracks.map((name, index) => ({ disc: 1, number: index + 1, title: name, durationMs: 180_000, id: `${id}-v${index + 1}` })),
    });
    const demos = opaqueAlbum("outside_demos01", "Demos", ["Pictureboard", "Esaul"]);
    const other = opaqueAlbum("outside_other01", "Other Demos", ["Pictureboard"]);
    const recording = (on: MusicAlbum, index: number): MusicRecording => ({
      id: on.tracks[index]!.id,
      title: on.tracks[index]!.title,
      durationMs: 180_000,
      artist: on.artist,
      album: { id: on.id, title: on.title, year: on.year, trackNumber: index + 1, disc: 1 },
    });
    const asked: MusicAlbumsQuery[] = [];
    const lines: string[] = [];
    const result = await matchParrotImport(
      [file("esaul.mp3", "Esaul", "Demos", 180_000), file("picture.mp3", "Pictureboard", "Demos", 180_000)],
      {
        recordings: async (question) => ({ results: question.title === "Esaul" ? [recording(demos, 1)] : [recording(demos, 0), recording(other, 0)] }),
        albums: async (question) => {
          asked.push(question);
          return { results: [] };
        },
        log: (line) => lines.push(line),
      }
    );
    console.info(`${T} only an outside source knows: ${JSON.stringify(result.albums.map((found) => [found.album.id, found.tracklistKnown, found.files]))}; asked ${JSON.stringify(asked)}\n${lines.join("\n")}`);
    expect(asked.filter((question) => question.id)).toEqual([]);
    expect(lines.some((line) => line.includes("2 with an outside id not asked"))).toBe(true);
    expect(result.unidentified).toEqual([]);
    expect(result.albums).toHaveLength(1);
    expect(result.albums[0]!.album.id).toBe(demos.id);
    expect(result.albums[0]!.tracklistKnown).toBe(false);
    expect(result.albums[0]!.files.map((placed) => [placed.file, placed.number])).toEqual([
      ["/m/picture.mp3", 1],
      ["/m/esaul.mp3", 2],
    ]);
    expect(parrotAlbumKey(demos)).not.toBe(parrotAlbumKey(other));
  });

  // @req PAR-META-29[parrot] @req PAR-META-30[parrot]
  // @bugfix: Chris's folder "Ella and Louis (1956)" (11 m4a, album tag "Ella and Louis", tracks 1-11, prod 2026-11-26)
  // split over 3 albums: our copy's "Ella and Louis" (2 files), an outside "Ella and Louis, Vol. 46" (7) and the outside
  // own "Ella and Louis" (2), shown as two identical "Ella and Louis · 1956" cards. The copy answered only 2 songs, and
  // its album, credited to Ella Fitzgerald and Louis Armstrong apart, was never offered for the other 9: the files'
  // artist "Ella Fitzgerald & Louis Armstrong" named neither of them.
  it("lands a folder agreeing on its album tag and numbering on our copy's album, a duo's credit naming each artist, one card for one album", async () => {
    const titles = [
      "Can't We Be Friends",
      "Isn't This a Lovely Day",
      "Moonlight in Vermont",
      "They Can't Take That Away From Me",
      "Under a Blanket of Blue",
      "Tenderly",
      "A Foggy Day",
      "Stars Fell on Alabama",
      "Cheek to Cheek",
      "The Nearness of You",
      "April in Paris",
    ];
    const ELLA = { id: "ella", name: "Ella Fitzgerald" };
    const LOUIS = { id: "louis", name: "Louis Armstrong" };
    const DUO = { id: "duo-outside", name: "Ella Fitzgerald & Louis Armstrong" };
    const lengthOf = (index: number) => 180_000 + index * 7_000;
    const tracksOf = (id: string, picked: number[], shift = 0) =>
      picked.map((index) => ({ disc: 1, number: index + 1, title: titles[index]!, durationMs: lengthOf(index) + shift, id: `${id}-${index + 1}` }));
    const all = titles.map((_, index) => index);
    const copy: MusicAlbum = { id: rg("ella and louis"), title: "Ella and Louis", year: 1956, kind: "album", artist: ELLA, artists: [ELLA, LOUIS], tracks: tracksOf(rg("ella and louis"), all) };
    const vol46: MusicAlbum = { id: "outside_vol46", title: "Ella and Louis, Vol. 46", year: 2020, kind: "album", artist: DUO, tracks: tracksOf("outside_vol46", all, 12_000) };
    const outsideOwn: MusicAlbum = { id: "outside_ella", title: "Ella and Louis", year: 1956, kind: "album", artist: DUO, tracks: tracksOf("outside_ella", [6, 10]) };
    const recording = (on: MusicAlbum, index: number, artist = on.artist): MusicRecording => {
      const track = on.tracks.find((one) => one.number === index + 1)!;
      return { id: track.id, title: track.title, durationMs: track.durationMs, artist, album: { id: on.id, title: on.title, year: on.year, trackNumber: track.number, disc: 1 } };
    };
    const questions = titles.map((title, index) => ({
      file: `/m/Ella and Louis (1956)/${String(index + 1).padStart(2, "0")} - ${title}.m4a`,
      title,
      artist: "Ella Fitzgerald & Louis Armstrong",
      album: "Ella and Louis",
      durationMs: lengthOf(index),
      disc: 1,
      number: index + 1,
    }));
    const lines: string[] = [];
    const result = await matchParrotImport(questions, {
      recordings: async (question) => {
        const index = titles.indexOf(question.title);
        // Prod before PAR-META-25: the copy answered "Can't We Be Friends" and "Isn't This a Lovely Day" alone.
        if (index < 2) return { results: [recording(copy, index, { id: "duo", name: "Louis Armstrong & Ella Fitzgerald" })] };
        return { results: [...(index === 6 || index === 10 ? [recording(outsideOwn, index)] : []), recording(vol46, index)] };
      },
      albums: async (question) => ({ results: question.id === copy.id || question.album === copy.title ? [copy] : [] }),
      log: (line) => lines.push(line),
    });
    console.info(`${T} Ella and Louis: ${JSON.stringify(result.albums.map((found) => [found.album.id, found.files.length]))}\n${lines.join("\n")}`);
    expect(result.unidentified).toEqual([]);
    expect(result.albums.map((found) => found.album.id)).toEqual([copy.id]);
    expect(result.albums[0]!.files.map((placed) => placed.number)).toEqual(all.map((index) => index + 1));
    expect(lines.some((line) => line.includes(`album ${outsideOwn.id} (Ella and Louis) is ${parrotAlbumKey(copy)}`))).toBe(true);
  });
});

describe(`${T} compilations and bootlegs`, () => {
  const VA = { id: "va", name: "Various Artists" };
  const track = (id: string, number: number, title: string, durationMs: number) => ({ disc: 1, number, title, durationMs, id: `${id}-${number}` });
  const CLOCKWORKERS: MusicAlbum = {
    id: rg("clockworkers"),
    title: "Clockworkers: The Album",
    year: 2007,
    kind: "Album + Soundtrack",
    artist: VA,
    tracks: [
      track("clockworkers", 1, "What I've Kept", 205_000),
      track("clockworkers", 2, "Before the Lights Go", 196_000),
      track("clockworkers", 3, "Doomsday Bell", 223_000),
      track("clockworkers", 4, "What It Feels Like for a Girl", 211_000),
    ],
  };
  const CLOCKWORKERS_LIVE: MusicAlbum = { ...CLOCKWORKERS, id: rg("clockworkers-live"), title: "Clockworkers: The Album (Live)", kind: "Album + Live" };
  const MINUTES = album(rg("minutes"), "Minutes to Daybreak", 2007, [["What I've Kept", 205_000]]);
  const ZEPHYRINE: MusicAlbum = { ...album(rg("zephyrine"), "Zephyrine", 2007, [["Doomsday Bell", 223_000]]), artist: { id: "sp", name: "The Smashing Lanterns" } };
  const BOOTLEG = { id: rg("lantern-room"), title: "2007-06-24: The Lantern Room, Millbrook, NC, USA", year: 2007, trackNumber: 1, disc: 1 };

  const compilationFile = (number: number, artist: string, title: string, extra: Partial<ParrotImportFileQuestion> = {}): ParrotImportFileQuestion => ({
    file: `/m/Clockworkers/${number}.mp3`,
    title,
    artist,
    album: "Clockworkers: The Album",
    albumArtist: "Various Artists",
    compilation: true,
    durationMs: 15_000,
    disc: 1,
    number,
    ...extra,
  });
  const recordingOn = (on: { id: string | null; title: string; year: number | null }, title: string, artist: MusicRecording["artist"], durationMs: number): MusicRecording => ({
    id: `${on.id}-${title}`,
    title,
    durationMs,
    artist,
    album: { id: on.id, title: on.title, year: on.year, trackNumber: 1, disc: 1 },
  });

  // @req PAR-META-03[parrot] PAR-LIB-01[parrot]
  // @bugfix @regression-proof: a "Clockworkers: The Album" copy tagged compilation=1 / "Various Artists" was split over
  // Minutes to Daybreak, a Greatest Hits, a Smashing Lanterns bootleg and "No match" (Parrot desktop walk, 2026-11-12).
  it("matches a compilation's files to the compilation as a whole, never splitting it over each artist's records", async () => {
    const asked = { recordings: [] as MusicRecordingsQuery[], albums: [] as MusicAlbumsQuery[] };
    const files = [
      compilationFile(1, "Linnet Park", "What I've Kept"),
      compilationFile(2, "Tin Tin Kites", "Before the Lights Go"),
      compilationFile(3, "Taking Back Sunday", "What It Feels Like for a Girl"),
      compilationFile(4, "Smashing Lanterns", "Doomsday Bell"),
      // Not on the soundtrack's tracklist: matched on its own afterwards.
      compilationFile(5, "Linnet Park", "Nook", { albumArtist: "VA", compilation: false }),
    ];
    const lines: string[] = [];
    const result = await matchParrotImport(files, {
      recordings: async (question) => {
        asked.recordings.push(question);
        return { results: question.title === "Nook" ? [recordingOn(MELTWAY, "Nook", LP, 185_000)] : [] };
      },
      albums: async (question) => {
        asked.albums.push(question);
        if (question.artist === "Various Artists") return { results: [CLOCKWORKERS_LIVE, CLOCKWORKERS] };
        return { results: ALBUMS.filter((found) => fold(found.title) === fold(question.album)) };
      },
      log: (line) => lines.push(line),
    });
    console.info(`${T} compilation: ${JSON.stringify(result.albums.map((found) => [found.album.title, found.files]))}\n${lines.join("\n")}`);
    expect(asked.albums[0]).toEqual({ artist: "Various Artists", album: "Clockworkers: The Album", limit: 5 });
    expect(result.unidentified).toEqual([]);
    expect(result.albums.map((found) => [found.album.title, found.files.map((placed) => [placed.file, placed.number])])).toEqual([
      ["Meltway", [["/m/Clockworkers/5.mp3", 5]]],
      [
        "Clockworkers: The Album",
        [
          ["/m/Clockworkers/1.mp3", 1],
          ["/m/Clockworkers/2.mp3", 2],
          ["/m/Clockworkers/4.mp3", 3],
          ["/m/Clockworkers/3.mp3", 4],
        ],
      ],
    ]);
    const soundtrack = result.albums.find((found) => found.album.id === CLOCKWORKERS.id)!;
    expect(soundtrack.tracklistKnown).toBe(true);
    // 15 s files against 3-4 min tracks: on the album, but to check.
    expect(soundtrack.files.every((placed) => !placed.sure)).toBe(true);
    // Only the file the soundtrack lacks was looked up on its own: under the soundtrack's name first, then, the lookup
    // having it on no such album, as a song with no album.
    expect(asked.recordings.map((question) => [question.title, question.album ?? null])).toEqual([
      ["Nook", "Clockworkers: The Album"],
      ["Nook", null],
    ]);
  });

  it("falls back to matching each file on its own when the compilation is not found as a whole", async () => {
    const result = await matchParrotImport([compilationFile(1, "Linnet Park", "What I've Kept", { durationMs: 205_000 })], {
      recordings: async () => ({ results: [recordingOn(MINUTES, "What I've Kept", LP, 205_000)] }),
      albums: async (question) => ({ results: question.artist === "Various Artists" ? [] : [MINUTES] }),
    });
    expect(result.albums.map((found) => [found.album.title, found.files.map((placed) => placed.sure)])).toEqual([["Minutes to Daybreak", [true]]]);
  });

  // @bugfix @regression-proof: a studio-tagged "Doomsday Bell" landed on a Smashing Lanterns concert bootleg.
  it("never prefers a live or bootleg release over the studio one for a file that says studio, and checks one it is left with", async () => {
    const SP = { id: "sp", name: "The Smashing Lanterns" };
    const studio = { file: "/m/doomsday.mp3", title: "Doomsday Bell", artist: "Smashing Lanterns", album: "", durationMs: 223_000, disc: 1, number: 0 };
    const lookups = (withStudio: boolean) => ({
      recordings: async () => ({
        results: [recordingOn(BOOTLEG, "Doomsday Bell", SP, 223_000), ...(withStudio ? [recordingOn(ZEPHYRINE, "Doomsday Bell", SP, 223_000)] : [])],
      }),
      // Each album lookup answers its own album only: the bootleg's name never brings Zephyrine into reach.
      albums: async (question: MusicAlbumsQuery) => ({ results: question.album === ZEPHYRINE.title ? [ZEPHYRINE] : [] }),
    });
    const both = await matchParrotImport([studio], lookups(true));
    expect(both.albums.map((found) => [found.album.title, found.files[0]!.sure])).toEqual([["Zephyrine", true]]);
    const onlyBootleg = await matchParrotImport([studio], lookups(false));
    expect(onlyBootleg.albums.map((found) => [found.album.title, found.files[0]!.sure])).toEqual([[BOOTLEG.title, false]]);
  });

  // @req PAR-META-03[parrot] PAR-META-13[parrot]
  // @bugfix @regression-proof: an untagged "Linnet Park - Fable.mp3" (no album) landed on the 8-Bit Uprising! game
  // (2010), whose take was closest in length to the 15 s file, instead of Meltway (2003) (Parrot desktop walk, 2026-11-12).
  it("files a song with no album hint on the artist's original studio album, not a game, compilation or live release", async () => {
    const fable = { file: "/m/Loose/Linnet Park - Fable.mp3", title: "Fable", artist: "Linnet Park", album: "", durationMs: 15_000, disc: 1, number: 0 };
    const on = (id: string, title: string, year: number, trackNumber: number, durationMs: number, kind?: string, official?: boolean): MusicRecording => ({
      id: `${id}-fable`,
      title: "Fable",
      durationMs,
      artist: LP,
      album: { id, title, year, trackNumber, disc: 1, ...(kind ? { kind } : {}), ...(official !== undefined ? { official } : {}) },
    });
    const MELTWAY: MusicAlbum = { ...album(rg("meltway-rg"), "Meltway", 2003, []), tracks: Array.from({ length: 13 }, (_, i) => track("meltway-rg", i + 1, i === 6 ? "Fable" : `Track ${i + 1}`, 162_000)) };
    const asked: MusicRecordingsQuery[] = [];
    const run = (results: MusicRecording[]) =>
      matchParrotImport([fable], {
        recordings: async (question) => {
          asked.push(question);
          return { results };
        },
        // Each album lookup answers its own album only.
        albums: async (question) => ({ results: question.album === "Meltway" ? [MELTWAY] : [] }),
        log: (line) => console.info(`${T} ${line}`),
      });
    // The lookup's own answers on prod, the game first: it is the take closest to the file's length.
    const typed = [
      on(rg("8bit-rg"), "8-Bit Uprising!", 2010, 4, 146_000, "Album + Soundtrack", true),
      on(rg("colorado-rg"), "2002-02-02: Colorado Springs, CO, USA", 2002, 13, 160_000, "Album + Live", false),
      on(rg("meltway20-rg"), "Meltway (20th anniversary edition)", 2023, 8, 166_431, "Album", true),
      on(rg("meltway-rg"), "Meltway", 2003, 7, 162_106, "Album", true),
    ];
    const typedResult = await run(typed);
    expect(typedResult.albums.map((found) => [found.album.title, found.files.map((placed) => placed.number)])).toEqual([["Meltway", [7]]]);
    // No album to go by: the file's length is not sent, so the lookup answers the song's best-known take first.
    expect(asked[0]).toEqual({ artist: "Linnet Park", title: "Fable", limit: 10 });
    // A lookup that does not give the release type: the earliest album whose name says no live, reissue or soundtrack.
    const untyped = typed.map((recording) => ({ ...recording, album: { ...recording.album!, kind: undefined, official: undefined } }));
    const untypedResult = await run(untyped);
    expect(untypedResult.albums.map((found) => [found.album.title, found.files.map((placed) => placed.number)])).toEqual([["Meltway", [7]]]);
    // The game is picked only when no studio album has the song.
    const onlyGame = await run([typed[0]!]);
    expect(onlyGame.albums.map((found) => found.album.title)).toEqual(["8-Bit Uprising!"]);
    // The walk's file sat in a folder named "Loose", read as its album: the lookup has the song on no such album, so
    // that is no hint and the song is asked again with none.
    asked.length = 0;
    const loose = await matchParrotImport([{ ...fable, album: "Loose" }], {
      recordings: async (question) => {
        asked.push(question);
        return { results: typed };
      },
      albums: async () => ({ results: [MELTWAY] }),
    });
    expect(loose.albums.map((found) => [found.album.title, found.files.map((placed) => placed.number)])).toEqual([["Meltway", [7]]]);
    expect(asked).toEqual([
      { artist: "Linnet Park", title: "Fable", album: "Loose", durationMs: 15_000, limit: 5 },
      { artist: "Linnet Park", title: "Fable", limit: 10 },
    ]);
  });
});

describe(`${T} albums asked by id`, () => {
  const VA = { id: "va", name: "Various Artists" };
  const DJ = { id: "dj", name: "DJ Morrow" };
  const SONGS: Array<[string, number]> = [
    ["Paperboat", 185_000],
    ["One Step Farther", 157_000],
    ["Near You", 203_000],
    ["At the Gate", 216_000],
  ];
  const STUDIO = album(rg("hollow-rg"), "Hollow Signal", 2000, SONGS);
  // Each song also sits on a compilation of its own and on a DJ set: 1 studio album + 8 others in reach.
  const OTHERS: MusicAlbum[] = SONGS.flatMap(([title, durationMs], index) => [
    { ...album(rg(`lounge-${index}`), `Lounge Sessions ${index + 1}`, 2010, [[title, durationMs]]), kind: "Album + Compilation", artist: VA },
    { ...album(rg(`set-${index}`), `Live From Lost Village ${index + 1}`, 2019, [[title, durationMs]]), kind: "Album + DJ-mix", artist: DJ },
  ]);
  const CATALOG = [STUDIO, ...OTHERS];

  /**
   * The metadata service's album lookup (`getMusicAlbums`): our copy first, by id when asked by one, else by album
   * artist and title; a name search our copy answers empty goes to an outside source, paced one call per 3 s across
   * the whole service, an id search never does.
   */
  const service = () => {
    const asked: MusicAlbumsQuery[] = [];
    const outsideSource: MusicAlbumsQuery[] = [];
    return {
      asked,
      outsideSource,
      pacedMs: () => outsideSource.length * 3_000,
      albums: async (query: MusicAlbumsQuery) => {
        asked.push(query);
        const copy = query.id
          ? CATALOG.filter((found) => found.id === query.id)
          : CATALOG.filter((found) => fold(found.artist.name) === fold(query.artist) && fold(found.title) === fold(query.album));
        if (copy.length > 0 || query.id) return { results: copy };
        outsideSource.push(query);
        return { results: [] };
      },
    };
  };

  // @bugfix @regression-proof: Daft Punk's "Discovery" (14 songs) took 68.6 s to identify on Parrot desktop v0.1.25:
  // the 22 compilations and DJ sets its songs sit on were asked by the song's artist and the album's title, which our
  // copy never finds (their album artist is "Various Artists" or the DJ), so each went to the outside source, one every 3 s
  // (Chris 2026-11-21, ParrotIdentifySlow).
  it("asks every answered album by its id, so songs on compilations and DJ sets make no outside-source call", async () => {
    const lookup = service();
    const files = SONGS.map(([title, durationMs], index) => ({
      file: `/m/Hollow Signal/${index + 1} ${title}.mp3`,
      title,
      artist: "Linnet Park",
      album: "Hollow Signal",
      durationMs: durationMs + 300,
      disc: 1,
      number: index + 1,
    }));
    const lines: string[] = [];
    const started = performance.now();
    const result = await matchParrotImport(files, {
      // Every song is on the studio album, its compilation and its DJ set, as the copy's recordings answer lists them.
      recordings: async (question) => ({
        results: CATALOG.flatMap((found) =>
          found.tracks
            .filter((track) => fold(track.title) === fold(question.title))
            .map((track) => ({
              id: track.id,
              title: track.title,
              durationMs: track.durationMs,
              artist: LP,
              album: { id: found.id, title: found.title, year: found.year, trackNumber: track.number, disc: track.disc, kind: found.kind },
            }))
        ),
      }),
      albums: lookup.albums,
      log: (line) => {
        lines.push(line);
        console.info(`${T} ${line}`);
      },
    });
    console.info(
      `${T} ${lookup.asked.length} album lookup(s), ${lookup.asked.filter((query) => query.id).length} by id, ` +
        `${lookup.outsideSource.length} to the outside source (≈${lookup.pacedMs()} ms of its pacing), matched in ${Math.round(performance.now() - started)} ms`
    );
    for (const query of lookup.outsideSource) console.info(`${T} outside source asked: ${query.artist} / ${query.album}`);

    expect(lookup.outsideSource).toEqual([]);
    // One lookup per album in reach by its id: the studio album, 4 compilations, 4 DJ sets.
    expect(lookup.asked.flatMap((query) => (query.id ? [query.id] : [])).sort()).toEqual(CATALOG.flatMap((found) => (found.id ? [found.id] : [])).sort());
    // Only the album credited to the songs' own artist is also asked by name, for its other editions.
    expect(lookup.asked.filter((query) => !query.id)).toEqual([{ artist: "Linnet Park", album: "Hollow Signal", limit: 5 }]);
    // Every album came with its tracklist: none was "kept from its recordings".
    expect(lines.filter((line) => line.includes("not in its own lookup"))).toEqual([]);
    expect(result.albums.map((found) => [found.album.title, found.tracklistKnown, found.files.map((placed) => placed.number)])).toEqual([
      ["Hollow Signal", true, [1, 2, 3, 4]],
    ]);
    expect(result.unidentified).toEqual([]);
  });

  it("asks an album answered without an id by its name, as before", async () => {
    const lookup = service();
    const nameless = { ...STUDIO, id: null };
    await matchParrotImport([{ file: "/m/a.mp3", title: "Paperboat", artist: "Linnet Park", album: "Hollow Signal", durationMs: 185_000, disc: 1, number: 1 }], {
      recordings: async () => ({
        results: [{ id: null, title: "Paperboat", durationMs: 185_000, artist: LP, album: { id: nameless.id, title: nameless.title, year: 2000, trackNumber: 1, disc: 1 } }],
      }),
      albums: lookup.albums,
      log: (line) => console.info(`${T} ${line}`),
    });
    expect(lookup.asked).toEqual([{ artist: "Linnet Park", album: "Hollow Signal", limit: 5 }]);
    expect(lookup.outsideSource).toEqual([]);
  });

  // The match corpus caught this: asked by id alone, Howard Shore's "The Lord of the Rings Trilogy: The Motion Picture
  // Trilogy Soundtrack" (found only by the name search of an answered album of his) fell out of reach, and 56 files
  // went to the three film soundtracks.
  it("still asks the songs' own artist's album by name, so its other editions stay in reach", async () => {
    const DELUXE: MusicAlbum = { ...album(rg("hollow-deluxe-rg"), "Hollow Signal (Deluxe Edition)", 2020, [...SONGS, ["Midnight Reprise", 199_000]]), kind: "Album" };
    const asked: MusicAlbumsQuery[] = [];
    const files = [...SONGS, ["Midnight Reprise", 199_000] as [string, number]].map(([title, durationMs], index) => ({
      file: `/m/Hollow Signal (Deluxe Edition)/${index + 1} ${title}.mp3`,
      title,
      artist: "Linnet Park",
      album: "Hollow Signal (Deluxe Edition)",
      durationMs,
      disc: 1,
      number: index + 1,
    }));
    const result = await matchParrotImport(files, {
      // The songs' answers name the studio album only; the bonus song is on no album the lookup answers (unidentified).
      recordings: async (question) => ({
        results: STUDIO.tracks
          .filter((track) => track.title === question.title)
          .map((track) => ({ id: track.id, title: track.title, durationMs: track.durationMs, artist: LP, album: { id: STUDIO.id, title: STUDIO.title, year: STUDIO.year, trackNumber: track.number, disc: 1, kind: "Album" } })),
      }),
      // Our copy's name search answers the album's editions alongside it.
      albums: async (query) => {
        asked.push(query);
        return { results: query.id ? [STUDIO, DELUXE].filter((found) => found.id === query.id) : fold(query.album).startsWith(fold(STUDIO.title)) ? [STUDIO, DELUXE] : [] };
      },
      log: (line) => console.info(`${T} ${line}`),
    });
    console.info(`${T} asked ${JSON.stringify(asked)}`);
    expect(asked).toEqual([
      { artist: "Linnet Park", album: "Hollow Signal", id: rg("hollow-rg") },
      { artist: "Linnet Park", album: "Hollow Signal", limit: 5 },
    ]);
    // The bonus song no recording answer names sits in the same folder as four songs sure on the deluxe edition, whose
    // free fifth track carries its title and length: it joins them (PAR-UP-10).
    expect(result.albums.map((found) => [found.album.title, found.files.map((placed) => placed.number)])).toEqual([["Hollow Signal (Deluxe Edition)", [1, 2, 3, 4, 5]]]);
    expect(result.unidentified).toEqual([]);
  });
});

/**
 * @test-id PARROT-CORE-IMPORT-MATCH-RETRY-001
 * @req PAR-UP-11[parrot]
 * @why PAR-UP-11 (Chris 2026-11-26): a metadata blip (503 `ticket_store_unavailable` for ~2 s) left a whole 24-song
 *   album unmatched because each lookup was asked once. A 5xx or a network error is asked again after a short wait.
 */
describe("[PARROT-CORE-IMPORT-MATCH-RETRY-001] lookup retry", () => {
  const unavailable = () => Object.assign(new Error("metadata service unavailable (503)"), { status: 503 });
  const songs = () => [file("fable.mp3", "Fable", "Meltway", 162_000), file("nook.mp3", "Nook", "Meltway", 185_000)];

  it("a lookup answered 503 and then found ends matched", async () => {
    const lookups = fakeLookups({ failFirst: unavailable, failFirstTimes: 2 });
    const result = await matchParrotImport(songs(), { ...lookups, retryDelaysMs: [1, 1, 1] });
    expect(result.unidentified).toEqual([]);
    expect(result.albums.map((found) => found.album.title)).toEqual(["Meltway"]);
  });

  it("a network error is asked again too", async () => {
    const lookups = fakeLookups({ failFirst: () => new TypeError("fetch failed"), failFirstTimes: 1 });
    const result = await matchParrotImport(songs(), { ...lookups, retryDelaysMs: [1] });
    expect(result.unidentified).toEqual([]);
  });

  it("stops after its tries: still down is lookup-failed; a 4xx is not asked again", async () => {
    const down = fakeLookups({ failFirst: unavailable, failFirstTimes: 100 });
    const result = await matchParrotImport([file("fable.mp3", "Fable", "Meltway", 162_000)], { ...down, retryDelaysMs: [1, 1] });
    expect(result.unidentified).toEqual([{ file: "/m/fable.mp3", reason: "lookup-failed" }]);
    expect(down.asked.recordings.length).toBe(3);
    const refused = fakeLookups({ failFirst: () => Object.assign(new Error("metadata request failed (400)"), { status: 400 }), failFirstTimes: 100 });
    await matchParrotImport([file("fable.mp3", "Fable", "Meltway", 162_000)], { ...refused, retryDelaysMs: [1, 1] });
    expect(refused.asked.recordings.length).toBe(1);
  });

  it("waits 1 s, 2.5 s and 5 s by default: within 10 s", () => {
    expect(PARROT_LOOKUP_RETRY_DELAYS_MS).toEqual([1000, 2500, 5000]);
  });
});

/**
 * @test-id PARROT-CORE-IMPORT-MATCH-RETRY-002
 * @req PAR-UP-11[parrot]
 * @why PAR-UP-11 (Chris 2026-11-27, metadata audit finding M-counters-parrot-import-drops-429-songs): 37 lookups an
 *   hour were refused with 429 and each left its song unmatched. A 429 is asked again after its Retry-After, capped
 *   at 60 s, up to 3 times.
 */
describe("[PARROT-CORE-IMPORT-MATCH-RETRY-002] lookup refused as too many (429)", () => {
  const tooMany = (retryAfterSeconds: number | undefined) => () =>
    Object.assign(new Error("metadata service unavailable (429)"), { name: "MetadataUnavailableError", status: 429, retryAfterSeconds, code: "rate_limited" });
  const fable = () => [file("fable.mp3", "Fable", "Meltway", 162_000)];

  it("a lookup refused 429 waits its Retry-After and then ends matched", async () => {
    const lookups = fakeLookups({ failFirst: tooMany(0.005), failFirstTimes: 1 });
    const lines: string[] = [];
    const result = await matchParrotImport(fable(), { ...lookups, retryDelaysMs: [1, 1, 1], log: (line) => lines.push(line) });
    expect(result.unidentified).toEqual([]);
    expect(result.albums.map((found) => found.album.title)).toEqual(["Meltway"]);
    expect(lines.filter((line) => line.includes("lookup retry"))).toEqual([
      "[import-match] recordings lookup retry 1/3 in 5ms: metadata service unavailable (429)",
    ]);
  });

  it("a Retry-After longer than the cap waits the cap; with none it waits the usual delay", async () => {
    const long = fakeLookups({ failFirst: tooMany(3600), failFirstTimes: 1 });
    const lines: string[] = [];
    const result = await matchParrotImport(fable(), { ...long, retryDelaysMs: [1, 1, 1], retryAfterCapMs: 7, log: (line) => lines.push(line) });
    expect(result.unidentified).toEqual([]);
    const unnamed = fakeLookups({ failFirst: tooMany(undefined), failFirstTimes: 1 });
    await matchParrotImport(fable(), { ...unnamed, retryDelaysMs: [3, 1, 1], log: (line) => lines.push(line) });
    expect(lines.filter((line) => line.includes("lookup retry")).map((line) => line.split(" in ")[1]!.split(":")[0])).toEqual(["7ms", "3ms"]);
  });

  it("asks at most 3 more times, then the song is lookup-failed", async () => {
    const refused = fakeLookups({ failFirst: tooMany(0.001), failFirstTimes: 100 });
    const result = await matchParrotImport(fable(), { ...refused, retryDelaysMs: [1, 1, 1] });
    expect(result.unidentified).toEqual([{ file: "/m/fable.mp3", reason: "lookup-failed" }]);
    expect(refused.asked.recordings.length).toBe(4);
  });

  it("waits at most 60 s by default", () => {
    expect(PARROT_LOOKUP_RETRY_AFTER_CAP_MS).toBe(60_000);
  });
});

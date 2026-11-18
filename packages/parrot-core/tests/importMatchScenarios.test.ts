/**
 * @test-id PARROT-CORE-IMPORT-SCENARIOS-001
 * @level unit (fake lookups shaped like the metadata's answers for Linnet Park)
 * @why PAR-UP-05 / PAR-META-03 (Chris 2026-11-15, issue #2507): importing Meltway put every song on the main Meltway
 *   release except Fable, which the lookup answered first on an obscure other "Meltway" release, so the review showed
 *   two albums. A folder's songs must land on the one release that fits the whole folder. Each scenario below is an
 *   import case with a trick (same title on several releases, deluxe and anniversary editions, compilations, a single,
 *   a live album, a game soundtrack, a missing track, a mis-tagged track) and the albums every file must land on.
 * @bugfix @regression-proof
 */
import { describe, expect, it } from "bun:test";
import type { MusicAlbum, MusicAlbumsQuery, MusicRecording, MusicRecordingsQuery } from "@space/shared/api";
import {
  matchParrotImport,
  parrotImportMissingTracks,
  type ParrotImportFileQuestion,
  type ParrotImportLibraryAlbum,
  type ParrotImportUnidentifiedReason,
} from "../src/importMatch";

const T = "[PARROT-CORE-IMPORT-SCENARIOS-001]";
const LP = { id: "lp", name: "Linnet Park" };

type Release = MusicAlbum & { official: boolean };
const release = (id: string, title: string, year: number, kind: string, tracks: Array<[string, number]>, official = true): Release => ({
  id,
  title,
  year,
  kind,
  official,
  artist: LP,
  tracks: tracks.map(([name, durationMs], index) => ({ disc: 1, number: index + 1, title: name, durationMs, id: `${id}-${index + 1}` })),
});

const MELTWAY_TRACKS: Array<[string, number]> = [
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
];
const HYBRID_TRACKS: Array<[string, number]> = [
  ["Paperboat", 184_000],
  ["One Step Farther", 155_000],
  ["Near You", 203_000],
  ["Points of Interest", 200_000],
  ["Cresting", 209_000],
  ["Far Away", 183_000],
  ["By the Window", 189_000],
  ["At the Gate", 216_000],
  ["A Place for My Coat", 184_000],
  ["Forsaken", 194_000],
  ["Cure for the Hiccups", 157_000],
  ["Pulling Me Along", 191_000],
];
const pick = (tracks: Array<[string, number]>, ...names: string[]) => names.map((name) => tracks.find(([title]) => title === name)!);

const MELTWAY = release("rg-meltway", "Meltway", 2003, "Album", MELTWAY_TRACKS);
/**
 * Where a user's Fable really landed (log 2026-11-14): "Meltway Hamburg", a live album the metadata types Album + Live
 * though its name never says live, its songs under their plain titles, Fable at track 8.
 */
const HAMBURG = release("rg-hamburg", "Meltway Hamburg", 2003, "Album + Live", [
  ["Interlude/Forecast", 75_000],
  ["Don't Linger", 189_000],
  ["Somewhere I Wander", 218_000],
  ["Hiding From You", 229_000],
  ["Paperboat", 190_000],
  ["Points of Interest", 203_000],
  ["Far Away", 186_000],
  ["Fable", 166_000],
  ["Nook", 188_000],
]);
const MELTWAY_HYBRID = release("rg-meltway-hybrid", "Meltway / Hollow Signal", 2003, "Album + Compilation", [...MELTWAY_TRACKS, ...HYBRID_TRACKS]);
const MELTWAY_20 = release("rg-meltway-20", "Meltway (20th Anniversary Edition)", 2023, "Album + Compilation", [...MELTWAY_TRACKS, ["Adrift", 199_000]]);
const HYBRID = release("rg-hybrid", "Hollow Signal", 2000, "Album", HYBRID_TRACKS);
const HYBRID_20 = release("rg-hybrid-20", "Hollow Signal (20th Anniversary Edition)", 2020, "Album + Compilation", [...HYBRID_TRACKS, ["She Wouldn't", 254_000]]);
const GREATEST = release("rg-greatest", "Greatest Hits", 2010, "Album + Compilation", [
  ...pick(MELTWAY_TRACKS, "Nook", "Fable", "Breaking the Tide"),
  ...pick(HYBRID_TRACKS, "At the Gate", "Cresting"),
]);
const LIVE = release("rg-live", "Live in Tarvo", 2003, "Album + Live", [
  ["Somewhere I Wander", 216_000],
  ["Fable", 170_000],
  ["Nook", 190_000],
  ["Cresting", 212_000],
  ["At the Gate", 221_000],
]);
const NOOK_SINGLE = release("rg-nook-single", "Nook", 2003, "Single", pick(MELTWAY_TRACKS, "Nook"));
const EIGHT_BIT = release("rg-8bit", "8-Bit Uprising!", 2010, "Album + Soundtrack", [
  ["Fable", 160_000],
  ["At the Gate", 214_000],
]);
/**
 * Releases bearing a studio album's very name (made-up tracklists, shaped like a real user library in the match corpus,
 * #2542 follow-up): a live release of the same name (Teddy Reeds' I've Tried Everything But Therapy), a later
 * compilation of the same name in another order (Hollerin' Fox's 1962 album), and names made only of symbols
 * (Eli Sharrow's "≈" against "+-=≈× (Tour Collection: Live)").
 */
const MTM_TRACKS: Array<[string, number]> = [
  ["Woken", 100_000],
  ["Given Way", 189_000],
  ["Leave Out All the Salt", 209_000],
  ["Bend It Out", 164_000],
  ["Shadow of the Pier", 289_000],
  ["What I've Kept", 205_000],
];
const MTM = release("rg-mtm", "Minutes to Daybreak", 2007, "Album", MTM_TRACKS);
const MTM_LIVE = release("rg-mtm-live", "Minutes to Daybreak", 2008, "Album + Live", MTM_TRACKS.map(([title, durationMs]) => [title, durationMs + 3_000]));
const LT_TRACKS: Array<[string, number]> = [
  ["Lost in the Fog", 205_000],
  ["In My Garden", 200_000],
  ["Turn It Down", 230_000],
  ["Salt Sand Silence", 147_000],
  ["I'll Be Late", 211_000],
  ["Castle of Sand", 205_000],
];
const LT = release("rg-lt", "Lasting Things", 2012, "Album", LT_TRACKS);
const LT_COMP = release("rg-lt-comp", "Lasting Things", 2014, "Album + Compilation", [
  ["Vandalized", 106_000],
  ...[...LT_TRACKS].reverse(),
  ["Roads Unmapped", 229_000],
  ["Skin to Stone", 168_000],
]);
const DIVIDE_TRACKS: Array<[string, number]> = [
  ["Pencil", 227_000],
  ["Cabin on the Hill", 261_000],
  ["Plunge", 238_000],
  ["Shape of Rain", 233_000],
  ["Flawless", 263_000],
];
const DIVIDE = release("rg-divide", "≈", 2017, "Album", DIVIDE_TRACKS);
const DIVIDE_LIVE = release("rg-divide-live", "+-=≈× (Tour Collection: Live)", 2023, "Album + Compilation + Live", [["Ripples", 196_000], ...DIVIDE_TRACKS]);
/** In the order the fake lookup answers by default: the odd editions first, so only matching puts things right. */
const CATALOG = [MTM_LIVE, LT_COMP, DIVIDE_LIVE, HAMBURG, MELTWAY_HYBRID, EIGHT_BIT, GREATEST, LIVE, NOOK_SINGLE, MELTWAY_20, HYBRID_20, MELTWAY, HYBRID, MTM, LT, DIVIDE];

const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const base = (text: string) => fold(text.replace(/\(.*?\)/g, ""));

/**
 * A lookup answering like the shared one: every recording whose title is the asked one (loosely), those on an album
 * named like the hint first, cut to `limit`. `hide` drops releases from a title's answers (a lookup whose few results
 * missed the main album).
 */
const fakeLookups = (hide: Record<string, string[]> = {}) => {
  const asked = { recordings: [] as MusicRecordingsQuery[], albums: [] as MusicAlbumsQuery[] };
  return {
    asked,
    recordings: async (question: MusicRecordingsQuery) => {
      asked.recordings.push(question);
      const found: Array<{ recording: MusicRecording; hinted: boolean }> = [];
      for (const album of CATALOG) {
        if (hide[question.title]?.includes(album.id!)) continue;
        for (const track of album.tracks) {
          if (base(track.title) !== base(question.title)) continue;
          found.push({
            hinted: !!question.album && base(album.title) === base(question.album),
            recording: {
              id: track.id,
              title: track.title,
              durationMs: track.durationMs,
              artist: LP,
              album: { id: album.id, title: album.title, year: album.year, trackNumber: track.number, disc: 1, kind: album.kind, official: album.official },
            },
          });
        }
      }
      const ordered = [...found.filter((one) => one.hinted), ...found.filter((one) => !one.hinted)];
      return { results: ordered.slice(0, question.limit ?? 5).map((one) => one.recording) };
    },
    albums: async (question: MusicAlbumsQuery) => {
      asked.albums.push(question);
      return { results: CATALOG.filter((album) => base(album.title) === base(question.album)).map(({ official: _official, ...album }) => album) };
    },
  };
};

/** One folder of files: each song tagged with the folder's album (or `tags[title]`), its length near the release's. */
const folder = (path: string, albumTag: string, songs: Array<[string, number]>, tags: Record<string, string> = {}): ParrotImportFileQuestion[] =>
  songs.map(([title, durationMs], index) => ({
    file: `${path}/${String(index + 1).padStart(2, "0")} ${title}.flac`,
    title,
    artist: "Linnet Park",
    album: tags[title] ?? albumTag,
    durationMs: durationMs + 400,
    disc: 1,
    number: index + 1,
    albumArtist: "Linnet Park",
  }));

type Scenario = {
  name: string;
  files: ParrotImportFileQuestion[];
  hide?: Record<string, string[]>;
  /** Album id → the titles that must sit on it; nothing else may be matched. */
  expect: Record<string, string[]>;
  missing?: Record<string, string[]>;
  /** The files (by path) the review must show "Check" for; every other placed file is confirmed. */
  checks?: string[];
  /** The files (by path) left unidentified, with why; none when absent. */
  unidentified?: Record<string, ParrotImportUnidentifiedReason>;
  /** The user's library before the import. */
  library?: ParrotImportLibraryAlbum[];
};

/** One loose file: `title` by Linnet Park, tagged `albumTag`, `durationMs` long, at `path`. */
const loose = (path: string, title: string, albumTag: string, durationMs: number | null): ParrotImportFileQuestion => ({
  file: path,
  title,
  artist: "Linnet Park",
  album: albumTag,
  durationMs,
  disc: 1,
  number: 0,
});

/** The library's copy of `album`, with the songs `titles` on their slots. */
const owned = (album: Release, titles: string[]): ParrotImportLibraryAlbum => ({
  musicId: album.id!,
  title: album.title,
  artist: LP.name,
  tracklist: album.tracks.map(({ disc, number, title, durationMs }) => ({ disc, number, title, durationMs })),
  owned: album.tracks.filter((track) => titles.includes(track.title)).map(({ disc, number }) => ({ disc, number })),
});

/** Each song `ms` longer than its listed length (a remaster's own mastering): `offsets[title]` overrides. */
const shifted = (tracks: Array<[string, number]>, ms: number, offsets: Record<string, number> = {}): Array<[string, number]> =>
  tracks.map(([title, durationMs]) => [title, durationMs + (offsets[title] ?? ms)]);

const titles = (tracks: Array<[string, number]>) => tracks.map(([title]) => title);
const without = (tracks: Array<[string, number]>, ...names: string[]) => tracks.filter(([title]) => !names.includes(title));

const SCENARIOS: Scenario[] = [
  {
    name: "a user's Meltway: Fable answered on the live Meltway Hamburg and odd editions, never on Meltway itself",
    files: folder("/music/Linnet Park/Meltway (2003)", "Meltway", MELTWAY_TRACKS),
    hide: { Fable: ["rg-meltway", "rg-meltway-20"] },
    expect: { "rg-meltway": titles(MELTWAY_TRACKS) },
  },
  {
    name: "Meltway where Fable's answers name the anniversary edition rather than Meltway itself",
    files: folder("/music/Linnet Park/Meltway (2003)", "Meltway", MELTWAY_TRACKS),
    hide: { Fable: ["rg-meltway"] },
    expect: { "rg-meltway": titles(MELTWAY_TRACKS) },
  },
  {
    name: "Meltway Hamburg tagged as such stays the live Hamburg album",
    files: folder("/music/Linnet Park/Meltway Hamburg", "Meltway Hamburg", HAMBURG.tracks.map((t) => [t.title, t.durationMs!])),
    expect: { "rg-hamburg": HAMBURG.tracks.map((t) => t.title) },
  },
  {
    name: "untagged Meltway files: the original studio album, not the game, the best-of, the single or the reissue",
    files: folder("/music/Linnet Park/Meltway", "", MELTWAY_TRACKS),
    expect: { "rg-meltway": titles(MELTWAY_TRACKS) },
  },
  {
    name: "the 20th anniversary edition stays the anniversary edition, bonus track included",
    files: folder("/music/Linnet Park/Meltway 20th", "Meltway (20th Anniversary Edition)", MELTWAY_20.tracks.map((t) => [t.title, t.durationMs!])),
    expect: { "rg-meltway-20": [...titles(MELTWAY_TRACKS), "Adrift"] },
  },
  {
    name: "Hollow Signal, whose At the Gate and Cresting are also on a best-of, a live album and a game",
    files: folder("/music/Linnet Park/Hollow Signal", "Hollow Signal", HYBRID_TRACKS),
    expect: { "rg-hybrid": titles(HYBRID_TRACKS) },
  },
  {
    name: "a folder missing one track is still one album, the missing song known",
    files: folder("/music/Linnet Park/Meltway", "Meltway", without(MELTWAY_TRACKS, "Fable")),
    hide: { Nook: ["rg-meltway"] },
    expect: { "rg-meltway": titles(without(MELTWAY_TRACKS, "Fable")) },
    missing: { "rg-meltway": ["Fable"] },
  },
  {
    name: "one mis-tagged track (Fable tagged Hollow Signal) inside the Meltway folder",
    files: folder("/music/Linnet Park/Meltway", "Meltway", MELTWAY_TRACKS, { Fable: "Hollow Signal" }),
    expect: { "rg-meltway": titles(MELTWAY_TRACKS) },
  },
  {
    name: "the best-of stays the best-of: its songs never scatter to their studio albums",
    files: folder("/music/Linnet Park/Greatest Hits", "Greatest Hits", GREATEST.tracks.map((t) => [t.title, t.durationMs!])),
    expect: { "rg-greatest": ["Nook", "Fable", "Breaking the Tide", "At the Gate", "Cresting"] },
  },
  {
    name: "the live album stays live, its Fable and Nook never pulled to Meltway",
    files: folder("/music/Linnet Park/Live in Tarvo", "Live in Tarvo", LIVE.tracks.map((t) => [t.title, t.durationMs!])),
    expect: { "rg-live": ["Somewhere I Wander", "Fable", "Nook", "Cresting", "At the Gate"] },
  },
  {
    name: "the Nook single stays a single next to Meltway in another folder",
    files: [...folder("/music/Linnet Park/Nook (single)", "Nook", pick(MELTWAY_TRACKS, "Nook")), ...folder("/music/Linnet Park/Meltway", "Meltway", MELTWAY_TRACKS)],
    expect: { "rg-nook-single": ["Nook"], "rg-meltway": titles(MELTWAY_TRACKS) },
    // Its tag names the single, but Meltway's studio Nook is as likely: placed on the single, to check.
    checks: ["/music/Linnet Park/Nook (single)/01 Nook.flac"],
  },
  {
    name: "two albums dumped in one folder each keep their own songs",
    files: [...folder("/music/Linnet Park", "Meltway", MELTWAY_TRACKS), ...folder("/music/Linnet Park", "Hollow Signal", HYBRID_TRACKS)].map((file, index) => ({
      ...file,
      file: `/music/Linnet Park/${index} ${file.title}.mp3`,
    })),
    hide: { Fable: ["rg-meltway"] },
    expect: { "rg-meltway": titles(MELTWAY_TRACKS), "rg-hybrid": titles(HYBRID_TRACKS) },
  },
  // @bugfix @regression-proof (Main, 2026-11-15): weigh every signal together; the cases below are the edges.
  {
    name: "the deluxe where the folder really is the deluxe: its bonus track is there, though the tag says plain Meltway",
    files: folder("/music/Linnet Park/Meltway", "Meltway", MELTWAY_20.tracks.map((t) => [t.title, t.durationMs!])),
    expect: { "rg-meltway-20": [...titles(MELTWAY_TRACKS), "Adrift"] },
  },
  {
    name: "a remaster with every length a few seconds off (a user's Fable 6.2 s over) stays on the 2003 Meltway, confirmed",
    files: folder("/music/Linnet Park/Meltway (Remastered)", "Meltway", shifted(MELTWAY_TRACKS, 2_100, { Fable: 6_200, Session: -300, "Somewhere I Wander": 11_900 })),
    expect: { "rg-meltway": titles(MELTWAY_TRACKS) },
  },
  {
    name: "one untagged folder mixing Meltway with two Hollow Signal songs: each song on its own album",
    files: folder("/music/Linnet Park/Mix", "", [...MELTWAY_TRACKS, ...pick(HYBRID_TRACKS, "Paperboat", "At the Gate")]),
    expect: { "rg-meltway": titles(MELTWAY_TRACKS), "rg-hybrid": ["Paperboat", "At the Gate"] },
  },
  {
    name: "an untagged Nook on its own goes to the studio album, not the single named Nook",
    files: [loose("/music/Nook.mp3", "Nook", "", 187_400)],
    expect: { "rg-meltway": ["Nook"] },
  },
  {
    name: "confidence edge: an untagged Fable 6.2 s longer than Meltway's (a user's own file) confirms on Meltway",
    files: [loose("/music/Linnet Park - Fable.m4a", "Fable", "", 168_200)],
    expect: { "rg-meltway": ["Fable"] },
  },
  {
    name: "confidence edge: an untagged Fable 30 s longer than every take is placed on Meltway but checked",
    files: [loose("/music/Fable.mp3", "Fable", "", 192_000)],
    expect: { "rg-meltway": ["Fable"] },
    checks: ["/music/Fable.mp3"],
  },
  {
    name: "trick 1: a radio edit 12 s short, named exactly like the album song, sits on the album's slot",
    files: folder("/music/Linnet Park/Meltway", "Meltway", shifted(MELTWAY_TRACKS, 0, { Nook: -12_400 })),
    expect: { "rg-meltway": titles(MELTWAY_TRACKS) },
  },
  {
    name: "trick 2: a live Fable whose name never says live (Hamburg's 165 s) goes on the studio album",
    files: [loose("/music/Fable.mp3", "Fable", "", 165_000)],
    expect: { "rg-meltway": ["Fable"] },
  },
  {
    name: "trick 3: an instrumental Fable in the Meltway folder sits on Fable's slot, checked",
    files: [...folder("/music/Linnet Park/Meltway", "Meltway", without(MELTWAY_TRACKS, "Fable")), loose("/music/Linnet Park/Meltway/Fable (Instrumental).flac", "Fable (Instrumental)", "Meltway", 162_400)],
    expect: { "rg-meltway": titles(MELTWAY_TRACKS).map((title) => (title === "Fable" ? "Fable (Instrumental)" : title)) },
    checks: ["/music/Linnet Park/Meltway/Fable (Instrumental).flac"],
  },
  {
    name: "trick 4: a different 5-minute song titled Fable dropped into the Meltway folder never takes Fable's slot",
    files: [...folder("/music/Linnet Park/Meltway", "Meltway", MELTWAY_TRACKS), loose("/music/Linnet Park/Meltway/Fable (other).mp3", "Fable", "Meltway", 300_000)],
    expect: { "rg-meltway": titles(MELTWAY_TRACKS) },
    unidentified: { "/music/Linnet Park/Meltway/Fable (other).mp3": "no-track" },
  },
  {
    name: "trick 5: the remaster with the anniversary edition's bonus track goes to the anniversary edition",
    files: folder("/music/Linnet Park/Meltway (Remastered)", "Meltway", shifted(MELTWAY_20.tracks.map((t) => [t.title, t.durationMs!]), 2_100)),
    expect: { "rg-meltway-20": [...titles(MELTWAY_TRACKS), "Adrift"] },
  },
  {
    name: "library 1: the library has Meltway without Fable; Fable uploaded alone confirms on Meltway's track 7",
    files: [loose("/music/Fable.mp3", "Fable", "", 168_200)],
    library: [owned(MELTWAY, titles(without(MELTWAY_TRACKS, "Fable")))],
    expect: { "rg-meltway": ["Fable"] },
  },
  {
    name: "library 2: Fable uploaded again while the library has it is checked",
    files: [loose("/music/Fable.mp3", "Fable", "Meltway", 162_400)],
    library: [owned(MELTWAY, titles(MELTWAY_TRACKS))],
    expect: { "rg-meltway": ["Fable"] },
    checks: ["/music/Fable.mp3"],
  },
  {
    name: "library 3: the library has the anniversary edition; a new untagged Nook goes to the anniversary edition",
    files: [loose("/music/Nook.mp3", "Nook", "", 187_400)],
    library: [owned(MELTWAY_20, titles(without(MELTWAY_TRACKS, "Nook")))],
    expect: { "rg-meltway-20": ["Nook"] },
  },
  {
    name: "same name 1: a folder tagged with a name its studio album and a live release share stays on the studio album, confirmed",
    files: folder("/music/Linnet Park/Minutes to Daybreak", "Minutes to Daybreak", MTM_TRACKS),
    expect: { "rg-mtm": titles(MTM_TRACKS) },
  },
  {
    name: "same name 2: a later compilation bearing the studio album's own name never takes the studio album's folder",
    files: folder("/music/Linnet Park/Lasting Things", "Lasting Things", LT_TRACKS),
    expect: { "rg-lt": titles(LT_TRACKS) },
  },
  {
    name: "same name 3: an album named only by a symbol (≈) is not every other album of symbols (a live tour collection)",
    files: folder("/music/Linnet Park/≈", "≈", DIVIDE_TRACKS),
    expect: { "rg-divide": titles(DIVIDE_TRACKS) },
  },
];

describe(`${T} import scenarios`, () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const lookups = fakeLookups(scenario.hide);
      const lines: string[] = [];
      const result = await matchParrotImport(scenario.files, { ...lookups, library: scenario.library, log: (line) => lines.push(line) });
      const byFile = new Map(scenario.files.map((file) => [file.file, file.title]));
      const got = Object.fromEntries(
        result.albums.map((found) => [found.album.id, found.files.map((placed) => byFile.get(placed.file)!).sort()])
      );
      const checked = result.albums.flatMap((found) => found.files.filter((placed) => !placed.sure).map((placed) => placed.file));
      console.info(
        `${T} ${scenario.name}\n  got ${JSON.stringify(got)}\n  checked ${JSON.stringify(checked)}\n  unidentified ${JSON.stringify(result.unidentified)}\n  ${lines.join("\n  ")}`
      );
      expect(Object.fromEntries(result.unidentified.map((one) => [one.file, one.reason]))).toEqual(scenario.unidentified ?? {});
      expect(got).toEqual(Object.fromEntries(Object.entries(scenario.expect).map(([key, names]) => [key, [...names].sort()])));
      expect(checked.sort()).toEqual([...(scenario.checks ?? [])].sort());
      for (const found of result.albums) {
        // Every file sits on the track of its own title, never a neighbour's slot.
        for (const placed of found.files) {
          const track = found.album.tracks.find((one) => one.disc === placed.disc && one.number === placed.number)!;
          expect(base(track.title)).toBe(base(byFile.get(placed.file)!));
        }
        const missing = scenario.missing?.[found.album.id!];
        if (missing) expect(parrotImportMissingTracks(found.album, found.files).map((track) => track.title)).toEqual(missing);
      }
    });
  }
});

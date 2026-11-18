import { describe, expect, it } from "vitest";
import { parseFilename } from "../src/parseMediaFilename";

const SUITE = "parse-media-filename";

type Expected = {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  part?: number;
  language?: string;
};

const FIELDS = ["title", "year", "season", "episode", "part", "language"] as const;

const pick = (parsed: Record<string, unknown>) =>
  Object.fromEntries(FIELDS.filter((field) => parsed[field] !== undefined).map((field) => [field, parsed[field]]));

// Values recorded from the parser before the cut-point rules were trimmed; caller-visible
// fields (title, year, season, episode, part, language) must stay identical.
const CORPUS: Array<[string, Expected]> = [
  ["Northern Orchard (2019).mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern Orchard (2019) [1080p].mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern.Orchard.2019.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern Orchard 2019 2160p HDR.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern Orchard.mkv", { title: "Northern Orchard" }],
  ["Northern Orchard 1080p.mkv", { title: "Northern Orchard" }],
  ["Northern.Orchard.2019.FHD.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern Orchard (2019) 4k.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern Orchard (2019) - 4K.mkv", { title: "Northern Orchard", year: 2019 }],
  ["The Saltmarsh - S01E02 - The Long Tide.mkv", { title: "The Saltmarsh", season: 1, episode: 2 }],
  ["The.Saltmarsh.S01E02.720p.mkv", { title: "The Saltmarsh", season: 1, episode: 2 }],
  ["The Saltmarsh 1x02.mkv", { title: "The Saltmarsh", season: 1, episode: 2 }],
  ["The Saltmarsh Season 2 Episode 5.mkv", { title: "The Saltmarsh", season: 2, episode: 5 }],
  ["the_saltmarsh_s01e05.mkv", { title: "the saltmarsh", season: 1, episode: 5 }],
  ["Bayview Holdings - 3x07 - The Audit.mkv", { title: "Bayview Holdings", season: 3, episode: 7 }],
  [
    "Bayview Holdings (2016) - S03E04 - Ledger Day [WEB 1080p][AAC 2.0][x264].mkv",
    { title: "Bayview Holdings", year: 2016, season: 3, episode: 4 },
  ],
  ["Bayview Holdings S02E10 1080p WEB-DL.mkv", { title: "Bayview Holdings", season: 2, episode: 10 }],
  ["Bayview.Holdings.S02E10.1080p.WEB.h264.mkv", { title: "Bayview Holdings", season: 2, episode: 10 }],
  ["Bayview.Holdings.S02E10.HDTV.x264.mkv", { title: "Bayview Holdings", season: 2, episode: 10 }],
  ["Copper Lantern - 145.mkv", { title: "Copper Lantern", episode: 145 }],
  ["Copper Lantern - 145 - 1080p.mkv", { title: "Copper Lantern", episode: 145 }],
  ["Copper Lantern Episode 12.mkv", { title: "Copper Lantern", episode: 12 }],
  ["Copper Lantern Ep 12.mkv", { title: "Copper Lantern", episode: 12 }],
  ["Copper Lantern S01.mkv", { title: "Copper Lantern", season: 1 }],
  ["Copper Lantern Saison 2 Episode 3.mkv", { title: "Copper Lantern", season: 2, episode: 3 }],
  ["Glass Meridian Part 2 (2010).mkv", { title: "Glass Meridian", year: 2010, part: 2 }],
  ["Glass Meridian Pt. 1 (2010).mkv", { title: "Glass Meridian", year: 2010, part: 1 }],
  ["Quiet Harbour CD1.avi", { title: "Quiet Harbour", part: 1 }],
  ["Quiet Harbour CD2.avi", { title: "Quiet Harbour", part: 2 }],
  ["Quiet Harbour Disc 1.mkv", { title: "Quiet Harbour", part: 1 }],
  ["Northern Orchard (2019) Extended.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern Orchard (2019) Remastered 1080p.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern.Orchard.2019.Unrated.1080p.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern Orchard (2019) Open Matte.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern.Orchard.2019.Blu-ray.x264.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern.Orchard.2019.Remux.AVC.DTS-HD.MA.5.1.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern.Orchard.2019.UHD.Remux.HEVC.TrueHD.Atmos.7.1.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern Orchard (2019) [2160p] [HEVC 10bit] [EAC3 5.1].mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern.Orchard.2019.DVD.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern.Orchard.2019.AAC.2.0.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern Orchard 2019 1080p FLAC.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Northern Orchard (2019) DTS 5.1.mkv", { title: "Northern Orchard", year: 2019 }],
  ["Glass Meridian (2010) Dual Audio.mkv", { title: "Glass Meridian", year: 2010 }],
  ["Le Jardin d'Hiver (2001) [FR-EN].mkv", { title: "Le Jardin d'Hiver", year: 2001, language: "fr" }],
  ["Le Jardin d'Hiver (2001) FRENCH.mkv", { title: "Le Jardin d'Hiver", year: 2001, language: "french" }],
  ["Northern Orchard (2019).fr.srt", { title: "Northern Orchard", year: 2019 }],
  ["Northern Orchard (2019).en.srt", { title: "Northern Orchard", year: 2019 }],
  ["Northern.Orchard.FRENCH.srt", { title: "Northern Orchard", language: "french" }],
  ["Northern.Orchard.2019.ENG.srt", { title: "Northern Orchard", year: 2019, language: "eng" }],
  ["Northern.Orchard.2019.GERMAN.1080p.mkv", { title: "Northern Orchard", year: 2019, language: "german" }],
  ["Northern.Orchard.2019.ITALIAN.mkv", { title: "Northern Orchard", year: 2019, language: "ita" }],
  ["Northern.Orchard.2019.ITA.srt", { title: "Northern Orchard", year: 2019, language: "ita" }],
  ["Northern.Orchard.2019.RUS.srt", { title: "Northern Orchard", year: 2019, language: "rus" }],
  ["Northern.Orchard.2019.UKR.srt", { title: "Northern Orchard", year: 2019, language: "ukr" }],
  ["Northern.Orchard.2019.JPN.srt", { title: "Northern Orchard", year: 2019, language: "jpn" }],
  ["Northern.Orchard.2019.NL.srt", { title: "Northern Orchard", year: 2019, language: "nl" }],
  ["Northern.Orchard.2019.FLEMISH.srt", { title: "Northern Orchard", year: 2019, language: "flemish" }],
  ["Bayview Holdings S01E01 FR.srt", { title: "Bayview Holdings", season: 1, episode: 1, language: "fr" }],
  ["Bayview.Holdings.S01E01.fr.srt", { title: "Bayview Holdings", season: 1, episode: 1 }],
  ["Bayview Holdings S01E01 eng.srt", { title: "Bayview Holdings", season: 1, episode: 1, language: "eng" }],
];

// Names the previous parser truncated: a hyphenated last word was cut as a trailing suffix,
// and the word "Max" was read as a service tag, leaving an empty title.
const TITLE_FIXES: Array<[string, Expected]> = [
  ["Ash-Grove.mkv", { title: "Ash-Grove" }],
  ["Max and the Lighthouse (2015).mkv", { title: "Max and the Lighthouse", year: 2015 }],
];

describe("parseFilename caller-visible fields", () => {
  it.each(CORPUS)("keeps the recorded fields for %s", (filename, expected) => {
    console.info(`[${SUITE}:exec] parseFilename(${JSON.stringify(filename)})`);
    const parsed = parseFilename(filename);
    const actual = pick(parsed);
    console.info(`[${SUITE}:exec] actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
    expect(actual).toEqual(expected);
  });

  it.each(TITLE_FIXES)("keeps the whole title for %s", (filename, expected) => {
    console.info(`[${SUITE}:exec] parseFilename(${JSON.stringify(filename)})`);
    const parsed = parseFilename(filename);
    const actual = pick(parsed);
    console.info(`[${SUITE}:exec] actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
    expect(actual).toEqual(expected);
  });
});

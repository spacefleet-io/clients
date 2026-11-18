import { describe, expect, it } from "vitest";
import {
  buildTracks,
  getAvailableFormats,
  guessQualityLabel,
  parseFilename,
  pickBestMatch,
  resolveTranscodeOutputs,
} from "../src";

const SUITE = "parse-and-quality";

const dumpParseSnapshot = (
  label: string,
  ctx: {
    filename?: string;
    parsed?: unknown;
    expected?: unknown;
    available?: unknown;
    formats?: unknown;
    candidates?: unknown;
    picked?: unknown;
    tracks?: unknown;
    outputs?: unknown;
    dimensions?: { height?: number; width?: number };
    actualLabel?: string;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.filename !== undefined) {
      console.error(`filename: ${JSON.stringify(ctx.filename)}`);
    }
    if (ctx.parsed !== undefined) {
      console.error(`parsed result:\n${JSON.stringify(ctx.parsed, null, 2)}`);
    }
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, null, 2)}`);
    }
    if (ctx.available !== undefined) {
      console.error(`available: ${JSON.stringify(ctx.available)}`);
    }
    if (ctx.formats !== undefined) {
      console.error(`formats:\n${JSON.stringify(ctx.formats, null, 2)}`);
    }
    if (ctx.candidates !== undefined) {
      console.error(`candidates:\n${JSON.stringify(ctx.candidates, null, 2)}`);
    }
    if (ctx.picked !== undefined) {
      console.error(`picked:\n${JSON.stringify(ctx.picked, null, 2)}`);
    }
    if (ctx.tracks !== undefined) {
      console.error(`tracks:\n${JSON.stringify(ctx.tracks, null, 2)}`);
    }
    if (ctx.outputs !== undefined) {
      console.error(`outputs:\n${JSON.stringify(ctx.outputs, null, 2)}`);
    }
    if (ctx.dimensions !== undefined) {
      console.error(`dimensions: ${JSON.stringify(ctx.dimensions)}`);
    }
    if (ctx.actualLabel !== undefined) {
      console.error(`actual label: ${JSON.stringify(ctx.actualLabel)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("ingest-core filename parsing and quality helpers", () => {
  it("parses common tv episode filenames", () => {
    const filename = "Bayview.Holdings.S01E03.1080p.mkv";
    console.info(`[${SUITE}:exec] parseFilename: ${JSON.stringify(filename)}`);
    const parsed = parseFilename(filename);
    console.info(`[${SUITE}:exec] parsed: title=${JSON.stringify(parsed.title)} season=${parsed.season} episode=${parsed.episode} resolution=${parsed.resolution}`);
    try {
      expect(parsed.title).toBe("Bayview Holdings");
      expect(parsed.season).toBe(1);
      expect(parsed.episode).toBe(3);
      expect(parsed.resolution).toBe("1080p");
    } catch (err) {
      dumpParseSnapshot("tv-episode-parse-mismatch", {
        filename,
        parsed,
        expected: { title: "Bayview Holdings", season: 1, episode: 3, resolution: "1080p" },
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof keeps explicit empty output selections empty", () => {
    console.info(`[${SUITE}:exec] resolveTranscodeOutputs([], false)`);
    const outputs = resolveTranscodeOutputs([], false);
    console.info(`[${SUITE}:exec] outputs length=${outputs.length}`);
    try {
      expect(outputs).toEqual([]);
    } catch (err) {
      dumpParseSnapshot("empty-outputs-resolved-non-empty", { outputs, expected: [] });
      throw err;
    }
  });

  it("filters available formats by source quality", () => {
    console.info(`[${SUITE}:exec] getAvailableFormats(source=1080p, h264, allowSourceEntry=true)`);
    const formats = getAvailableFormats("1080p", "h264", true);
    console.info(`[${SUITE}:exec] formats=${JSON.stringify(formats.map((f) => ({ quality: f.quality, isSource: (f as { isSource?: boolean }).isSource })))}`);
    try {
      expect(formats.some((entry) => entry.quality === "2160p")).toBe(false);
      expect(formats.some((entry) => entry.quality === "1080p" && entry.isSource)).toBe(true);
    } catch (err) {
      dumpParseSnapshot("filter-formats-by-source-mismatch", {
        formats,
        expected: "no 2160p; one 1080p marked isSource=true",
      });
      throw err;
    }
  });

  it("builds sensible default track preferences", () => {
    console.info(`[${SUITE}:exec] buildTracks(audioLang=en, subtitleLang=fr)`);
    const tracks = buildTracks("en", "fr");
    console.info(`[${SUITE}:exec] tracks=${JSON.stringify(tracks)}`);
    try {
      expect(tracks.audioLangs).toEqual([{ code: "en", keep: true }]);
      expect(tracks.subtitleLangs).toEqual([
        { code: "en", keep: true },
        { code: "fr", keep: true },
      ]);
    } catch (err) {
      dumpParseSnapshot("build-tracks-mismatch", {
        tracks,
        expected: {
          audioLangs: [{ code: "en", keep: true }],
          subtitleLangs: [{ code: "en", keep: true }, { code: "fr", keep: true }],
        },
      });
      throw err;
    }
  });

  it("picks best match candidate by title/year", () => {
    const query = { title: "Glass Meridian", year: "2021" };
    const candidates = [
      { id: "a", title: "Glass Meridian", year: "2021", originalTitle: null, type: "movie" },
      { id: "b", title: "Glass Meridian Part Two", year: "2024", originalTitle: null, type: "movie" },
    ];
    console.info(`[${SUITE}:exec] pickBestMatch query=${JSON.stringify(query)} candidates=${JSON.stringify(candidates.map((c) => ({ id: c.id, title: c.title, year: c.year })))}`);
    const item = pickBestMatch(query, candidates as never);
    console.info(`[${SUITE}:exec] picked id=${JSON.stringify(item?.id)} expected="a"`);
    try {
      expect(item?.id).toBe("a");
    } catch (err) {
      dumpParseSnapshot("pick-best-match-wrong-candidate", {
        candidates,
        picked: item,
        expected: { id: "a" },
      });
      throw err;
    }
  });

  it("maps dimensions to quality label", () => {
    console.info(`[${SUITE}:exec] guessQualityLabel(1080, 1920)`);
    const a = guessQualityLabel(1080, 1920);
    console.info(`[${SUITE}:exec] => ${JSON.stringify(a)} expected="1080p"`);
    try {
      expect(a).toBe("1080p");
    } catch (err) {
      dumpParseSnapshot("quality-label-1080-mismatch", { dimensions: { height: 1080, width: 1920 }, actualLabel: a, expected: "1080p" });
      throw err;
    }

    console.info(`[${SUITE}:exec] guessQualityLabel(360, 640)`);
    const b = guessQualityLabel(360, 640);
    console.info(`[${SUITE}:exec] => ${JSON.stringify(b)} expected="360p"`);
    try {
      expect(b).toBe("360p");
    } catch (err) {
      dumpParseSnapshot("quality-label-360-mismatch", { dimensions: { height: 360, width: 640 }, actualLabel: b, expected: "360p" });
      throw err;
    }
  });

  it("detects multi-part movies from filename", () => {
    const cases = [
      { filename: "The Quiet Harbour Part 1 (2001).mkv", expected: { part: 1, year: 2001 } },
      { filename: "Northern Orchard Pt. 2 (2013).mkv", expected: { part: 2, year: 2013 } },
      { filename: "Copper Lantern Disc 1.mkv", expected: { part: 1 } },
      { filename: "Movie CD2 1080p.mkv", expected: { part: 2 } },
    ];
    for (const c of cases) {
      console.info(`[${SUITE}:exec] multi-part: parseFilename(${JSON.stringify(c.filename)})`);
      const parsed = parseFilename(c.filename);
      console.info(`[${SUITE}:exec] parsed part=${parsed.part} year=${parsed.year} expected=${JSON.stringify(c.expected)}`);
      try {
        expect(parsed.part).toBe(c.expected.part);
        if (typeof c.expected.year === "number") {
          expect(parsed.year).toBe(c.expected.year);
        }
      } catch (err) {
        dumpParseSnapshot("multi-part-parse-mismatch", {
          filename: c.filename,
          parsed,
          expected: c.expected,
        });
        throw err;
      }
    }
  });

  it("parses anime-style bare absolute episode numbers", () => {
    const cases = [
      { filename: "Saltmarsh Chronicles - 145 - 1080p.mkv", expected: { episode: 145 } },
      { filename: "Bayview Tides - 1071 - FR 1080p.mkv", expected: { episode: 1071 } },
    ];
    for (const c of cases) {
      console.info(`[${SUITE}:exec] anime-bare-episode: parseFilename(${JSON.stringify(c.filename)})`);
      const parsed = parseFilename(c.filename);
      console.info(`[${SUITE}:exec] parsed episode=${parsed.episode} title=${JSON.stringify(parsed.title)} expectedEpisode=${c.expected.episode}`);
      try {
        expect(parsed.episode).toBe(c.expected.episode);
        if (c.filename.includes("Saltmarsh")) {
          expect(parsed.title).toBeTruthy();
        }
      } catch (err) {
        dumpParseSnapshot("anime-episode-parse-mismatch", {
          filename: c.filename,
          parsed,
          expected: c.expected,
        });
        throw err;
      }
    }
  });

  it("S01E03 format still works after anime handler addition (regression guard)", () => {
    const filename = "Bayview.Holdings.S01E03.1080p.mkv";
    console.info(`[${SUITE}:exec] regression guard: parseFilename(${JSON.stringify(filename)})`);
    const parsed = parseFilename(filename);
    console.info(`[${SUITE}:exec] parsed season=${parsed.season} episode=${parsed.episode}`);
    try {
      expect(parsed.season).toBe(1);
      expect(parsed.episode).toBe(3);
    } catch (err) {
      dumpParseSnapshot("regression-S01E03-broken", {
        filename,
        parsed,
        expected: { season: 1, episode: 3 },
      });
      throw err;
    }
  });

  it("returns multiple quality formats for multi-quality transcode configuration", () => {
    console.info(`[${SUITE}:exec] getAvailableFormats(1080p, h264, allowSourceEntry=false)`);
    const formats = getAvailableFormats("1080p", "h264", false);
    console.info(`[${SUITE}:exec] formats=${JSON.stringify(formats.map((f) => ({ quality: f.quality, isSource: (f as { isSource?: boolean }).isSource })))}`);

    try {
      expect(formats.some((f) => f.quality === "2160p")).toBe(false);
      expect(formats.some((f) => f.quality === "1080p" && f.isSource)).toBe(true);
      expect(formats.some((f) => f.quality === "720p")).toBe(true);
      expect(formats.some((f) => f.quality === "360p")).toBe(true);
    } catch (err) {
      dumpParseSnapshot("multi-quality-formats-missing", {
        formats,
        expected: "no 2160p; 1080p isSource=true; 720p present; 360p present",
      });
      throw err;
    }

    const selection = [
      { quality: "720p", codec: "h264" } as const,
      { quality: "360p", codec: "h264" } as const,
    ];
    console.info(`[${SUITE}:exec] resolveTranscodeOutputs(${JSON.stringify(selection)}, false)`);
    const outputs = resolveTranscodeOutputs(selection, false);
    const outputQualities = outputs.map((o) => o.quality);
    console.info(`[${SUITE}:exec] outputs.length=${outputs.length} qualities=${JSON.stringify(outputQualities)}`);

    try {
      expect(outputs).toHaveLength(2);
      expect(outputQualities).toEqual(["720p", "360p"]);
    } catch (err) {
      dumpParseSnapshot("multi-quality-outputs-mismatch", {
        outputs,
        expected: { length: 2, qualities: ["720p", "360p"] },
      });
      throw err;
    }
  });
});

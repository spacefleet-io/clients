import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFfprobe, type FfprobeStream } from "@space/ffmpeg";
import { requireMediaBinary } from "@space/media-deps";

const SUITE = "ingest-fixtures-integration";

type ExpectedTrack = {
  codec: string;
  language?: string;
  channels?: number;
  width?: number;
  height?: number;
  labelContains?: string;
};

type FixtureExpectation = {
  path: string;
  kind: "video" | "subtitle";
  expected: {
    video?: ExpectedTrack[];
    audio?: ExpectedTrack[];
    subtitles?: ExpectedTrack[];
    chapters?: number;
  };
  expectedUserInput?: {
    audioTrackOverrides?: Array<{ index: number; language: string; label: string }>;
    subtitleTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  };
};

type FixtureExpectationFile = {
  version: number;
  files: FixtureExpectation[];
};

const dumpFixtureSnapshot = (
  label: string,
  ctx: {
    fixturePath?: string;
    inventory?: ReadonlyArray<{ path: string; kind: string }>;
    expected?: unknown;
    probeStreams?: {
      video?: ReadonlyArray<FfprobeStream>;
      audio?: ReadonlyArray<FfprobeStream>;
      subtitles?: ReadonlyArray<FfprobeStream>;
      chapterCount?: number;
    };
    audioOverrides?: ReadonlyArray<unknown>;
    subtitleOverrides?: ReadonlyArray<unknown>;
    undefinedAudioIndexes?: ReadonlyArray<number>;
    undefinedSubtitleIndexes?: ReadonlyArray<number>;
    missingExpected?: unknown;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.fixturePath) {
      console.error(`fixture path: ${ctx.fixturePath}`);
    }
    if (ctx.inventory) {
      console.error(`fixture inventory (${ctx.inventory.length}):\n${JSON.stringify(ctx.inventory, null, 2)}`);
    }
    if (ctx.expected !== undefined) {
      console.error(`expected manifest entry:\n${JSON.stringify(ctx.expected, null, 2)}`);
    }
    if (ctx.probeStreams) {
      console.error(`ffprobe streams summary:`);
      console.error(`  video: ${JSON.stringify((ctx.probeStreams.video ?? []).map((s) => ({ codec: s.codec_name, width: s.width, height: s.height })))}`);
      console.error(`  audio: ${JSON.stringify((ctx.probeStreams.audio ?? []).map((s) => ({ codec: s.codec_name, channels: s.channels, language: s.language ?? s.tags?.language })))}`);
      console.error(`  subtitles: ${JSON.stringify((ctx.probeStreams.subtitles ?? []).map((s) => ({ codec: s.codec_name, language: s.language ?? s.tags?.language })))}`);
      if (typeof ctx.probeStreams.chapterCount === "number") {
        console.error(`  chapters: ${ctx.probeStreams.chapterCount}`);
      }
    }
    if (ctx.audioOverrides !== undefined) {
      console.error(`expected audio overrides:\n${JSON.stringify(ctx.audioOverrides, null, 2)}`);
    }
    if (ctx.subtitleOverrides !== undefined) {
      console.error(`expected subtitle overrides:\n${JSON.stringify(ctx.subtitleOverrides, null, 2)}`);
    }
    if (ctx.undefinedAudioIndexes) {
      console.error(`audio indexes with und language: ${JSON.stringify(ctx.undefinedAudioIndexes)}`);
    }
    if (ctx.undefinedSubtitleIndexes) {
      console.error(`subtitle indexes with und language: ${JSON.stringify(ctx.undefinedSubtitleIndexes)}`);
    }
    if (ctx.missingExpected !== undefined) {
      console.error(`missing-expected detail:\n${JSON.stringify(ctx.missingExpected, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const normalizeLanguage = (stream: FfprobeStream) => {
  const fromTags =
    (stream.tags?.language as string | undefined) ??
    (stream.tags?.LANGUAGE as string | undefined) ??
    null;
  const raw = String(stream.language ?? fromTags ?? "und").trim().toLowerCase();
  if (!raw) return "und";
  if (raw === "fre") return "fr";
  if (raw === "fra") return "fr";
  if (raw === "eng") return "en";
  return raw;
};

const normalizeTitle = (stream: FfprobeStream) => {
  const fromTags =
    (stream.tags?.title as string | undefined) ??
    (stream.tags?.TITLE as string | undefined) ??
    "";
  return String(stream.title ?? fromTags ?? "").trim();
};

const findMatchingTrack = (tracks: FfprobeStream[], expected: ExpectedTrack) => {
  return tracks.find((stream) => {
    if (String(stream.codec_name ?? "") !== expected.codec) return false;
    if (typeof expected.language === "string" && normalizeLanguage(stream) !== expected.language) return false;
    if (typeof expected.channels === "number" && Number(stream.channels ?? -1) !== expected.channels) return false;
    if (typeof expected.width === "number" && Number(stream.width ?? -1) !== expected.width) return false;
    if (typeof expected.height === "number" && Number(stream.height ?? -1) !== expected.height) return false;
    if (expected.labelContains && !normalizeTitle(stream).toLowerCase().includes(expected.labelContains.toLowerCase())) {
      return false;
    }
    return true;
  });
};

// A real probe of the fixtures is the point of this suite. On a machine without ffprobe it skips
// loudly instead of failing with `spawn ffprobe ENOENT`; CI (SF_REQUIRE_MEDIA_BINARIES=1, the shipped
// bundle on PATH) fails the file instead, so the skip cannot hide there.
const ffprobeAvailable = requireMediaBinary(
  "ffprobe",
  await runFfprobe(["-v", "quiet", "-print_format", "json", "-show_format", "-"]).then(
    () => true,
    (err: unknown) => !(err instanceof Error && err.message.includes("ENOENT")),
  ),
);
if (!ffprobeAvailable) {
  console.warn(`[${SUITE}:SKIPPED] ffprobe unavailable: the fixture probe expectations did not run on this host`);
}

describe("ingest fixture expectations", () => {
  /**
   * @test-id INGEST-FIXTURES-001
   * @level integration
   * @why Lock ffprobe-derived fixture metadata and required undefined-track user decisions for deterministic ingest/e2e coverage.
   */
  it.skipIf(!ffprobeAvailable)("matches ffprobe metadata and undefined-track resolution expectations", async () => {
    const testsDir = path.dirname(fileURLToPath(import.meta.url));
    const fixturesDir = path.join(testsDir, "..", "fixtures", "ingest");
    const expectationPath = path.join(fixturesDir, "fixture_expectations.json");
    console.info(`[${SUITE}:setup] reading expectation manifest: ${expectationPath}`);
    const expectationRaw = await readFile(expectationPath, "utf8");
    const expectation = JSON.parse(expectationRaw) as FixtureExpectationFile;
    const inventory = expectation.files.map((f) => ({ path: f.path, kind: f.kind }));
    console.info(`[${SUITE}:setup] manifest version=${expectation.version} fixture count=${expectation.files.length}`);
    console.info(`[${SUITE}:setup] inventory: ${JSON.stringify(inventory)}`);

    try {
      expect(expectation.version).toBe(1);
      expect(expectation.files.length).toBeGreaterThan(0);
    } catch (err) {
      dumpFixtureSnapshot("manifest-header-mismatch", { inventory });
      throw err;
    }

    for (const file of expectation.files) {
      const absolutePath = path.join(fixturesDir, file.path);
      console.info(`[${SUITE}:exec] probing fixture: ${file.path} (kind=${file.kind})`);
      const probe = await runFfprobe([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        absolutePath,
      ]);
      const streams = probe.streams;
      const videoStreams = streams.filter((stream) => stream.codec_type === "video");
      const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
      const subtitleStreams = streams.filter((stream) => stream.codec_type === "subtitle");
      const chapters = (probe.data as { chapters?: unknown[] }).chapters ?? [];
      console.info(`[${SUITE}:exec] probe summary: ${file.path} video=${videoStreams.length} audio=${audioStreams.length} subtitle=${subtitleStreams.length} chapters=${chapters.length}`);

      for (const expected of file.expected.video ?? []) {
        const match = findMatchingTrack(videoStreams, expected);
        if (!match) {
          dumpFixtureSnapshot("expected-video-track-missing", {
            fixturePath: file.path,
            expected,
            probeStreams: { video: videoStreams, audio: audioStreams, subtitles: subtitleStreams, chapterCount: chapters.length },
            missingExpected: expected,
          });
        }
        expect(match, `missing expected video track in ${file.path}`).toBeTruthy();
      }
      for (const expected of file.expected.audio ?? []) {
        const match = findMatchingTrack(audioStreams, expected);
        if (!match) {
          dumpFixtureSnapshot("expected-audio-track-missing", {
            fixturePath: file.path,
            expected,
            probeStreams: { video: videoStreams, audio: audioStreams, subtitles: subtitleStreams, chapterCount: chapters.length },
            missingExpected: expected,
          });
        }
        expect(match, `missing expected audio track in ${file.path}`).toBeTruthy();
      }
      for (const expected of file.expected.subtitles ?? []) {
        const match = findMatchingTrack(subtitleStreams, expected);
        if (!match) {
          dumpFixtureSnapshot("expected-subtitle-track-missing", {
            fixturePath: file.path,
            expected,
            probeStreams: { video: videoStreams, audio: audioStreams, subtitles: subtitleStreams, chapterCount: chapters.length },
            missingExpected: expected,
          });
        }
        expect(match, `missing expected subtitle track in ${file.path}`).toBeTruthy();
      }
      if (typeof file.expected.chapters === "number") {
        try {
          expect(chapters.length, `chapter count mismatch in ${file.path}`).toBe(file.expected.chapters);
        } catch (err) {
          dumpFixtureSnapshot("chapter-count-mismatch", {
            fixturePath: file.path,
            expected: { chapters: file.expected.chapters },
            probeStreams: { chapterCount: chapters.length },
          });
          throw err;
        }
      }

      const undefinedAudioIndexes = audioStreams
        .map((stream, index) => ({ index, language: normalizeLanguage(stream) }))
        .filter((entry) => entry.language === "und")
        .map((entry) => entry.index);
      const undefinedSubtitleIndexes = subtitleStreams
        .map((stream, index) => ({ index, language: normalizeLanguage(stream) }))
        .filter((entry) => entry.language === "und")
        .map((entry) => entry.index);

      const expectedAudioOverrides = file.expectedUserInput?.audioTrackOverrides ?? [];
      const expectedSubtitleOverrides = file.expectedUserInput?.subtitleTrackOverrides ?? [];
      console.info(`[${SUITE}:exec] ${file.path}: undefinedAudioIndexes=${JSON.stringify(undefinedAudioIndexes)} expectedAudioOverrideIndexes=${JSON.stringify(expectedAudioOverrides.map((e) => e.index))}`);
      console.info(`[${SUITE}:exec] ${file.path}: undefinedSubtitleIndexes=${JSON.stringify(undefinedSubtitleIndexes)} expectedSubtitleOverrideIndexes=${JSON.stringify(expectedSubtitleOverrides.map((e) => e.index))}`);

      try {
        expect(
          expectedAudioOverrides.map((entry) => entry.index).sort((a, b) => a - b),
          `audio override indexes mismatch for ${file.path}`
        ).toEqual(undefinedAudioIndexes.sort((a, b) => a - b));
        expect(
          expectedSubtitleOverrides.map((entry) => entry.index).sort((a, b) => a - b),
          `subtitle override indexes mismatch for ${file.path}`
        ).toEqual(undefinedSubtitleIndexes.sort((a, b) => a - b));
      } catch (err) {
        dumpFixtureSnapshot("undefined-track-override-mismatch", {
          fixturePath: file.path,
          audioOverrides: expectedAudioOverrides,
          subtitleOverrides: expectedSubtitleOverrides,
          undefinedAudioIndexes,
          undefinedSubtitleIndexes,
          probeStreams: { audio: audioStreams, subtitles: subtitleStreams },
        });
        throw err;
      }

      for (const override of expectedAudioOverrides) {
        try {
          expect(override.language).not.toBe("und");
          expect(override.label.length).toBeGreaterThan(0);
        } catch (err) {
          dumpFixtureSnapshot("audio-override-shape-invalid", {
            fixturePath: file.path,
            audioOverrides: expectedAudioOverrides,
            missingExpected: override,
          });
          throw err;
        }
      }
      for (const override of expectedSubtitleOverrides) {
        try {
          expect(override.language).not.toBe("und");
          expect(override.label.length).toBeGreaterThan(0);
        } catch (err) {
          dumpFixtureSnapshot("subtitle-override-shape-invalid", {
            fixturePath: file.path,
            subtitleOverrides: expectedSubtitleOverrides,
            missingExpected: override,
          });
          throw err;
        }
      }
    }
    console.info(`[${SUITE}:teardown] all ${expectation.files.length} fixtures validated`);
  });
});

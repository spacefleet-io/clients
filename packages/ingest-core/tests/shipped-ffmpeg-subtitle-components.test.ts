import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireMediaBinary } from "@space/media-deps";
import { resolveSubtitleOutput } from "../src/mediaProcessor";
// Test-only reach into the sibling package: @space/ffmpeg exports only its runtime API.
import { COMPONENT_LIST_ARGS, findMissingComponents, type ListedComponentKind } from "../../media-deps/src/components";
import { ffmpegComponentFlags } from "../../media-deps/src/features";

// @bugfix @regression-proof (issue #25, review of PR #41): packaged desktop builds run a reduced ffmpeg
// (`--disable-everything`). The first build enabled only the dash/image2/matroska/mp4 muxers, so
// `resolveSubtitleOutput`'s `subtitle-N.sup` (PGS copy) and `subtitle-N.srt` (text → srt) outputs failed with
// "Unable to choose an output format" and packaged users got no PGS or text subtitles.
//
// The desktop now ships the media-deps bundle (packages/media-deps; one feature list for every OS). This pins
// every component the subtitle extraction emits twice: against the shared feature list that configures the
// build, and, when the shipped bundle's ffmpeg is on this host, against what that binary really lists.
const SUITE = "shipped-ffmpeg-subtitle-components";

// Every subtitle codec ingest classifies, plus one it does not know (falls back to srt).
const SUBTITLE_CODECS = [
  "hdmv_pgs_subtitle",
  "dvd_subtitle",
  "vobsub",
  "dvb_subtitle",
  "subrip",
  "ass",
  "ssa",
  "mov_text",
  "webvtt",
  "some_future_codec",
];

// ffmpeg picks the muxer from the extension when no `-f` is given.
const MUXER_BY_EXTENSION: Record<string, string> = { sup: "sup", srt: "srt", mkv: "matroska" };
// Configure component names; ffmpeg's `mov_text` codec is the `movtext` component.
const COMPONENT_BY_CODEC: Record<string, string> = {
  srt: "srt",
  subrip: "subrip",
  ass: "ass",
  ssa: "ssa",
  mov_text: "movtext",
  webvtt: "webvtt",
};

const argAfter = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const requiredFlagsFor = (codec: string) => {
  const { format, codecArgs } = resolveSubtitleOutput(codec);
  const muxer = argAfter(codecArgs, "-f") ?? MUXER_BY_EXTENSION[format];
  const encoder = argAfter(codecArgs, "-c:s");
  const required: string[] = [];
  if (!muxer) throw new Error(`[${SUITE}] no muxer mapping for output extension .${format}; add it here`);
  required.push(`--enable-muxer=${muxer}`);
  if (encoder && encoder !== "copy") {
    const encoderComponent = COMPONENT_BY_CODEC[encoder];
    if (!encoderComponent) throw new Error(`[${SUITE}] no component mapping for encoder ${encoder}`);
    required.push(`--enable-encoder=${encoderComponent}`);
    // Transcoding decodes the source track first; an unknown codec has no decoder to pin.
    const decoderComponent = COMPONENT_BY_CODEC[codec];
    if (decoderComponent) required.push(`--enable-decoder=${decoderComponent}`);
  }
  return { format, codecArgs, required };
};

describe("shared ffmpeg feature list covers ingest subtitle extraction", () => {
  const flags = ffmpegComponentFlags();

  for (const codec of SUBTITLE_CODECS) {
    it(`builds every component needed to extract ${codec}`, () => {
      const { format, codecArgs, required } = requiredFlagsFor(codec);
      const missing = required.filter((flag) => !flags.includes(flag));
      console.info(
        `[${SUITE}:${codec}] output=.${format} args=${codecArgs.join(" ")} required=${required.join(" ")} missing=${missing.join(" ") || "none"}`
      );
      if (missing.length > 0) console.error(`[${SUITE}:${codec}] feature-list flags:\n${flags.join("\n")}`);
      expect(missing).toEqual([]);
    });
  }
});

// The bundle fetched by `bun scripts/fetch-deps.ts` (or an explicit SF_FFMPEG_PATH). Skipped, with the reason
// logged, where no runnable shipped ffmpeg exists (e.g. a checkout that never fetched the bundle).
const resolveShippedFfmpeg = () => {
  const explicit = process.env.SF_FFMPEG_PATH;
  if (explicit) return existsSync(explicit) ? explicit : null;
  if (process.platform !== "linux" || process.arch !== "x64") return null;
  const fetched = path.resolve(import.meta.dirname, "../../../vendor/deps/linux-x64/bin/ffmpeg");
  return existsSync(fetched) ? fetched : null;
};
const shippedFfmpeg = resolveShippedFfmpeg();
requireMediaBinary("shipped ffmpeg (vendor/deps/linux-x64/bin/ffmpeg or SF_FFMPEG_PATH)", shippedFfmpeg !== null);
if (!shippedFfmpeg) {
  console.info(`[${SUITE}] no shipped ffmpeg on this host (fetch: bun scripts/fetch-deps.ts); skipping the real-binary check`);
}

describe.skipIf(!shippedFfmpeg)("the shipped ffmpeg binary covers ingest subtitle extraction", () => {
  const listings: Partial<Record<ListedComponentKind, string>> = {};
  const listing = (kind: ListedComponentKind) => {
    listings[kind] ??= spawnSync(shippedFfmpeg!, ["-hide_banner", COMPONENT_LIST_ARGS[kind]], { encoding: "utf8" }).stdout;
    return listings;
  };

  for (const codec of SUBTITLE_CODECS) {
    it(`lists every component needed to extract ${codec}`, () => {
      const { required } = requiredFlagsFor(codec);
      const kinds = [...new Set(required.map((flag) => /^--enable-([a-z]+)=/.exec(flag)![1] as ListedComponentKind))];
      for (const kind of kinds) listing(kind);
      const missing = findMissingComponents(required, listings);
      console.info(`[${SUITE}:${codec}] ffmpeg=${shippedFfmpeg} required=${required.join(" ")} missing=${missing.join(" ") || "none"}`);
      expect(missing).toEqual([]);
    });
  }
});

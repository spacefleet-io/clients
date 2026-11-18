/**
 * @bugfix @regression-proof
 * @req INGS-SOURCE-03
 *
 * Issue #303: the stored source format used to be labelled `h264` whenever the
 * probe said anything other than HEVC / H.264 (AV1, VP9, MPEG-2 ...), so a
 * client could pick an AV1 original believing it was "H.264, safe".
 *
 * The probe fixtures below are the `streams[]` video entry of real
 * `ffprobe -show_streams -print_format json` output for 320x180 files made with
 * ffmpeg (libsvtav1, libvpx-vp9, libx265, libx264, mpeg2video).
 */

import { mkdtempSync, rmSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCodecForQuality, normalizeSourceCodec } from "../src/quality";

const SUITE = "source-codec";

const videoStream = (codec_name: string, extra: Record<string, unknown> = {}) => ({
  index: 0,
  codec_type: "video",
  codec_name,
  width: 320,
  height: 180,
  pix_fmt: "yuv420p",
  ...extra,
});

const FIXTURES = [
  { label: "av1", stream: videoStream("av1", { profile: "Main" }), expected: "av1" },
  { label: "vp9", stream: videoStream("vp9", { profile: "Profile 0" }), expected: "vp9" },
  { label: "hevc", stream: videoStream("hevc", { profile: "Main", codec_tag_string: "[0][0][0][0]" }), expected: "hevc" },
  { label: "h264", stream: videoStream("h264", { profile: "High", codec_tag_string: "avc1" }), expected: "h264" },
  { label: "mpeg2", stream: videoStream("mpeg2video", { profile: "Main" }), expected: "mpeg2" },
] as const;

describe("normalizeSourceCodec (ffprobe codec_name -> stored label)", () => {
  it.each(FIXTURES)("$label fixture -> $expected", ({ stream, expected }) => {
    const actual = normalizeSourceCodec(stream.codec_name);
    console.info(`[${SUITE}:map] ffprobe codec_name=${stream.codec_name} -> ${actual}`);
    expect(actual).toBe(expected);
  });

  it("normalises the other common ffprobe names", () => {
    const cases: Array<[string, string]> = [
      ["h265", "hevc"],
      ["HEVC", "hevc"],
      ["vp8", "vp8"],
      ["mpeg4", "mpeg4"],
      ["mpeg1video", "mpeg1"],
      ["vc1", "vc1"],
    ];
    for (const [raw, expected] of cases) {
      expect(normalizeSourceCodec(raw)).toBe(expected);
    }
  });

  it("stores the raw ffprobe name for a codec it does not know, never h264", () => {
    expect(normalizeSourceCodec("prores")).toBe("prores");
    expect(normalizeSourceCodec("  Theora ")).toBe("theora");
    expect(normalizeSourceCodec("wmv3")).toBe("wmv3");
  });

  it("says unknown (not h264) when the probe reports no codec", () => {
    expect(normalizeSourceCodec(undefined)).toBe("unknown");
    expect(normalizeSourceCodec(null)).toBe("unknown");
    expect(normalizeSourceCodec("")).toBe("unknown");
  });

  it("keeps the transcode output codec set apart: encoders only ever get h264 / hevc", () => {
    for (const quality of ["2160p", "1080p", "720p", "480p", "360p", "240p", "144p"] as const) {
      expect(["h264", "hevc"]).toContain(defaultCodecForQuality(quality));
    }
  });
});

const runFfprobeMock = vi.fn();
const runFfmpegMock = vi.fn();
const createFfmpegTaskMock = vi.fn();

vi.mock("@space/ffmpeg", () => ({
  runFfprobe: runFfprobeMock,
  runFfmpeg: runFfmpegMock,
  createFfmpegTask: createFfmpegTaskMock,
}));

const setupDashOutput = async (mpdPath: string) => {
  await fs.mkdir(dirname(mpdPath), { recursive: true });
  await fs.writeFile(join(dirname(mpdPath), "init-0.mp4"), "init");
  await fs.writeFile(join(dirname(mpdPath), "seg-00001.m4s"), "seg-1");
  await fs.writeFile(
    mpdPath,
    [
      '<MPD><Period><AdaptationSet contentType="video" codecs="av01.0.00M.08">',
      '<SegmentTemplate timescale="1"><SegmentTimeline><S t="0" d="12" /></SegmentTimeline></SegmentTemplate>',
      "</AdaptationSet></Period></MPD>",
    ].join(""),
  );
};

describe("ingest probe path records the real source codec", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-source-codec-"));
    runFfprobeMock.mockReset();
    runFfmpegMock.mockReset();
    createFfmpegTaskMock.mockReset();
    runFfmpegMock.mockResolvedValue({ stdout: "", stderr: "" });
    createFfmpegTaskMock.mockImplementation((args: string[]) => {
      const mpdPath = args.find((value) => value.endsWith(".mpd")) ?? args[args.length - 1]!;
      return { promise: setupDashOutput(mpdPath).then(() => ({ stdout: "", stderr: "" })), cancel: vi.fn() };
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each(FIXTURES)("source output of a $label upload is labelled $expected", async ({ label, stream, expected }) => {
    // Dynamic import: the `@space/ffmpeg` mock factory above reads consts that vi.mock does not hoist, so the module under test loads after them.
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import("../src/mediaProcessor");
    const jobId = `j-${label}`;
    configureMediaIngestRuntime({
      resolveJobDir: (userId, id) => join(root, "jobs", userId, id),
      encryptMediaObject: vi.fn(() => Buffer.alloc(0)),
      uploadStorageObject: vi.fn(async () => "would-not-run"),
    });
    runFfprobeMock.mockResolvedValue({
      streams: [stream],
      data: { format: { duration: "1" }, chapters: [] },
    });

    const result = await produceMediaOutputs({
      userId: "u1",
      jobId,
      inputPath: `/tmp/${label}.mkv`,
      includeSource: true,
      includeFallback: false,
      includeAudio: false,
      includeSubtitles: false,
      includeChapters: false,
    });

    const sourceOutput = result.stateStore.getState().outputs.find((o) => o.id === "video-source");
    console.info(
      `[${SUITE}:probe] ${label}: ffprobe=${stream.codec_name} state.codec=${sourceOutput?.codec} produced.codec=${result.produced.videoFormats[0]?.codec}`,
    );
    expect(sourceOutput?.codec).toBe(expected);
    expect(result.produced.videoFormats[0]?.codec).toBe(expected);
  });
});

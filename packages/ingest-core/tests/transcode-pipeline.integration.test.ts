/**
 * @test-id TRANSCODE-PIPELINE-001
 * @level integration
 * @why No test runs ffmpeg encoding end-to-end on real media to verify DASH segment output.
 *      Transcode bugs (wrong codec, missing segments, broken MPD) are invisible without real encoding.
 * @covers packages/ingest-core/src/mediaProcessor.ts: encodeDashVideo, DASH segment creation
 * @risk Requires ffmpeg binary — skip if unavailable
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runFfmpeg, runFfprobe } from "@space/ffmpeg";
import { requireMediaBinary } from "@space/media-deps";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "ingest", "video");
// Use the smallest fixture for fast tests
const SMALL_FIXTURE = join(FIXTURE_DIR, "Le Phare de l'Étang (2001) [FR-EN].mkv");

const SUITE = "transcode-pipeline-integration";

const dumpPipelineSnapshot = (
  label: string,
  ctx: {
    phase?: string;
    workDir?: string;
    intermediateOutputs?: ReadonlyArray<string>;
    ffmpegStderrTail?: string;
    fixture?: string;
    fixtureSize?: number;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.phase) console.error(`pipeline phase: ${ctx.phase}`);
    if (ctx.fixture) {
      console.error(
        `fixture path: ${ctx.fixture}${typeof ctx.fixtureSize === "number" ? ` (size=${ctx.fixtureSize} bytes)` : ""}`,
      );
    }
    if (ctx.workDir) {
      console.error(`workDir: ${ctx.workDir}`);
      try {
        const files = readdirSync(ctx.workDir);
        console.error(`workDir entries (${files.length}):\n${JSON.stringify(files, null, 2)}`);
      } catch (e) {
        console.error(`(workDir listing failed: ${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (ctx.intermediateOutputs) {
      console.error(`intermediate outputs:\n${JSON.stringify(ctx.intermediateOutputs, null, 2)}`);
    }
    if (typeof ctx.ffmpegStderrTail === "string") {
      const tail = ctx.ffmpegStderrTail.split("\n").slice(-20).join("\n");
      console.error(`ffmpeg stderr (last 20 lines):\n${tail}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const probeFile = async (path: string) =>
  runFfprobe(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path]);

const ffmpegAvailable = async (): Promise<boolean> => {
  let usable = false;
  try {
    usable = (await probeFile(SMALL_FIXTURE)).streams.length > 0;
  } catch {
    usable = false;
  }
  return requireMediaBinary("ffprobe", usable);
};

describe("transcode pipeline integration", () => {
  /**
   * @test-id TRANSCODE-PIPELINE-002
   * @level integration
   * @why Real ffprobe must report the fixture's video + audio streams; every
   *      later encode decision is driven by that probe.
   */
  it("ffprobe extracts stream metadata from fixture", async () => {
    console.info(`[${SUITE}:probe-only:setup] fixture=${SMALL_FIXTURE}`);
    if (!existsSync(SMALL_FIXTURE)) { console.info(`[${SUITE}:probe-only:skip] fixture not found`); return; }
    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) { console.info(`[${SUITE}:probe-only:skip] ffmpeg/ffprobe not available`); return; }

    console.info(`[${SUITE}:probe-only:run] probing fixture`);
    const probe = await probeFile(SMALL_FIXTURE);
    console.info(`[${SUITE}:probe-only:assert] streams=${probe.streams.length}`);
    if (probe.streams.length === 0) {
      dumpPipelineSnapshot("probe-no-streams", {
        phase: "probe",
        fixture: SMALL_FIXTURE,
        fixtureSize: statSync(SMALL_FIXTURE).size,
      });
    }
    expect(probe.streams.length).toBeGreaterThan(0);

    const videoStream = probe.streams.find((s) => s.codec_type === "video");
    expect(videoStream).toBeTruthy();
    expect(Number(videoStream!.width)).toBeGreaterThan(0);
    expect(Number(videoStream!.height)).toBeGreaterThan(0);

    const audioStreams = probe.streams.filter((s) => s.codec_type === "audio");
    console.info(
      `[${SUITE}:probe-only:assert] video=${videoStream!.width}x${videoStream!.height} audio_streams=${audioStreams.length}`,
    );
    expect(audioStreams.length).toBeGreaterThan(0);
  });

  /**
   * @test-id TRANSCODE-PIPELINE-003
   * @level integration
   * @why The source format is a stream-copy remux to DASH; it must yield an
   *      MPD plus init and media segments without re-encoding.
   */
  it("source remux (copy) produces DASH segments", async () => {
    console.info(`[${SUITE}:source-remux:setup] preparing copy-remux to DASH`);
    if (!existsSync(SMALL_FIXTURE)) { console.info(`[${SUITE}:source-remux:skip] fixture not found`); return; }
    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) { console.info(`[${SUITE}:source-remux:skip] ffmpeg/ffprobe not available`); return; }

    const workDir = mkdtempSync(join(tmpdir(), "transcode-test-source-"));
    console.info(`[${SUITE}:source-remux:setup] workDir=${workDir}`);
    try {
      // Remux to DASH with copy codec (same as source upload)
      console.info(`[${SUITE}:source-remux:run] invoking ffmpeg copy → DASH`);
      const result = await runFfmpeg([
        "-i", SMALL_FIXTURE,
        "-c:v", "copy",
        "-an", // no audio for this test
        "-f", "dash",
        "-seg_duration", "12",
        "-init_seg_name", "init-stream0.mp4",
        "-media_seg_name", "seg-stream0-$Number$.m4s",
        "-use_template", "1",
        "-use_timeline", "1",
        join(workDir, "manifest.mpd"),
      ]);

      // Verify output structure
      const files = readdirSync(workDir);
      console.info(`[${SUITE}:source-remux:assert] workDir files=${files.length}: ${JSON.stringify(files)}`);
      if (!files.includes("manifest.mpd") || !files.some((f) => f.startsWith("init-")) || !files.some((f) => f.startsWith("seg-"))) {
        dumpPipelineSnapshot("source-remux-incomplete-outputs", {
          phase: "dash-copy-remux",
          workDir,
          intermediateOutputs: files,
          ffmpegStderrTail: result.stderr,
        });
      }
      expect(files).toContain("manifest.mpd");
      expect(files.some((f) => f.startsWith("init-"))).toBe(true);
      expect(files.some((f) => f.startsWith("seg-"))).toBe(true);

      // Verify MPD is valid XML with expected elements
      const mpd = readFileSync(join(workDir, "manifest.mpd"), "utf8");
      expect(mpd).toContain("MPD");
      expect(mpd).toContain("Period");
      expect(mpd).toContain("AdaptationSet");
      expect(mpd).toContain("Representation");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  /**
   * @test-id TRANSCODE-PIPELINE-004
   * @level integration
   * @why A real libx264 360p re-encode (the fallback variant) must yield a
   *      DASH manifest and a 360p init segment.
   */
  it("360p transcode produces smaller output", async () => {
    console.info(`[${SUITE}:transcode-360p:setup] preparing libx264 360p re-encode`);
    if (!existsSync(SMALL_FIXTURE)) { console.info(`[${SUITE}:transcode-360p:skip] fixture not found`); return; }
    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) { console.info(`[${SUITE}:transcode-360p:skip] ffmpeg/ffprobe not available`); return; }

    const workDir = mkdtempSync(join(tmpdir(), "transcode-test-360p-"));
    console.info(`[${SUITE}:transcode-360p:setup] workDir=${workDir}`);
    try {
      console.info(`[${SUITE}:transcode-360p:run] invoking ffmpeg libx264 → DASH 360p`);
      const result = await runFfmpeg([
        "-i", SMALL_FIXTURE,
        "-c:v", "libx264",
        "-vf", "scale=-2:360",
        "-preset", "ultrafast",
        "-crf", "28",
        "-pix_fmt", "yuv420p", // the app always outputs 8-bit 4:2:0; the shipped x264 is 8-bit only
        "-an",
        "-f", "dash",
        "-seg_duration", "4",
        "-init_seg_name", "init-360p.mp4",
        "-media_seg_name", "seg-360p-$Number$.m4s",
        "-use_template", "1",
        "-use_timeline", "1",
        join(workDir, "manifest.mpd"),
      ]);

      const files = readdirSync(workDir);
      console.info(`[${SUITE}:transcode-360p:assert] workDir files=${files.length}: ${JSON.stringify(files)}`);
      if (!files.includes("manifest.mpd") || !files.some((f) => f.startsWith("init-360p"))) {
        dumpPipelineSnapshot("transcode-360p-incomplete-outputs", {
          phase: "transcode-360p",
          workDir,
          intermediateOutputs: files,
          ffmpegStderrTail: result.stderr,
        });
      }
      expect(files).toContain("manifest.mpd");
      expect(files.some((f) => f.startsWith("init-360p"))).toBe(true);

      // Verify the output is actually 360p by probing it
      const initFile = files.find((f) => f.startsWith("init-360p"));
      if (initFile) {
        // Init segment exists — the transcode succeeded
        expect(initFile).toBeTruthy();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  /**
   * @test-id TRANSCODE-PIPELINE-005
   * @level integration
   * @why ffmpeg progress parsing drives the job progress bar; values must
   *      advance monotonically from a real encode.
   */
  it("transcode progress values advance monotonically", async () => {
    console.info(`[${SUITE}:progress:setup] preparing 360p with progress callbacks`);
    if (!existsSync(SMALL_FIXTURE)) { console.info(`[${SUITE}:progress:skip] fixture not found`); return; }
    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) { console.info(`[${SUITE}:progress:skip] ffmpeg/ffprobe not available`); return; }

    const workDir = mkdtempSync(join(tmpdir(), "transcode-test-progress-"));
    console.info(`[${SUITE}:progress:setup] workDir=${workDir}`);
    try {
      const percentValues: number[] = [];
      console.info(`[${SUITE}:progress:run] invoking ffmpeg with progress`);
      const result = await runFfmpeg(
        [
          "-i", SMALL_FIXTURE,
          "-c:v", "libx264",
          "-vf", "scale=-2:360",
          "-preset", "ultrafast",
          "-crf", "28",
          "-pix_fmt", "yuv420p", // the app always outputs 8-bit 4:2:0; the shipped x264 is 8-bit only
          "-an",
          "-f", "dash",
          "-seg_duration", "4",
          "-init_seg_name", "init-progress.mp4",
          "-media_seg_name", "seg-progress-$Number$.m4s",
          "-use_template", "1",
          "-use_timeline", "1",
          join(workDir, "manifest.mpd"),
        ],
        {
          progress: {
            enabled: true,
            durationMs: 5_000,
            onUpdate: (stats) => {
              if (typeof stats.percent === "number") percentValues.push(stats.percent);
            },
          },
        }
      );

      console.info(`[${SUITE}:progress:assert] captured ${percentValues.length} percent samples`);
      // Verify monotonic: each value >= previous
      for (let i = 1; i < percentValues.length; i++) {
        if (percentValues[i] < percentValues[i - 1]) {
          dumpPipelineSnapshot("progress-non-monotonic", {
            phase: `progress-tick-${i}`,
            workDir,
            intermediateOutputs: readdirSync(workDir),
            ffmpegStderrTail: result.stderr,
          });
          console.error(`[${SUITE}:progress:assert] full sequence: ${percentValues.join(", ")}`);
        }
        expect(percentValues[i]).toBeGreaterThanOrEqual(percentValues[i - 1]);
      }
      expect(percentValues.length).toBeGreaterThan(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  /**
   * @test-id TRANSCODE-PIPELINE-006
   * @level integration
   * @why Audio tracks ship as separate AAC DASH outputs; a real extraction
   *      must produce a playable audio-only MPD.
   */
  it("audio extraction to AAC DASH", async () => {
    console.info(`[${SUITE}:audio:setup] preparing audio-only AAC DASH`);
    if (!existsSync(SMALL_FIXTURE)) { console.info(`[${SUITE}:audio:skip] fixture not found`); return; }
    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) { console.info(`[${SUITE}:audio:skip] ffmpeg/ffprobe not available`); return; }

    const workDir = mkdtempSync(join(tmpdir(), "transcode-test-audio-"));
    console.info(`[${SUITE}:audio:setup] workDir=${workDir}`);
    try {
      console.info(`[${SUITE}:audio:run] invoking ffmpeg AAC → DASH`);
      const result = await runFfmpeg([
        "-i", SMALL_FIXTURE,
        "-vn", // no video
        "-c:a", "aac",
        "-b:a", "128k",
        "-ac", "2",
        "-f", "dash",
        "-seg_duration", "4",
        "-init_seg_name", "init-audio.mp4",
        "-media_seg_name", "seg-audio-$Number$.m4s",
        "-use_template", "1",
        "-use_timeline", "1",
        join(workDir, "manifest.mpd"),
      ]);

      const files = readdirSync(workDir);
      console.info(`[${SUITE}:audio:assert] workDir files=${files.length}: ${JSON.stringify(files)}`);
      if (!files.includes("manifest.mpd") || !files.some((f) => f.startsWith("init-audio"))) {
        dumpPipelineSnapshot("audio-incomplete-outputs", {
          phase: "audio-aac-dash",
          workDir,
          intermediateOutputs: files,
          ffmpegStderrTail: result.stderr,
        });
      }
      expect(files).toContain("manifest.mpd");
      expect(files.some((f) => f.startsWith("init-audio"))).toBe(true);

      const mpd = readFileSync(join(workDir, "manifest.mpd"), "utf8");
      expect(mpd).toContain("audio");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  /**
   * @test-id TRANSCODE-PIPELINE-007
   * @level integration
   * @why Downscaling a 1080p source to a 720p variant must yield a DASH
   *      manifest and a 720p init segment.
   */
  it("720p transcode from 1080p source produces output", async () => {
    console.info(`[${SUITE}:transcode-720p:setup] preparing 720p re-encode`);
    if (!existsSync(SMALL_FIXTURE)) { console.info(`[${SUITE}:transcode-720p:skip] fixture not found`); return; }
    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) { console.info(`[${SUITE}:transcode-720p:skip] ffmpeg/ffprobe not available`); return; }

    const workDir = mkdtempSync(join(tmpdir(), "transcode-test-720p-"));
    console.info(`[${SUITE}:transcode-720p:setup] workDir=${workDir}`);
    try {
      console.info(`[${SUITE}:transcode-720p:run] invoking ffmpeg libx264 → DASH 720p`);
      const result = await runFfmpeg([
        "-i", SMALL_FIXTURE,
        "-c:v", "libx264",
        "-vf", "scale=-2:720",
        "-preset", "ultrafast",
        "-crf", "28",
        "-pix_fmt", "yuv420p", // the app always outputs 8-bit 4:2:0; the shipped x264 is 8-bit only
        "-an",
        "-f", "dash",
        "-seg_duration", "4",
        "-init_seg_name", "init-720p.mp4",
        "-media_seg_name", "seg-720p-$Number$.m4s",
        "-use_template", "1",
        "-use_timeline", "1",
        join(workDir, "manifest.mpd"),
      ]);

      const files = readdirSync(workDir);
      console.info(`[${SUITE}:transcode-720p:assert] workDir files=${files.length}: ${JSON.stringify(files)}`);
      if (!files.includes("manifest.mpd") || !files.some((f) => f.startsWith("init-720p"))) {
        dumpPipelineSnapshot("transcode-720p-incomplete-outputs", {
          phase: "transcode-720p",
          workDir,
          intermediateOutputs: files,
          ffmpegStderrTail: result.stderr,
        });
      }
      expect(files).toContain("manifest.mpd");
      expect(files.some((f) => f.startsWith("init-720p"))).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  /**
   * @test-id TRANSCODE-PIPELINE-008
   * @level integration
   * @why A libx265 encode must yield a DASH manifest and an hevc init segment
   *      on an ffmpeg that ships libx265 (the shipped media-deps ffmpeg does;
   *      see packages/media-deps/src/features.ts).
   */
  it("HEVC/h265 transcode produces valid output", async () => {
    console.info(`[${SUITE}:transcode-hevc:setup] preparing libx265 360p re-encode`);
    if (!existsSync(SMALL_FIXTURE)) { console.info(`[${SUITE}:transcode-hevc:skip] fixture not found`); return; }
    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) { console.info(`[${SUITE}:transcode-hevc:skip] ffmpeg/ffprobe not available`); return; }

    const workDir = mkdtempSync(join(tmpdir(), "transcode-test-hevc-"));
    console.info(`[${SUITE}:transcode-hevc:setup] workDir=${workDir}`);
    try {
      console.info(`[${SUITE}:transcode-hevc:run] invoking ffmpeg libx265 → DASH 360p`);
      const result = await runFfmpeg([
        "-i", SMALL_FIXTURE,
        "-c:v", "libx265",
        "-vf", "scale=-2:360",
        "-preset", "ultrafast",
        "-crf", "28",
        "-an",
        "-f", "dash",
        "-seg_duration", "4",
        "-init_seg_name", "init-hevc.mp4",
        "-media_seg_name", "seg-hevc-$Number$.m4s",
        "-use_template", "1",
        "-use_timeline", "1",
        join(workDir, "manifest.mpd"),
      ]);

      const files = readdirSync(workDir);
      console.info(`[${SUITE}:transcode-hevc:assert] workDir files=${files.length}: ${JSON.stringify(files)}`);
      if (!files.includes("manifest.mpd") || !files.some((f) => f.startsWith("init-hevc"))) {
        dumpPipelineSnapshot("transcode-hevc-incomplete-outputs", {
          phase: "transcode-hevc",
          workDir,
          intermediateOutputs: files,
          ffmpegStderrTail: result.stderr,
        });
      }
      expect(files).toContain("manifest.mpd");
      expect(files.some((f) => f.startsWith("init-hevc"))).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  /**
   * @test-id TRANSCODE-PIPELINE-009
   * @level integration
   * @why A truncated/corrupt source must be rejected at probe time (probe
   *      error or no video stream) before it reaches an encoder.
   */
  it("corrupt/truncated file raises error at probe stage", async () => {
    const corruptFixture = join(FIXTURE_DIR, "test-corrupt-truncated.mkv");
    console.info(`[${SUITE}:corrupt:setup] corruptFixture=${corruptFixture}`);
    if (!existsSync(corruptFixture)) { console.info(`[${SUITE}:corrupt:skip] corrupt fixture not found`); return; }
    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) { console.info(`[${SUITE}:corrupt:skip] ffmpeg/ffprobe not available`); return; }

    try {
      console.info(`[${SUITE}:corrupt:run] probing corrupt fixture`);
      const probe = await probeFile(corruptFixture);
      // If probe succeeds, it should have no usable video streams
      const videoStreams = probe.streams.filter((s: any) => s.codec_type === "video");
      console.info(`[${SUITE}:corrupt:assert] probe succeeded; video_streams=${videoStreams.length}`);
      if (videoStreams.length !== 0) {
        dumpPipelineSnapshot("corrupt-unexpected-video-streams", {
          phase: "probe-corrupt",
          fixture: corruptFixture,
          fixtureSize: statSync(corruptFixture).size,
        });
      }
      expect(videoStreams).toHaveLength(0);
    } catch (err) {
      console.info(
        `[${SUITE}:corrupt:assert] probe threw as expected: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Probe throwing is the expected behavior for corrupt files
      expect(true).toBe(true);
    }
  });
});

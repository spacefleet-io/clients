import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pre-fix, `transcodeTotal` was bumped on each `startTranscodeStep()`, so the
 * progress denominator grew as new ffmpeg invocations began. The user-visible
 * `(done + active) / total` therefore jumped backward at the start of every
 * new output (e.g. 99% → 50% → 99% → 66% → 99% across multiple outputs).
 *
 * Post-fix, `transcodeTotal` is computed once upfront from the same predicates
 * the encode loops use, so the parsed ffmpeg time drives a monotonic 0→99%
 * across the whole extracting stage.
 */

const SUITE = "media-processor-progress-monotonic";

const dumpProgressSnapshot = (
  label: string,
  ctx: {
    progressEvents?: ReadonlyArray<{ stage: string; pct: number }>;
    transcoding?: ReadonlyArray<{ stage: string; pct: number }>;
    violationIndex?: number;
    prev?: number;
    current?: number;
    ffmpegStepCount?: number;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (typeof ctx.ffmpegStepCount === "number") {
      console.error(`ffmpeg createFfmpegTask invocations=${ctx.ffmpegStepCount}`);
    }
    if (ctx.progressEvents) {
      const lastTen = ctx.progressEvents.slice(-10);
      console.error(
        `total progress events=${ctx.progressEvents.length} (showing last 10):\n${JSON.stringify(lastTen, null, 2)}`,
      );
    }
    if (ctx.transcoding) {
      const lastTen = ctx.transcoding.slice(-10);
      console.error(
        `transcoding-stage events=${ctx.transcoding.length} (last 10):\n${JSON.stringify(lastTen, null, 2)}`,
      );
      const pcts = ctx.transcoding.map((e) => e.pct);
      console.error(`transcoding pct sequence: ${pcts.join(", ")}`);
    }
    if (typeof ctx.violationIndex === "number") {
      console.error(
        `monotonic violation at index=${ctx.violationIndex}: prev=${ctx.prev}% → current=${ctx.current}%`,
      );
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const runFfprobeMock = vi.fn();
const runFfmpegMock = vi.fn();
const createFfmpegTaskMock = vi.fn();

vi.mock("@space/ffmpeg", () => ({
  runFfprobe: runFfprobeMock,
  runFfmpeg: runFfmpegMock,
  createFfmpegTask: createFfmpegTaskMock,
}));

const writeDashOutput = async (mpdPath: string, codecType: "video" | "audio") => {
  await fs.mkdir(dirname(mpdPath), { recursive: true });
  await fs.writeFile(join(dirname(mpdPath), "init.m4s"), "init");
  await fs.writeFile(join(dirname(mpdPath), "seg-00001.m4s"), "seg-1");
  const codecs = codecType === "video" ? "avc1.640028" : "mp4a.40.2";
  await fs.writeFile(
    mpdPath,
    [
      `<MPD><Period><AdaptationSet contentType="${codecType}" codecs="${codecs}">`,
      '<SegmentTemplate timescale="1">',
      "<SegmentTimeline>",
      '<S t="0" d="4" />',
      "</SegmentTimeline>",
      "</SegmentTemplate>",
      "</AdaptationSet></Period></MPD>",
    ].join("")
  );
};

describe("@bugfix @regression-proof media processor progress is monotonic across multiple outputs", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-media-processor-monotonic-"));
    console.info(`[${SUITE}:setup] temp root=${root}`);
    runFfprobeMock.mockReset();
    runFfmpegMock.mockReset();
    createFfmpegTaskMock.mockReset();
    runFfmpegMock.mockResolvedValue({ stdout: "", stderr: "" });
  });

  afterEach(() => {
    console.info(`[${SUITE}:teardown] removing temp root=${root}`);
    rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("never decreases transcoding pct as encode outputs cycle through start/active/finish", async () => {
    console.info(`[${SUITE}:setup] driving 7-output job (1 source + 3 audio + 3 subtitle)`);
    // Drive a synthetic job with source + 3 audio + 3 subtitle outputs (7
    // total) so the multi-invocation extracting bug would be visible. Pre-fix
    // this produces a sequence like [1, 50, 66, 75, ...] as transcodeTotal
    // grew with each startTranscodeStep().
    const progressEvents: Array<{ stage: string; pct: number }> = [];

    // Mock ffmpeg task to emit synthetic mid-encode progress callbacks.
    // We need to space steps far enough apart in wall-clock time that the
    // emitProgress de-bouncer (400ms gate for non-0/non-100 pcts) lets the
    // start-of-step emits through, so the test can observe the bug.
    let step = 0;
    createFfmpegTaskMock.mockImplementation((args: string[], options: any) => {
      step += 1;
      const mpdPath = args.find((value) => value.endsWith(".mpd"));
      const subtitleOutput = args.find((value) => value.endsWith(".srt"));
      const isVideo = args.some((value) => value === "0:v:0");
      const codecType: "video" | "audio" = isVideo ? "video" : "audio";

      const promise = (async () => {
        // Fire mid-encode progress so transcodeActive ramps; then "complete".
        options?.progress?.onUpdate?.({ percent: 50 });
        options?.progress?.onUpdate?.({ percent: 100 });
        if (mpdPath) {
          await writeDashOutput(mpdPath, codecType);
        } else if (subtitleOutput) {
          await fs.mkdir(dirname(subtitleOutput), { recursive: true });
          await fs.writeFile(subtitleOutput, "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
        }
        // Space steps ≥400ms apart AFTER the final progress emit so
        // emitProgress' 400ms debouncer does not swallow the next step's
        // start-of-step emit (the regression we are asserting).
        await new Promise((r) => setTimeout(r, 420));
        return { stdout: "", stderr: "" };
      })();
      return { promise, cancel: vi.fn() };
    });
    void step; // referenced for side-effect, lint-quiet

    const { configureMediaIngestRuntime, processMediaJob } = await import("../src/mediaProcessor");
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: (bytes) => bytes,
      uploadStorageObject: vi.fn(async (_token: string, objectKey: string) => `persisted-${objectKey}`),
    });

    runFfprobeMock.mockResolvedValue({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac", tags: { language: "eng", title: "Main" } },
        { codec_type: "audio", codec_name: "aac", tags: { language: "fre", title: "FR" } },
        { codec_type: "audio", codec_name: "aac", tags: { language: "ger", title: "DE" } },
        { codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng", title: "EN" } },
        { codec_type: "subtitle", codec_name: "subrip", tags: { language: "fre", title: "FR" } },
        { codec_type: "subtitle", codec_name: "subrip", tags: { language: "ger", title: "DE" } },
      ],
      data: { format: { duration: "60" }, chapters: [] },
    });

    console.info(`[${SUITE}:run] invoking processMediaJob`);
    await processMediaJob({
      token: "token",
      userId: "user-monotonic",
      jobId: "job-monotonic",
      placementId: "placement-monotonic",
      inputPath: "/tmp/input.mp4",
      includeSource: true,
      includeFallback: false,
      includeAudio: true,
      includeSubtitles: true,
      includeChapters: false,
      onProgress: (stage, pct) => {
        progressEvents.push({ stage, pct });
      },
    });
    console.info(`[${SUITE}:run] processMediaJob complete — captured ${progressEvents.length} progress events`);

    // Sanity: at least one transcoding event must have fired across 7 outputs.
    const transcoding = progressEvents.filter((event) => event.stage === "transcoding");
    console.info(`[${SUITE}:assert] transcoding events=${transcoding.length}`);
    if (transcoding.length <= 1) {
      dumpProgressSnapshot("transcoding-events-too-few", { progressEvents, transcoding, ffmpegStepCount: step });
    }
    expect(transcoding.length).toBeGreaterThan(1);

    // Core invariant — pct must be non-decreasing across the transcoding stage.
    for (let i = 1; i < transcoding.length; i += 1) {
      const prev = transcoding[i - 1].pct;
      const current = transcoding[i].pct;
      if (current < prev) {
        dumpProgressSnapshot("monotonic-violation", {
          progressEvents,
          transcoding,
          violationIndex: i,
          prev,
          current,
          ffmpegStepCount: step,
        });
        throw new Error(
          `transcoding progress went backward at index ${i}: ${prev}% → ${current}% — full sequence: ${transcoding
            .map((e) => e.pct)
            .join(", ")}`
        );
      }
    }
    console.info(`[${SUITE}:assert] monotonic invariant held across ${transcoding.length} transcoding events`);
  }, 20_000);
});

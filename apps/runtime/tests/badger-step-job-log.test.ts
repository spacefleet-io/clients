/**
 * @req RT-LOG-01
 * engineV2 badger steps write the encode/upload tool output to runtime.log
 * and, when a step fails, the tail of that output next to the error
 * (issue #671, R9).
 */
import { describe, expect, it } from "vitest";
import {
  MAX_LINES_PER_STEP,
  PROGRESS_LINE_INTERVAL_MS,
  TAIL_LINES,
  createStepLogSink,
  isProgressLine,
  runWithStepLog,
} from "../src/modules/badger/steps/jobLog";

const makeSink = () => {
  const info: string[] = [];
  const error: string[] = [];
  let t = 1_000_000;
  const sink = createStepLogSink({
    jobId: "job-1",
    stepKind: "transcode",
    now: () => t,
    sink: {
      info: (m: unknown) => void info.push(String(m)),
      error: (m: unknown) => void error.push(String(m)),
    } as Pick<Console, "info" | "error">,
  });
  return { sink, info, error, advance: (ms: number) => void (t += ms) };
};

describe("badger step job log", () => {
  it("writes lines with the job/step prefix and drops blank lines", () => {
    const { sink, info } = makeSink();
    sink.onLog("Stream #0:0 -> #0:0 (h264 -> hevc)\n");
    sink.onLog("   ");
    console.info("[test] lines", info);
    expect(info).toEqual(["[runtime][job job-1][transcode] Stream #0:0 -> #0:0 (h264 -> hevc)"]);
  });

  it("drops ffmpeg 'Opening … for writing' lines from the log and the tail, keeps the rest", () => {
    const { sink, info } = makeSink();
    for (let i = 0; i < MAX_LINES_PER_STEP + 50; i++) {
      sink.onLog(`[dash @ 0x5581] Opening '/jobs/j/video-source/seg-${String(i).padStart(5, "0")}.m4s.tmp' for writing`);
      sink.onLog(`[dash @ 0x5581] Opening '/jobs/j/video-source/stream.mpd.tmp' for writing\n`);
    }
    sink.onLog("[aac @ 0x55] Too many bits 8832 > 6144 per frame requested");
    sink.onLog("Output file is opening 'x' slowly"); // not the muxer line
    console.info("[test] written after 2100 Opening lines + 2 real lines", info);
    if (info.length !== 2) console.error("[test] tail", sink.tail());
    expect(info).toEqual([
      "[runtime][job job-1][transcode] [aac @ 0x55] Too many bits 8832 > 6144 per frame requested",
      "[runtime][job job-1][transcode] Output file is opening 'x' slowly",
    ]);
    expect(info.some((l) => l.includes("log cap"))).toBe(false);
    expect(sink.tail()).toEqual(["[aac @ 0x55] Too many bits 8832 > 6144 per frame requested", "Output file is opening 'x' slowly"]);
  });

  it("recognises ffmpeg and upload progress lines", () => {
    for (const l of ["frame=  120 fps=30", "size=  1024kB time=00:00:04", "upload 12.3 MiB/s eta 40s", "upload 57%"]) {
      expect(isProgressLine(l), l).toBe(true);
    }
    for (const l of ["Hardware encoder failed, falling back to software", "Error opening input file"]) {
      expect(isProgressLine(l), l).toBe(false);
    }
  });

  it("rate-limits progress lines to one per interval but keeps them in the tail", () => {
    const { sink, info, advance } = makeSink();
    for (let i = 0; i < 50; i++) {
      sink.onLog(`frame= ${i} fps=30`);
      advance(100);
    }
    console.info("[test] progress lines written after 5 s of 100 ms ticks", info.length);
    expect(info).toHaveLength(1);
    advance(PROGRESS_LINE_INTERVAL_MS);
    sink.onLog("frame= 999 fps=30");
    expect(info).toHaveLength(2);
    expect(sink.tail()).toHaveLength(TAIL_LINES);
    expect(sink.tail().at(-1)).toBe("frame= 999 fps=30");
  });

  it("caps written lines per step and logs the cap once", () => {
    const { sink, info } = makeSink();
    for (let i = 0; i < MAX_LINES_PER_STEP + 200; i++) sink.onLog(`warning ${i}`);
    const capNotices = info.filter((l) => l.includes("log cap"));
    console.info("[test] written", info.length, "cap notices", capNotices.length);
    expect(info).toHaveLength(MAX_LINES_PER_STEP + 1);
    expect(capNotices).toHaveLength(1);
    expect(sink.tail()).toHaveLength(TAIL_LINES);
    expect(sink.tail().at(-1)).toBe(`warning ${MAX_LINES_PER_STEP + 199}`);
  });

  it("logs the failure with the output tail, including lines past the cap", () => {
    const { sink, error } = makeSink();
    for (let i = 0; i < MAX_LINES_PER_STEP + 5; i++) sink.onLog(`line ${i}`);
    sink.logFailure(new Error("ffmpeg exited 1"));
    console.error("[test] failure log", error[0]?.slice(0, 300));
    expect(error).toHaveLength(1);
    expect(error[0]).toContain("[runtime][job job-1][transcode] failed: ffmpeg exited 1");
    expect(error[0]).toContain(`line ${MAX_LINES_PER_STEP + 4}`);
    expect(error[0]).toContain("earlier lines were not logged");
  });

  it("runWithStepLog logs a failure and rethrows unchanged; skips abort", async () => {
    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      const boom = new Error("upload 413");
      const live = { job: { jobId: "job-2" }, signal: new AbortController().signal };
      await expect(
        runWithStepLog(live, "upload", async (onLog) => {
          onLog("PUT part 3 failed");
          throw boom;
        })
      ).rejects.toBe(boom);
      expect(errors).toHaveLength(1);
      expect(String(errors[0]![0])).toContain("[runtime][job job-2][upload] failed: upload 413");
      expect(String(errors[0]![0])).toContain("PUT part 3 failed");

      const ac = new AbortController();
      ac.abort();
      await expect(
        runWithStepLog({ job: { jobId: "job-3" }, signal: ac.signal }, "upload", async () => {
          throw new Error("CANCELLED");
        })
      ).rejects.toThrow("CANCELLED");
      expect(errors).toHaveLength(1);
    } finally {
      console.error = orig;
    }
  });
});

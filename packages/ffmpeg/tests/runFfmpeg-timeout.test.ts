/**
 * runFfmpeg `timeoutMs` — ultimate-stress F2 added short hardware-encoder
 * probes that must not hang the runtime if a driver wedges. The child is
 * killed and the promise rejects with a "timed out" error.
 */

import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { requireMediaBinary } from "@space/media-deps";
import { runFfmpeg } from "../src/index";

const ffmpegAvailable = requireMediaBinary("ffmpeg", (() => {
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    return true;
  } catch {
    console.info("[runffmpeg-timeout:detect] ffmpeg NOT on PATH — timeout tests will skip");
    return false;
  }
})());

describe.skipIf(!ffmpegAvailable)("runFfmpeg timeoutMs", () => {
  it("kills a still-running ffmpeg and rejects with a timeout error", async () => {
    const started = Date.now();
    // `-re` paces the lavfi source in real time, so a 30s clip runs ~30s.
    const run = runFfmpeg(
      ["-re", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=30", "-f", "null", "-"],
      { progress: { enabled: false }, timeoutMs: 400 }
    );
    await expect(run).rejects.toThrow(/timed out after 400ms/);
    const elapsed = Date.now() - started;
    console.info(`[runffmpeg-timeout:kill] rejected after ${elapsed}ms`);
    expect(elapsed).toBeLessThan(10_000);
  });

  it("does not interfere with a run that finishes before the timeout", async () => {
    const res = await runFfmpeg(
      ["-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=0.2", "-f", "null", "-"],
      { progress: { enabled: false }, timeoutMs: 20_000 }
    );
    expect(res.code).toBe(0);
  });
});

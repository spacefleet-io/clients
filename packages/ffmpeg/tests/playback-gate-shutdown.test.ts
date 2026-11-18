/**
 * @bugfix transcode-not-gated-during-playback @regression-proof
 *
 * Runtime shutdown while ffmpeg is frozen: the gate's shutdown() thaws every
 * encoder, so a SIGTERM (Bun's default kill) is delivered and the encoder
 * ends cleanly. Own file: shutdown() is permanent for the process.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMediaBinary, syntheticYuvInput, writeSyntheticYuv } from "@space/media-deps";
import { createFfmpegTask, encodePlaybackGate } from "../src/index";

const ffmpegAvailable = requireMediaBinary("ffmpeg", (() => {
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stateOf = (pid: number): string => {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
};

let clipDir = "";
beforeAll(() => {
  clipDir = mkdtempSync(join(tmpdir(), "sf-gate-shutdown-"));
  writeSyntheticYuv(join(clipDir, "clip.yuv"), { width: 640, height: 360, frames: 50 });
});
afterAll(() => rmSync(clipDir, { recursive: true, force: true }));

describe.skipIf(process.platform !== "linux" || !ffmpegAvailable)("shutdown while ffmpeg is frozen @bugfix @regression-proof", () => {
  it("shutdown thaws the frozen encoder; it can then be terminated cleanly", async () => {
    let pid: number | undefined;
    const task = createFfmpegTask(
      [...syntheticYuvInput(join(clipDir, "clip.yuv"), { width: 640, height: 360, rate: 25, seconds: 120 }), "-c:v", "libx264", "-threads", "1", "-f", "null", "-"],
      {
        playbackGated: true,
        progress: { enabled: false },
        onSpawn: (child) => {
          pid = child.pid;
        },
      }
    );
    await sleep(800);
    encodePlaybackGate.setPolicy("pause", { reason: "test" });
    await sleep(300);
    expect(stateOf(pid!)).toBe("T");

    encodePlaybackGate.shutdown();
    await sleep(300);
    console.info(`[playback-gate-shutdown] state after shutdown = ${stateOf(pid!)}`);
    expect(stateOf(pid!)).not.toBe("T");

    const cancelledAt = Date.now();
    task.cancel();
    await task.promise.catch(() => {});
    expect(Date.now() - cancelledAt).toBeLessThan(5000);
  }, 30_000);
});

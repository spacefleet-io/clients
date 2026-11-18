/**
 * A missing ffmpeg/ffprobe binary must reject, not hang.
 *
 * spawnCommand's Node path only listened for `close`. When the binary does not
 * exist, child_process emits `error` (ENOENT) and nobody handled it: the error
 * surfaced as an uncaught exception and the awaiting promise never settled, so
 * a runtime job on a host without ffprobe hung forever. Seen in CI (#25): the
 * runtime suite's HMR-resilience tests timed out at 30s on a runner image
 * without ffmpeg.
 *
 * @bugfix @regression-proof
 */

import { describe, expect, it } from "vitest";
import { runFfmpeg, runFfprobe } from "../src/index";

const SUITE = "spawn-missing-binary";
const MISSING = "/nonexistent/sf-missing-binary";

describe("spawnCommand with a missing binary", () => {
  it("@bugfix @regression-proof runFfprobe rejects with ENOENT instead of hanging", async () => {
    const started = Date.now();
    console.info(`[${SUITE}:ffprobe] spawning ${MISSING}`);
    const run = runFfprobe(["-version"], { ffprobePath: MISSING });
    await expect(run).rejects.toThrow(/ENOENT/);
    console.info(`[${SUITE}:ffprobe] rejected after ${Date.now() - started}ms`);
  }, 5_000);

  it("@bugfix @regression-proof runFfmpeg rejects with ENOENT instead of hanging", async () => {
    const started = Date.now();
    console.info(`[${SUITE}:ffmpeg] spawning ${MISSING}`);
    const run = runFfmpeg(["-version"], { ffmpegPath: MISSING, progress: { enabled: false } });
    await expect(run).rejects.toThrow(/ENOENT/);
    console.info(`[${SUITE}:ffmpeg] rejected after ${Date.now() - started}ms`);
  }, 5_000);
});

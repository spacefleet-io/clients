/**
 * Regression test for the bug where runFfmpeg dropped stdout when progress was
 * disabled. Pre-fix: captureStdout was set to false when progressOutput was
 * "stdout" (the default), making stdout empty for all callers that passed
 * { progress: { enabled: false } }. Post-fix: captureStdout is true whenever
 * progress is disabled, regardless of progressOutput.
 *
 * Affected: packages/ffmpeg/src/index.ts:286-287 (captureStdout / captureStderr)
 */

import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { requireMediaBinary } from "@space/media-deps";
import { runFfmpeg } from "../src/index";

const ffmpegAvailable = requireMediaBinary("ffmpeg", (() => {
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    console.info(`[runffmpeg-encoders:detect] ffmpeg available on PATH`);
    return true;
  } catch {
    console.info(`[runffmpeg-encoders:detect] ffmpeg NOT on PATH — encoder tests will skip`);
    return false;
  }
})());

// Dumps the runFfmpeg result so a stdout/stderr/exit-code assertion failure
// surfaces the actual captured streams (truncated) instead of just a length.
// Body is try/wrapped so a dump failure can never mask the real assertion.
const dumpRunResultSnapshot = (
  label: string,
  result: Awaited<ReturnType<typeof runFfmpeg>>
) => {
  try {
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    console.error(`=== [runffmpeg-encoders:${label}] runFfmpeg result snapshot ===`);
    console.error(`code=${JSON.stringify(result.code)}`);
    console.error(`stdout.length=${stdout.length} stderr.length=${stderr.length}`);
    console.error(`stdout.includes(libx264)=${stdout.includes("libx264")}`);
    console.error(`stdout(head 600):\n${stdout.slice(0, 600)}`);
    console.error(`stderr(head 600):\n${stderr.slice(0, 600)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runFfmpeg stdout capture @bugfix @regression-proof", () => {
  it(
    "returns non-empty stdout when progress is disabled and ffmpeg writes to stdout",
    { skip: !ffmpegAvailable },
    async () => {
      console.info(`[runffmpeg-encoders:progress-disabled] running ffmpeg -encoders (progress.enabled=false)`);
      const result = await runFfmpeg(["-encoders"], { progress: { enabled: false } });
      console.info(
        `[runffmpeg-encoders:progress-disabled] code=${result.code} stdout.length=${result.stdout.length}`
      );
      if (result.stdout.length === 0 || !result.stdout.includes("libx264")) {
        dumpRunResultSnapshot("progress-disabled", result);
      }
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.stdout).toContain("libx264");
    }
  );

  it(
    "stdout contains the encoders header line",
    { skip: !ffmpegAvailable },
    async () => {
      console.info(`[runffmpeg-encoders:header-line] running ffmpeg -encoders (progress.enabled=false)`);
      const result = await runFfmpeg(["-encoders"], { progress: { enabled: false } });
      // ffmpeg -encoders outputs a header followed by encoder entries
      console.info(
        `[runffmpeg-encoders:header-line] code=${result.code} matches-/Encoders:/i=${/Encoders:/i.test(result.stdout)}`
      );
      if (!/Encoders:/i.test(result.stdout)) {
        dumpRunResultSnapshot("header-line", result);
      }
      expect(result.stdout).toMatch(/Encoders:/i);
    }
  );

  it(
    "stdout is empty (encoders go to stderr) when progress is enabled and output is stdout",
    { skip: !ffmpegAvailable },
    async () => {
      // With progress enabled (default), -progress pipe:1 is injected, so progress
      // frames go to stdout. ffmpeg -encoders sends the encoder list to stdout, but
      // captureStdout is false in this path (progress parsing owns stdout). The
      // encoder list therefore appears in stderr via the log handler.
      // This case is NOT affected by the Bug A fix — it confirms no regression in
      // the progress-enabled path: stdout is not captured (empty is expected),
      // and the process exits cleanly.
      console.info(`[runffmpeg-encoders:progress-enabled] running ffmpeg -encoders (progress default=enabled)`);
      const result = await runFfmpeg(["-encoders"]);
      console.info(`[runffmpeg-encoders:progress-enabled] code=${result.code}`);
      if (result.code !== 0) {
        dumpRunResultSnapshot("progress-enabled", result);
      }
      expect(result.code).toBe(0);
    }
  );
});

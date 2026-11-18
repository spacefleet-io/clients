/**
 * @bugfix mpv subtitle pipeline reports zero tracks despite runtime producing
 *   subtitleTracks (TaskList #31) — root cause was that the checked-in
 *   Saltmarsh fixtures preserve subtitle stream metadata but their
 *   subtitle packets are empty (TAG:DURATION=00:00:00). ffmpeg extraction
 *   yields 0-byte SRT files, which mpv refuses to load with "Can not open
 *   external file".
 * @regression-proof Verifies prepareSaltmarshFixture(...) produces a
 *   remuxed MKV from which ffmpeg can extract a non-empty SRT for
 *   stream 0:s:0 — the pre-fix invariant ("ffmpeg srt extraction yields
 *   0 bytes from the source fixture") is asserted explicitly first so the
 *   regression cannot silently come back if the fixture is regenerated
 *   later, and the post-fix invariant ("ffmpeg yields >0 bytes from the
 *   prepared fixture") gates green.
 */
import { describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireMediaBinary } from "@space/media-deps";
import { prepareSaltmarshFixture } from "./_helpers/saltmarshFixture";

const FIXTURE_ROOT = join(
  process.cwd(),
  "..",
  "..",
  "..",
  "packages",
  "ingest-core",
  "fixtures",
  "ingest",
  "video"
);
const FIXTURE_EP1 = "Saltmarsh - S01E01 - Low Tide.mkv";

const ffmpegAvailable = (() => {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

requireMediaBinary("ffmpeg", ffmpegAvailable);
const fixtureExists = existsSync(join(FIXTURE_ROOT, FIXTURE_EP1));
console.info(
  `[saltmarsh-fixture-helper:setup] ffmpegAvailable=${ffmpegAvailable} fixtureExists=${fixtureExists} fixtureRoot=${FIXTURE_ROOT} ep1=${FIXTURE_EP1}`,
);

const extractFirstSubtitleSize = (mkvPath: string): number => {
  const tmpDir = mkdtempSync(join(tmpdir(), "sf-fixture-extract-"));
  try {
    const outPath = join(tmpDir, "sub.srt");
    console.info(`[saltmarsh-fixture-helper:extract] running ffmpeg -map 0:s:0 on ${mkvPath} -> ${outPath}`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", mkvPath, "-map", "0:s:0", "-c:s", "srt", outPath], {
      stdio: "ignore",
      timeout: 30_000,
    });
    const size = existsSync(outPath) ? statSync(outPath).size : 0;
    console.info(`[saltmarsh-fixture-helper:extract] extracted SRT size=${size} bytes (exists=${existsSync(outPath)})`);
    return size;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

// On assertion failure, dump the file paths + extracted sizes so the
// fixture-regeneration drift (the documented regression trigger) is visible.
const dumpFixtureSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [saltmarsh-fixture-helper:${label}] snapshot ===`);
    console.error(`ffmpegAvailable=${ffmpegAvailable} fixtureExists=${fixtureExists}`);
    console.error(`context: ${JSON.stringify(ctx, null, 2)}`);
    console.error(`=== [saltmarsh-fixture-helper:${label}] end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("prepareSaltmarshFixture (regression)", () => {
  if (!ffmpegAvailable || !fixtureExists) {
    it.skip("requires ffmpeg + Saltmarsh EP1 fixture", () => {});
    return;
  }

  it(
    "@bugfix @regression-proof source fixture's subtitle stream extracts as 0 bytes (precondition for the bug)",
    () => {
      // This guards the regression: if the checked-in fixture is ever
      // regenerated to contain real subtitle packets, this assertion will
      // start failing and the helper can be retired. Until then, this
      // verifies the bug's environmental precondition.
      const sourcePath = join(FIXTURE_ROOT, FIXTURE_EP1);
      console.info(`[saltmarsh-fixture-helper:precondition] checking source fixture subtitle packets at ${sourcePath}`);
      const sourceSubSize = extractFirstSubtitleSize(sourcePath);
      if (sourceSubSize !== 0) {
        dumpFixtureSnapshot("precondition-nonzero-source-sub", { sourcePath, sourceSubSize });
      }
      expect(sourceSubSize, "source fixture should have empty subtitle packets").toBe(0);
    },
    60_000
  );

  it(
    "@bugfix @regression-proof prepareSaltmarshFixture produces a fixture whose subtitle streams ffmpeg can extract",
    async () => {
      const sourcePath = join(FIXTURE_ROOT, FIXTURE_EP1);
      console.info(`[saltmarsh-fixture-helper:prepare] preparing remuxed fixture from ${sourcePath}`);
      const preparedPath = await prepareSaltmarshFixture(sourcePath);
      console.info(`[saltmarsh-fixture-helper:prepare] prepared fixture at ${preparedPath}`);
      try {
        const preparedSubSize = extractFirstSubtitleSize(preparedPath);
        if (!(preparedSubSize > 0)) {
          dumpFixtureSnapshot("prepared-zero-byte-sub", { sourcePath, preparedPath, preparedSubSize });
        }
        expect(
          preparedSubSize,
          "prepared fixture's first subtitle stream should extract as a non-empty SRT"
        ).toBeGreaterThan(0);
      } finally {
        // Helper writes into a tmpdir-rooted directory; remove the parent.
        const parent = preparedPath.replace(/\/[^/]+$/u, "");
        rmSync(parent, { recursive: true, force: true });
      }
    },
    60_000
  );
});

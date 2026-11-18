import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CONTROLLER_PATH = resolve(
  process.cwd(),
  "src/renderer/src/components/MediaPlaybackController.tsx",
);
console.info(`[media-playback-controller-resume-race:setup] reading controller source from ${CONTROLLER_PATH}`);
const source = readFileSync(CONTROLLER_PATH, "utf8");
console.info(`[media-playback-controller-resume-race:setup] source loaded, length=${source.length} chars`);

// On assertion failure, dump the key index positions inside run() (await vs ref
// read ordering is the whole point of the fix) so a regression is diagnosable.
const dumpResumeRaceSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [media-playback-controller-resume-race:${label}] snapshot ===`);
    console.error(
      `global indexes: awaitDatasetReady("playback")=${source.indexOf('awaitDatasetReady("playback")')} getSharedSettingRef.current(=${source.indexOf("getSharedSettingRef.current(")} Promise.race(=${source.indexOf("Promise.race(")}`,
    );
    for (const [k, v] of Object.entries(ctx)) {
      const str = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      const trimmed = str.length > 1200 ? `${str.slice(0, 1200)}…(truncated ${str.length} chars)` : str;
      console.error(`${k}: ${trimmed}`);
    }
    console.error(`=== [media-playback-controller-resume-race:${label}] end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

/**
 * @bugfix evening-cold-start-resume-race
 * @regression-proof
 *
 * Pre-fix shape: a `useMemo` `episodeResumeProgress` captured
 * `getSharedSetting` at render time; `getResumeCandidate` (a
 * `useCallback`) closed over that memo. When the controller's `run()`
 * awaited `awaitDatasetReady("playback")`, the playback dataset hydrated
 * AFTER the closure was created, but `getResumeCandidate` still read the
 * STALE empty-settings value → `sourceProgress` was null → mpv launched
 * from position 0 instead of the saved resume.
 *
 * Post-fix shape: a `getSharedSettingRef` is updated on every render,
 * and `run()` reads `getSharedSettingRef.current(`episode_resume_v1:…`)`
 * AFTER the await — guaranteeing the fresh post-hydration value.
 *
 * The fix is verified at the source level because the failure mode is
 * a React closure-capture timing race inside a useCallback dep array;
 * a unit-level Vitest harness cannot reliably reproduce the exact
 * pre-hydration→post-hydration render boundary without re-encoding the
 * controller's internal effect graph in the test.
 */
describe("@bugfix @regression-proof MediaPlaybackController resume-race after awaitDatasetReady", () => {
  it("declares a getSharedSettingRef ref that is updated on every render", () => {
    console.info("[media-playback-controller-resume-race:ref-decl] asserting getSharedSettingRef declaration + per-render update");
    const declOk = /const\s+getSharedSettingRef\s*=\s*useRef\(getSharedSetting\)/.test(source);
    const updateOk = /getSharedSettingRef\.current\s*=\s*getSharedSetting/.test(source);
    console.info(`[media-playback-controller-resume-race:ref-decl] declOk=${declOk} updateOk=${updateOk}`);
    if (!declOk || !updateOk) {
      dumpResumeRaceSnapshot("ref-decl-missing", { declOk, updateOk });
    }
    expect(source).toMatch(/const\s+getSharedSettingRef\s*=\s*useRef\(getSharedSetting\)/);
    expect(source).toMatch(/getSharedSettingRef\.current\s*=\s*getSharedSetting/);
  });

  it("does NOT use a useMemo-derived episodeResumeProgress (the stale-closure source)", () => {
    console.info("[media-playback-controller-resume-race:no-stale-memo] asserting episodeResumeProgress is absent");
    if (/episodeResumeProgress/.test(source)) {
      dumpResumeRaceSnapshot("stale-memo-still-present", {
        note: "episodeResumeProgress reappeared — the stale-closure source is back",
      });
    }
    expect(source).not.toMatch(/episodeResumeProgress/);
  });

  it("reads episode_resume_v1 via getSharedSettingRef.current AFTER awaitDatasetReady('playback')", () => {
    console.info("[media-playback-controller-resume-race:ref-after-await] isolating run() body + checking await/ref ordering");
    const runBodyMatch = source.match(
      /const run = async \(\) => \{([\s\S]*?)\n\s{4}\};\s*\n\s+void run\(\);/
    );
    if (!runBodyMatch) {
      dumpResumeRaceSnapshot("run-body-not-found", { note: "run() body regex did not match" });
    }
    expect(runBodyMatch).not.toBeNull();
    const runBody = runBodyMatch?.[1] ?? "";

    const awaitIdx = runBody.indexOf("awaitDatasetReady(\"playback\")");
    const refReadIdx = runBody.indexOf("getSharedSettingRef.current(");
    console.info(`[media-playback-controller-resume-race:ref-after-await] awaitIdx=${awaitIdx} refReadIdx=${refReadIdx} runBody.length=${runBody.length}`);
    if (awaitIdx < 0 || refReadIdx < 0 || refReadIdx <= awaitIdx) {
      dumpResumeRaceSnapshot("ref-read-not-after-await", { awaitIdx, refReadIdx, runBody });
    }
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(refReadIdx).toBeGreaterThan(-1);
    // The ref read must come AFTER the awaitDatasetReady call — that's
    // the whole point of the fix.
    expect(refReadIdx).toBeGreaterThan(awaitIdx);
    // The episode id is resolved from the `episodeId` PROP (not the stale
    // `activeEpisodeId` state, which lags by a render on a cold-start play —
    // it's null when run() reads it), then the ref read uses it for the key.
    // @bugfix evening-cold-start-resume-race (episode-id half)
    expect(runBody).toMatch(/const\s+resumeEpisodeId\s*=\s*episodeId\s*\?\?\s*null/);
    expect(runBody).toMatch(/getSharedSettingRef\.current\(`episode_resume_v1:\$\{resumeEpisodeId\}`\)/);
  });

  it("races awaitDatasetReady('playback') against a 5s timeout and logs playback-await-timeout on expiry", () => {
    // The race exists so a broken sync stream cannot wedge Play forever.
    console.info("[media-playback-controller-resume-race:race-timeout] asserting Promise.race + 5000ms timeout + playback-await-timeout log");
    const checks = {
      race: /Promise\.race\(\s*\[\s*awaitDatasetReady\("playback"\)/.test(source),
      timeout5s: /setTimeout\([^,]+,\s*5000\)/.test(source),
      timeoutLog: /playback-await-timeout/.test(source),
    };
    console.info(`[media-playback-controller-resume-race:race-timeout] checks=${JSON.stringify(checks)}`);
    if (!checks.race || !checks.timeout5s || !checks.timeoutLog) {
      dumpResumeRaceSnapshot("race-timeout-missing", { checks });
    }
    expect(source).toMatch(/Promise\.race\(\s*\[\s*awaitDatasetReady\("playback"\)/);
    expect(source).toMatch(/setTimeout\([^,]+,\s*5000\)/);
    expect(source).toMatch(/playback-await-timeout/);
  });

  it("getResumeCandidate accepts an explicit progressOverride argument and no longer depends on episodeResumeProgress", () => {
    // The callback signature must take the details, the resolved progress, AND
    // the explicit episode id — so it never reads the stale closure activeEpisodeId.
    console.info("[media-playback-controller-resume-race:getResumeCandidate-sig] asserting 3-arg signature + override-based sourceProgress");
    const sigRe =
      /getResumeCandidate\s*=\s*useCallback\(\s*\(\s*details:\s*MediaDetails\s*,\s*progressOverride:\s*number\s*\|\s*null\s*,\s*episodeIdForResume:\s*string\s*\|\s*null\s*\)/;
    if (!sigRe.test(source)) {
      dumpResumeRaceSnapshot("getResumeCandidate-signature-mismatch", { pattern: String(sigRe) });
    }
    expect(source).toMatch(sigRe);
    // For an episode the override (its episode_resume_v1 progress) is the only
    // source; only a movie falls back to details.progressPct.
    expect(source).toMatch(/sourceProgress\s*=\s*episodeIdForResume\s*\?\s*progressOverride/);
    // The dep array must NOT mention the (now-removed) episodeResumeProgress.
    console.info("[media-playback-controller-resume-race:getResumeCandidate] checking dep array for stale episodeResumeProgress");
    const depMatch = source.match(/getResumeCandidate\s*=\s*useCallback\([\s\S]*?\[(.*?)\]\s*\)\s*;/);
    if (!depMatch) {
      dumpResumeRaceSnapshot("getResumeCandidate-dep-array-not-found", {
        note: "useCallback dep-array regex for getResumeCandidate did not match",
      });
    }
    expect(depMatch).not.toBeNull();
    const deps = depMatch?.[1] ?? "";
    console.info(`[media-playback-controller-resume-race:getResumeCandidate] dep array=[${deps}]`);
    if (/episodeResumeProgress/.test(deps)) {
      dumpResumeRaceSnapshot("getResumeCandidate-stale-dep", { deps });
    }
    expect(deps).not.toMatch(/episodeResumeProgress/);
  });

  it("after the await race, run() re-checks the active flag before proceeding", () => {
    const runBodyMatch = source.match(
      /const run = async \(\) => \{([\s\S]*?)\n\s{4}\};\s*\n\s+void run\(\);/
    );
    if (!runBodyMatch) {
      dumpResumeRaceSnapshot("run-body-not-found-active-recheck", { note: "run() body regex did not match" });
    }
    const runBody = runBodyMatch?.[1] ?? "";
    // Between the Promise.race and setLaunchProgressValue(40), there
    // must still be an `if (!active) return;` guard.
    console.info("[media-playback-controller-resume-race:active-recheck] checking !active guard between race and progress(40)");
    const raceIdx = runBody.indexOf("Promise.race(");
    const progress40Idx = runBody.indexOf("setLaunchProgressValue(40)");
    console.info(`[media-playback-controller-resume-race:active-recheck] raceIdx=${raceIdx} progress40Idx=${progress40Idx}`);
    if (raceIdx < 0 || progress40Idx <= raceIdx) {
      dumpResumeRaceSnapshot("active-recheck-bad-ordering", { raceIdx, progress40Idx, runBody });
    }
    expect(raceIdx).toBeGreaterThan(-1);
    expect(progress40Idx).toBeGreaterThan(raceIdx);
    const between = runBody.slice(raceIdx, progress40Idx);
    if (!/if\s*\(!active\)\s*return/.test(between)) {
      dumpResumeRaceSnapshot("active-recheck-guard-missing", { between });
    }
    expect(between).toMatch(/if\s*\(!active\)\s*return/);
  });
});

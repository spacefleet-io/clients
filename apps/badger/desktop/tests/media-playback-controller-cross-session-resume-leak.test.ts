import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CONTROLLER_PATH = resolve(
  process.cwd(),
  "src/renderer/src/components/MediaPlaybackController.tsx",
);
console.info(`[media-playback-controller-cross-session-resume-leak:setup] reading controller source from ${CONTROLLER_PATH}`);
const source = readFileSync(CONTROLLER_PATH, "utf8");
console.info(
  `[media-playback-controller-cross-session-resume-leak:setup] source loaded, length=${source.length} chars, prepareEpisodeStart occurrences=${(source.match(/prepareEpisodeStart/g) ?? []).length}`,
);

// On assertion failure, dump the matched block (or its absence) so a refactor
// that strips the engine-ref reset is diagnosable from CI logs.
const dumpResumeLeakSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [media-playback-controller-cross-session-resume-leak:${label}] snapshot ===`);
    console.error(
      `counts: prepareEpisodeStart=${(source.match(/prepareEpisodeStart/g) ?? []).length} startFrom=${(source.match(/startFrom/g) ?? []).length} clearResumeTarget=${(source.match(/clearResumeTarget/g) ?? []).length}`,
    );
    for (const [k, v] of Object.entries(ctx)) {
      const str = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      const trimmed = str.length > 1200 ? `${str.slice(0, 1200)}…(truncated ${str.length} chars)` : str;
      console.error(`${k}: ${trimmed}`);
    }
    console.error(`=== [media-playback-controller-cross-session-resume-leak:${label}] end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

/**
 * @bugfix cross-session-resume-refs-leak
 * @regression-proof
 *
 * Symptom observed in live use: a Play click on an episode whose saved
 * progress is BELOW the resume-prompt floor (so the controller correctly
 * chooses the direct-launch path, no prompt) launched mpv at the position
 * of a prior in-session playback rather than at zero. The persisted
 * progress on close then reflected the inherited position, masking the
 * leak as a "stale UI" complaint.
 *
 * Why the leak exists: the engine's init effect picks the launch position
 * from `seekTargetRef.current ?? lastKnownTimeRef.current`
 * (useMpvPlaybackEngine.ts:2053). The poll loop continuously writes
 * `lastKnownTimeRef.current = displayTime` during playback
 * (useMpvPlaybackEngine.ts:2550). Neither ref is cleared on `process_gone`
 * (mpv exit) or on media/episode change. The only resets are explicit
 * `prepareEpisodeStart(0, true)` / `clearResumeTarget()` calls from the
 * controller's next-episode and restart paths.
 *
 * The cold-start race fixed in commit 26d27740 ("episode-id half") only
 * covered the same-session, same-mount controller-state read race. THIS
 * regression is the cross-session engine-ref leak — different code path,
 * same family of "stale launch position" symptom.
 *
 * Post-fix invariant: the controller's run() direct-launch branch (chosen
 * when `launchPlan.showResumePrompt` is false) calls
 * `playback.prepareEpisodeStart?.(0, true)` before `setIsLaunching(true)`.
 * That call zeroes both engine refs (useMpvPlaybackEngine.ts:2994-3000),
 * so the init effect launches mpv from 0 regardless of what the prior
 * session left behind. Mirrors the existing next-episode reset around
 * MediaPlaybackController.tsx:472 and the restart path at lines 887/893.
 *
 * Why source-level not behavioral: the failure mode is the engine's init
 * effect reading session-scoped refs after a controller path that does
 * not own those refs. A behavioral harness would have to either (a) host
 * the real engine and simulate two mpv sessions worth of poll-loop ref
 * writes, or (b) mock the engine and re-encode the leak as a test fixture
 * — at which point the test no longer proves the production refs are
 * cleared. Pinning the controller's call to `prepareEpisodeStart(0, true)`
 * structurally guarantees the reset happens, paired with the engine's
 * own unit coverage of `prepareEpisodeStart`'s ref-write contract.
 */
describe("@bugfix @regression-proof MediaPlaybackController cross-session engine-resume-refs leak", () => {
  it("directLaunch branch calls prepareEpisodeStart(startAt, true), startAt 0 unless auto-resuming, before setIsLaunching(true)", () => {
    // Isolate the directLaunch branch: from its trace log down to the
    // setIsLaunching(true) that hands control to the engine's init effect.
    console.info("[media-playback-controller-cross-session-resume-leak:directLaunch] isolating directLaunch branch");
    const directLaunchBlockMatch = source.match(
      /playTraceLog\.debug\(\{ requestKey \}, "Controller\.run:directLaunch"\);([\s\S]*?)setIsLaunching\(true\);/,
    );
    if (!directLaunchBlockMatch) {
      dumpResumeLeakSnapshot("directLaunch-block-not-found", {
        note: "regex from playTraceLog directLaunch to setIsLaunching(true) did not match",
      });
    }
    expect(directLaunchBlockMatch, "directLaunch branch not found in MediaPlaybackController.tsx").not.toBeNull();
    const directLaunchBlock = directLaunchBlockMatch?.[1] ?? "";
    console.info(`[media-playback-controller-cross-session-resume-leak:directLaunch] block length=${directLaunchBlock.length} chars`);
    // Since the HEVC hand-off (ec5794acc) the reset passes `startAt`: 0 on a fresh Play, the resume position only on an
    // auto-resume hand-off. The reset itself must stay, and `startAt` must stay 0 whenever there is no auto-resume.
    const resetRe = /playback\.prepareEpisodeStart\?\.\(\s*(?:0|startAt)\s*,\s*true\s*\)/;
    const startAtRe = /const startAt = autoResume \? \(nextResume \?\? 0\) : 0;/;
    if (!resetRe.test(directLaunchBlock) || !startAtRe.test(source)) {
      dumpResumeLeakSnapshot("directLaunch-missing-prepareEpisodeStart", { directLaunchBlock });
    }

    expect(
      directLaunchBlock,
      "directLaunch branch MUST reset the engine's resume refs via playback.prepareEpisodeStart(startAt, true) before setIsLaunching(true). Without this, the engine's init effect reads seekTargetRef/lastKnownTimeRef left over from a prior playback session and launches mpv at the previous position. Mirrors the next-episode reset.",
    ).toMatch(resetRe);
    expect(source, "startAt is 0 unless the launch auto-resumes").toMatch(startAtRe);
  });

  it("resumeAction (post-prompt Resume) still drives the engine via startFrom which sets the refs", () => {
    // Cross-check: the prompt path does NOT need prepareEpisodeStart because
    // the user's Resume click calls playback.startFrom(time, true) with `time` defaulting to resumeCandidateTime,
    // and startFrom writes both refs.
    console.info("[media-playback-controller-cross-session-resume-leak:resumeAction] asserting startFrom(time = resumeCandidateTime, true)");
    const resumeRe =
      /resumeAction = useAsyncAction\(async \(time: number \| null = resumeCandidateTime\) => \{[\s\S]*?playback\.startFrom\(time,\s*true\)/;
    if (!resumeRe.test(source)) {
      dumpResumeLeakSnapshot("resumeAction-missing-startFrom", {
        note: "resumeAction's playback.startFrom(time, true) with time = resumeCandidateTime not found in source",
      });
    }
    expect(source).toMatch(resumeRe);
  });

  it("restartAction keeps its existing reset triple (clearResumeTarget + prepareEpisodeStart(0,true) + startFrom(0,true))", () => {
    // Pins the already-correct Start-Over path so a future refactor doesn't
    // strip the reset while assuming \"prepareEpisodeStart now happens elsewhere\".
    // Anchor on the next sibling declaration so the non-greedy body match
    // does not stop at an inner `});` from a nested flushSync/callback.
    console.info("[media-playback-controller-cross-session-resume-leak:restartAction] isolating restartAction body");
    const restartActionMatch = source.match(
      /restartAction\s*=\s*useAsyncAction\(async \(\) => \{([\s\S]*?)\}\);\s*const\s+handleRestart\b/,
    );
    if (!restartActionMatch) {
      dumpResumeLeakSnapshot("restartAction-block-not-found", {
        note: "regex for restartAction useAsyncAction body did not match",
      });
    }
    expect(restartActionMatch, "restartAction not found").not.toBeNull();
    const restartBody = restartActionMatch?.[1] ?? "";
    const restartTriple = {
      clearResumeTarget: /playback\.clearResumeTarget\?\.\(\)/.test(restartBody),
      prepareEpisodeStart: /playback\.prepareEpisodeStart\?\.\(\s*0\s*,\s*true\s*\)/.test(restartBody),
      startFrom: /playback\.startFrom\(\s*0\s*,\s*true\s*\)/.test(restartBody),
    };
    console.info(`[media-playback-controller-cross-session-resume-leak:restartAction] reset triple present=${JSON.stringify(restartTriple)}`);
    if (!restartTriple.clearResumeTarget || !restartTriple.prepareEpisodeStart || !restartTriple.startFrom) {
      dumpResumeLeakSnapshot("restartAction-incomplete-reset-triple", { restartTriple, restartBody });
    }
    expect(restartBody).toMatch(/playback\.clearResumeTarget\?\.\(\)/);
    expect(restartBody).toMatch(/playback\.prepareEpisodeStart\?\.\(\s*0\s*,\s*true\s*\)/);
    expect(restartBody).toMatch(/playback\.startFrom\(\s*0\s*,\s*true\s*\)/);
  });

  it("next-episode handoff keeps prepareEpisodeStart(0, true) before flipping activeEpisodeId", () => {
    // Sanity guard for the OTHER known reset path. Without this the cross-
    // session leak would re-emerge for the auto-next-episode case.
    console.info("[media-playback-controller-cross-session-resume-leak:next-episode] asserting prepareEpisodeStart precedes setActiveEpisodeId(targetEpisode.id)");
    // Previous and next episode share one handler since c83bda36d (`targetEpisode`).
    const nextEpisodeRe =
      /playback\.prepareEpisodeStart\?\.\(\s*0\s*,\s*true\s*\);[\s\S]*?setActiveEpisodeId\(targetEpisode\.id\)/;
    if (!nextEpisodeRe.test(source)) {
      dumpResumeLeakSnapshot("next-episode-reset-not-found", { pattern: String(nextEpisodeRe) });
    }
    expect(source).toMatch(nextEpisodeRe);
  });
});

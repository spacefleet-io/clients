import { describe, expect, it } from "vitest";
import {
  getPlaybackLaunchMedia,
  getPlaybackLaunchPlan,
  hasUsableExternalTrackState,
  isCurrentExternalMpvLaunch,
  isExternalMpvResponseError,
  isExternalMpvResponseReady,
  shouldClearPlaybackLaunchUi,
  shouldHandlePlaybackRequest,
  shouldIgnoreExternalTeardownDuringLaunch,
  shouldPersistPlaybackProgress,
  shouldTeardownExternalPlayback,
  shouldTreatRecoveredExternalStateAsReady,
} from "../src/index";

// On assertion failure, dump the helper inputs + observed outputs so a
// classification regression is diagnosable from CI logs alone (suite-id:
// desktop-mpv-playback). Wrapped in try/catch so a dump failure can never
// mask the real assertion.
const dumpHelperSnapshot = (label: string, cells: Record<string, unknown>) => {
  try {
    console.error(`=== [desktop-mpv-playback:${label}] helper snapshot ===`);
    for (const [name, value] of Object.entries(cells)) {
      console.error(`${name}=${JSON.stringify(value)}`);
    }
    console.error(`=== [desktop-mpv-playback:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("desktop mpv playback shared helpers", () => {
  console.info("[desktop-mpv-playback:setup] exercising pure mpv-playback helper rules");

  it("treats successful or error mpv replies as ready responses", () => {
    console.info("[desktop-mpv-playback:run] isExternalMpvResponseReady classification");
    const readyOk = isExternalMpvResponseReady({ data: 0 });
    const readyErr = isExternalMpvResponseReady({ error: "property unavailable" });
    const readyNull = isExternalMpvResponseReady(null);
    if (!readyOk || !readyErr || readyNull) {
      dumpHelperSnapshot("ready-response", { readyOk, readyErr, readyNull });
    }
    expect(readyOk).toBe(true);
    expect(readyErr).toBe(true);
    expect(readyNull).toBe(false);
  });

  // @bugfix mpv-script-message-silently-dropped
  // @regression-proof Script-message metadata (sub-add, chapters, etc) were
  // silently dropped because `error: "success"` was misclassified as a
  // failure. Keep success responses distinct from real errors here so callers
  // never regress to treating every mpv reply as a failure.
  it("distinguishes mpv success replies from real errors", () => {
    console.info(
      "[desktop-mpv-playback:run] isExternalMpvResponseError success-vs-real-error classification",
    );
    const cells = {
      successPlain: isExternalMpvResponseError({ error: "success" }),
      successWithNullData: isExternalMpvResponseError({ error: "success", data: null }),
      errPropertyUnavailable: isExternalMpvResponseError({ error: "property unavailable" }),
      errSocketMissing: isExternalMpvResponseError({ error: "mpv_socket_missing" }),
      nullReply: isExternalMpvResponseError(null),
      dataOnly: isExternalMpvResponseError({ data: 0 }),
      undefinedReply: isExternalMpvResponseError(undefined),
    };
    const ok =
      cells.successPlain === false &&
      cells.successWithNullData === false &&
      cells.errPropertyUnavailable === true &&
      cells.errSocketMissing === true &&
      cells.nullReply === false &&
      cells.dataOnly === false &&
      cells.undefinedReply === false;
    if (!ok) dumpHelperSnapshot("success-vs-error", cells);
    // Success: mpv always returns error: "success" on OK — must be NOT error.
    expect(cells.successPlain).toBe(false);
    expect(cells.successWithNullData).toBe(false);
    // Real errors surface a different error string.
    expect(cells.errPropertyUnavailable).toBe(true);
    expect(cells.errSocketMissing).toBe(true);
    // No response / no error field: not an error.
    expect(cells.nullReply).toBe(false);
    expect(cells.dataOnly).toBe(false);
    expect(cells.undefinedReply).toBe(false);
  });

  it("accepts active external track state before full stabilization when playback is already live", () => {
    console.info("[desktop-mpv-playback:run] hasUsableExternalTrackState live-playback path");
    const tracks = [{ id: 1, type: "video" }, { id: 2, type: "audio" }];
    const usable = hasUsableExternalTrackState(tracks, 1136.04, 120);
    if (!usable) dumpHelperSnapshot("usable-track-state", { tracks, timePos: 1136.04, duration: 120, usable });
    expect(usable).toBe(true);
  });

  it("dedupes repeated playback requests for a short window", () => {
    console.info("[desktop-mpv-playback:run] shouldHandlePlaybackRequest dedupe-window path");
    const requestKey = "media-1:movie:7";
    const first = shouldHandlePlaybackRequest(requestKey, 1_000);
    const second = shouldHandlePlaybackRequest(requestKey, 1_001);
    if (!first || second) dumpHelperSnapshot("dedupe-window", { requestKey, first, second });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  // @bugfix dialog-reopen-resume-prompt-dropped
  // @regression-proof MediaDetailsDialog used to bump playbackRequestId via
  // `value + 1`, then reset it to 0 each time the dialog closed. After a
  // close+reopen cycle the next play click would land on requestId=1 again
  // and shouldHandlePlaybackRequest's module-level cache would silently
  // dedupe-drop it within the 5s TTL — the resume prompt never appeared
  // because the requestIdEffect short-circuited before opening it. The fix
  // switched the bump to Date.now() so request IDs are globally unique
  // across mount/unmount cycles. This test pins the fact that the dedupe is
  // strictly per-key — distinct (Date.now-style) request IDs for the same
  // media+episode must each be handled, even when fired back-to-back inside
  // the TTL window.
  it("@bugfix @regression-proof handles distinct request ids on the same media within the dedupe TTL", () => {
    console.info(
      "[desktop-mpv-playback:run] @bugfix dialog-reopen-resume-prompt-dropped — distinct ids inside TTL",
    );
    const mediaId = "media-1";
    const episodeId = "ep-S01E01";
    // Click 1 — Date.now()-style id at t=10.000s.
    const firstKey = `${mediaId}:${episodeId}:1730000000000`;
    const firstHandled = shouldHandlePlaybackRequest(firstKey, 10_000);
    // Click 2 within the 5s TTL but with a fresh (later) Date.now() id —
    // historically requestId would have rolled back to 1 here (collides
    // with click 1), but with monotonic ids the new key is distinct.
    const secondKey = `${mediaId}:${episodeId}:1730000002500`;
    const secondHandled = shouldHandlePlaybackRequest(secondKey, 12_500);
    // Same key again inside the TTL still dedupes (regression is *only*
    // about distinct ids).
    const secondDeduped = shouldHandlePlaybackRequest(secondKey, 12_501);
    if (!firstHandled || !secondHandled || secondDeduped) {
      dumpHelperSnapshot("distinct-ids-within-ttl", {
        firstKey,
        secondKey,
        firstHandled,
        secondHandled,
        secondDeduped,
      });
    }
    expect(firstHandled).toBe(true);
    expect(secondHandled).toBe(true);
    expect(secondDeduped).toBe(false);
  });

  it("builds the expected launch plan around resume candidates", () => {
    console.info("[desktop-mpv-playback:run] getPlaybackLaunchPlan resume-candidate vs no-candidate");
    const withResume = getPlaybackLaunchPlan(1136.04);
    const withoutResume = getPlaybackLaunchPlan(null);
    try {
      expect(withResume).toEqual({
        openPlayback: false,
        showResumePrompt: true,
        deferForPrompt: true,
      });
      expect(withoutResume).toEqual({
        openPlayback: true,
        showResumePrompt: false,
        deferForPrompt: false,
      });
    } catch (err) {
      dumpHelperSnapshot("launch-plan", { withResume, withoutResume });
      throw err;
    }
  });

  it("@bugfix @regression-proof prefers freshly resolved media details for launch-time playback metadata", () => {
    console.info(
      "[desktop-mpv-playback:run] @bugfix getPlaybackLaunchMedia — fresh details preferred over stale",
    );
    const current = { id: "media-1", audioTracks: [], subtitleTracks: [] };
    const latest = { id: "media-1", audioTracks: [{ id: "a1" }], subtitleTracks: [{ id: "s1" }] };
    const pickedLatest = getPlaybackLaunchMedia(current, latest);
    const pickedCurrent = getPlaybackLaunchMedia(current, null);
    if (pickedLatest !== latest || pickedCurrent !== current) {
      dumpHelperSnapshot("launch-media", {
        current,
        latest,
        pickedLatestIsLatest: pickedLatest === latest,
        pickedCurrentIsCurrent: pickedCurrent === current,
      });
    }
    expect(pickedLatest).toBe(latest);
    expect(pickedCurrent).toBe(current);
  });

  it("tracks launch UI lifecycle correctly", () => {
    console.info("[desktop-mpv-playback:run] shouldClearPlaybackLaunchUi lifecycle gating");
    const idle = shouldClearPlaybackLaunchUi(false, false, false, false);
    const launching = shouldClearPlaybackLaunchUi(true, false, false, false);
    if (idle || !launching) dumpHelperSnapshot("launch-ui-lifecycle", { idle, launching });
    expect(idle).toBe(false);
    expect(launching).toBe(true);
  });

  it("keeps launch and teardown heuristics deterministic", () => {
    console.info("[desktop-mpv-playback:run] launch/teardown heuristic battery");
    const cells = {
      launchStale: isCurrentExternalMpvLaunch(8, 7),
      launchCurrent: isCurrentExternalMpvLaunch(8, 8),
      teardown: shouldTeardownExternalPlayback(true, false),
      ignoreTeardownDuringLaunch: shouldIgnoreExternalTeardownDuringLaunch(10_000, false, 10_500),
      persistProgress: shouldPersistPlaybackProgress(1_000, 1_500),
      treatRecoveredReady: shouldTreatRecoveredExternalStateAsReady(false, true),
    };
    const ok =
      cells.launchStale === false &&
      cells.launchCurrent === true &&
      cells.teardown === true &&
      cells.ignoreTeardownDuringLaunch === true &&
      cells.persistProgress === true &&
      cells.treatRecoveredReady === true;
    if (!ok) dumpHelperSnapshot("launch-teardown-heuristics", cells);
    expect(cells.launchStale).toBe(false);
    expect(cells.launchCurrent).toBe(true);
    expect(cells.teardown).toBe(true);
    expect(cells.ignoreTeardownDuringLaunch).toBe(true);
    expect(cells.persistProgress).toBe(true);
    expect(cells.treatRecoveredReady).toBe(true);
  });
});

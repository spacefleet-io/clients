import { describe, expect, it } from "vitest";
import {
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
} from "@space/desktop-mpv-playback";

// On assertion failure, dump the exact inputs + computed result so a failing
// truth-table line is diagnosable from CI logs alone (per "Tests log
// generously"). Body wrapped in try/catch so a dump failure can't mask the
// real assertion. These predicates are pure → the snapshot IS the full state.
const dumpExternalMpvSnapshot = (
  label: string,
  inputs: Record<string, unknown>,
  computed: unknown,
) => {
  try {
    console.error(`=== [external-mpv-controller:${label}] snapshot ===`);
    console.error(`inputs=${JSON.stringify(inputs)}`);
    console.error(`computed=${JSON.stringify(computed)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

console.info(`[external-mpv-controller:setup] pinning pure external-mpv playback-decision predicates`);

describe("isExternalMpvResponseReady", () => {
  it("treats successful mpv replies as ready", () => {
    expect(isExternalMpvResponseReady({ data: 0 })).toBe(true);
  });

  it("treats mpv error replies as socket-ready", () => {
    expect(isExternalMpvResponseReady({ error: "property unavailable" })).toBe(true);
  });

  it("rejects nullish or primitive values", () => {
    expect(isExternalMpvResponseReady(null)).toBe(false);
    expect(isExternalMpvResponseReady(undefined)).toBe(false);
    expect(isExternalMpvResponseReady("nope")).toBe(false);
  });
});

describe("isExternalMpvResponseError", () => {
  // @bugfix mpv-script-message-silently-dropped
  // @regression-proof mpv IPC always sets `error: "success"` on OK. A naive
  // `"error" in result` test treated success as failure, dropping every
  // script-message metadata command (subs, chapters, playback). Pin the
  // discriminator here so this can't silently regress.
  it("returns false for mpv success responses", () => {
    const a = isExternalMpvResponseError({ error: "success" });
    const b = isExternalMpvResponseError({ error: "success", data: null });
    if (a !== false || b !== false) {
      dumpExternalMpvSnapshot("success-discriminator", { a: { error: "success" }, b: { error: "success", data: null } }, { a, b });
    }
    expect(a).toBe(false);
    expect(b).toBe(false);
  });

  it("returns true for real mpv errors", () => {
    expect(isExternalMpvResponseError({ error: "property unavailable" })).toBe(true);
    expect(isExternalMpvResponseError({ error: "mpv_socket_missing" })).toBe(true);
  });

  it("returns false when there is no error field or no response", () => {
    expect(isExternalMpvResponseError(null)).toBe(false);
    expect(isExternalMpvResponseError(undefined)).toBe(false);
    expect(isExternalMpvResponseError({ data: 0 })).toBe(false);
  });
});

describe("hasUsableExternalTrackState", () => {
  it("@bugfix @regression-proof accepts active playback with discovered tracks before the track list fully settles", () => {
    const tracks = [{ id: 1, type: "video" }, { id: 2, type: "audio" }];
    const computed = hasUsableExternalTrackState(tracks, 1136.04, 120);
    if (computed !== true) {
      dumpExternalMpvSnapshot("usable-track-state", { tracks, timePos: 1136.04, settleMs: 120 }, computed);
    }
    expect(computed).toBe(true);
  });

  it("keeps waiting when no usable tracks exist yet", () => {
    expect(hasUsableExternalTrackState([], 12, 900)).toBe(false);
    expect(hasUsableExternalTrackState([{ id: 1, type: "video" }], null, 120)).toBe(false);
  });
});

describe("shouldTeardownExternalPlayback", () => {
  it("@bugfix @regression-proof does not tear down mpv on the initial closed mount", () => {
    expect(shouldTeardownExternalPlayback(false, false)).toBe(false);
    expect(shouldTeardownExternalPlayback(false, true)).toBe(false);
  });

  it("tears down mpv only when playback closes after being open", () => {
    expect(shouldTeardownExternalPlayback(true, false)).toBe(true);
    expect(shouldTeardownExternalPlayback(true, true)).toBe(false);
  });
});

describe("shouldHandlePlaybackRequest", () => {
  it("@bugfix @regression-proof dedupes the same playback request across a strict-mode remount", () => {
    const requestKey = "media-1:movie:7";
    expect(shouldHandlePlaybackRequest(requestKey, 1_000)).toBe(true);
    expect(shouldHandlePlaybackRequest(requestKey, 1_001)).toBe(false);
  });

  it("allows a fresh request after the dedupe window expires", () => {
    const requestKey = "media-2:movie:3";
    expect(shouldHandlePlaybackRequest(requestKey, 2_000)).toBe(true);
    expect(shouldHandlePlaybackRequest(requestKey, 7_500)).toBe(true);
  });
});

describe("getPlaybackLaunchPlan", () => {
  it("@bugfix @regression-proof keeps playback closed until the user answers the resume prompt", () => {
    const plan = getPlaybackLaunchPlan(1136.04);
    const expected = { openPlayback: false, showResumePrompt: true, deferForPrompt: true };
    if (JSON.stringify(plan) !== JSON.stringify(expected)) {
      dumpExternalMpvSnapshot("launch-plan-resume", { resumeTarget: 1136.04 }, plan);
    }
    expect(plan).toEqual(expected);
  });

  it("opens playback immediately when there is no resume target", () => {
    expect(getPlaybackLaunchPlan(null)).toEqual({
      openPlayback: true,
      showResumePrompt: false,
      deferForPrompt: false,
    });
  });
});

describe("shouldClearPlaybackLaunchUi", () => {
  it("@bugfix @regression-proof does not clear launch UI on the controller's initial mount", () => {
    expect(shouldClearPlaybackLaunchUi(false, false, false, false)).toBe(false);
  });

  it("clears launch UI after an active playback or resume prompt has fully closed", () => {
    expect(shouldClearPlaybackLaunchUi(true, false, false, false)).toBe(true);
    expect(shouldClearPlaybackLaunchUi(true, false, true, false)).toBe(false);
    expect(shouldClearPlaybackLaunchUi(true, true, false, false)).toBe(false);
  });
});

describe("isCurrentExternalMpvLaunch", () => {
  it("@bugfix @regression-proof ignores stale mpv exit events from an older launch", () => {
    expect(isCurrentExternalMpvLaunch(8, 7)).toBe(false);
  });

  it("accepts events for the active mpv launch", () => {
    expect(isCurrentExternalMpvLaunch(8, 8)).toBe(true);
  });
});

describe("shouldIgnoreExternalTeardownDuringLaunch", () => {
  it("@bugfix @regression-proof ignores stale teardown during the first second of an external launch", () => {
    expect(shouldIgnoreExternalTeardownDuringLaunch(10_000, false, 10_500)).toBe(true);
  });

  it("does not ignore teardown once mpv is ready or the grace window has passed", () => {
    expect(shouldIgnoreExternalTeardownDuringLaunch(10_000, true, 10_500)).toBe(false);
    expect(shouldIgnoreExternalTeardownDuringLaunch(10_000, false, 11_500)).toBe(false);
  });
});

describe("shouldPersistPlaybackProgress", () => {
  it("@bugfix @regression-proof persists playback progress on a tighter cadence for accurate resume points", () => {
    expect(shouldPersistPlaybackProgress(0, 100)).toBe(true);
    expect(shouldPersistPlaybackProgress(1_000, 1_300)).toBe(false);
    expect(shouldPersistPlaybackProgress(1_000, 1_500)).toBe(true);
  });
});

describe("shouldTreatRecoveredExternalStateAsReady", () => {
  it("@bugfix @regression-proof accepts a recovered live external mpv state when strict startup stabilization times out", () => {
    expect(shouldTreatRecoveredExternalStateAsReady(false, true)).toBe(true);
  });

  it("still rejects startup only when neither strict nor recovered readiness succeeds", () => {
    expect(shouldTreatRecoveredExternalStateAsReady(true, false)).toBe(true);
    expect(shouldTreatRecoveredExternalStateAsReady(false, false)).toBe(false);
  });
});

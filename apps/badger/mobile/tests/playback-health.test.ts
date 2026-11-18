import { describe, expect, it } from "vitest";
import type { PlaybackSnapshot } from "@space/mobile-mpv-playback";
import {
  IDLE_FAILURE_GRACE_MS,
  LOADING_FAILURE_MS,
  LOADING_HINT_MS,
  buildStartOptions,
  detectPlaybackFailure,
  shouldShowLoadingHint,
  shouldShowSpinner,
  trackLoading,
} from "../src/lib/playback/health";

const snap = (over: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot => ({
  sampledAtMs: 0, position: 0, duration: 100, paused: false, cacheEnd: 0, cacheDuration: 0, cacheSpeed: 0, eof: false,
  pausedForCache: false, seeking: false, idle: false, coreIdle: false, voConfigured: true, hwdec: "mediacodec",
  currentVo: "gpu", videoCodec: "h264", frameDrops: 0, decoderFrameDrops: 0, avsync: 0, netBps: 0, cacheSecs: 30, demuxerMaxBytes: 33554432, vid: 1, aid: 1, sid: 0, videoWidth: 1920, videoHeight: 804,
  ...over,
});

describe("buildStartOptions", () => {
  it("carries only the resume position", () => {
    expect(buildStartOptions({ startSeconds: 123 })).toBe("start=123.000");
    expect(buildStartOptions({ startSeconds: 0 })).toBeNull();
  });
});

describe("shouldShowSpinner", () => {
  it("spins before first frame, on rebuffer and on seek", () => {
    expect(shouldShowSpinner(null)).toBe(true);
    expect(shouldShowSpinner(snap({ voConfigured: false }))).toBe(true);
    expect(shouldShowSpinner(snap({ pausedForCache: true }))).toBe(true);
    expect(shouldShowSpinner(snap({ seeking: true }))).toBe(true);
    expect(shouldShowSpinner(snap())).toBe(false);
    expect(shouldShowSpinner(snap({ eof: true, seeking: true }))).toBe(false);
  });

  /** @req PLAY-OSMEDIA-01[badger-mobile] */
  it("does not wait for a picture that is switched off in the background", () => {
    const background = snap({ voConfigured: false, vid: -1, aid: 1, currentVo: "" });
    console.info("[playback-health] picture off, sound on:", JSON.stringify({ vid: background.vid, aid: background.aid }));
    expect(shouldShowSpinner(background)).toBe(false);
    expect(trackLoading(null, { snapshot: background, nowMs: 90_000, floorMs: 0 })).toBeNull();
    expect(shouldShowSpinner(snap({ voConfigured: false, vid: -1, aid: 1, pausedForCache: true }))).toBe(true);
    // Before any track is chosen (start of a load) it still spins.
    expect(shouldShowSpinner(snap({ voConfigured: false, vid: -1, aid: -1 }))).toBe(true);
  });
});

const quiet = { stuckLoadingMs: 0, switching: false };

describe("detectPlaybackFailure", () => {
  it("is quiet while healthy or starting", () => {
    expect(detectPlaybackFailure({ snapshot: snap(), msSinceLoad: 1000, firstFrameSeen: true, ...quiet })).toBeNull();
    expect(detectPlaybackFailure({ snapshot: snap({ idle: true, voConfigured: false }), msSinceLoad: 500, firstFrameSeen: false, ...quiet })).toBeNull();
  });
  it("detects idle after the grace period and unexpected stops", () => {
    expect(detectPlaybackFailure({ snapshot: snap({ idle: true, voConfigured: false }), msSinceLoad: IDLE_FAILURE_GRACE_MS, firstFrameSeen: false, ...quiet })).toBe("openFailed");
    expect(detectPlaybackFailure({ snapshot: snap({ idle: true }), msSinceLoad: 99999, firstFrameSeen: true, ...quiet })).toBe("stoppedUnexpectedly");
    expect(detectPlaybackFailure({ snapshot: snap({ idle: true, eof: true }), msSinceLoad: 99999, firstFrameSeen: true, ...quiet })).toBeNull();
  });
  /** @req PLAY-ABR-04[badger-mobile] */
  it("a quality switch in flight owns its own idle blips: no error while it loads, before or after the first frame", () => {
    const idle = snap({ idle: true, voConfigured: false });
    // [switching, firstFrameSeen] → reason, for an idle player long past the open grace period.
    const cases: [switching: boolean, firstFrameSeen: boolean][] = [[true, false], [true, true], [false, false], [false, true]];
    const outcomes = cases.map(([switching, firstFrameSeen]) => [
      `switching=${switching} firstFrame=${firstFrameSeen}`,
      detectPlaybackFailure({ snapshot: idle, msSinceLoad: 99999, firstFrameSeen, stuckLoadingMs: 2000, switching }),
    ]);
    console.info(`[health] idle rung: ${JSON.stringify(outcomes)}`);
    // The switch machine retries an idle rung itself: only once it gave up (switching over) is the idle player a failure.
    expect(outcomes).toEqual([
      ["switching=true firstFrame=false", null],
      ["switching=true firstFrame=true", null],
      ["switching=false firstFrame=false", "openFailed"],
      ["switching=false firstFrame=true", "stoppedUnexpectedly"],
    ]);
  });
});

/** @req PLAY-ABR-03[badger-mobile] */
describe("stuck-loading timers (PLAY-ABR-03)", () => {
  it("the first start hints at 30 s and only errors at 60 s, never at the old 45 s", () => {
    const starting = snap({ voConfigured: false });
    const log = (ms: number) => {
      const failure = detectPlaybackFailure({ snapshot: starting, msSinceLoad: ms, firstFrameSeen: false, stuckLoadingMs: ms, switching: false });
      console.info(`[loading-timers] first start t=${ms}ms hint=${shouldShowLoadingHint(ms)} failure=${failure}`);
      return failure;
    };
    expect(LOADING_HINT_MS).toBe(30_000);
    expect(LOADING_FAILURE_MS).toBe(60_000);
    expect(shouldShowLoadingHint(LOADING_HINT_MS - 1)).toBe(false);
    expect(shouldShowLoadingHint(LOADING_HINT_MS)).toBe(true);
    expect(log(44_999)).toBeNull();
    expect(log(45_000)).toBeNull();
    expect(log(LOADING_FAILURE_MS - 1)).toBeNull();
    expect(log(LOADING_FAILURE_MS)).toBe("startTimeout");
  });

  it("a stall after the first frame follows the same 30 s hint / 60 s error", () => {
    const stalled = snap({ pausedForCache: true });
    const failure = (ms: number) => detectPlaybackFailure({ snapshot: stalled, msSinceLoad: 600_000, firstFrameSeen: true, stuckLoadingMs: ms, switching: false });
    expect(failure(LOADING_FAILURE_MS - 1)).toBeNull();
    expect(failure(LOADING_FAILURE_MS)).toBe("loadingTimeout");
  });

  it("a quality switch that never loads follows the same timers", () => {
    const failure = (ms: number) => detectPlaybackFailure({ snapshot: snap({ voConfigured: false, seeking: true }), msSinceLoad: 600_000, firstFrameSeen: true, stuckLoadingMs: ms, switching: true });
    expect(failure(LOADING_FAILURE_MS - 1)).toBeNull();
    expect(failure(LOADING_FAILURE_MS)).toBe("loadingTimeout");
  });

  it("measures continuous loading: it starts with the spinner and restarts after a healthy frame", () => {
    let since: number | null = null;
    // First start: counted from when the load began, even before the first poll answered.
    since = trackLoading(since, { snapshot: snap({ voConfigured: false }), nowMs: 5_000, floorMs: 1_000 });
    expect(since).toBe(1_000);
    since = trackLoading(since, { snapshot: snap({ voConfigured: false }), nowMs: 31_000, floorMs: 1_000 });
    expect(since).toBe(1_000);
    // A healthy frame ends it.
    since = trackLoading(since, { snapshot: snap(), nowMs: 32_000, floorMs: null });
    expect(since).toBeNull();
    // A later rebuffer starts a fresh count at that moment.
    since = trackLoading(since, { snapshot: snap({ pausedForCache: true }), nowMs: 100_000, floorMs: null });
    expect(since).toBe(100_000);
    // End of file never counts as loading.
    expect(trackLoading(100_000, { snapshot: snap({ eof: true, seeking: true }), nowMs: 200_000, floorMs: null })).toBeNull();
    // A quality switch running counts as loading even with the old frame still on screen, and a settled one stops counting.
    expect(trackLoading(null, { snapshot: snap(), nowMs: 300_000, floorMs: null, switching: true })).toBe(300_000);
    expect(trackLoading(300_000, { snapshot: snap(), nowMs: 310_000, floorMs: null, switching: false })).toBeNull();
    // No snapshot yet: nothing to judge.
    expect(trackLoading(null, { snapshot: null, nowMs: 1, floorMs: null })).toBeNull();
  });

  it("the timers only ever report a hint or an error code: nothing here can ask for another quality", () => {
    const outputs = new Set<unknown>();
    for (const ms of [0, 29_000, 30_000, 45_000, 59_999, 60_000, 600_000]) {
      for (const switching of [false, true]) {
        outputs.add(detectPlaybackFailure({ snapshot: snap({ voConfigured: false }), msSinceLoad: ms, firstFrameSeen: false, stuckLoadingMs: ms, switching }));
        outputs.add(shouldShowLoadingHint(ms));
      }
    }
    console.info(`[loading-timers] possible outputs=${JSON.stringify([...outputs])}`);
    expect([...outputs].every((value) => value === null || typeof value === "boolean" || value === "startTimeout" || value === "loadingTimeout")).toBe(true);
  });
});

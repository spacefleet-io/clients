// @vitest-environment jsdom
//
// @bugfix @regression-proof issue #25 P19 / M7 — the hidden app window burned
// ~30 % CPU during external playback (ultimate confirmation run, seed
// 1791373829836): 74–81 % of renderer_loaf_ms was hidden-window work, ~91 % of
// it React `performWorkUntilDeadline` from the 250 ms mpv poll's setState and
// ~6 % job-progress SSE re-renders. `backgroundThrottling: false` means
// `win.hide()` neither throttles the renderer nor flips
// `document.visibilityState`, so the perf probe's hidden exclusion never
// applied either (M7: 0 flips over 189 playback hides on S1).
//
// Fix pinned here:
//   1. main pushes a hidden/visible flag over IPC on every hide/show
//      (`markAppWindowVisibility`, deduped per window);
//   2. the poll drops UI-only state writes while hidden and applies the
//      latest value once on show, while the 500 ms progress save keeps its
//      cadence;
//   3. the e2e perf probe marks hidden spans from main's flag.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldPersistPlaybackProgress } from "@space/desktop-mpv-playback";

import {
  __resetAppWindowVisibilityForTests,
  __setAppWindowHiddenForTests,
  createHiddenCoalescedSetter,
  createVisibilityAwareInterval,
  HIDDEN_LOOP_INTERVAL_MS,
  isAppWindowHidden,
} from "../src/renderer/src/lib/appWindowVisibility";
import {
  createHiddenDeferredProgress,
  type EngineSetProgress,
  type LibrarySetProgress,
  useHiddenDeferredSetProgress,
} from "../src/renderer/src/lib/hiddenProgressBuffer";
import {
  APP_WINDOW_VISIBILITY_CHANNEL,
  markAppWindowVisibility,
} from "../src/main/appWindowVisibility";
import {
  installRendererPerfProbe,
  overlapsHiddenSpan,
  recordHiddenTransition,
} from "../src/renderer/src/lib/e2ePerfProbe";
import type { BrowserWindow } from "electron";

const LOG = "[hidden-renderer-quiet]";
const T0 = 1_791_373_829_836;

beforeEach(() => {
  __resetAppWindowVisibilityForTests();
});

afterEach(() => {
  __resetAppWindowVisibilityForTests();
  vi.restoreAllMocks();
});

describe("main pushes the hidden flag (@bugfix @regression-proof issue #25 P19)", () => {
  const fakeWindow = () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
    };
    return { win: win as unknown as BrowserWindow, send };
  };

  it("sends one message per real flip, deduping the explicit mark and the hide/show event", () => {
    const { win, send } = fakeWindow();
    let now = T0;
    const clock = () => now;
    const marks = [
      markAppWindowVisibility(win, true, "external-mpv-hide", clock),
      markAppWindowVisibility(win, true, "window-hide-event", clock),
      (now += 60_000, markAppWindowVisibility(win, false, "external-mpv-show", clock)),
      markAppWindowVisibility(win, false, "window-show-event", clock),
    ];
    console.info(`${LOG} main marks=${JSON.stringify(marks)} sends=${JSON.stringify(send.mock.calls)}`);
    expect(send.mock.calls).toEqual([
      [APP_WINDOW_VISIBILITY_CHANNEL, { hidden: true, atMs: T0, reason: "external-mpv-hide" }],
      [APP_WINDOW_VISIBILITY_CHANNEL, { hidden: false, atMs: T0 + 60_000, reason: "external-mpv-show" }],
    ]);
    expect(marks[1]).toBeNull();
    expect(marks[3]).toBeNull();
  });

  it("ignores a destroyed window", () => {
    const send = vi.fn();
    const win = { isDestroyed: () => true, webContents: { isDestroyed: () => true, send } };
    expect(markAppWindowVisibility(win as unknown as BrowserWindow, true, "x")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("the external-mpv hide/show and every BrowserWindow hide/show path mark the flag", () => {
    const externalMpv = readFileSync(resolve(__dirname, "../src/main/externalMpv.ts"), "utf8");
    const index = readFileSync(resolve(__dirname, "../src/main/index.ts"), "utf8");
    const wiring = {
      mpvHide: /win\.hide\(\);\s*markAppWindowVisibility\(win, true, "external-mpv-hide"\)/.test(externalMpv),
      mpvShow: /win\.show\(\);\s*markAppWindowVisibility\(win, false, "external-mpv-show"\)/.test(externalMpv),
      trackEvents: /trackAppWindowVisibility\(win\)/.test(index),
      ipcGet: /registerAppWindowVisibilityIpc\(ipcMain\)/.test(index),
      trayShow: /markAppWindowVisibility\(mainWindow, false, "show-main-window"\)/.test(index),
    };
    console.info(`${LOG} main wiring ${JSON.stringify(wiring)}`);
    expect(wiring).toEqual({ mpvHide: true, mpvShow: true, trackEvents: true, ipcGet: true, trayShow: true });
  });
});

describe("poll UI state while hidden (@bugfix @regression-proof issue #25 P19)", () => {
  it("drops UI writes while hidden and applies only the latest value on show", () => {
    const setCurrentTime = vi.fn();
    const ui = createHiddenCoalescedSetter<number>(setCurrentTime);
    ui.set(1);
    __setAppWindowHiddenForTests({ hidden: true, atMs: T0, reason: "external-mpv-hide" });
    ui.set(2);
    ui.set(3);
    console.info(`${LOG} hidden: calls=${JSON.stringify(setCurrentTime.mock.calls)} skipped=${ui.skipped()}`);
    expect(setCurrentTime.mock.calls).toEqual([[1]]);
    __setAppWindowHiddenForTests({ hidden: false, atMs: T0 + 500, reason: "external-mpv-show" });
    console.info(`${LOG} shown: calls=${JSON.stringify(setCurrentTime.mock.calls)}`);
    expect(setCurrentTime.mock.calls).toEqual([[1], [3]]);
    ui.set(4);
    expect(setCurrentTime.mock.calls).toEqual([[1], [3], [4]]);
    // A show with nothing pending does not write again.
    __setAppWindowHiddenForTests({ hidden: true, atMs: T0 + 600, reason: "x" });
    __setAppWindowHiddenForTests({ hidden: false, atMs: T0 + 700, reason: "x" });
    expect(setCurrentTime).toHaveBeenCalledTimes(3);
    ui.dispose();
  });

  it("replays 10 s of hidden 1 Hz polls: 0 UI setState, progress saved every poll (1 s)", () => {
    // Mirrors the poll's per-tick work: three UI-only writes, then the
    // progress save gated only by shouldPersistPlaybackProgress. While hidden
    // the poll runs at HIDDEN_LOOP_INTERVAL_MS (issue #25 P19-residual).
    const uiSetter = vi.fn();
    const saves: Array<{ at: number; positionSeconds: number }> = [];
    const uiTime = createHiddenCoalescedSetter<number>(uiSetter);
    const uiBuffered = createHiddenCoalescedSetter<number>(uiSetter);
    const uiAppend = createHiddenCoalescedSetter<number>(uiSetter);
    let lastSaveAt = 0;
    const tick = (now: number, position: number) => {
      uiTime.set(position);
      uiBuffered.set(position + 30);
      uiAppend.set(Math.round(((position + 30) / 1_400) * 100));
      if (shouldPersistPlaybackProgress(lastSaveAt, now)) {
        lastSaveAt = now;
        saves.push({ at: now, positionSeconds: position });
      }
    };

    __setAppWindowHiddenForTests({ hidden: true, atMs: T0, reason: "external-mpv-hide" });
    let position = 120;
    for (let now = T0; now < T0 + 10_000; now += HIDDEN_LOOP_INTERVAL_MS) {
      tick(now, position);
      position += HIDDEN_LOOP_INTERVAL_MS / 1_000;
    }
    const gaps = saves.slice(1).map((s, i) => s.at - saves[i].at);
    console.info(
      `${LOG} hidden 10 s: uiSetStateCalls=${uiSetter.mock.calls.length} skipped=${uiTime.skipped() + uiBuffered.skipped() + uiAppend.skipped()} saves=${saves.length} gaps=${JSON.stringify([...new Set(gaps)])} lastSaved=${saves.at(-1)?.positionSeconds}`,
    );
    expect(isAppWindowHidden()).toBe(true);
    expect(uiSetter).not.toHaveBeenCalled();
    expect(saves).toHaveLength(10);
    expect(new Set(gaps)).toEqual(new Set([HIDDEN_LOOP_INTERVAL_MS]));
    expect(saves.at(-1)?.positionSeconds).toBe(129);

    __setAppWindowHiddenForTests({ hidden: false, atMs: T0 + 10_000, reason: "external-mpv-show" });
    console.info(`${LOG} on show: uiSetStateCalls=${JSON.stringify(uiSetter.mock.calls)}`);
    expect(uiSetter.mock.calls).toEqual([[129], [159], [Math.round((159 / 1_400) * 100)]]);
    uiTime.dispose();
    uiBuffered.dispose();
    uiAppend.dispose();
  });

  it("the engine poll routes the per-tick UI writes through the hidden gate, never the progress save", () => {
    const src = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const start = src.indexOf("const uiCurrentTime = createHiddenCoalescedSetter(setCurrentTime);");
    const end = src.indexOf("const pollInterval = createVisibilityAwareInterval(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const poll = src.slice(start, end);
    const wiring = {
      gatedTime: /uiCurrentTime\.set\(time\)/.test(poll),
      gatedBuffered: (poll.match(/uiBufferedTime\.set\(/g) ?? []).length,
      gatedAppend: /uiAppendProgress\.set\(/.test(poll),
      rawChurn: (poll.match(/\b(setCurrentTime|setBufferedTime|setAppendProgress)\(/g) ?? []).length,
      progressSave: /void setProgress\(media\.id, pct/.test(poll),
      progressGatedByHidden: /if \(!isAppWindowHidden\(\)\)[^\n]*setProgress|isAppWindowHidden\(\)\)\s*return/.test(poll),
      disposes: /uiCurrentTime\.dispose\(\)/.test(src.slice(end, end + 600)),
    };
    console.info(`${LOG} poll wiring ${JSON.stringify(wiring)}`);
    expect(wiring).toEqual({
      gatedTime: true,
      gatedBuffered: 2,
      gatedAppend: true,
      rawChurn: 0,
      progressSave: true,
      progressGatedByHidden: false,
      disposes: true,
    });
  });
});

describe("perf probe hidden spans come from main (@bugfix @regression-proof issue #25 M7)", () => {
  it("marks a frame inside a main hidden span hidden even though document.visibilityState stayed visible", () => {
    const spans: Array<{ from: number; to: number | null }> = [];
    recordHiddenTransition(spans, true, T0);
    recordHiddenTransition(spans, true, T0 + 10); // repeated hide: no new span
    const duringOpen = overlapsHiddenSpan(spans, T0 + 2_000, T0 + 2_150);
    recordHiddenTransition(spans, false, T0 + 60_000);
    recordHiddenTransition(spans, false, T0 + 60_010);
    const cases = {
      visibility: document.visibilityState,
      spans,
      duringOpen,
      inside: overlapsHiddenSpan(spans, T0 + 30_000, T0 + 30_120),
      straddlesShow: overlapsHiddenSpan(spans, T0 + 59_950, T0 + 60_100),
      before: overlapsHiddenSpan(spans, T0 - 500, T0 - 100),
      after: overlapsHiddenSpan(spans, T0 + 60_100, T0 + 60_300),
    };
    console.info(`${LOG} probe spans ${JSON.stringify(cases)}`);
    expect(cases.visibility).toBe("visible");
    expect(spans).toEqual([{ from: T0, to: T0 + 60_000 }]);
    expect(cases).toMatchObject({ duringOpen: true, inside: true, straddlesShow: true, before: false, after: false });
  });

  it("the installed probe stamps drained frames hidden from main's flag", async () => {
    type Callback = (list: { getEntries: () => unknown[] }) => void;
    const observers: Array<{ type: string; cb: Callback }> = [];
    class FakeObserver {
      constructor(private readonly cb: Callback) {}
      observe(opts: { type: string }) {
        observers.push({ type: opts.type, cb: this.cb });
      }
    }
    vi.stubGlobal("PerformanceObserver", FakeObserver);
    // The probe constructs its observers at install time, so the stub above is in place.
    installRendererPerfProbe(true);
    const origin = performance.timeOrigin;
    __setAppWindowHiddenForTests({ hidden: true, atMs: origin + 1_000, reason: "external-mpv-hide" });
    __setAppWindowHiddenForTests({ hidden: false, atMs: origin + 5_000, reason: "external-mpv-show" });
    const loafObserver = observers.find((o) => o.type === "long-animation-frame");
    expect(loafObserver).toBeDefined();
    const frame = (startTime: number) => ({ startTime, duration: 150, blockingDuration: 100, scripts: [], renderStart: 0, styleAndLayoutStart: 0 });
    loafObserver!.cb({ getEntries: () => [frame(2_000), frame(6_000)] });
    const drained = window.__sfRendererPerf!.drain();
    const loaf = drained.loaf.filter((r): r is Extract<typeof r, { ts: number }> => "ts" in r);
    console.info(`${LOG} probe drain ${JSON.stringify(loaf.map((r) => ({ at: r.ts - origin, hidden: r.hidden })))}`);
    expect(loaf.map((r) => r.hidden)).toEqual([true, false]);
    vi.unstubAllGlobals();
  });
});

// Issue #25 P19-residual (ultimate "before" run, seed 1791422679313): the
// hidden renderer still burned 19/22/28 % CPU (p25/p50/p90). The engine's
// progress save called the library's `setProgress`, which rewrote
// settingsMap / media / mediaDetailsMap on every save — every library
// consumer (and the MediaDetailsDialog selectedDetails effect, 153 runs/min)
// re-rendered an invisible window. The poll and ABR tick also kept 250 ms.
describe("engine setProgress while hidden (@bugfix @regression-proof issue #25 P19-residual)", () => {
  type Timing = { positionSeconds?: number | null; durationSeconds?: number | null } | null;
  type Call = { args: [string, number, (string | null)?, Timing?]; deferUi: boolean };
  /** Fake library setProgress: a call without deferUi is a library state write (= consumer re-render). */
  const fakeLibrary = () => {
    const calls: Call[] = [];
    const setProgress: LibrarySetProgress = async (mediaId, pct, episodeId, timing, options) => {
      calls.push({ args: [mediaId, pct, episodeId, timing], deferUi: options?.deferUi === true });
    };
    const stateWrites = () => calls.filter((c) => !c.deferUi);
    return { calls, setProgress, stateWrites };
  };

  it("persists every hidden save without notifying library consumers, then applies the latest once on show", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const lib = fakeLibrary();
    let engineSetProgress: EngineSetProgress | null = null;
    const Probe = () => {
      engineSetProgress = useHiddenDeferredSetProgress(lib.setProgress);
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    const save = (pct: number, episodeId: string | null = "e1") =>
      engineSetProgress!("m1", pct, episodeId, { positionSeconds: pct * 10, durationSeconds: 1_000 });

    await save(1);
    expect(lib.stateWrites()).toHaveLength(1);

    __setAppWindowHiddenForTests({ hidden: true, atMs: T0, reason: "external-mpv-hide" });
    // 60 s hidden at the 1 Hz hidden poll; autoplay moves to e2 halfway.
    for (let i = 2; i <= 61; i += 1) await save(i, i <= 31 ? "e1" : "e2");
    const hiddenCalls = lib.calls.slice(1);
    console.info(`${LOG} engine setProgress hidden: calls=${hiddenCalls.length} stateWrites=${hiddenCalls.filter((c) => !c.deferUi).length}`);
    expect(hiddenCalls).toHaveLength(60);
    expect(hiddenCalls.every((c) => c.deferUi)).toBe(true);
    expect(hiddenCalls.at(-1)?.args).toEqual(["m1", 61, "e2", { positionSeconds: 610, durationSeconds: 1_000 }]);
    expect(lib.stateWrites()).toHaveLength(1);

    await act(async () => {
      __setAppWindowHiddenForTests({ hidden: false, atMs: T0 + 60_000, reason: "external-mpv-show" });
    });
    const onShow = lib.stateWrites().slice(1).map((c) => c.args);
    console.info(`${LOG} engine setProgress on show: ${JSON.stringify(onShow)}`);
    // The latest value per episode, once each, through the normal (state-writing) path.
    expect(onShow).toEqual([
      ["m1", 31, "e1", { positionSeconds: 310, durationSeconds: 1_000 }],
      ["m1", 61, "e2", { positionSeconds: 610, durationSeconds: 1_000 }],
    ]);
    // Visible again: writes go straight through; a second show has nothing to replay.
    await save(62, "e2");
    expect(lib.calls.at(-1)).toEqual({ args: ["m1", 62, "e2", { positionSeconds: 620, durationSeconds: 1_000 }], deferUi: false });
    __setAppWindowHiddenForTests({ hidden: true, atMs: T0 + 61_000, reason: "x" });
    __setAppWindowHiddenForTests({ hidden: false, atMs: T0 + 62_000, reason: "x" });
    expect(lib.stateWrites()).toHaveLength(4);
    await act(async () => root.unmount());
  });

  it("unmounting while hidden applies what is pending (no lost UI state)", async () => {
    const lib = fakeLibrary();
    const deferred = createHiddenDeferredProgress(lib.setProgress);
    const detach = deferred.attach();
    __setAppWindowHiddenForTests({ hidden: true, atMs: T0, reason: "external-mpv-hide" });
    await deferred.setProgress("m2", 40, null, null);
    await deferred.setProgress("m2", 41, null, null);
    expect(lib.stateWrites()).toHaveLength(0);
    detach();
    expect(lib.stateWrites().map((c) => c.args)).toEqual([["m2", 41, null, null]]);
  });

  // @bugfix @regression-proof alert audit #3356 A17: LIBRARY_NOT_READY reached Bugsink as an unhandled rejection
  // (badger-desktop 0.1.20, 2026-11-20) when playback unmounted after the library closed.
  it("a replayed save the closed library refuses is logged, never an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const lib = fakeLibrary();
      let libraryOpen = true;
      const deferred = createHiddenDeferredProgress(async (...args) => {
        if (!libraryOpen) throw new Error("LIBRARY_NOT_READY");
        return lib.setProgress(...args);
      });
      const detach = deferred.attach();
      __setAppWindowHiddenForTests({ hidden: true, atMs: T0, reason: "external-mpv-hide" });
      await deferred.setProgress("m3", 50, null, null);
      libraryOpen = false;
      detach();
      // No delay: one macrotask turn is when Node reports a rejection nobody handled.
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      expect(unhandled).toEqual([]);
      expect(lib.stateWrites()).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("LibraryProvider's setProgress persists without state writes when deferUi is set; the playback engine gets the wrapper", () => {
    const src = readFileSync(resolve(__dirname, "../src/renderer/src/lib/libraryContext.tsx"), "utf8");
    const start = src.indexOf("const setProgress = useCallback(");
    const body = src.slice(start, src.indexOf("\n  );", start));
    const branchAt = body.indexOf("if (options?.deferUi) {");
    const deferBranch = branchAt > -1 ? body.slice(branchAt, body.indexOf("const timestamp = new Date()", branchAt)) : "";
    const wiring = {
      hasBranch: branchAt > -1,
      branchBeforeStateWrites: branchAt > -1 && branchAt < body.indexOf("setSettingsMap("),
      branchStateWrites: (deferBranch.match(/\b(setSettingsMap|updateMedia|setMediaDetailsMap)\(/g) ?? []).length,
      branchPersists: /db\.setProgress\(mediaId, pct, episodeId \?\? null, timing \?\? null\)/.test(deferBranch),
      branchReturns: /return runOptimisticWrite\(/.test(deferBranch),
    };
    const engines = {
      controller: /usePlaybackEngine\(\{[\s\S]*?\n\s+setProgress: engineSetProgress,/.test(
        readFileSync(resolve(__dirname, "../src/renderer/src/components/MediaPlaybackController.tsx"), "utf8"),
      ),
    };
    console.info(`${LOG} deferUi wiring ${JSON.stringify(wiring)} engines=${JSON.stringify(engines)}`);
    expect(wiring).toEqual({
      hasBranch: true,
      branchBeforeStateWrites: true,
      branchStateWrites: 0,
      branchPersists: true,
      branchReturns: true,
    });
    expect(engines).toEqual({ controller: true });
  });
});

describe("poll and ABR cadence while hidden (@bugfix @regression-proof issue #25 P19-residual)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs at 250 ms while visible, 1 Hz while hidden, and polls immediately on show", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const loop = createVisibilityAwareInterval(fn, { visibleMs: 250 });
    vi.advanceTimersByTime(1_000);
    const visibleCalls = fn.mock.calls.length;

    __setAppWindowHiddenForTests({ hidden: true, atMs: T0, reason: "external-mpv-hide" });
    fn.mockClear();
    vi.advanceTimersByTime(10_000);
    const hiddenCalls = fn.mock.calls.length;
    const hiddenPeriod = loop.periodMs();

    __setAppWindowHiddenForTests({ hidden: false, atMs: T0 + 10_000, reason: "external-mpv-show" });
    const onShow = fn.mock.calls.length - hiddenCalls;
    fn.mockClear();
    vi.advanceTimersByTime(1_000);
    const afterShow = fn.mock.calls.length;
    console.info(`${LOG} cadence visible/1s=${visibleCalls} hidden/10s=${hiddenCalls} period=${hiddenPeriod} onShow=${onShow} visibleAgain/1s=${afterShow}`);
    expect({ visibleCalls, hiddenCalls, hiddenPeriod, onShow, afterShow, visiblePeriod: loop.periodMs() }).toEqual({
      visibleCalls: 4,
      hiddenCalls: 10,
      hiddenPeriod: HIDDEN_LOOP_INTERVAL_MS,
      onShow: 1,
      afterShow: 4,
      visiblePeriod: 250,
    });
    expect(HIDDEN_LOOP_INTERVAL_MS).toBe(1_000);
    loop.dispose();
    vi.advanceTimersByTime(5_000);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("starts at 1 Hz when the window is already hidden", () => {
    vi.useFakeTimers();
    __setAppWindowHiddenForTests({ hidden: true, atMs: T0, reason: "external-mpv-hide" });
    const fn = vi.fn();
    const loop = createVisibilityAwareInterval(fn, { visibleMs: 250 });
    vi.advanceTimersByTime(5_000);
    expect(fn).toHaveBeenCalledTimes(5);
    loop.dispose();
  });

  it("the engine poll and ABR tick both use the visibility-aware interval; hidden ABR decides every tick", () => {
    const src = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const wiring = {
      rawPollInterval: /window\.setInterval\(poll,/.test(src),
      rawTickInterval: /window\.setInterval\(tick,/.test(src),
      pollAware: /createVisibilityAwareInterval\(\(\) => void poll\(\), \{ visibleMs: 250 \}\)/.test(src),
      tickAware: /createVisibilityAwareInterval\(\(\) => void tick\(\), \{ visibleMs: 250 \}\)/.test(src),
      hiddenAbrDecidesEveryTick: /if \(!isAppWindowHidden\(\) && abrPollCycleRef\.current % ABR_DECIDE_EVERY_N_POLLS !== 0\) return;/.test(src),
      hiddenSaveLogDebug: /playbackDebugLog\.debug\(saveFields, "progress poll save \(hidden\)"\)/.test(src),
      hiddenTimePosLogDebug: /if \(isAppWindowHidden\(\)\) mpvLog\.debug\(sample, "time-pos sample \(hidden\)"\)/.test(src),
    };
    console.info(`${LOG} cadence wiring ${JSON.stringify(wiring)}`);
    expect(wiring).toEqual({
      rawPollInterval: false,
      rawTickInterval: false,
      pollAware: true,
      tickAware: true,
      hiddenAbrDecidesEveryTick: true,
      hiddenSaveLogDebug: true,
      hiddenTimePosLogDebug: true,
    });
  });
});

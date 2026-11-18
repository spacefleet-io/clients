// @vitest-environment jsdom
//
// @bugfix @regression-proof pause-for-change-idle-dead-wait (issue #25 F8)
//
// Seam run 2026-10-05 (selftest "Start over" after a prior playback): the
// timeline showed `startFrom: zero-seek path → pauseForChange + loadStream`
// at t+281 ms but `loadStream: enter` only at t+6320 ms — a 6.0 s dead wait
// before mpv was even launched (ttff_ms 8750 vs a 3000 budget).
//
// Root cause: with NO live mpv (lifecycle `idle`), `pauseForChange` still ran
// the full pause dance. `setPaused(true)` → `waitForExternalPause(true)` and
// then `pauseForChange` called `waitForExternalPause(true)` AGAIN; each one
// polls `getProperty("pause")` 20 × 150 ms. With no player,
// `sendExternalRequest` returns null instantly, so each call is a pure 3.0 s
// sleep loop (2 × 3.0 s ≈ 6.0 s). Nothing can ever flip a pause flag on a
// player that does not exist.
//
// Fix pinned here:
//   1. `waitForExternalPause` resolves `false` immediately when the external
//      player is disabled or the lifecycle is idle/stopping.
//   2. `pauseForChange` skips the pause dance entirely (runs the action)
//      when there is no live external player to pause.
//
// Tests log generously: every case prints the measured elapsed time so a
// regression is diagnosable from the output alone.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type { LifecycleState } from "@space/mpv-protocol";
import type { PlaybackPhase } from "@space/desktop-mpv-playback";

import {
  useExternalMpvCommands,
  type ExternalMpvCommands,
  type ExternalMpvCommandsParams,
} from "../src/renderer/src/lib/useExternalMpvCommands";
import { hasLiveExternalPlayer } from "../src/renderer/src/lib/mpvPlaybackState";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const renderCommands = (params: ExternalMpvCommandsParams): { current: ExternalMpvCommands } => {
  const ref = { current: null as unknown as ExternalMpvCommands };
  function Probe() {
    ref.current = useExternalMpvCommands(params);
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe />);
  });
  return ref;
};

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

const buildParams = (lifecycle: LifecycleState, request: Mock): ExternalMpvCommandsParams => ({
  mpvClient: {
    command: vi.fn(async () => ({ error: "mpv_socket_missing" })),
    request,
    waitForReady: vi.fn(async () => false),
  } as unknown as ExternalMpvCommandsParams["mpvClient"],
  mpvFlagsRef: { current: { smokeTest: false, externalPlayer: true } },
  lifecycleRef: { current: lifecycle },
  phaseRef: { current: { kind: "idle" } as unknown as PlaybackPhase },
  lastKnownTimeRef: { current: 0 },
});

describe("waitForExternalPause with no live mpv (@bugfix @regression-proof pause-for-change-idle-dead-wait)", () => {
  it("resolves false immediately when the lifecycle is idle (was a 3.0 s sleep loop)", async () => {
    const request = vi.fn(async () => ({ error: "success", data: true }));
    const hook = renderCommands(buildParams({ kind: "idle" }, request));
    const t0 = performance.now();
    const result = await hook.current.waitForExternalPause(true);
    const elapsedMs = performance.now() - t0;
    console.info(`[pause-idle-no-wait] idle: result=${result} elapsedMs=${elapsedMs.toFixed(1)} requestCalls=${request.mock.calls.length}`);
    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
    expect(request).not.toHaveBeenCalled();
  }, 15_000);

  it("resolves false immediately when the lifecycle is stopping", async () => {
    const request = vi.fn(async () => ({ error: "success", data: true }));
    const hook = renderCommands(buildParams({ kind: "stopping" } as LifecycleState, request));
    const t0 = performance.now();
    const result = await hook.current.waitForExternalPause(true);
    const elapsedMs = performance.now() - t0;
    console.info(`[pause-idle-no-wait] stopping: result=${result} elapsedMs=${elapsedMs.toFixed(1)}`);
    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  }, 15_000);

  it("still resolves true as soon as a live mpv reports the expected pause state", async () => {
    const request = vi.fn(async () => ({ error: "success", data: true }));
    const hook = renderCommands(buildParams({ kind: "socket-ready", launchId: 1 }, request));
    const result = await hook.current.waitForExternalPause(true);
    console.info(`[pause-idle-no-wait] live: result=${result} requestCalls=${request.mock.calls.length}`);
    expect(result).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  }, 15_000);
});

describe("hasLiveExternalPlayer (pauseForChange gate)", () => {
  it("is false for idle/stopping lifecycles or a disabled external player, true otherwise", () => {
    const cases: Array<[string, LifecycleState, boolean, boolean]> = [
      ["idle", { kind: "idle" }, true, false],
      ["stopping", { kind: "stopping" } as LifecycleState, true, false],
      ["socket-ready but external player disabled", { kind: "socket-ready", launchId: 1 }, false, false],
      ["socket-ready", { kind: "socket-ready", launchId: 1 }, true, true],
    ];
    for (const [label, lifecycle, external, expected] of cases) {
      const actual = hasLiveExternalPlayer(lifecycle, external);
      console.info(`[pause-idle-no-wait] hasLiveExternalPlayer(${label}) = ${actual}`);
      expect(actual, label).toBe(expected);
    }
  });
});

describe("pauseForChange source contract", () => {
  it("skips the pause dance (runs the action directly) when there is no live external player", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/renderer/src/lib/useMpvPlaybackEngine.ts"),
      "utf8",
    );
    const start = source.indexOf("const pauseForChange = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 1_200);
    console.info(`[pause-idle-no-wait] pauseForChange head:\n${body.slice(0, 600)}`);
    expect(body).toMatch(/hasLiveExternalPlayer\(\s*lifecycleRef\.current,\s*mpvFlagsRef\.current\.externalPlayer\s*\)/);
    // The no-player branch must run the action and return BEFORE any pause
    // attempt (holdManualState / setPaused / waitForExternalPause).
    const guardIdx = body.search(/hasLiveExternalPlayer\(/);
    const pauseIdx = body.search(/holdManualState\(|setPaused\(true\)|waitForExternalPause\(true\)/);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(pauseIdx).toBeGreaterThan(guardIdx);
  });
});

// @vitest-environment jsdom
//
// @bugfix @regression-proof start-from-dead-mpv-dropped (issue #2776)
//
// movie-playback e2e, 2026-11-16: mpv was quit, and a Resume
// arrived before the renderer had seen the exit (the lifecycle goes idle
// 100–600 ms after the socket dies, under load). `startFrom` still read
// `isExternalActive(lifecycle) === true`, took the alive-mpv path
// (`ensureExternalSeek(time)` + `sendPauseCommand`), every seek hit the dead
// socket (`ensureExternalSeek: exhausted`), and nothing relaunched mpv: the
// Resume was silently lost.
//
// Fix pinned here:
//   1. `ensureExternalSeek` reports how the seek ended. When mpv is gone (the
//      lifecycle leaves the active states during or right after the retries)
//      it resolves `"player-gone"` instead of a bare exhausted warning.
//   2. `startFrom`'s alive-mpv paths relaunch mpv at the start position on
//      `"player-gone"` instead of dropping the request.
//
// Tests log generously: each case prints the outcome, the elapsed time and the
// IPC call counts so a regression is diagnosable from the output alone.

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

const LIVE: LifecycleState = { kind: "socket-ready", launchId: 1 } as LifecycleState;
const IDLE: LifecycleState = { kind: "idle" };

const phase = (kind: "playing" | "launching"): PlaybackPhase =>
  (kind === "playing"
    ? { kind: "playing", gen: 1, lastLaunchedKey: null, lastReloadSignature: null, lastConsumedIntent: null }
    : { kind: "launching", gen: 1, intent: "auto", lastLaunchedKey: null, lastReloadSignature: null, lastConsumedIntent: null }) as PlaybackPhase;

type Harness = {
  params: ExternalMpvCommandsParams;
  lifecycleRef: { current: LifecycleState };
  command: Mock;
  request: Mock;
};

/** A dead mpv: commands fail with a missing socket, requests get no answer. */
const deadMpv = (lifecycle: LifecycleState, phaseKind: "playing" | "launching" = "playing"): Harness => {
  const command = vi.fn(async () => ({ error: "mpv_socket_missing" }));
  const request = vi.fn(async () => null);
  const lifecycleRef = { current: lifecycle };
  return {
    command,
    request,
    lifecycleRef,
    params: {
      mpvClient: { command, request, waitForReady: vi.fn(async () => false) } as unknown as ExternalMpvCommandsParams["mpvClient"],
      mpvFlagsRef: { current: { smokeTest: false, externalPlayer: true } },
      lifecycleRef,
      phaseRef: { current: phase(phaseKind) },
      lastKnownTimeRef: { current: 0 },
    },
  };
};

const timed = async <T,>(run: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> => {
  const t0 = performance.now();
  const value = await run();
  return { value, elapsedMs: performance.now() - t0 };
};

describe("ensureExternalSeek outcome (@bugfix @regression-proof start-from-dead-mpv-dropped #2776)", () => {
  it("reports player-gone when mpv's exit reaches the lifecycle during the retries", async () => {
    const h = deadMpv(LIVE);
    const hook = renderCommands(h.params);
    // The exit lands 300 ms into the seek, as it did in the e2e.
    window.setTimeout(() => {
      h.lifecycleRef.current = IDLE;
    }, 300);
    const { value, elapsedMs } = await timed(() => hook.current.ensureExternalSeek(4));
    console.info(
      `[start-from-dead-mpv] exit mid-seek: outcome=${String(value)} elapsedMs=${elapsedMs.toFixed(0)} ` +
        `commands=${h.command.mock.calls.length} requests=${h.request.mock.calls.length}`,
    );
    expect(value).toBe("player-gone");
    // It stops retrying once mpv is known gone instead of burning all six attempts.
    expect(elapsedMs).toBeLessThan(1_000);
  }, 15_000);

  it("reports player-gone when the exit reaches the lifecycle just after the retries ran out", async () => {
    const h = deadMpv(LIVE);
    const hook = renderCommands(h.params);
    window.setTimeout(() => {
      h.lifecycleRef.current = IDLE;
    }, 1_800);
    const { value, elapsedMs } = await timed(() => hook.current.ensureExternalSeek(4));
    console.info(`[start-from-dead-mpv] exit after retries: outcome=${String(value)} elapsedMs=${elapsedMs.toFixed(0)}`);
    expect(value).toBe("player-gone");
  }, 15_000);

  it("reports exhausted (not player-gone) when mpv stays alive but never reaches the target", async () => {
    const h = deadMpv(LIVE);
    const hook = renderCommands(h.params);
    const { value, elapsedMs } = await timed(() => hook.current.ensureExternalSeek(4));
    console.info(`[start-from-dead-mpv] still alive: outcome=${String(value)} elapsedMs=${elapsedMs.toFixed(0)}`);
    expect(value).toBe("exhausted");
  }, 15_000);

  it("reports settled when a live mpv lands on the target", async () => {
    const h = deadMpv(LIVE);
    h.command.mockImplementation(async () => ({ error: "success" }));
    h.request.mockImplementation(async () => ({ error: "success", data: 4.01 }));
    const hook = renderCommands(h.params);
    const { value } = await timed(() => hook.current.ensureExternalSeek(4));
    console.info(`[start-from-dead-mpv] live: outcome=${String(value)} commands=${h.command.mock.calls.length}`);
    expect(value).toBe("settled");
    expect(h.command).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("reports blocked when the phase gate drops the seek (launch in flight)", async () => {
    const h = deadMpv(LIVE, "launching");
    const hook = renderCommands(h.params);
    const { value } = await timed(() => hook.current.ensureExternalSeek(4));
    console.info(`[start-from-dead-mpv] gated: outcome=${String(value)} commands=${h.command.mock.calls.length}`);
    expect(value).toBe("blocked");
    expect(h.command).not.toHaveBeenCalled();
  }, 15_000);
});

describe("startFrom relaunches instead of dropping a start that finds mpv gone (#2776)", () => {
  const engineSource = readFileSync(
    resolve(process.cwd(), "src/renderer/src/lib/useMpvPlaybackEngine.ts"),
    "utf8",
  );
  const startFromBody = (() => {
    const start = engineSource.indexOf("const startFrom = useCallback(");
    const end = engineSource.indexOf("const prepareEpisodeStart = useCallback(", start);
    return start >= 0 && end > start ? engineSource.slice(start, end) : "";
  })();
  const relaunchBody = (() => {
    const start = engineSource.indexOf("const seekStartOrRelaunch = useCallback(");
    const end = engineSource.indexOf("}, [", start);
    return start >= 0 && end > start ? engineSource.slice(start, end) : "";
  })();

  it("both alive-mpv start paths go through seekStartOrRelaunch, never a bare void'd seek", () => {
    console.info(
      `[start-from-dead-mpv] startFrom body ${startFromBody.length} chars; ` +
        `seekStartOrRelaunch calls=${(startFromBody.match(/seekStartOrRelaunch\(/g) ?? []).length} ` +
        `bare seeks=${(startFromBody.match(/void ensureExternalSeek\(/g) ?? []).length}`,
    );
    expect(startFromBody.length).toBeGreaterThan(0);
    expect(startFromBody.match(/seekStartOrRelaunch\(/g) ?? []).toHaveLength(2);
    expect(startFromBody).not.toMatch(/void ensureExternalSeek\(/);
  });

  it("seekStartOrRelaunch relaunches at the start position when the seek reports player-gone", () => {
    console.info(`[start-from-dead-mpv] seekStartOrRelaunch body:\n${relaunchBody}`);
    expect(relaunchBody.length).toBeGreaterThan(0);
    expect(relaunchBody).toMatch(/[!=]== "player-gone"/);
    expect(relaunchBody).toMatch(/loadStream\(\{\s*startTime:/);
    // A newer start supersedes this one: it must not relaunch over it.
    expect(relaunchBody).toMatch(/startGenRef\.current !== gen/);
  });
});

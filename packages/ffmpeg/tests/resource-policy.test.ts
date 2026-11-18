/**
 * @bugfix background-encode-starves-playback @regression-proof
 *
 * Reference hardware: 4-core i5, no GPU encoder. A libx264/libx265 retranscode
 * running at (near-)normal priority with an auto-sized thread pool takes every
 * core and makes mpv drop frames / the UI lag. These tests pin the policy that
 * stops that: below-normal priority that is real on every platform, a thread
 * cap that leaves two cores free, and an x265 pool cap (libx265 ignores
 * `-threads`).
 */

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, getPriority, setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  backgroundEncodePriority,
  buildFfmpegThreadArgs,
  createBackgroundPriorityController,
  FFMPEG_BACKGROUND_NICENESS,
  FFMPEG_MAX_THREADS,
  FFMPEG_PLAYBACK_ACTIVE_NICENESS,
  resolveFfmpegNiceness,
  resolveFfmpegThreads,
  runFfprobe,
  type BackgroundPriorityDeps,
} from "../src/index";

describe("resolveFfmpegNiceness", () => {
  it("defaults to PRIORITY_BELOW_NORMAL — the lowest value libuv maps to a non-NORMAL Windows class", () => {
    console.info("[resource-policy:niceness] default =", resolveFfmpegNiceness({}));
    expect(FFMPEG_BACKGROUND_NICENESS).toBe(osConstants.priority.PRIORITY_BELOW_NORMAL);
    expect(resolveFfmpegNiceness({})).toBe(10);
  });

  it("honours SF_FFMPEG_NICE inside libuv's range and ignores junk", () => {
    expect(resolveFfmpegNiceness({ SF_FFMPEG_NICE: "0" })).toBe(0);
    expect(resolveFfmpegNiceness({ SF_FFMPEG_NICE: "19" })).toBe(19);
    expect(resolveFfmpegNiceness({ SF_FFMPEG_NICE: "20" })).toBe(10);
    expect(resolveFfmpegNiceness({ SF_FFMPEG_NICE: "abc" })).toBe(10);
    expect(resolveFfmpegNiceness({ SF_FFMPEG_NICE: "" })).toBe(10);
  });
});

describe("resolveFfmpegThreads", () => {
  it("leaves two cores free, never below 1", () => {
    const table: Array<[number, number]> = [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2], // the reference i5
      [6, 4],
      [8, 6],
      [12, 10],
    ];
    for (const [cores, expected] of table) {
      console.info(`[resource-policy:threads] cores=${cores} -> ${resolveFfmpegThreads(cores, {})}`);
      expect(resolveFfmpegThreads(cores, {})).toBe(expected);
    }
  });

  it("caps very wide hosts", () => {
    expect(resolveFfmpegThreads(32, {})).toBe(FFMPEG_MAX_THREADS);
    expect(resolveFfmpegThreads(256, {})).toBe(FFMPEG_MAX_THREADS);
  });

  it("falls back to a single thread for a nonsense core count", () => {
    expect(resolveFfmpegThreads(Number.NaN, {})).toBe(1);
    expect(resolveFfmpegThreads(0, {})).toBe(1);
  });

  it("SF_FFMPEG_THREADS overrides; 0 disables the cap", () => {
    expect(resolveFfmpegThreads(4, { SF_FFMPEG_THREADS: "3" })).toBe(3);
    expect(resolveFfmpegThreads(4, { SF_FFMPEG_THREADS: "0" })).toBe(0);
    expect(resolveFfmpegThreads(4, { SF_FFMPEG_THREADS: "nope" })).toBe(2);
    expect(resolveFfmpegThreads(4, { SF_FFMPEG_THREADS: "-1" })).toBe(2);
  });
});

describe("buildFfmpegThreadArgs", () => {
  it("caps decoder, encoder and filter graph for a software x264 encode", () => {
    expect(buildFfmpegThreadArgs({ threads: 2, softwareEncoder: true })).toEqual({
      input: ["-threads", "2"],
      output: ["-threads", "2", "-filter_threads", "2"],
    });
  });

  it("also caps libx265's own pool (it ignores -threads)", () => {
    expect(buildFfmpegThreadArgs({ threads: 2, softwareEncoder: true, x265: true })).toEqual({
      input: ["-threads", "2"],
      output: ["-threads", "2", "-x265-params", "pools=2", "-filter_threads", "2"],
    });
  });

  it("skips encoder flags for hardware encoders but still caps CPU decode + filters", () => {
    expect(buildFfmpegThreadArgs({ threads: 4, softwareEncoder: false })).toEqual({
      input: ["-threads", "4"],
      output: ["-filter_threads", "4"],
    });
  });

  it("emits nothing when the cap is disabled", () => {
    expect(buildFfmpegThreadArgs({ threads: 0, softwareEncoder: true })).toEqual({ input: [], output: [] });
  });
});

// Why this checks the setPriority CALL and never the child's niceness read back
// from the OS (#278): a host daemon (ananicy-cpp on the CI host, and on
// users' machines too) renices processes by name AFTER our setpriority, so a
// readback sees the daemon's value (-4, 19, ...), not our policy. What we own is
// the decision (which niceness, for which child, never above the parent), so the
// decision is asserted through an injected, recorded setPriority.
describe("background children are lowered by the policy", () => {
  const record = (parentNi: number) => {
    const calls: Array<{ id: number; value: number }> = [];
    const controller = createBackgroundPriorityController({
      getOwnPriority: () => parentNi,
      listThreadIds: (pid) => [pid],
      setPriority: (id, value) => {
        calls.push({ id, value });
      },
      env: {},
      info: () => {},
      warn: () => {},
    });
    return { calls, controller };
  };

  it("default: BELOW_NORMAL (10) when the parent is at normal priority", () => {
    const { calls, controller } = record(0);
    controller.track(100);
    expect(calls).toEqual([{ id: 100, value: FFMPEG_BACKGROUND_NICENESS }]);
    expect(FFMPEG_BACKGROUND_NICENESS).toBe(10);
  });

  it("explicit niceness: 0 inherits the parent's priority (no setPriority call)", () => {
    for (const parentNi of [0, 16]) {
      const { calls, controller } = record(parentNi);
      controller.track(100, 0);
      expect(calls).toEqual([]);
    }
  });

  it("parent already niced: never raised above the parent, still at least BELOW_NORMAL", () => {
    const table: Array<[parentNi: number, expected: number]> = [
      [4, 10], // parent ahead of BELOW_NORMAL: the child still drops to 10
      [10, 10],
      [16, 16], // parent below BELOW_NORMAL (service manager, `nice`): child must not jump ahead
      [19, 19],
    ];
    for (const [parentNi, expected] of table) {
      const { calls, controller } = record(parentNi);
      controller.track(100);
      expect(calls).toEqual([{ id: 100, value: expected }]);
    }
  });

  // The fake ffprobe is a `#!/bin/sh` script, which Windows cannot exec.
  it.skipIf(process.platform === "win32")("runFfprobe hands its child pid and the per-call niceness to the controller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-ffmpeg-nice-"));
    const fake = join(dir, "fake-ffprobe.sh");
    writeFileSync(fake, '#!/bin/sh\necho \'{"streams":[],"format":{}}\'\n');
    chmodSync(fake, 0o755);
    const track = vi.spyOn(backgroundEncodePriority, "track");
    try {
      await runFfprobe(["-v", "quiet"], { ffprobePath: fake });
      await runFfprobe(["-v", "quiet"], { ffprobePath: fake, niceness: 0 });
      expect(track).toHaveBeenCalledTimes(2);
      expect(track.mock.calls[0]?.[0]).toBeTypeOf("number");
      expect(track.mock.calls[0]?.[1]).toBeUndefined(); // default policy
      expect(track.mock.calls[1]?.[1]).toBe(0); // explicit: inherit the parent
    } finally {
      track.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * @bugfix @regression-proof P23 (ultimate confirm run 2026-10-07): background
 * format/backfill encodes kept competing with mpv for the same cores for the
 * whole playback session. While a playback session is open every background
 * encode drops to the lowest priority (IDLE class on Windows), including
 * encodes that were already running when playback started.
 */
describe("playback-active background encode throttle @bugfix @regression-proof", () => {
  const makeFakeDeps = (overrides: Partial<BackgroundPriorityDeps> = {}) => {
    const calls: Array<{ id: number; value: number }> = [];
    const infos: Array<Record<string, unknown>> = [];
    const warns: Array<Record<string, unknown>> = [];
    const deps: Partial<BackgroundPriorityDeps> = {
      setPriority: (id, value) => {
        calls.push({ id, value });
      },
      getOwnPriority: () => 0,
      listThreadIds: (pid) => [pid, pid + 1, pid + 2],
      env: {},
      info: (message, data) => {
        console.info(`[resource-policy:throttle] ${message}`, data);
        infos.push(data);
      },
      warn: (message, data) => {
        console.info(`[resource-policy:throttle] (warn) ${message}`, data);
        warns.push(data);
      },
      ...overrides,
    };
    return { deps, calls, infos, warns };
  };

  it("drops to the lowest priority while playback is active; the env override still wins", () => {
    console.info(`[resource-policy:throttle] lowest=${FFMPEG_PLAYBACK_ACTIVE_NICENESS}`);
    expect(FFMPEG_PLAYBACK_ACTIVE_NICENESS).toBe(osConstants.priority.PRIORITY_LOW);
    expect(FFMPEG_PLAYBACK_ACTIVE_NICENESS).toBe(19);
    expect(FFMPEG_PLAYBACK_ACTIVE_NICENESS).toBeGreaterThan(FFMPEG_BACKGROUND_NICENESS);
    expect(resolveFfmpegNiceness({}, true)).toBe(FFMPEG_PLAYBACK_ACTIVE_NICENESS);
    expect(resolveFfmpegNiceness({}, false)).toBe(FFMPEG_BACKGROUND_NICENESS);
    expect(resolveFfmpegNiceness({ SF_FFMPEG_NICE: "5" }, true)).toBe(5);
  });

  it("renices every thread of running encodes on playback start and stop, and new spawns start at the current level", () => {
    const { deps, calls, infos } = makeFakeDeps();
    const controller = createBackgroundPriorityController(deps);
    try {
      const untrack = controller.track(100);
      expect(calls).toEqual([100, 101, 102].map((id) => ({ id, value: FFMPEG_BACKGROUND_NICENESS })));
      calls.length = 0;

      controller.setPlaybackActive(true, { reason: "playback.stream_prepared", sessionId: "s1" });
      expect(calls).toEqual([100, 101, 102].map((id) => ({ id, value: FFMPEG_PLAYBACK_ACTIVE_NICENESS })));
      expect(infos.at(-1)).toMatchObject({
        playbackActive: true,
        niceness: FFMPEG_PLAYBACK_ACTIVE_NICENESS,
        tracked: 1,
        reniced: 1,
        failed: 0,
        reason: "playback.stream_prepared",
      });
      calls.length = 0;

      // Spawned during playback: starts throttled.
      controller.track(200);
      expect(calls.every((c) => c.value === FFMPEG_PLAYBACK_ACTIVE_NICENESS)).toBe(true);
      calls.length = 0;

      // A repeated "active" signal (second session) is not a transition.
      controller.setPlaybackActive(true);
      expect(calls).toEqual([]);

      controller.setPlaybackActive(false, { reason: "playback.stream_released" });
      expect(new Set(calls.map((c) => c.value))).toEqual(new Set([FFMPEG_BACKGROUND_NICENESS]));
      expect(new Set(calls.map((c) => c.id))).toEqual(new Set([100, 101, 102, 200, 201, 202]));
      calls.length = 0;

      untrack();
      expect(controller.trackedCount()).toBe(1);
      controller.setPlaybackActive(true);
      expect(new Set(calls.map((c) => c.id))).toEqual(new Set([200, 201, 202]));
    } catch (err) {
      console.error(`[resource-policy:throttle] snapshot calls=${JSON.stringify(calls)} infos=${JSON.stringify(infos)}`);
      throw err;
    }
  });

  it("leaves explicitly pinned children alone, never raises above the parent, and counts failures", () => {
    const { deps, calls, infos, warns } = makeFakeDeps({
      getOwnPriority: () => 15,
      listThreadIds: (pid) => [pid], // no per-thread niceness on this OS: one id per process
      setPriority: (id, value) => {
        if (id === 300) throw new Error("EACCES");
        calls.push({ id, value });
      },
    });
    const controller = createBackgroundPriorityController(deps);
    try {
      controller.track(10, 0); // foreground op: niceness 0 = inherit, pinned
      controller.track(20);
      controller.track(300);
      // Parent already at 15: the background default (10) is clamped up to 15.
      expect(calls).toEqual([{ id: 20, value: 15 }]);
      expect(warns).toHaveLength(1);
      calls.length = 0;

      controller.setPlaybackActive(true);
      expect(calls).toEqual([{ id: 20, value: FFMPEG_PLAYBACK_ACTIVE_NICENESS }]);
      expect(infos.at(-1)).toMatchObject({ tracked: 3, reniced: 1, failed: 1 });
      // The failure is logged once, not per transition.
      expect(warns).toHaveLength(1);
    } catch (err) {
      console.error(
        `[resource-policy:throttle] snapshot calls=${JSON.stringify(calls)} infos=${JSON.stringify(infos)} warns=${JSON.stringify(warns)}`
      );
      throw err;
    }
  });

  // Real-OS smoke, host-independent: the kernel accepts our setpriority on a live
  // child at spawn and at playback start (both only RAISE niceness, which needs no
  // privilege). Playback stop is not asserted: lowering niceness again needs
  // CAP_SYS_NICE / RLIMIT_NICE, so EACCES there is documented, logged-once behaviour.
  // The resulting niceness is deliberately not read back (see the ananicy-cpp note above).
  it.skipIf(process.platform === "win32")(
    "a real running child accepts the policy's setPriority on spawn and on playback start",
    () => {
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      const calls: Array<{ id: number; value: number }> = [];
      const parentNi = getPriority(0);
      try {
        expect(child.pid).toBeTypeOf("number");
        const controller = createBackgroundPriorityController({
          getOwnPriority: () => parentNi,
          setPriority: (id, value) => {
            setPriority(id, value); // throws if the OS refuses
            calls.push({ id, value });
          },
          warn: (message, data) => {
            throw new Error(`unexpected warning: ${message} ${JSON.stringify(data)}`);
          },
          info: () => {},
        });
        controller.track(child.pid);
        expect(calls.length).toBeGreaterThan(0);
        expect(new Set(calls.map((c) => c.value))).toEqual(new Set([Math.max(FFMPEG_BACKGROUND_NICENESS, parentNi)]));
        calls.length = 0;

        controller.setPlaybackActive(true, { reason: "test" });
        expect(new Set(calls.map((c) => c.value))).toEqual(
          new Set([Math.max(FFMPEG_PLAYBACK_ACTIVE_NICENESS, parentNi)])
        );
      } finally {
        child.kill();
      }
    }
  );
});

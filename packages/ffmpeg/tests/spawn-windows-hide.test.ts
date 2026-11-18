/**
 * ffmpeg / ffprobe must not open a console window on Windows.
 *
 * The app spawns the runtime detached, so on Windows the runtime has no console. ffmpeg and ffprobe are
 * console programs: spawned without `windowsHide`, each run got its own visible console window (Badger
 * 0.1.0, first Windows user, during a movie import), and closing one killed that ffmpeg (CTRL_CLOSE_EVENT),
 * so the import failed. spawnCommand now spreads the platform's `processes.spawnOptions({ detached: false })`
 * into the spawn, which on Windows carries `windowsHide: true` (libuv: CREATE_NO_WINDOW).
 *
 * This file runs under vitest (Node), so it covers the node:child_process branch; the Bun.spawn branch gets
 * the same options object and is covered by the source guard `tests/tools/windows_console_hide.test.ts`.
 *
 * @req PLAT-DESK-13 @bugfix @regression-proof windows-console-windows
 */

import type * as ChildProcessModule from "node:child_process";
import { getDesktopPlatform, setDesktopPlatformForTests } from "@space/desktop-platform";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnCalls = vi.hoisted(() => [] as Array<{ command: string; options: Record<string, unknown> }>);

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  return {
    ...original,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ command, options });
      return original.spawn(command, args, options);
    },
  };
});

import { runFfmpeg, runFfprobe } from "../src/index";

const SUITE = "spawn-windows-hide";
const MISSING = "/nonexistent/sf-missing-binary";

describe("ffmpeg/ffprobe spawns hide their console on Windows", () => {
  afterEach(() => {
    setDesktopPlatformForTests(null);
    spawnCalls.length = 0;
  });

  const pinWindowsSpawnOptions = () => {
    const host = getDesktopPlatform();
    const requested: Array<{ detached: boolean }> = [];
    // The Windows layer's answer (packages/desktop-platform-windows/src/processes.ts).
    const spawnOptions = (options: { detached: boolean }) => {
      requested.push(options);
      return { detached: options.detached, windowsHide: true };
    };
    setDesktopPlatformForTests({ ...host, processes: { ...host.processes, spawnOptions } });
    return requested;
  };

  it("@req PLAT-DESK-13 @bugfix @regression-proof runFfprobe spawns with the platform's windowsHide", async () => {
    const requested = pinWindowsSpawnOptions();
    console.info(`[${SUITE}:ffprobe] spawning ${MISSING} with a Windows spawnOptions`);
    await expect(runFfprobe(["-version"], { ffprobePath: MISSING })).rejects.toThrow(/ENOENT/);
    console.info(`[${SUITE}:ffprobe] spawnOptions requests=${JSON.stringify(requested)} spawns=${JSON.stringify(spawnCalls)}`);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe(MISSING);
    expect(spawnCalls[0].options).toMatchObject({ windowsHide: true, detached: false });
    expect(requested).toEqual([{ detached: false }]);
  }, 5_000);

  it("@req PLAT-DESK-13 @bugfix @regression-proof runFfmpeg spawns with the platform's windowsHide", async () => {
    const requested = pinWindowsSpawnOptions();
    console.info(`[${SUITE}:ffmpeg] spawning ${MISSING} with a Windows spawnOptions`);
    await expect(runFfmpeg(["-version"], { ffmpegPath: MISSING, progress: { enabled: false } })).rejects.toThrow(/ENOENT/);
    console.info(`[${SUITE}:ffmpeg] spawnOptions requests=${JSON.stringify(requested)} spawns=${JSON.stringify(spawnCalls)}`);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].options).toMatchObject({ windowsHide: true, detached: false });
  }, 5_000);
});

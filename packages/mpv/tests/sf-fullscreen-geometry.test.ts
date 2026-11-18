/**
 * @bugfix mpv-fullscreen-shrunk-by-geometry-lock
 * @regression-proof
 *
 * Issue #2643 (macos-ultimate run 33463, 70 `video_corrupt_frames` across the grid; replay 34521:
 * c021 90 + 201, c028 269, c034 250 + 277 undecodable strip grabs). Every corrupt-frame screenshot
 * shows the video drawn in the top-left 70 % of the screen. mpv's log
 * (mpv-2-1794821850150.log) has the window fullscreen at 0.497 s (`Window size: 3024x1964`), then
 * sf.lua's geometry lock (file-loaded / video-params -> lock_window_size + `geometry=70%x70%`) at
 * 0.525 s, and the window at `2116x1330` (70 %) for the rest of that player's life: on macOS
 * setting autofit/geometry while fullscreen resizes the window out of fullscreen, so the player
 * showed a shrunk picture after a launch or reload.
 *
 * Fix (resources/osc/sf.lua): the windowed geometry lock is not applied while fullscreen; mpv keeps
 * the windowed size for when fullscreen ends. Windowed playback is still locked.
 *
 * Runs the REAL sf.lua under tests/lua/mp_mock.lua. Skips loudly when no Lua
 * interpreter is on PATH; in CI (SF_REQUIRE_MEDIA_BINARIES=1) a missing one fails the file.
 */
import { describe, expect, it } from "vitest";
import { requireMediaBinary } from "@space/media-deps";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TAG = "[sf-fullscreen-geometry]";
const sfLua = fileURLToPath(new URL("../resources/osc/sf.lua", import.meta.url));
const driver = fileURLToPath(new URL("./lua/sf_fullscreen_geometry_scenario.lua", import.meta.url));
const LUA_CANDIDATES = ["luajit", "lua5.1", "lua5.2", "lua"];
const lua = LUA_CANDIDATES.find((bin) => spawnSync(bin, ["-v"]).status === 0) ?? null;
requireMediaBinary("a Lua interpreter (luajit, lua5.1, lua5.2 or lua)", lua !== null);
if (!lua) console.warn(`${TAG} SKIP: no Lua interpreter on PATH (tried ${LUA_CANDIDATES.join(", ")})`);

type Phase = { phase: string; fullscreen: boolean; sets: string[] | Record<string, never> };

function run(): Phase[] {
  const proc = spawnSync(lua!, [driver, sfLua], { encoding: "utf8", timeout: 30_000 });
  const line = (proc.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  if (proc.status !== 0 || !line) {
    console.error(`${TAG} exit=${proc.status}\n${proc.stdout ?? ""}${proc.stderr ?? ""}`);
    throw new Error(`scenario failed (exit ${proc.status})`);
  }
  const phases = (JSON.parse(line.slice("RESULT ".length)) as { phases: Phase[] }).phases;
  console.info(`${TAG} ${JSON.stringify(phases)}`);
  return phases;
}

const setsOf = (p: Phase | undefined): string[] => (p && Array.isArray(p.sets) ? p.sets : []);

describe.skipIf(!lua)("sf.lua window geometry lock and fullscreen (#2643)", () => {
  it("@bugfix @regression-proof sets no window geometry while fullscreen, still locks it windowed", () => {
    const phases = run();
    const byName = Object.fromEntries(phases.map((p) => [p.phase, p]));
    expect(setsOf(byName["file-loaded while fullscreen"])).toEqual([]);
    expect(setsOf(byName["video-params while fullscreen"])).toEqual([]);
    expect(byName["video-params while fullscreen"]?.fullscreen).toBe(true);
    expect(setsOf(byName["file-loaded windowed"])).toContain("geometry=70%x70%");
  });
});

/**
 * @bugfix mpv-pill-state-ipc-flood
 * @bugfix mpv-subtitles-lost-after-reload
 * @regression-proof
 *
 * Ultimate-stress findings (#25), both in resources/osc/sf.lua:
 *
 * NEW-pill-state-flood: emit_pill_state ran on every refresh_pill, i.e. per
 * frame, so mpv pushed ~16-24 `sf-pill-state` script-messages a second
 * through IPC into the desktop main process even when nothing changed.
 * Pre-fix: 100 refresh ticks -> 100 emits; 10 s at 24 fps -> 240 emits.
 * Fix: emit on a visible-state change, plus a 1 Hz heartbeat.
 *
 * NEW-subs-lost-after-reload: apply_subtitles_json returned early on a stale
 * `subtitles_applied` (still true from the previous load when the renderer's
 * re-send landed before the reload's start-file), start-file then wiped
 * pending_subtitles, and file-loaded had nothing to re-apply, so subtitles
 * vanished after a reload / next file. Pre-fix: 0 sub-add after the reload.
 * Fix: cache the last list and re-apply it on file-loaded.
 *
 * Runs the REAL sf.lua under tests/lua/mp_mock.lua. Skips loudly when no Lua
 * interpreter is on PATH; in CI (SF_REQUIRE_MEDIA_BINARIES=1) a missing one fails the file.
 */
import { describe, expect, it } from "vitest";
import { requireMediaBinary } from "@space/media-deps";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TAG = "[sf-pill-state-and-subs]";
const sfLua = fileURLToPath(new URL("../resources/osc/sf.lua", import.meta.url));
const driver = fileURLToPath(new URL("./lua/sf_pill_subs_scenario.lua", import.meta.url));

const LUA_CANDIDATES = ["luajit", "lua5.1", "lua5.2", "lua"];
const lua = LUA_CANDIDATES.find((bin) => spawnSync(bin, ["-v"]).status === 0) ?? null;
requireMediaBinary("a Lua interpreter (luajit, lua5.1, lua5.2 or lua)", lua !== null);
if (!lua) {
  console.warn(`${TAG} SKIP: no Lua interpreter on PATH (tried ${LUA_CANDIDATES.join(", ")})`);
} else {
  console.info(`${TAG} using ${lua}: ${spawnSync(lua, ["-v"]).stdout.toString().trim()} sf.lua=${sfLua}`);
}

type Result = Record<string, unknown> & { log: string };

// The mock's JSON encoder writes an empty Lua table as {}; normalise to arrays.
const asArray = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);

const runScenario = (scenario: string): Result => {
  const proc = spawnSync(lua!, [driver, sfLua, scenario], { encoding: "utf8", timeout: 30_000 });
  const log = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const resultLine = (proc.stdout ?? "").split("\n").find((line) => line.startsWith("RESULT "));
  if (proc.status !== 0 || !resultLine) {
    console.error(`${TAG} scenario=${scenario} exit=${proc.status} signal=${proc.signal}\n${log}`);
    throw new Error(`scenario ${scenario} failed (exit ${proc.status})`);
  }
  const parsed = JSON.parse(resultLine.slice("RESULT ".length)) as Record<string, unknown>;
  const relevant = log
    .split("\n")
    .filter((line) => /sf-subs|sub-add|reload|event:|rror|warn/.test(line))
    .join("\n");
  console.info(`${TAG} scenario=${scenario} result=${resultLine.slice("RESULT ".length)}\n${relevant}`);
  return { ...parsed, log };
};

describe.skipIf(!lua)("sf.lua sf-pill-state is emitted on change + 1 Hz heartbeat (#25 NEW-pill-state-flood)", () => {
  it("100 ticks with an unchanged payload emit at most once; 10 s of playback emit ~1/s; a change emits on its tick", () => {
    const r = runScenario("pill-flood");
    expect(r.emitsPer100Ticks, "emits across 100 unchanged refresh ticks").toBeLessThanOrEqual(1);
    // Heartbeat: about one emit per second of unchanged playback, not per frame.
    expect(r.emitsPer10s as number).toBeGreaterThanOrEqual(8);
    expect(r.emitsPer10s as number).toBeLessThanOrEqual(11);
    expect(r.lastTimePos, "heartbeat carries time-pos").toEqual(expect.any(Number));
    // The pill appearing is emitted on the first tick inside the marker.
    const state = r.activeState as { active: boolean; kind: string; timePos: number; countdown: number };
    expect(state.active).toBe(true);
    expect(state.kind).toBe("skip_intro");
    expect(state.timePos).toBeGreaterThanOrEqual((r.introStart as number) - 1e-6);
    expect(state.timePos).toBeLessThanOrEqual((r.introStart as number) + 1 / 24 + 1e-6);
    // A visible countdown changes once per second: ~5 emits in 5 s, not 120.
    expect(r.emitsPer5sCountdown as number).toBeGreaterThanOrEqual(4);
    expect(r.emitsPer5sCountdown as number).toBeLessThanOrEqual(6);
    // countdown is the whole-second value the pill shows (end 30 s after start, 5 s in).
    expect(r.countdownAfter5s).toBe(25);
  });
});

describe.skipIf(!lua)("sf.lua subtitles survive a reload / next file (#25 NEW-subs-lost-after-reload)", () => {
  it("re-applies subtitles on file-loaded when the re-send landed before the reload's start-file", () => {
    const r = runScenario("subs-resend-before-start");
    expect(r.addsInitial).toBe(1);
    expect(r.addsAfterReload, "sub-add after start-file + file-loaded").toBe(1);
    expect(asArray(r.externalSubs)).toEqual(["http://127.0.0.1/subs/ep1-en.vtt"]);
  });

  it("re-applies the cached subtitles on file-loaded when the renderer does not re-send (quality reload)", () => {
    const r = runScenario("subs-no-resend");
    expect(r.addsAfterReload).toBe(1);
    expect(asArray(r.externalSubs)).toEqual(["http://127.0.0.1/subs/ep1-en.vtt"]);
  });

  it("next file: applies the new list sent before start-file, not the previous file's", () => {
    const r = runScenario("subs-next-file-early");
    expect(r.addsBAfterReload).toBe(1);
    expect(r.addsAAfterReload).toBe(0);
    expect(asArray(r.externalSubs)).toEqual(["http://127.0.0.1/subs/ep2-en.vtt"]);
  });

  it("next file without subtitles: an empty list clears the cache so nothing leaks", () => {
    const r = runScenario("subs-next-file-empty");
    expect(r.addsAfterReload).toBe(0);
    expect(asArray(r.externalSubs)).toEqual([]);
  });
});

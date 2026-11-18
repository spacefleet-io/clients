/**
 * @bugfix mpv-pill-blinks-on-abr-reload
 * @regression-proof
 *
 * Issue #25, ultimate run seed 1791529129542, shard-3
 * (a Linux test machine), case c055 `osc-pill-disappear`: the skip-intro pill vanished
 * at 145.92 s although the intro ends at 150 s.
 *
 * Live evidence: right after the harness seeked to 145.936 s (mid-intro, pill
 * shown) the throttled network stalled and Auto quality downshifted
 * 1080p→480p (timeline `abr downshift`). The renderer reloaded the same
 * episode with `loadfile replace start=145.938` (mpv-10-1792047556669.log
 * L1261). The old file ended, time-pos became unavailable and sf.lua's
 * refresh_pill drew nothing and emitted `active:false` (L1289), until the new
 * stream's file-loaded re-applied the envelope 0.66 s later (L1689-1703).
 * The clip (osc-pill-disappear-1.mp4) shows the pill gone for frames 50-55.
 *
 * Fix (resources/osc/sf.lua): a drawn pill is HELD while time-pos is
 * unavailable between files. The hold ends when time-pos is known again (the
 * reloaded envelope decides), when an envelope for other media arrives, or
 * when mpv goes idle.
 *
 * Runs the REAL sf.lua under tests/lua/mp_mock.lua. Skips loudly when no Lua
 * interpreter is on PATH; in CI (SF_REQUIRE_MEDIA_BINARIES=1) a missing one fails the file.
 */
import { describe, expect, it } from "vitest";
import { requireMediaBinary } from "@space/media-deps";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TAG = "[sf-pill-survives-reload]";
const sfLua = fileURLToPath(new URL("../resources/osc/sf.lua", import.meta.url));
const driver = fileURLToPath(new URL("./lua/sf_pill_reload_scenario.lua", import.meta.url));

const LUA_CANDIDATES = ["luajit", "lua5.1", "lua5.2", "lua"];
const lua = LUA_CANDIDATES.find((bin) => spawnSync(bin, ["-v"]).status === 0) ?? null;
requireMediaBinary("a Lua interpreter (luajit, lua5.1, lua5.2 or lua)", lua !== null);
if (!lua) {
  console.warn(`${TAG} SKIP: no Lua interpreter on PATH (tried ${LUA_CANDIDATES.join(", ")})`);
} else {
  console.info(`${TAG} using ${lua}: ${spawnSync(lua, ["-v"]).stdout.toString().trim()} sf.lua=${sfLua}`);
}

type Emit = { active: boolean; kind?: string; timePos?: number };
type Step = { step: string; wall: number; timePos?: number; pillDrawn: boolean; emits: Emit[] | Record<string, never> };
type Result = { scenario: string; steps: Step[] };

// The mock's JSON encoder writes an empty Lua table as {}; normalise to arrays.
const emitsOf = (step: Step): Emit[] => (Array.isArray(step.emits) ? step.emits : []);

const runScenario = (scenario: string): Result => {
  const proc = spawnSync(lua!, [driver, sfLua, scenario], { encoding: "utf8", timeout: 30_000 });
  const log = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const resultLine = (proc.stdout ?? "").split("\n").find((line) => line.startsWith("RESULT "));
  if (proc.status !== 0 || !resultLine) {
    console.error(`${TAG} scenario=${scenario} exit=${proc.status} signal=${proc.signal}\n${log}`);
    throw new Error(`scenario ${scenario} failed (exit ${proc.status})`);
  }
  const relevant = log
    .split("\n")
    .filter((line) => /STEP|sf-pill|event:|rror|warn/.test(line))
    .join("\n");
  console.info(`${TAG} scenario=${scenario}\n${relevant}`);
  return JSON.parse(resultLine.slice("RESULT ".length)) as Result;
};

const stepNamed = (r: Result, name: string): Step => {
  const step = r.steps.find((s) => s.step === name);
  if (!step) throw new Error(`${TAG} ${r.scenario}: no step "${name}" in ${r.steps.map((s) => s.step).join(", ")}`);
  return step;
};

const stepsBetween = (r: Result, from: string, to: string): Step[] => {
  const start = r.steps.findIndex((s) => s.step === from);
  const end = r.steps.findIndex((s) => s.step === to);
  if (start < 0 || end < start) throw new Error(`${TAG} ${r.scenario}: bad step range ${from} → ${to}`);
  return r.steps.slice(start, end + 1);
};

// @req PLAY-NEXT-03: the skip offer stays drawn across an Auto-quality reload of the same media.
describe.skipIf(!lua)("sf.lua skip pill survives a same-media reload (#25 c055 osc-pill-disappear)", () => {
  it("c055 replay: the pill stays drawn and never reports inactive across the ABR reload", () => {
    const r = runScenario("abr-reload");
    expect(stepNamed(r, "pill drawn before reload").pillDrawn, "precondition: pill drawn at 147.4 s").toBe(true);
    const window = stepsBetween(r, "old file ended (time-pos nil)", "0.5 s after reload");
    for (const step of window) {
      console.info(`${TAG} abr-reload ${step.step}: pillDrawn=${step.pillDrawn} emits=${JSON.stringify(step.emits)}`);
      expect(step.pillDrawn, `pill drawn at "${step.step}"`).toBe(true);
      for (const emit of emitsOf(step)) {
        expect(emit.active, `sf-pill-state at "${step.step}": ${JSON.stringify(emit)}`).toBe(true);
      }
    }
    // Once the new stream plays, the pill is the reloaded envelope's intro pill.
    const loaded = emitsOf(stepNamed(r, "file-loaded"));
    expect(loaded.at(-1)).toMatchObject({ active: true, kind: "skip_intro", timePos: 145.938 });
  });

  it("control: an envelope for other media (next episode) clears the held pill at once", () => {
    const r = runScenario("next-episode");
    const sent = stepNamed(r, "next episode envelope sent");
    expect(sent.pillDrawn, "old episode's pill after the next episode's envelope").toBe(false);
    for (const step of stepsBetween(r, "next episode envelope sent", "0.5 s after load")) {
      expect(step.pillDrawn, `pill drawn at "${step.step}"`).toBe(false);
    }
    const reported = r.steps.flatMap(emitsOf);
    expect(reported.at(-1)?.active, "last sf-pill-state").toBe(false);
  });

  it("control: a reload that lands outside the marker clears the pill once time-pos is known", () => {
    const r = runScenario("reload-outside-marker");
    expect(stepNamed(r, "file-loaded").pillDrawn).toBe(false);
    expect(stepNamed(r, "first time-pos tick").pillDrawn).toBe(false);
    const reported = r.steps.flatMap(emitsOf);
    expect(reported.at(-1)?.active, "last sf-pill-state").toBe(false);
  });

  it("control: playback stopping (mpv idle) clears the held pill", () => {
    const r = runScenario("stopped-idle");
    expect(stepNamed(r, "idle-active true").pillDrawn).toBe(false);
    expect(stepNamed(r, "idle 0.5 s").pillDrawn).toBe(false);
    const reported = r.steps.flatMap(emitsOf);
    expect(reported.at(-1)?.active, "last sf-pill-state").toBe(false);
  });
});

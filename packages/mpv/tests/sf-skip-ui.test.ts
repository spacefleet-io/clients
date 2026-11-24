/**
 * sf.lua's skip UI under the mocked mp runtime (tests/lua/sf_skip_ui_scenario.lua): the "Intro skipped. Was it
 * right?" line, the Change times panel, the save-scope step and the control bar's skip menu. The renderer half
 * (what a verdict or a save stores) is apps/badger/desktop/tests/mpv-skip-edit.test.ts.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TAG = "[sf-skip-ui]";
const sfLua = fileURLToPath(new URL("../resources/osc/sf.lua", import.meta.url));
const driver = fileURLToPath(new URL("./lua/sf_skip_ui_scenario.lua", import.meta.url));
const LUA_CANDIDATES = ["luajit", "lua5.1", "lua5.2", "lua"];
const lua = LUA_CANDIDATES.find((bin) => spawnSync(bin, ["-v"]).status === 0) ?? null;
if (!lua) console.warn(`${TAG} SKIP: no Lua interpreter on PATH (tried ${LUA_CANDIDATES.join(", ")})`);

type Checkpoint = { label: string; media: number; paused: boolean; skip: string; pill: string };
type ScenarioResult = {
  edits: string[][];
  checkpoints: Checkpoint[];
  menus: { prompt: string; items: string[] }[];
  returnPos?: number;
  log: string;
};

// The mock's JSON encoder writes an empty Lua table as {}; normalise to arrays.
const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const runScenario = (scenario: string): ScenarioResult => {
  const proc = spawnSync(lua!, [driver, sfLua, scenario], { encoding: "utf8", timeout: 30_000 });
  const log = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const resultLine = (proc.stdout ?? "").split("\n").find((line) => line.startsWith("RESULT "));
  if (proc.status !== 0 || !resultLine) {
    console.error(`${TAG} scenario=${scenario} exit=${proc.status}\n${log}`);
    throw new Error(`scenario ${scenario} failed (exit ${proc.status})`);
  }
  const parsed = JSON.parse(resultLine.slice("RESULT ".length)) as Record<string, unknown>;
  return {
    edits: asArray<string[]>(parsed.edits),
    checkpoints: asArray<Checkpoint>(parsed.checkpoints),
    menus: asArray<{ prompt: string; items: string[] }>(parsed.menus),
    returnPos: typeof parsed.returnPos === "number" ? parsed.returnPos : undefined,
    log,
  };
};

const checkpoint = (result: ScenarioResult, label: string): Checkpoint => {
  const found = result.checkpoints.find((c) => c.label === label);
  if (!found) throw new Error(`no checkpoint ${label}\n${result.log}`);
  return found;
};

// @req PLAY-SKIP-01[badger-desktop] PLAY-SKIP-03[badger-desktop]
describe.skipIf(!lua)("sf.lua asks whether a skipped intro was right", () => {
  it("after the intro skips by itself, 'Yes' reports the times and thanks the user", () => {
    const result = runScenario("asked-yes");
    const asked = checkpoint(result, "asked");
    console.info(`${TAG} asked-yes edits=${JSON.stringify(result.edits)} media=${asked.media}`);
    expect(asked.media, "the intro was skipped to its end").toBeGreaterThanOrEqual(150);
    expect(asked.skip).toContain("Intro skipped. Was it right?");
    expect(asked.skip).toContain("}Yes");
    expect(asked.skip).toContain("}Change times");
    expect(asked.pill, "the pill makes room for the line").not.toContain("Skip intro");
    expect(result.edits).toEqual([["verdict", "intro", "60.000", "150.000", "1200.000"]]);
    const after = checkpoint(result, "after-yes");
    expect(after.skip).toBe("");
    expect(after.pill).toContain("Thanks");
  });

  it("goes away by itself after a few seconds without reporting anything", () => {
    const result = runScenario("asked-timeout");
    expect(checkpoint(result, "asked").skip).toContain("Was it right?");
    expect(checkpoint(result, "after-wait").skip).toBe("");
    expect(result.edits).toEqual([]);
  });

  it("never asks about times it is sure of (the metadata service's, the user's own, or sure detection)", () => {
    const skipped = checkpoint(runScenario("sure-no-ask"), "skipped");
    expect(skipped.media, "the intro was skipped").toBeGreaterThanOrEqual(150);
    expect(skipped.skip).toBe("");
  });

  it("asks after the user skips unsure credits; Yes reports the credits", () => {
    const result = runScenario("credits-asked");
    const asked = checkpoint(result, "asked");
    expect(asked.media, "the credits were skipped").toBeGreaterThanOrEqual(1190);
    expect(asked.skip).toContain("Credits skipped. Was it right?");
    expect(result.edits).toEqual([["verdict", "credits", "1100.000", "1190.000", "1200.000"]]);
  });

  it("follows the app's language @req PLAY-SKIP-07[badger-desktop]", () => {
    const asked = checkpoint(runScenario("asked-french"), "asked");
    expect(asked.skip).toContain("Générique passé. C’était bien ?");
    expect(asked.skip).toContain("}Oui");
    expect(asked.skip).toContain("}Modifier les temps");
  });
});

// @req PLAY-SKIP-04[badger-desktop] PLAY-SKIP-05[badger-desktop]
describe.skipIf(!lua)("sf.lua Change times panel and save scope", () => {
  it("pauses on the handle's frame, moves it by 1 s per arrow key, asks the scope, saves, then plays on where it was", () => {
    const result = runScenario("change-save");
    const panel = checkpoint(result, "panel");
    console.info(`${TAG} change-save edits=${JSON.stringify(result.edits)} return=${result.returnPos}`);
    expect(panel.paused, "the panel pauses").toBe(true);
    expect(panel.media, "the picture shows the end handle's frame").toBeCloseTo(150, 3);
    expect(panel.skip).toContain("Save  [Enter]");
    expect(panel.skip).toContain("Cancel  [Esc]");
    expect(checkpoint(result, "nudged").media, "two LEFT presses move the end 2 s back").toBeCloseTo(148, 3);

    const scope = checkpoint(result, "scope");
    expect(scope.skip).toContain("Use these times for");
    expect(scope.skip).toContain("This season");
    expect(scope.skip).toContain("Only this episode");
    expect(scope.skip, "never an episode count").not.toMatch(/\d+\s+episodes?/i);

    expect(result.edits).toEqual([
      ["preselect", "intro", "60.000", "148.000"],
      ["save", "intro", "60.000", "148.000", "episode", "1200.000"],
    ]);
    const saved = checkpoint(result, "saved");
    expect(saved.skip).toBe("");
    expect(saved.pill).toContain("Saved for this episode");
    expect(saved.paused, "playing again").toBe(false);
    expect(saved.media).toBeGreaterThanOrEqual(result.returnPos! - 1e-3);
  });

  it("Esc cancels without saving and plays on where it was", () => {
    const result = runScenario("change-cancel");
    const cancelled = checkpoint(result, "cancelled");
    expect(result.edits).toEqual([]);
    expect(cancelled.skip).toBe("");
    expect(cancelled.paused).toBe(false);
    expect(cancelled.media).toBeGreaterThanOrEqual(result.returnPos! - 1e-3);
    expect(cancelled.media).toBeLessThan(result.returnPos! + 1);
  });
});

// @req PLAY-SKIP-10[badger-desktop]
describe.skipIf(!lua)("sf.lua control bar skip menu", () => {
  it("without times, offers to mark where the intro ends and where the credits start, at the current moment", () => {
    const result = runScenario("menu-without-times");
    expect(result.menus[0]!.items).toEqual(["Intro ends here", "Credits start here"]);
    expect(checkpoint(result, "intro-ends-here").paused).toBe(true);
    expect(result.edits[0]!.slice(0, 3)).toEqual(["preselect", "intro", "0.000"]);
    expect(Number(result.edits[0]![3])).toBeCloseTo(300.5, 1);
  });

  it("with times, offers to change them; the credits panel opens on their start", () => {
    const result = runScenario("menu-with-times");
    expect(result.menus[0]!.items).toEqual(["Change intro times", "Change credits times"]);
    const panel = checkpoint(result, "change-credits");
    expect(panel.paused).toBe(true);
    expect(panel.media).toBeCloseTo(1100, 3);
  });
});

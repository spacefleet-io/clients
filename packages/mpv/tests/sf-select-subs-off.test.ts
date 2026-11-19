/**
 * @bugfix mpv-subtitles-cannot-be-turned-off
 * @regression-proof
 *
 * Issue #25, reported by Chris on "Orchard": the film has exactly one subtitle
 * track (French) and the app selects it by default. Once playback runs there is
 * no way to turn it off from the OSC: the subtitle menu (sf-select.lua) listed
 * only the tracks, so "off" was never a row to pick, and the track-picked
 * toggle on the selected row was invisible to the user.
 *
 * Fix: the subtitle menu (property `sid`) leads with an "Off" row, labelled
 * with the app's UI-language string (`sf-labels-json`: "Off" / "Aucun"). It is
 * the current row (● and the cursor's start row) whenever no subtitle is
 * selected. Picking it sets sid=no and reports `sf-track-picked sid no`;
 * picking a track afterwards turns it on. The aid / secondary-sid menus are
 * unchanged.
 *
 * Runs the REAL sf-select.lua under tests/lua/mp_mock.lua. Skips loudly when no
 * Lua interpreter is on PATH (the CI image has none; run locally).
 */
import { describe, expect, it } from "vitest";
import { requireMediaBinary } from "@space/media-deps";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TAG = "[sf-select-subs-off]";
const selectLua = fileURLToPath(new URL("../resources/osc/sf-select.lua", import.meta.url));
const driver = fileURLToPath(new URL("./lua/sf_select_off_scenario.lua", import.meta.url));

const LUA_CANDIDATES = ["luajit", "lua5.1", "lua5.2", "lua"];
const lua = LUA_CANDIDATES.find((bin) => spawnSync(bin, ["-v"]).status === 0) ?? null;
requireMediaBinary("a Lua interpreter (luajit, lua5.1, lua5.2 or lua)", lua !== null);
if (!lua) {
  console.warn(`${TAG} SKIP: no Lua interpreter on PATH (tried ${LUA_CANDIDATES.join(", ")})`);
} else {
  console.info(`${TAG} using ${lua}: ${spawnSync(lua, ["-v"]).stdout.toString().trim()} sf-select.lua=${selectLua}`);
}

type Menu = { items: string[]; default_item: number; prompt: string };
type Result = {
  scenario: string;
  menu?: Menu;
  sid?: number | string;
  aid?: number | string;
  sidSets?: number;
  picks?: Array<[string, string]>;
  subPrompt?: string;
  audioPrompt?: string;
  osd?: unknown;
  log: string;
};

const runScenario = (scenario: string): Result => {
  const proc = spawnSync(lua!, [driver, selectLua, scenario], { encoding: "utf8", timeout: 30_000 });
  const log = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const resultLine = (proc.stdout ?? "").split("\n").find((line) => line.startsWith("RESULT "));
  if (proc.status !== 0 || !resultLine) {
    console.error(`${TAG} scenario=${scenario} exit=${proc.status} signal=${proc.signal}\n${log}`);
    throw new Error(`scenario ${scenario} failed (exit ${proc.status})`);
  }
  const parsed = JSON.parse(resultLine.slice("RESULT ".length)) as Omit<Result, "log">;
  console.info(`${TAG} scenario=${scenario} result=${resultLine.slice("RESULT ".length)}\n${log.split("\n").filter((l) => /input.select|track picked|sid|aid/.test(l)).join("\n")}`);
  return { ...parsed, log };
};

describe.skipIf(!lua)("sf-select.lua subtitle menu has an Off row (#25 Orchard: cannot turn subtitles off)", () => {
  it("one subtitle track, selected: Off is listed first, unselected, and picking it sets sid=no @req PLAY-TRACK-02[badger-desktop]", () => {
    const r = runScenario("single-selected");
    expect(r.menu?.items, "Off row + the one track").toEqual(["○ Off", "● French"]);
    expect(r.menu?.default_item, "cursor starts on the selected track").toBe(2);
    expect(r.sid).toBe("no");
    expect(r.picks, "the app is told, so reloads keep it off").toEqual([["sid", "no"]]);
  });

  it("subtitles off (default or after Off): the Off row is the selected row and the cursor's start row", () => {
    const r = runScenario("single-off");
    expect(r.menu?.items).toEqual(["● Off", "○ French"]);
    expect(r.menu?.default_item).toBe(1);
  });

  it("picking the track after Off turns it back on", () => {
    const r = runScenario("off-then-track");
    expect(r.sid).toBe(1);
    expect(r.picks).toEqual([["sid", "1"]]);
  });

  it("picking the track that is already on keeps it on: no toggle, and no sid re-set (mpv would refresh-seek)", () => {
    const r = runScenario("reselect-current");
    expect(r.sid).toBe(1);
    expect(r.sidSets, "sid is not re-set to its current value").toBe(0);
    expect(r.picks).toEqual([["sid", "1"]]);
  });

  it("picking Off while subtitles are already off does not re-set sid, and still reports the pick", () => {
    const r = runScenario("off-when-already-off");
    expect(r.sidSets).toBe(0);
    expect(r.picks).toEqual([["sid", "no"]]);
  });

  it("two tracks: Off sits first, the selected track is the current row; Off turns it off, a track switches", () => {
    const off = runScenario("two-tracks");
    expect(off.menu?.items).toEqual(["○ Off", "○ French", "● English"]);
    expect(off.menu?.default_item).toBe(3);
    expect(off.sid).toBe("no");
    expect(off.picks).toEqual([["sid", "no"]]);

    const sw = runScenario("two-tracks-switch");
    expect(sw.sid).toBe(1);
    expect(sw.picks).toEqual([["sid", "1"]]);
  });

  it("the Off row is labelled with the app's UI-language string (sf-labels-json), falling back to Off", () => {
    expect(runScenario("label-fr").menu?.items).toEqual(["○ Aucun", "● French"]);
    expect(runScenario("label-garbage").menu?.items, "malformed / empty labels keep the default").toEqual(["○ Off", "● French"]);
  });

  // Chris 2026-11-18 (#2988): the subtitles button always opens the menu, so a title with no subtitle track gets Off alone.
  it("no subtitle track: the menu opens with Off alone, the current row", () => {
    expect(runScenario("no-tracks").menu).toEqual({ prompt: "Select a subtitle:", items: ["● Off"], default_item: 1 });
  });

  // @bugfix badger-menu-headers-english @regression-proof
  it("the audio and subtitle menu prompts are the app's UI-language strings (sf-labels-json), English until they arrive @req PLAY-TRACK-02[badger-desktop]", () => {
    const en = runScenario("prompts-default");
    expect(en.subPrompt).toBe("Select a subtitle:");
    expect(en.audioPrompt).toBe("Select an audio track:");
    const fr = runScenario("prompts-fr");
    expect(fr.subPrompt).toBe("Choisir des sous-titres :");
    expect(fr.audioPrompt, "a later payload without the prompt (or with \"\") keeps it").toBe("Choisir une piste audio :");
    expect(JSON.stringify(fr.osd), "empty-state line").toContain("Aucune piste vidéo disponible.");
  });

  it("the audio menu is unchanged: no Off row, and picking the selected track still turns it off", () => {
    const r = runScenario("audio-keeps-toggle");
    expect(r.menu?.items).toEqual(["● English"]);
    expect(r.aid).toBe("no");
    expect(r.picks).toEqual([["aid", "no"]]);
  });
});

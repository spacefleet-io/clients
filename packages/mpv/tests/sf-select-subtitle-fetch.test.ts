/**
 * PLAY-SUBGET-02: the mpv subtitle menu's "Get more subtitles…" row and the
 * search drawn over the paused video (sf-select.lua). The row shows only when
 * the app sends its label on `sf-labels-json` and asks the app to start
 * (`sf-subtitle-fetch open`). With no subtitle track the subtitles button still
 * opens the menu, Off then the row, searching nothing until the row is picked
 * (PLAY-SUBGET-05, PLAY-SUBGET-24). The app then sends panels and the
 * language list on `sf-subtitle-fetch-json`; picks and Escape come back on
 * `sf-subtitle-fetch`.
 *
 * PLAY-SUBGET-07: "Try another version" follows it while the app's label says
 * the subtitle that is on was fetched; picking it sends `version`.
 *
 * Runs the REAL sf-select.lua under tests/lua/mp_mock.lua. Skips loudly when no
 * Lua interpreter is on PATH (the CI image has none; run locally).
 */
import { describe, expect, it } from "vitest";
import { requireMediaBinary } from "@space/media-deps";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TAG = "[sf-select-subtitle-fetch]";
const selectLua = fileURLToPath(new URL("../resources/osc/sf-select.lua", import.meta.url));
const driver = fileURLToPath(new URL("./lua/sf_select_fetch_scenario.lua", import.meta.url));

const LUA_CANDIDATES = ["luajit", "lua5.1", "lua5.2", "lua"];
const lua = LUA_CANDIDATES.find((bin) => spawnSync(bin, ["-v"]).status === 0) ?? null;
requireMediaBinary("a Lua interpreter (luajit, lua5.1, lua5.2 or lua)", lua !== null);
if (!lua) console.warn(`${TAG} SKIP: no Lua interpreter on PATH (tried ${LUA_CANDIDATES.join(", ")})`);

type Result = {
  items?: string[];
  prompt?: string;
  fetch?: string[][];
  fetch_on_open?: string[][];
  picks?: string[][];
  sid?: number | string;
  warned?: number;
  shown?: string;
  after?: string;
  escape?: string;
  bound?: boolean;
};

// The mock's JSON encoder writes an empty Lua table as {}.
const list = <T>(value: T[] | Record<string, never> | undefined): T[] => (Array.isArray(value) ? value : []);

const runScenario = (scenario: string): Result => {
  const proc = spawnSync(lua!, [driver, selectLua, scenario], { encoding: "utf8", timeout: 30_000 });
  const resultLine = (proc.stdout ?? "").split("\n").find((line) => line.startsWith("RESULT "));
  if (proc.status !== 0 || !resultLine) {
    console.error(`${TAG} scenario=${scenario} exit=${proc.status}\n${proc.stdout ?? ""}${proc.stderr ?? ""}`);
    throw new Error(`scenario ${scenario} failed (exit ${proc.status})`);
  }
  return JSON.parse(resultLine.slice("RESULT ".length)) as Result;
};

// @req PLAY-SUBGET-02[badger-desktop]
describe.skipIf(!lua)("sf-select.lua: Get more subtitles… (PLAY-SUBGET-02)", () => {
  it("the subtitle menu ends with the row; picking it asks the app to start and changes no track", () => {
    const r = runScenario("row");
    expect(r.items).toEqual(["○ Off", "● French", "+ Get more subtitles…"]);
    expect(r.fetch).toEqual([["open"]]);
    expect(list(r.picks), "no track pick is reported").toEqual([]);
    expect(r.sid).toBe(1);
  });

  it("no row until the app sends its label, and an empty label hides it again", () => {
    expect(runScenario("row-hidden").items).toEqual(["○ Off", "● French"]);
    expect(runScenario("row-cleared").items).toEqual(["○ Off", "● French"]);
  });

  // @req PLAY-SUBGET-05[badger-desktop] @req PLAY-SUBGET-24[badger-desktop]
  it("with no subtitle track the subtitles button opens the menu, Off then Get more, and searches only when it is picked", () => {
    const r = runScenario("no-tracks");
    console.info(`${TAG} no-tracks ${JSON.stringify(r)}`);
    expect(r.items).toEqual(["● Off", "+ Weitere Untertitel suchen…"]);
    expect(list(r.fetch_on_open), "nothing searched when the menu opens").toEqual([]);
    expect(r.fetch).toEqual([["open"]]);
    expect(r.warned).toBe(0);
  });

  it("with no subtitle track and nothing to search, it says there are none", () => {
    const r = runScenario("no-tracks-no-label");
    expect(r.items).toBeUndefined();
    expect(list(r.fetch)).toEqual([]);
    expect(r.warned).toBe(1);
  });

  // @req PLAY-SUBGET-07[badger-desktop]
  it("Try another version follows Get more while a fetched subtitle is on; picking it sends version, no track pick", () => {
    const r = runScenario("version-row");
    console.info(`${TAG} version-row ${JSON.stringify(r)}`);
    expect(r.items).toEqual(["○ Off", "● French", "+ Get more subtitles…", "+ Try another version"]);
    expect(r.fetch).toEqual([["version"]]);
    expect(list(r.picks)).toEqual([]);
    expect(r.sid).toBe(1);
  });

  // @req PLAY-SUBGET-07[badger-desktop]
  it("no Try another version while subtitles are off, or once the app clears its label", () => {
    expect(runScenario("version-row-off").items).toEqual(["● Off", "○ French", "+ Get more subtitles…"]);
    expect(runScenario("version-row-cleared").items).toEqual(["○ Off", "● French", "+ Get more subtitles…"]);
  });

  it("the language list is mpv's menu; a pick sends its key, and closing after it is not a cancel", () => {
    const r = runScenario("list-pick");
    expect(r.prompt).toBe("Pick a language");
    expect(r.items).toEqual(["English", "Spanish"]);
    expect(r.fetch).toEqual([["pick", "es|plain|"]]);
  });

  it("leaving the list without a pick cancels (playback resumes, nothing changed)", () => {
    expect(runScenario("list-cancel").fetch).toEqual([["cancel"]]);
  });

  it("a dismissable panel is drawn centred and Escape hides it and cancels", () => {
    const r = runScenario("panel-dismiss");
    // MPV-OSC-05: the panel canvas is the OSD size in logical px (mock: 1920x1080 at hidpi 1), so its centre is (960,540).
    expect(r.shown).toContain("\\an5\\pos(960,540)");
    expect(r.shown).toContain("Looking for subtitles…");
    expect(r.escape).toBe("ESC");
    expect(r.after).toBe("");
    expect(r.fetch).toEqual([["cancel"]]);
    expect(r.bound).toBe(false);
  });

  it("a busy panel (downloading, saving) has no Escape; its text is escaped; close hides it", () => {
    const r = runScenario("panel-busy");
    expect(r.shown).toContain("Saving to your media library \\{now\\}");
    expect(r.bound).toBe(false);
    expect(r.after).toBe("");
    expect(list(r.fetch)).toEqual([]);
  });

  it("long text wraps inside the panel, which grows to fit", () => {
    const r = runScenario("panel-wrap");
    expect(r.shown).toContain("these\\Nsubtitles.");
    expect(r.shown).toContain("l 640 0 640 164 0 164");
  });
});

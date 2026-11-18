/**
 * @bugfix mpv-survives-app-sigkill
 * @regression-proof
 *
 * Wiring half of ultimate-stress finding F6 (`orphan-mpv`): the desktop main
 * process must hand its own pid to the shipped OSC script so sf.lua's
 * parent-death watchdog can quit the detached mpv when Electron is SIGKILLed.
 * The behavioural half (real mpv exits <=2 s after the parent dies) lives in
 * packages/mpv/tests/sf-parent-watchdog.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const externalMpvSource = readFileSync(new URL("../src/main/externalMpv.ts", import.meta.url), "utf8");
const sfLuaSource = readFileSync(
  new URL("../../../../packages/mpv/resources/osc/sf.lua", import.meta.url),
  "utf8",
);

describe("external mpv parent-death watchdog wiring", () => {
  it("externalMpv passes process.pid as sf-parent_pid and sf.lua reads the same option", () => {
    const needles = [
      { file: "externalMpv", token: "sf-parent_pid=${process.pid}", present: externalMpvSource.includes("sf-parent_pid=${process.pid}") },
      { file: "sf.lua", token: "parent_pid", present: sfLuaSource.includes("parent_pid = \"\"") },
      { file: "sf.lua", token: "user_opts.parent_pid", present: sfLuaSource.includes("user_opts.parent_pid") },
    ];
    const missing = needles.filter((n) => !n.present);
    console.info(`[external-mpv-parent-watchdog-source] needles=${needles.length} missing=${missing.length}`);
    if (missing.length > 0) console.error(`[external-mpv-parent-watchdog-source] missing:\n${JSON.stringify(missing, null, 2)}`);
    expect(missing).toEqual([]);
  });
});

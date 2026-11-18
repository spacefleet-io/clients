/**
 * @bugfix sf-bindings-ready-late-listener (#25 P9)
 * @regression-proof
 *
 * tog4in1's window-controls section must be the newest forced section so it
 * outranks sf.lua's MBTN_LEFT (pill-click routing). sf.lua's section is flushed
 * from mp.defaults' first idle handler, so sf.lua tells tog4in1 once it is live
 * (`script-message sf-bindings-ready`) and tog4in1 re-pushes its sections.
 * Scripts load on their own threads: on a slow host (CI) tog4in1 can register
 * its listener AFTER sf.lua's one-shot broadcast, the message is lost and
 * window-controls stays below sf.lua. Fix: tog4in1 asks on load
 * (`sf-bindings-query`) and sf.lua answers whenever its bindings are live.
 *
 * Runs the REAL sf.lua under tests/lua/mp_mock.lua (no mpv). The real-mpv side
 * is covered by osc-window-controls-steady-state.test.ts.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireMediaBinary } from "@space/media-deps";

const TAG = "[sf-bindings-handshake]";
const sfLua = fileURLToPath(new URL("../resources/osc/sf.lua", import.meta.url));
const driver = fileURLToPath(new URL("./lua/sf_bindings_handshake_scenario.lua", import.meta.url));
const LUA_CANDIDATES = ["luajit", "lua5.1", "lua5.2", "lua"];
const lua = LUA_CANDIDATES.find((bin) => spawnSync(bin, ["-v"]).status === 0) ?? null;
requireMediaBinary("a Lua interpreter (luajit, lua5.1, lua5.2 or lua)", lua !== null);
if (!lua) console.warn(`${TAG} SKIP: no Lua interpreter on PATH (tried ${LUA_CANDIDATES.join(", ")})`);

const runScenario = (scenario: string): Record<string, unknown> => {
  const proc = spawnSync(lua!, [driver, sfLua, scenario], { encoding: "utf8", timeout: 30_000 });
  const log = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const resultLine = (proc.stdout ?? "").split("\n").find((line) => line.startsWith("RESULT "));
  console.info(`${TAG} scenario=${scenario} exit=${proc.status}\n${log.split("\n").filter((l) => /handshake|sf-sections|RESULT|rror/.test(l)).join("\n")}`);
  if (proc.status !== 0 || !resultLine) {
    console.error(`${TAG} scenario=${scenario} full output:\n${log}`);
    throw new Error(`scenario ${scenario} failed (exit ${proc.status})`);
  }
  return JSON.parse(resultLine.slice("RESULT ".length)) as Record<string, unknown>;
};

describe.skipIf(!lua)("sf.lua sf-bindings-ready handshake survives any script load order (#25 P9)", () => {
  it("answers a listener that registers after the one-shot broadcast (late tog4in1)", () => {
    const r = runScenario("late-listener");
    expect(r.after_broadcast, "sf.lua broadcasts once its idle flush ran").toBe(1);
    expect(r.after_query, "a late sf-bindings-query must get its own sf-bindings-ready").toBe(2);
  });

  it("does not claim ready before its bindings are live, then broadcasts exactly once", () => {
    const r = runScenario("early-query");
    expect(r.after_early_query, "no ready before sf.lua's section is flushed").toBe(0);
    expect(r.after_idle).toBe(1);
    expect(r.after_second_idle, "one-shot: later idle passes stay quiet").toBe(1);
  });
});

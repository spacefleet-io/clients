import { describe, expect, it } from "vitest";
import { buildTaskkillArgs, createWindowsProcessGroup } from "../src/processGroup";

describe("taskkill argv", () => {
  it("terminate asks the whole tree, kill forces it", () => {
    console.info("[windows-group:argv] building taskkill argv");
    expect(buildTaskkillArgs(4321, "terminate")).toEqual(["/PID", "4321", "/T"]);
    expect(buildTaskkillArgs(4321, "kill")).toEqual(["/PID", "4321", "/T", "/F"]);
  });
});

describe("windows process group", () => {
  it("signal runs taskkill with the tree argv and reports its exit status", () => {
    const runs: string[][] = [];
    const group = createWindowsProcessGroup({
      runTaskkill: (args) => {
        runs.push(args);
        return args.includes("/F") ? 0 : 128;
      },
    });
    expect(group.signal(10, "kill")).toBe(true);
    expect(group.signal(10, "terminate")).toBe(false); // console processes refuse the polite request
    expect(runs).toEqual([
      ["/PID", "10", "/T", "/F"],
      ["/PID", "10", "/T"],
    ]);
  });

  it("a taskkill that cannot run (null status) did not signal anything", () => {
    const group = createWindowsProcessGroup({ runTaskkill: () => null });
    expect(group.signal(10, "kill")).toBe(false);
  });

  it("never runs taskkill for a nonsense pid", () => {
    let runs = 0;
    const group = createWindowsProcessGroup({ runTaskkill: () => (runs += 1, 0), probe: () => true });
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(group.signal(pid, "kill")).toBe(false);
      expect(group.isAlive(pid)).toBe(false);
    }
    expect(runs).toBe(0);
  });

  it("isAlive follows the probe", () => {
    const alive = new Set([7]);
    const group = createWindowsProcessGroup({ probe: (pid) => alive.has(pid) });
    expect(group.isAlive(7)).toBe(true);
    alive.delete(7);
    expect(group.isAlive(7)).toBe(false);
  });

  it("the default probe sees this process and not an unused pid", () => {
    const group = createWindowsProcessGroup();
    expect(group.isAlive(process.pid)).toBe(true);
    expect(group.isAlive(2 ** 22 - 7)).toBe(false);
  });
});

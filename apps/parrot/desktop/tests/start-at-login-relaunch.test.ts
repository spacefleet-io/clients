/**
 * REL-UPD-04: an AppImage update moves Parrot to a new file name, so on Linux the start-at-login entry is written
 * again at every launch. The launch-time helper is the real code; only the OS login-item call is a recorder.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@space/error-report/electron-main", () => ({
  createElectronMainReporting: () => ({ isEnabled: () => false, setEnabled: async () => undefined }),
}));

import { reapplyStartAtLoginAtLaunch } from "../src/main/errorReports";

const SUITE = "[parrot-start-at-login-relaunch]";

const run = (platform: NodeJS.Platform, setup: { done: boolean; startAtLogin: boolean }, throws = false) => {
  const applied: boolean[] = [];
  const failures: string[] = [];
  const rewritten = reapplyStartAtLoginAtLaunch({
    platform,
    setup,
    applyStartAtLogin: (on) => {
      applied.push(on);
      if (throws) throw new Error("autostart dir read-only");
    },
    fail: (line) => failures.push(line),
  });
  console.info(`${SUITE} platform=${platform} setup=${JSON.stringify(setup)} rewritten=${rewritten} applied=${JSON.stringify(applied)} failures=${JSON.stringify(failures)}`);
  return { rewritten, applied, failures };
};

describe("@req REL-UPD-04[parrot] start at login survives an update", () => {
  it("rewrites the Linux autostart entry at launch when the user chose start at login", () => {
    expect(run("linux", { done: true, startAtLogin: true })).toEqual({ rewritten: true, applied: [true], failures: [] });
  });

  it("leaves it alone when the user said no, or setup is not finished", () => {
    expect(run("linux", { done: true, startAtLogin: false }).applied).toEqual([]);
    expect(run("linux", { done: false, startAtLogin: true }).applied).toEqual([]);
  });

  it("does nothing on Windows and macOS, whose login item does not hold a versioned file name", () => {
    expect(run("win32", { done: true, startAtLogin: true }).applied).toEqual([]);
    expect(run("darwin", { done: true, startAtLogin: true }).applied).toEqual([]);
  });

  it("a failed rewrite is logged and the launch goes on", () => {
    const result = run("linux", { done: true, startAtLogin: true }, true);
    expect(result.rewritten).toBe(true);
    expect(result.failures).toEqual(["[login-item] could not rewrite at launch: autostart dir read-only"]);
  });
});

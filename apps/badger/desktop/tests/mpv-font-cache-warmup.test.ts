import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDesktopPlatform } from "@space/desktop-platform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * @bugfix @regression-proof mpv-bundle-fontconfig-cold-scan (#25 P5/B3)
 *
 * The bundled mpv's first play scanned every system font before its first
 * frame (1.8 s idle, 17.3 s under load: black backdrop window). At app start
 * the main process now runs the bundle once headless, at the lowest
 * priority, to build that cache off the play path. Contract: bundle target →
 * one spawn of the planned warm-up with priority 19; other targets → none.
 */

vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

let dataDir = "";
const savedXdg = process.env.SF_MPV_XDG_DATA_HOME;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "sf-mpv-font-warmup-app-"));
  process.env.SF_MPV_XDG_DATA_HOME = dataDir;
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env.SF_MPV_XDG_DATA_HOME;
  else process.env.SF_MPV_XDG_DATA_HOME = savedXdg;
  rmSync(dataDir, { recursive: true, force: true });
});

const fakeChild = () => Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });

describe("@bugfix @regression-proof warmMpvBundleFontCache", () => {
  it("spawns the bundle headless at the lowest priority", async () => {
    const mod = (await import("../src/main/mpvFontCacheWarmup").catch(() => null)) as
      | typeof import("../src/main/mpvFontCacheWarmup")
      | null;
    console.info(`[mpv-font-warmup-app] module loaded=${Boolean(mod)}`);
    expect(mod).not.toBeNull();
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child);
    const setPriorityImpl = vi.fn();
    mod!.warmMpvBundleFontCache(
      { bin: "/opt/b/bin/mpv", kind: "bundle", libDirs: ["/opt/b/lib"] },
      { spawnImpl: spawnImpl as never, setPriorityImpl },
    );
    const calls = spawnImpl.mock.calls as unknown as Array<[string, string[], { env: NodeJS.ProcessEnv }]>;
    // The platform's loader-path variable(s) for the bundle's lib dirs (Linux: LD_LIBRARY_PATH;
    // macOS: DYLD_FALLBACK_LIBRARY_PATH; Windows: PATH).
    const loaderVars = Object.keys(getDesktopPlatform().binaries.launchEnv({ libDirs: ["/opt/b/lib"] }, {}));
    console.info(
      `[mpv-font-warmup-app] spawn=${JSON.stringify(calls.map(([bin, args, opts]) => ({ bin, args, loader: loaderVars.map((key) => opts.env[key]) })))} priority=${JSON.stringify(setPriorityImpl.mock.calls)}`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/opt/b/bin/mpv");
    expect(calls[0][1]).toEqual(expect.arrayContaining(["--vo=null", "--ao=null", "--frames=1"]));
    expect(loaderVars.length).toBeGreaterThan(0);
    for (const key of loaderVars) expect(calls[0][2].env[key]?.startsWith("/opt/b/lib"), key).toBe(true);
    expect(setPriorityImpl).toHaveBeenCalledWith(4242, 19);
    child.emit("exit", 0, null);
  });

  it("does nothing for system / fallback mpv", async () => {
    const mod = (await import("../src/main/mpvFontCacheWarmup").catch(() => null)) as
      | typeof import("../src/main/mpvFontCacheWarmup")
      | null;
    expect(mod).not.toBeNull();
    const spawnImpl = vi.fn(() => fakeChild());
    mod!.warmMpvBundleFontCache({ bin: "/usr/bin/mpv", kind: "system", libDirs: [] }, { spawnImpl: spawnImpl as never });
    mod!.warmMpvBundleFontCache({ bin: "mpv", kind: "fallback", libDirs: [] }, { spawnImpl: spawnImpl as never });
    console.info(`[mpv-font-warmup-app] non-bundle spawns=${spawnImpl.mock.calls.length}`);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

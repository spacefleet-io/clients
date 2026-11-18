import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellApp } from "@space/desktop-platform-contract";
import { linuxShell } from "../src/shell";

const roots: string[] = [];
const makeTempDir = () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-linux-shell-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("linux shell", () => {
  it("prepareApp sets the WM class switch and leaves the AUMID alone", () => {
    const appendSwitch = vi.fn();
    const setAppUserModelId = vi.fn();
    const app: ShellApp = { setAppUserModelId, commandLine: { appendSwitch } };
    linuxShell.prepareApp(app, { appUserModelId: "io.example.app", linuxWindowClass: "SpaceBadger" });
    console.info(`[linux-shell:prepareApp] appendSwitch=${JSON.stringify(appendSwitch.mock.calls)}`);
    expect(appendSwitch).toHaveBeenCalledExactlyOnceWith("class", "SpaceBadger");
    expect(setAppUserModelId).not.toHaveBeenCalled();
  });

  it("quits when all windows are closed", () => {
    expect(linuxShell.quitWhenAllWindowsClosed).toBe(true);
  });

  it("keeps the legacy app name, no application menu, a colour tray icon and in-app updates", () => {
    expect(linuxShell.appName({ productName: "SpaceBadger", legacyName: "@space/badger" })).toBe("@space/badger");
    expect(linuxShell.applicationMenu).toBe(false);
    expect(linuxShell.trayIcon).toBe("color");
  });

  // #25: the GPU vo first, the CPU x11 vo as mpv's own fallback (no GPU, llvmpipe on Xvfb, broken driver).
  // x11 is also the vo a launch goes straight to when this machine's GPU probe is remembered to fail;
  // a Wayland-only session has no CPU vo (x11 cannot open there), so it always probes.
  it("mpvWindow: gpu vo with x11 fallback, app id flag follows the session, x11 is the CPU vo when an X display exists", () => {
    const hasWayland = () => true;
    const cases: Array<[Record<string, string>, string[], string | null]> = [
      [{ DISPLAY: ":0" }, ["--x11-name=app"], "x11"],
      [{ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }, ["--x11-name=app"], "x11"],
      [{ WAYLAND_DISPLAY: "wayland-0" }, ["--wayland-app-id=app"], null],
      [{ XDG_SESSION_TYPE: "Wayland" }, ["--wayland-app-id=app"], null],
      [{}, [], null],
    ];
    for (const [env, args, cpuVo] of cases) {
      const window = linuxShell.mpvWindow({ appId: "app", env, mpvHasWayland: hasWayland });
      console.info(`[linux-shell:mpvWindow] env=${JSON.stringify(env)} mpvHasWayland=true -> ${JSON.stringify(window)}`);
      expect(window).toEqual({ defaultVo: "gpu,x11", cpuVo, args, noWindow: null });
    }
  });

  // @bugfix @regression-proof wayland-appid-option-not-found: every Wayland-only launch passed
  // `--wayland-appid`, which no mpv knows ("Error parsing option wayland-appid (option not found)",
  // mpv exits), and the bundled mpv has no Wayland gpu context at all (only x11egl), so playback
  // died with nothing said. Now: the real flag only when the mpv in use has Wayland; without it
  // and without an X display, `noWindow` so the launch tells the user instead of starting mpv.
  it("mpvWindow on a Wayland-only session: --wayland-app-id only when mpv has Wayland, noWindow without it @bugfix @regression-proof", () => {
    const waylandOnly = { WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" };
    const withWayland = linuxShell.mpvWindow({ appId: "app", env: waylandOnly, mpvHasWayland: () => true });
    console.info(`[linux-shell:mpvWindow:wayland-only] mpv with Wayland -> ${JSON.stringify(withWayland)}`);
    expect(withWayland).toEqual({ defaultVo: "gpu,x11", cpuVo: null, args: ["--wayland-app-id=app"], noWindow: null });
    expect(withWayland.args.some((arg) => arg.startsWith("--wayland-appid"))).toBe(false);

    const probe = vi.fn(() => false);
    const withoutWayland = linuxShell.mpvWindow({ appId: "app", env: waylandOnly, mpvHasWayland: probe });
    console.info(`[linux-shell:mpvWindow:wayland-only] mpv without Wayland (bundled) -> ${JSON.stringify(withoutWayland)} probeCalls=${probe.mock.calls.length}`);
    expect(withoutWayland).toEqual({ defaultVo: "gpu,x11", cpuVo: null, args: [], noWindow: "mpv_no_display" });
    expect(probe).toHaveBeenCalledOnce();

    // Unknown (no probe given) counts as no Wayland: never pass a flag mpv may reject.
    const unknown = linuxShell.mpvWindow({ appId: "app", env: waylandOnly });
    console.info(`[linux-shell:mpvWindow:wayland-only] no probe -> ${JSON.stringify(unknown)}`);
    expect(unknown.noWindow).toBe("mpv_no_display");
    expect(unknown.args).toEqual([]);
  });

  it("mpvWindow asks mpv about Wayland only on a Wayland-only session", () => {
    const probe = vi.fn(() => false);
    for (const env of [{ DISPLAY: ":0" }, { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }, {}]) {
      const window = linuxShell.mpvWindow({ appId: "app", env, mpvHasWayland: probe });
      console.info(`[linux-shell:mpvWindow:no-probe] env=${JSON.stringify(env)} -> ${JSON.stringify(window)}`);
      expect(window.noWindow).toBeNull();
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("hasDisplay: DISPLAY or WAYLAND_DISPLAY", () => {
    expect(linuxShell.hasDisplay({ DISPLAY: ":0" })).toBe(true);
    expect(linuxShell.hasDisplay({ WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    expect(linuxShell.hasDisplay({})).toBe(false);
    expect(linuxShell.hasDisplay({ DISPLAY: "" })).toBe(false);
  });

  it("prepareMpvWindow keeps mpv's XDG data in dataDir on a copy of env, without an icon", () => {
    const home = makeTempDir();
    vi.stubEnv("XDG_DATA_HOME", home);
    const env = { KEEP: "1", XDG_DATA_HOME: "/elsewhere" };
    const out = linuxShell.prepareMpvWindow({ appId: "io.example.mpv", dataDir: "/data/dir", env });
    console.info(`[linux-shell:mpv-window] out=${JSON.stringify(out)} entries=${existsSync(path.join(home, "applications"))}`);
    expect(out).toEqual({ KEEP: "1", XDG_DATA_HOME: "/data/dir", MALLOC_ARENA_MAX: "1" });
    expect(env.XDG_DATA_HOME).toBe("/elsewhere");
    expect(existsSync(path.join(home, "applications"))).toBe(false);
  });

  it("prepareMpvWindow registers a .desktop entry and icon under the user's XDG data home", () => {
    const home = makeTempDir();
    vi.stubEnv("XDG_DATA_HOME", home);
    const iconPath = path.join(makeTempDir(), "icon.png");
    writeFileSync(iconPath, "png-bytes");
    const out = linuxShell.prepareMpvWindow({ appId: "io.example.mpv", iconPath, dataDir: "/data/dir", env: {} });
    const desktopFile = path.join(home, "applications", "io.example.mpv-mpv.desktop");
    const iconFile = path.join(home, "icons", "hicolor", "256x256", "apps", "io.example.mpv.png");
    console.info(`[linux-shell:mpv-window] desktop=${existsSync(desktopFile)} icon=${existsSync(iconFile)}`);
    expect(out.XDG_DATA_HOME).toBe("/data/dir");
    expect(readFileSync(iconFile, "utf8")).toBe("png-bytes");
    const entry = readFileSync(desktopFile, "utf8");
    expect(entry).toContain("[Desktop Entry]");
    expect(entry).toContain("StartupWMClass=io.example.mpv");
    expect(entry).toContain("Icon=io.example.mpv");
    // REL-MAC-09: the player window is "Badger Player", and the helper entry never shows in the launcher's app list.
    expect(entry).toContain("Name=Badger Player");
    expect(entry).toContain("NoDisplay=true");
    expect(entry).not.toContain("SpaceBadger");
  });

  // @bugfix @regression-proof issue #265: mpv's RSS kept +60-130 MB per loadfile replace (po-mem play: 257 -> 296 MB):
  // glibc's per-thread arenas (many ~64 MB regions) fragment under the demuxer/decoder threads' alloc churn and never
  // return the freed pages. One arena stops it (reload series 264 -> 714 MB default, 328 -> 342 MB plateau).
  it("prepareMpvWindow pins glibc to one malloc arena for mpv (#265) @bugfix @regression-proof", () => {
    const out = linuxShell.prepareMpvWindow({ appId: "io.example.mpv", dataDir: "/data/dir", env: {} });
    console.info(`[linux-shell:mpv-malloc] MALLOC_ARENA_MAX=${out.MALLOC_ARENA_MAX}`);
    expect(out.MALLOC_ARENA_MAX).toBe("1");
  });

  it("prepareMpvWindow keeps an operator-set MALLOC_ARENA_MAX (#265) @bugfix @regression-proof", () => {
    const out = linuxShell.prepareMpvWindow({ appId: "io.example.mpv", dataDir: "/data/dir", env: { MALLOC_ARENA_MAX: "4" } });
    expect(out.MALLOC_ARENA_MAX).toBe("4");
  });
});

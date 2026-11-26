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
  // MPV-GPU-04: Electron 45 picks its ozone platform from the session by itself (Wayland on Wayland, X11 on X11; seen
  // by hand: no X11 window on a Wayland session, X11 windows with WAYLAND_DISPLAY unset), so the app must never append
  // an ozone switch: one would also override the test harness's `--ozone-platform=x11` (packages/test-seed).
  it("prepareApp sets the WM class switch, leaves the AUMID alone and never picks an ozone platform @req MPV-GPU-04[badger-desktop,parrot]", () => {
    const appendSwitch = vi.fn();
    const setAppUserModelId = vi.fn();
    const app: ShellApp = { setAppUserModelId, commandLine: { appendSwitch } };
    linuxShell.prepareApp(app, { appUserModelId: "io.example.app", linuxWindowClass: "SpaceBadger" });
    console.info(`[linux-shell:prepareApp] appendSwitch=${JSON.stringify(appendSwitch.mock.calls)}`);
    expect(appendSwitch).toHaveBeenCalledExactlyOnceWith("class", "SpaceBadger");
    expect(appendSwitch.mock.calls.some(([name]) => String(name).startsWith("ozone"))).toBe(false);
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

  // #25: the GPU vo first, the session's CPU vo as mpv's own fallback (no GPU, llvmpipe, broken driver): x11 on an
  // X11 session, wlshm on a Wayland one (MPV-GPU-04). That CPU vo is also the one a launch goes straight to when this
  // machine's GPU probe is remembered to fail.
  it("mpvWindow on an X11 session: gpu,x11 with x11 as the CPU vo and --x11-name, mpv never asked about Wayland @req MPV-GPU-04[badger-desktop]", () => {
    const probe = vi.fn(() => true);
    const window = linuxShell.mpvWindow({ appId: "app", env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }, mpvHasWayland: probe });
    console.info(`[linux-shell:mpvWindow:x11] -> ${JSON.stringify(window)} probeCalls=${probe.mock.calls.length}`);
    expect(window).toEqual({ defaultVo: "gpu,x11", cpuVo: "x11", args: ["--x11-name=app"], unsetEnv: [], noWindow: null });
    expect(probe).not.toHaveBeenCalled();
  });

  // MPV-GPU-04: a Wayland session (with or without XWayland's DISPLAY) plays in a native Wayland window when the mpv
  // has Wayland (the bundled one does). DISPLAY leaves mpv's environment: with it, mpv's gpu probe opened an XWayland
  // x11egl window whenever the wayland context was rejected (seen by hand with llvmpipe, mpv 0.42), instead of wlshm.
  it("mpvWindow on a Wayland session with a Wayland mpv: gpu,wlshm, --wayland-app-id, DISPLAY unset @req MPV-GPU-04[badger-desktop]", () => {
    const cases: Array<[Record<string, string>, string[]]> = [
      [{ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" }, ["DISPLAY"]],
      [{ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }, ["DISPLAY"]],
      [{ WAYLAND_DISPLAY: "wayland-0" }, []],
      [{ XDG_SESSION_TYPE: "Wayland" }, []],
    ];
    for (const [env, unsetEnv] of cases) {
      const probe = vi.fn(() => true);
      const window = linuxShell.mpvWindow({ appId: "app", env, mpvHasWayland: probe });
      console.info(`[linux-shell:mpvWindow:wayland] env=${JSON.stringify(env)} -> ${JSON.stringify(window)} probeCalls=${probe.mock.calls.length}`);
      expect(window).toEqual({ defaultVo: "gpu,wlshm", cpuVo: "wlshm", args: ["--wayland-app-id=app"], unsetEnv, noWindow: null });
      expect(window.defaultVo.split(",")).not.toContain("x11");
      expect(window.args.some((arg) => arg.startsWith("--x11-name"))).toBe(false);
      expect(probe).toHaveBeenCalledOnce();
    }
  });

  // An mpv without Wayland (a system mpv set through SF_MPV_SYSTEM_BIN) can only open an X11 window: it keeps one
  // when the Wayland session has XWayland's DISPLAY, the only window it can open there.
  it("mpvWindow on a Wayland session with an mpv without Wayland: X11 window when a DISPLAY exists", () => {
    const probe = vi.fn(() => false);
    const window = linuxShell.mpvWindow({ appId: "app", env: { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }, mpvHasWayland: probe });
    console.info(`[linux-shell:mpvWindow:wayland-no-mpv-wayland] -> ${JSON.stringify(window)} probeCalls=${probe.mock.calls.length}`);
    expect(window).toEqual({ defaultVo: "gpu,x11", cpuVo: "x11", args: ["--x11-name=app"], unsetEnv: [], noWindow: null });
    expect(probe).toHaveBeenCalledOnce();
  });

  // @bugfix @regression-proof wayland-appid-option-not-found: every Wayland-only launch passed
  // `--wayland-appid`, which no mpv knows ("Error parsing option wayland-appid (option not found)",
  // mpv exits), so playback died with nothing said. Now: the real flag only when the mpv in use has
  // Wayland; without it and without an X display, `noWindow` so the launch tells the user instead of starting mpv.
  it("mpvWindow on a Wayland-only session: --wayland-app-id only when mpv has Wayland, noWindow without it @bugfix @regression-proof", () => {
    const waylandOnly = { WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" };
    const withWayland = linuxShell.mpvWindow({ appId: "app", env: waylandOnly, mpvHasWayland: () => true });
    console.info(`[linux-shell:mpvWindow:wayland-only] mpv with Wayland -> ${JSON.stringify(withWayland)}`);
    expect(withWayland).toEqual({ defaultVo: "gpu,wlshm", cpuVo: "wlshm", args: ["--wayland-app-id=app"], unsetEnv: [], noWindow: null });
    expect(withWayland.args.some((arg) => arg.startsWith("--wayland-appid"))).toBe(false);

    const probe = vi.fn(() => false);
    const withoutWayland = linuxShell.mpvWindow({ appId: "app", env: waylandOnly, mpvHasWayland: probe });
    console.info(`[linux-shell:mpvWindow:wayland-only] mpv without Wayland -> ${JSON.stringify(withoutWayland)} probeCalls=${probe.mock.calls.length}`);
    expect(withoutWayland).toEqual({ defaultVo: "gpu,x11", cpuVo: null, args: [], unsetEnv: [], noWindow: "mpv_no_display" });
    expect(probe).toHaveBeenCalledOnce();

    // Unknown (no probe given) counts as no Wayland: never pass a flag mpv may reject.
    const unknown = linuxShell.mpvWindow({ appId: "app", env: waylandOnly });
    console.info(`[linux-shell:mpvWindow:wayland-only] no probe -> ${JSON.stringify(unknown)}`);
    expect(unknown.noWindow).toBe("mpv_no_display");
    expect(unknown.args).toEqual([]);
  });

  it("mpvWindow asks mpv about Wayland only on a Wayland session", () => {
    const probe = vi.fn(() => true);
    for (const env of [{ DISPLAY: ":0" }, {}]) {
      const window = linuxShell.mpvWindow({ appId: "app", env, mpvHasWayland: probe });
      console.info(`[linux-shell:mpvWindow:no-probe] env=${JSON.stringify(env)} -> ${JSON.stringify(window)}`);
      expect(window.noWindow).toBeNull();
      expect(window.unsetEnv).toEqual([]);
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

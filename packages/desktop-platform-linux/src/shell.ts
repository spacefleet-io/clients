import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ShellLayer } from "@space/desktop-platform-contract";

// The entry only lets the window manager give mpv's window Badger's name and icon (StartupWMClass = the mpv window's
// class). NoDisplay keeps it out of the launcher's app list: Badger itself is listed once, by its package (REL-MAC-09).
const buildDesktopEntry = (appId: string, iconName: string) => {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Badger Player",
    `Exec=${appId}`,
    `Icon=${iconName}`,
    `StartupWMClass=${appId}`,
    "NoDisplay=true",
    "Terminal=false",
  ].join("\n");
};

export const linuxShell: ShellLayer = {
  prepareApp: (app, { linuxWindowClass }) => {
    app.commandLine.appendSwitch("class", linuxWindowClass);
  },
  prepareMpvWindow: ({ appId, iconPath, dataDir, env }) => {
    // Register a .desktop entry + icon so the window manager groups the mpv
    // window under its own app id, and keep mpv's XDG data in `dataDir`.
    const desktopDataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
    const appDir = join(desktopDataHome, "applications");
    const iconDir = join(desktopDataHome, "icons", "hicolor", "256x256", "apps");
    if (iconPath && existsSync(iconPath)) {
      mkdirSync(appDir, { recursive: true });
      mkdirSync(iconDir, { recursive: true });
      const iconName = appId;
      copyFileSync(iconPath, join(iconDir, `${iconName}.png`));
      writeFileSync(join(appDir, `${appId}-mpv.desktop`), buildDesktopEntry(appId, iconName));
    }
    // One glibc malloc arena: mpv's demuxer / decoder / filter threads each get a ~64 MB arena that fragments and
    // never gives pages back (+60-130 MB retained per loadfile replace, 6.9 MB/min on a 6 min reload series; issue #265).
    // An operator-set value wins.
    return { ...env, XDG_DATA_HOME: dataDir, MALLOC_ARENA_MAX: env.MALLOC_ARENA_MAX?.trim() || "1" };
  },
  // GPU vo first, CPU x11 vo last (#25). The gpu vo probes its contexts with
  // software renderers rejected (no --gpu-context / --gpu-sw: an explicit
  // context accepts llvmpipe), so no GPU, Xvfb's llvmpipe or a broken driver
  // leave mpv on x11, which converts and scales on the CPU through zimg.
  // x11 is the CPU vo only with an X display: a Wayland-only session cannot open it.
  // A Wayland-only session needs an mpv with a Wayland gpu context; the bundled
  // one has none (media-deps builds -Dwayland=disabled), so there no window can
  // open and the launch reports `noWindow` instead of starting an mpv that exits.
  // mpv's flag is `--wayland-app-id`: the old `--wayland-appid` is not an mpv
  // option, and mpv quit at once with "option not found" on every Wayland-only launch.
  mpvWindow: ({ appId, env = process.env, mpvHasWayland }) => {
    const hasWayland = Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE?.toLowerCase() === "wayland";
    const hasX11 = Boolean(env.DISPLAY);
    if (hasX11) return { defaultVo: "gpu,x11", cpuVo: "x11", args: [`--x11-name=${appId}`], noWindow: null };
    if (!hasWayland) return { defaultVo: "gpu,x11", cpuVo: null, args: [], noWindow: null };
    if (mpvHasWayland?.() === true) {
      return { defaultVo: "gpu,x11", cpuVo: null, args: [`--wayland-app-id=${appId}`], noWindow: null };
    }
    return { defaultVo: "gpu,x11", cpuVo: null, args: [], noWindow: "mpv_no_display" };
  },
  quitWhenAllWindowsClosed: true,
  hasDisplay: (env = process.env) => Boolean(env.DISPLAY || env.WAYLAND_DISPLAY),
  // safeStorage's keyring entry is "<name> Safe Storage": renaming the app would lose the sign-in.
  appName: ({ legacyName }) => legacyName,
  applicationMenu: false,
  trayIcon: "color",
};

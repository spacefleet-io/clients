import type { ShellLayer } from "@space/desktop-platform-contract";

export const windowsShell: ShellLayer = {
  prepareApp: (app, { appUserModelId }) => {
    app.setAppUserModelId(appUserModelId);
  },
  // Nothing to register at run time: mpv.exe is its own process, outside Badger's AppUserModelId, and its window
  // and taskbar button take the icon and name built into mpv.exe, which the media-deps windows-x64 recipe makes
  // Badger's (MPV-MODEL-05, recipes/windows-x64/brand-mpv.sh).
  prepareMpvWindow: ({ env }) => ({ ...env }),
  // d3d11 GPU vo (#25): with no usable GPU it renders on a WARP (software)
  // device, which is the CPU fallback, so the list needs no second vo and
  // there is no separate CPU vo to launch straight on.
  mpvWindow: () => ({ defaultVo: "gpu", cpuVo: null, args: [], unsetEnv: [], noWindow: null }),
  quitWhenAllWindowsClosed: true,
  hasDisplay: () => true,
  // Same name as Linux and every existing install (the AppUserModelId carries the product identity).
  appName: ({ legacyName }) => legacyName,
  applicationMenu: false,
  trayIcon: "color",
};

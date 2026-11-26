import type { ShellLayer } from "@space/desktop-platform-contract";

export const macosShell: ShellLayer = {
  // No AppUserModelId / WM class on macOS: the app's identity is its bundle (Info.plist).
  prepareApp: () => {},
  // The mpv window's name and Dock icon come from its helper app bundle (`Badger Player.app`,
  // MPV-MODEL-03), so nothing is registered at run time; libc malloc needs no arena cap.
  prepareMpvWindow: ({ env }) => ({ ...env }),
  // gpu-next through Vulkan on Metal (MoltenVK), not Apple's deprecated OpenGL (MPV-GPU-03). The
  // window's app id comes from the helper app bundle, so there is no id flag.
  // No CPU vo: every Mac has a Metal GPU, and mpv's other macOS vo (libmpv/cocoa-cb) is not used.
  mpvWindow: () => ({ defaultVo: "gpu-next", cpuVo: null, args: ["--gpu-api=vulkan", "--gpu-context=macvk"], unsetEnv: [], noWindow: null }),
  // PLAT-DESK-06: closing the last window keeps Badger running in the Dock and the menu bar.
  // Every explicit quit (Cmd+Q, app menu, menu-bar Quit) calls app.quit() itself, so the
  // window-all-closed handler never has to.
  quitWhenAllWindowsClosed: false,
  hasDisplay: () => true,
  // REL-MAC-05: the Dock, the app menu and "Quit Badger" carry the product name.
  appName: ({ productName }) => productName,
  // macOS has one global menu bar the app fills (app menu with Hide / Quit, Edit for copy / paste, Window).
  applicationMenu: true,
  // Menu-bar icons are monochrome template images that macOS tints for light / dark menu bars.
  trayIcon: "template",
};

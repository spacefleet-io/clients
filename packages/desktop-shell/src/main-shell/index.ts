/** Electron main-process shell Badger and Parrot desktop share: tray, close-to-tray, application menu, silent launches. */
import type { MainShellStrings } from "./menu";
import type { TrayLabels } from "./tray";

export * from "./menu";
export * from "./protocolClient";
export * from "./silentAudio";
export * from "./tray";
export * from "./userDataDir";

/** The tray's words for an app: "Open <app>", Quit, and the app's name as tooltip. */
export const trayLabelsFor = (strings: MainShellStrings, appName: string): TrayLabels => ({
  open: strings.trayOpen(appName),
  quit: strings.trayQuit,
  tooltip: appName,
});

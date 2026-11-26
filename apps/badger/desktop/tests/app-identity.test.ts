/**
 * The app name + Electron userData dir per OS, resolved through the REAL
 * platform implementations (not mocks): Linux and Windows must keep exactly the
 * name and data dir existing installs use, macOS is Badger with its data in
 * ~/Library/Application Support/Badger (REL-MAC-05).
 */
import { describe, expect, it } from "vitest";

import { platform as linux } from "@space/desktop-platform-linux";
import { platform as macos } from "@space/desktop-platform-macos";
import { platform as windows } from "@space/desktop-platform-windows";
import { BADGER_IDENTITY } from "../src/main/appIdentity";
import { buildApplicationMenu, resolveAppIdentity, type AppIdentityPlatform } from "@space/desktop-shell/main-shell";

/** Badger's declaration through the shared resolver, as index.ts calls it. */
const badgerIdentity = (platform: AppIdentityPlatform, appData: string, env: NodeJS.ProcessEnv, devBuild: boolean) =>
  resolveAppIdentity({ ...BADGER_IDENTITY, platform, appData, env, devBuild });

describe("app identity per OS", () => {
  it("keeps the Linux name and userData dir of existing installs (Badger, ~/.config/@sf/desktop)", () => {
    const identity = badgerIdentity(linux, "/home/u/.config", {}, false);
    console.info(`[app-identity:linux] ${JSON.stringify(identity)}`);
    expect(identity).toEqual({ name: "Badger", userDataDir: "/home/u/.config/@sf/desktop" });
  });

  it("keeps the Windows name and userData dir of existing installs (Badger, %APPDATA%\\@sf\\desktop)", () => {
    const identity = badgerIdentity(windows, "C:\\Users\\u\\AppData\\Roaming", {}, false);
    console.info(`[app-identity:windows] ${JSON.stringify(identity)}`);
    expect(identity).toEqual({ name: "Badger", userDataDir: "C:\\Users\\u\\AppData\\Roaming\\@sf\\desktop" });
  });

  // @req PLAT-DESK-07 app data in ~/Library/Application Support/Badger
  // @req REL-MAC-05 the Mac app is named Badger
  it("names the Mac app Badger with its data in Application Support/Badger", () => {
    const identity = badgerIdentity(macos, "/Users/u/Library/Application Support", {}, false);
    console.info(`[app-identity:macos] ${JSON.stringify(identity)}`);
    expect(identity).toEqual({ name: "Badger", userDataDir: "/Users/u/Library/Application Support/Badger" });
  });

  it("lets SF_USER_DATA_PATH override the dir on every OS", () => {
    for (const platform of [linux, windows, macos]) {
      expect(badgerIdentity(platform, "/x", { SF_USER_DATA_PATH: " /lane/data " }, false).userDataDir).toBe("/lane/data");
    }
  });
});

// @req PLAT-DESK-06 macOS app menu: "Quit Badger" (Cmd+Q) is the explicit quit, Edit menu for copy/paste
describe("application menu", () => {
  it("is only installed where the OS has a global menu bar", () => {
    expect([linux.shell.applicationMenu, windows.shell.applicationMenu, macos.shell.applicationMenu]).toEqual([false, false, true]);
    expect([linux.shell.trayIcon, windows.shell.trayIcon, macos.shell.trayIcon]).toEqual(["color", "color", "template"]);
  });

  it("has the app menu with Hide and a Cmd+Q 'Quit Badger' through requestQuit, plus Edit and Window", () => {
    let quits = 0;
    const menu = buildApplicationMenu({ appName: "Badger", requestQuit: () => quits++ });
    console.info(`[app-menu] ${JSON.stringify(menu, (key, value) => (key === "click" ? "[fn]" : value))}`);
    const appMenu = menu[0]!;
    expect(appMenu.label).toBe("Badger");
    const items = appMenu.submenu as Array<{ label?: string; role?: string; accelerator?: string; click?: () => void }>;
    expect(items.find((item) => item.role === "hide")?.label).toBe("Hide Badger");
    const quit = items.find((item) => item.label === "Quit Badger");
    expect(quit?.accelerator).toBe("CommandOrControl+Q");
    expect(quit?.role).toBeUndefined();
    quit?.click?.();
    expect(quits).toBe(1);
    expect(menu.map((entry) => entry.role)).toEqual([undefined, "editMenu", "windowMenu"]);
  });
});

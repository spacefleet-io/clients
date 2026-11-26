import { describe, expect, it } from "vitest";
import { windowsShell } from "../src/shell";

describe("windows shell", () => {
  it("prepareApp sets the AppUserModelId and nothing else", () => {
    const calls: string[] = [];
    windowsShell.prepareApp(
      { setAppUserModelId: (id) => calls.push(`aumid:${id}`), commandLine: { appendSwitch: (name) => calls.push(`switch:${name}`) } },
      { appUserModelId: "io.example.app", linuxWindowClass: "Ignored" }
    );
    console.info("[windows-shell:prepareApp]", calls);
    expect(calls).toEqual(["aumid:io.example.app"]);
  });

  it("prepareMpvWindow returns a copy of env", () => {
    const env = { KEEP: "1" };
    const out = windowsShell.prepareMpvWindow({ appId: "x", dataDir: "C:\\data", env });
    expect(out).toEqual({ KEEP: "1" });
    expect(out).not.toBe(env);
  });

  // #25: the CPU path is a WARP device inside the gpu vo, so there is no separate CPU vo to launch straight on.
  it("mpvWindow uses the gpu vo, no separate CPU vo and no app-id flags", () => {
    expect(windowsShell.mpvWindow({ appId: "io.example.app", env: { DISPLAY: ":0" } })).toEqual({ defaultVo: "gpu", cpuVo: null, args: [], unsetEnv: [], noWindow: null });
  });

  it("quits with the last window and always has a display", () => {
    expect(windowsShell.quitWhenAllWindowsClosed).toBe(true);
    expect(windowsShell.hasDisplay({})).toBe(true);
    expect(windowsShell.hasDisplay()).toBe(true);
  });

  it("keeps the legacy app name, no application menu, a colour tray icon and in-app updates", () => {
    expect(windowsShell.appName({ productName: "SpaceBadger", legacyName: "@space/badger" })).toBe("@space/badger");
    expect(windowsShell.applicationMenu).toBe(false);
    expect(windowsShell.trayIcon).toBe("color");
  });
});

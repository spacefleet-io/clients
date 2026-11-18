import { describe, expect, it } from "vitest";
import { installSourceFromInstaller, linuxInstallSource, withInstallSource } from "../src/installSource";
import { compareVersions, formatClientHeader, parseClientHeader, splitInstallSource } from "../src/appVersion";

const SUITE = "install-source";
const log = (testId: string, phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${testId} ${phase}`, data === undefined ? "" : JSON.stringify(data));

describe("REL-CD-29 install source: only the store family leaves the device", () => {
  it("maps each Android installer to its family, anything else to sideload @req REL-CD-29 @req OPS-BIZ-10", () => {
    const testId = "android-installer";
    const cases: Array<[string | null | undefined, string]> = [
      ["com.android.vending", "play"],
      [" COM.ANDROID.VENDING ", "play"],
      ["org.fdroid.fdroid", "fdroid"],
      ["org.fdroid.fdroid.privileged", "fdroid"],
      ["org.fdroid.basic", "fdroid"],
      ["com.looker.droidify", "fdroid"],
      ["com.machiav3lli.fdroid", "fdroid"],
      ["nya.kitsunyan.foxydroid", "fdroid"],
      ["dev.imranr.obtainium", "obtainium"],
      ["dev.imranr.obtainium.fdroid", "obtainium"],
      ["com.google.android.packageinstaller", "sideload"],
      ["com.android.chrome", "sideload"],
      ["", "sideload"],
      [null, "sideload"],
      [undefined, "sideload"],
    ];
    log(testId, "start", { count: cases.length });
    const actual = cases.map(([installer]) => [installer, installSourceFromInstaller(installer)]);
    log(testId, "mapped", actual);
    expect(actual).toEqual(cases);
    log(testId, "done");
  });

  it("tells Flatpak, AppImage and a system package apart on Linux @req REL-CD-29 @req OPS-BIZ-10", () => {
    const testId = "linux-env";
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ FLATPAK_ID: "com.spacefleet.Parrot" }, "flatpak"],
      [{ FLATPAK_ID: "com.spacefleet.Badger", APPIMAGE: "/tmp/x.AppImage" }, "flatpak"],
      [{ APPIMAGE: "/home/u/Apps/Parrot.AppImage" }, "appimage"],
      [{ FLATPAK_ID: " ", APPIMAGE: "" }, "system"],
      [{}, "system"],
    ];
    log(testId, "start", { count: cases.length });
    const actual = cases.map(([env]) => [env, linuxInstallSource(env)]);
    log(testId, "mapped", actual);
    expect(actual).toEqual(cases);
    log(testId, "done");
  });

  it("appends the source as build metadata the version gate ignores @req REL-CD-29 @req OPS-BIZ-10", () => {
    const testId = "with-source";
    log(testId, "start");
    expect(withInstallSource("0.3.1", "play")).toBe("0.3.1+play");
    expect(withInstallSource("1.0.0-beta.2", "fdroid")).toBe("1.0.0-beta.2+fdroid");
    expect(withInstallSource("0.3.1", null)).toBe("0.3.1");
    expect(withInstallSource("0.3.1+ci.4", "play")).toBe("0.3.1+ci.4");
    const header = formatClientHeader({ app: "badger", platform: "android", version: withInstallSource("0.3.1", "play") });
    const parsed = parseClientHeader(header);
    log(testId, "header", { header, parsed });
    expect(header).toBe("badger/android/0.3.1+play");
    expect(parsed).toEqual({ app: "badger", platform: "android", version: "0.3.1+play" });
    expect(compareVersions("0.3.1+play", "0.3.1")).toBe(0);
    expect(compareVersions("0.3.0+sideload", "0.3.1")).toBeLessThan(0);
    // What the API reads back (OPS-BIZ-10) is exactly what the client appended.
    expect(splitInstallSource(withInstallSource("0.3.1", "play"))).toEqual({ version: "0.3.1", source: "play" });
    expect(splitInstallSource(withInstallSource("0.1.3", "flatpak"))).toEqual({ version: "0.1.3", source: "flatpak" });
    log(testId, "done");
  });
});

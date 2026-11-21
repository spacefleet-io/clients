import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  modules: {} as Record<string, unknown>,
  platform: { OS: "android", isTV: false } as { OS: string; isTV?: boolean },
}));

vi.mock("react-native", () => ({
  get NativeModules() {
    return native.modules;
  },
  get Platform() {
    return native.platform;
  },
}));

import { deviceClientIdentity, mobileClientIdentity, mobileClientPlatform, nativeAppInfo, openInstallerListing } from "../src/appInfo";
import { formatClientHeader, type ClientIdentity } from "@space/shared/appVersion";

const SUITE = "app-info";
const log = (testId: string, phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${testId} ${phase}`, data === undefined ? "" : JSON.stringify(data));

const header = (identity: ClientIdentity | null) => (identity ? formatClientHeader(identity) : null);

afterEach(() => {
  native.modules = {};
  native.platform = { OS: "android", isTV: false };
});

describe("REL-CD-29 phone and TV builds state version and store", () => {
  it("reads SpaceAppInfo's constants however the bridge exposes them @req REL-CD-29", () => {
    const testId = "native-constants";
    const cases = [
      { name: "property", modules: { SpaceAppInfo: { appVersion: "0.3.1", installer: "com.android.vending" } } },
      { name: "getConstants", modules: { SpaceAppInfo: { getConstants: () => ({ appVersion: " 0.3.1 ", installer: "" }) } } },
      { name: "apple", modules: { SpaceAppInfo: { appVersion: "0.1.3" } } },
      { name: "blank", modules: { SpaceAppInfo: { appVersion: "", installer: null } } },
      { name: "missing", modules: {} },
      { name: "no-modules", modules: undefined },
    ].map((c) => ({ name: c.name, info: nativeAppInfo(c.modules) }));
    log(testId, "read", cases);
    expect(cases.map((c) => c.info)).toEqual([
      { version: "0.3.1", installer: "com.android.vending" },
      { version: "0.3.1", installer: null },
      { version: "0.1.3", installer: null },
      { version: null, installer: null },
      { version: null, installer: null },
      { version: null, installer: null },
    ]);
    log(testId, "done");
  });

  it("names the platform for phones and TVs @req REL-CD-29", () => {
    const testId = "platform";
    const actual = [
      mobileClientPlatform({ OS: "android" }),
      mobileClientPlatform({ OS: "android", isTV: true }),
      mobileClientPlatform({ OS: "ios" }),
      mobileClientPlatform({ OS: "ios", isTV: true }),
    ];
    log(testId, "platforms", actual);
    expect(actual).toEqual(["android", "android-tv", "ios", "tvos"]);
  });

  it("adds the store family on Android only, never the installer name @req REL-CD-29 @req OPS-BIZ-10", () => {
    const testId = "identity";
    const cases = [
      header(mobileClientIdentity("badger", { OS: "android" }, { version: "0.3.1", installer: "com.android.vending" })),
      header(mobileClientIdentity("badger", { OS: "android", isTV: true }, { version: "0.2.0", installer: "com.android.vending" })),
      header(mobileClientIdentity("parrot", { OS: "android" }, { version: "0.1.3", installer: "org.fdroid.fdroid" })),
      header(mobileClientIdentity("parrot", { OS: "android" }, { version: "0.1.3", installer: "dev.imranr.obtainium" })),
      header(mobileClientIdentity("parrot", { OS: "android" }, { version: "0.1.3", installer: "com.google.android.packageinstaller" })),
      header(mobileClientIdentity("parrot", { OS: "android" }, { version: "0.1.3", installer: null })),
      header(mobileClientIdentity("parrot", { OS: "ios" }, { version: "0.1.3", installer: null })),
      header(mobileClientIdentity("badger", { OS: "ios", isTV: true }, { version: "0.3.1", installer: null })),
      header(mobileClientIdentity("badger", { OS: "android" }, { version: null, installer: "com.android.vending" })),
    ];
    log(testId, "headers", cases);
    expect(cases).toEqual([
      "badger/android/0.3.1+play",
      "badger/android-tv/0.2.0+play",
      "parrot/android/0.1.3+fdroid",
      "parrot/android/0.1.3+obtainium",
      "parrot/android/0.1.3+sideload",
      "parrot/android/0.1.3+sideload",
      "parrot/ios/0.1.3",
      "badger/tvos/0.3.1",
      null,
    ]);
    expect(cases.join(" ")).not.toContain("vending");
    log(testId, "done");
  });

  it("reads this device and never throws while the app starts @req REL-CD-29 @req OPS-BIZ-10", () => {
    const testId = "device";
    native.modules = { SpaceAppInfo: { appVersion: "0.1.3", installer: "com.looker.droidify" } };
    const parrot = deviceClientIdentity("parrot");
    log(testId, "android", parrot);
    expect(parrot && formatClientHeader(parrot)).toBe("parrot/android/0.1.3+fdroid");

    native.platform = undefined as unknown as { OS: string };
    const broken = deviceClientIdentity("parrot");
    log(testId, "broken-platform", broken);
    expect(broken).toBeNull();
    log(testId, "done");
  });
});

describe("REL-CD-29 update screen: where the update comes from", () => {
  it("reads the Apple distribution and keeps it off the API header @req REL-CD-29", () => {
    const testId = "apple-distribution";
    const cases = [
      nativeAppInfo({ SpaceAppInfo: { appVersion: "0.1.3", appleDistribution: "testflight" } }),
      nativeAppInfo({ SpaceAppInfo: { getConstants: () => ({ appVersion: "0.1.3", appleDistribution: "appstore" }) } }),
      nativeAppInfo({ SpaceAppInfo: { appVersion: "0.1.3", appleDistribution: "enterprise" } }),
      nativeAppInfo({ SpaceAppInfo: { appVersion: "0.1.3" } }),
    ];
    log(testId, "read", cases);
    expect(cases).toEqual([
      { version: "0.1.3", installer: null, appleDistribution: "testflight" },
      { version: "0.1.3", installer: null, appleDistribution: "appstore" },
      { version: "0.1.3", installer: null },
      { version: "0.1.3", installer: null },
    ]);
    const sent = header(mobileClientIdentity("badger", { OS: "ios" }, cases[0]!));
    log(testId, "header", sent);
    expect(sent).toBe("badger/ios/0.1.3");
    log(testId, "done");
  });

  it("asks the installing app to show the listing, false when it cannot @req REL-CD-29", async () => {
    const testId = "open-installer";
    const opened = await openInstallerListing({ SpaceAppInfo: { openInstaller: async () => true } });
    const nothing = await openInstallerListing({ SpaceAppInfo: { openInstaller: async () => false } });
    const missing = await openInstallerListing({ SpaceAppInfo: { appVersion: "0.1.3" } });
    const noModules = await openInstallerListing(undefined);
    const thrown = await openInstallerListing({
      SpaceAppInfo: {
        openInstaller: async () => {
          throw new Error("no activity");
        },
      },
    });
    log(testId, "results", { opened, nothing, missing, noModules, thrown });
    expect([opened, nothing, missing, noModules, thrown]).toEqual([true, false, false, false, false]);
    log(testId, "done");
  });
});

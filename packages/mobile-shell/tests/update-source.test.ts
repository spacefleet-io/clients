/**
 * @test-id MOBILE-SHELL-UPDATE-SOURCE-001
 * @level unit
 * @req REL-CD-29[badger-mobile,badger-tv,parrot]
 * @why REL-CD-29 (vault v4 slice 11, audit gap 9): a store app cannot replace itself, so the phone and TV update
 *   screens must name the one place this install's new version comes from and open it. Before, every Android install
 *   got the Play Store (Badger's library screen even had a wrong package name and a placeholder App Store id), and an
 *   F-Droid or hand-installed APK user was sent somewhere that cannot update them. This walks the whole mapping
 *   (installer package × build flavour × Apple distribution), the button's installer-first order, and the copy in
 *   every app language.
 * @covers packages/mobile-shell/src/updateSource.ts packages/mobile-shell/src/androidBuild.ts packages/mobile-shell/src/androidBuild.foss.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  modules: {} as Record<string, unknown>,
  platform: { OS: "android", isTV: false } as { OS: string; isTV?: boolean },
  opened: [] as string[],
  openFails: false,
}));

vi.mock("react-native", () => ({
  get NativeModules() {
    return native.modules;
  },
  get Platform() {
    return native.platform;
  },
  Linking: {
    openURL: async (url: string) => {
      if (native.openFails) throw new Error("no handler");
      native.opened.push(url);
    },
  },
}));

import { ANDROID_PACKAGE_NAMES } from "@space/shared/androidRepo";
import { ANDROID_BUILD } from "../src/androidBuild";
import { ANDROID_BUILD as FOSS_BUILD } from "../src/androidBuild.foss";
import {
  UPDATE_SOURCE_KINDS,
  deviceUpdateSource,
  openUpdateSource,
  updateSourceFor,
  type UpdateSourceInput,
} from "../src/updateSource";

const T = "[MOBILE-SHELL-UPDATE-SOURCE-001]";
const say = (line: string, extra?: unknown) => console.info(`${T} ${line}`, extra === undefined ? "" : JSON.stringify(extra));

const android = { OS: "android", isTV: false };
const source = (installer: string | null, over: Partial<UpdateSourceInput> = {}) =>
  updateSourceFor({ app: "parrot", platform: android, build: { version: "0.1.3", installer }, androidBuild: "play", language: "en", ...over });

afterEach(() => {
  native.modules = {};
  native.platform = { OS: "android", isTV: false };
  native.opened = [];
  native.openFails = false;
});

describe("REL-CD-29: where this install's update comes from", () => {
  it("Android: each store opens itself, its web page as the fallback", () => {
    const cases = {
      play: source("com.android.vending"),
      playBadgerTv: source("com.android.vending", { app: "badger", platform: { OS: "android", isTV: true } }),
      fdroid: source("org.fdroid.fdroid"),
      droidify: source("com.looker.droidify"),
      neostore: source("com.machiav3lli.fdroid"),
      obtainium: source("dev.imranr.obtainium"),
      amazon: source("com.amazon.venezia"),
      galaxy: source("com.sec.android.app.samsungapps"),
    };
    say("stores", cases);
    expect(cases).toEqual({
      play: { kind: "play", url: "https://play.google.com/store/apps/details?id=io.spacefleet.parrot", viaInstaller: true },
      playBadgerTv: { kind: "play", url: "https://play.google.com/store/apps/details?id=com.spacebadger.mobile", viaInstaller: true },
      fdroid: { kind: "fdroid", url: "https://packages.spacefleet.io/parrot/fdroid", viaInstaller: true },
      droidify: { kind: "fdroid", url: "https://packages.spacefleet.io/parrot/fdroid", viaInstaller: true },
      neostore: { kind: "fdroid", url: "https://packages.spacefleet.io/parrot/fdroid", viaInstaller: true },
      obtainium: { kind: "obtainium", url: "https://packages.spacefleet.io/parrot/fdroid", viaInstaller: true },
      amazon: { kind: "amazon", url: "https://www.amazon.com/gp/mas/dl/android?p=io.spacefleet.parrot", viaInstaller: true },
      galaxy: { kind: "store", url: "market://details?id=io.spacefleet.parrot", viaInstaller: true },
    });
  });

  it("Android: a hand-installed APK gets the download of its own flavour (the two cannot update each other)", () => {
    const hand = [null, "", "com.android.shell", "pc", "adb", "com.google.android.packageinstaller", "com.android.packageinstaller", "io.spacefleet.parrot", "io.spacefleet.parrot.e2e"];
    const play = hand.map((installer) => source(installer, { language: "fr" }));
    const foss = hand.map((installer) => source(installer, { androidBuild: "foss", language: "fr" }));
    say("hand play", play);
    say("hand foss", foss);
    for (const s of play) {
      expect(s).toEqual({ kind: "apk", url: "https://spacefleet.io/fr/downloads?app=parrot#android-repo", viaInstaller: false });
    }
    for (const s of foss) expect(s).toEqual({ kind: "apk", url: "https://packages.spacefleet.io/parrot/fdroid", viaInstaller: false });
    const badgerSelf = source("com.spacebadger.mobile", { app: "badger" });
    say("badger self-update", badgerSelf);
    expect(badgerSelf.kind).toBe("apk");
    expect(badgerSelf.url).toBe("https://spacefleet.io/en/downloads?app=badger#android-repo");
  });

  it("Apple: App Store or TestFlight by the receipt, no button on the TV, nothing known without the module", () => {
    const ios = (appleDistribution: "appstore" | "testflight" | undefined, isTV = false, app: "badger" | "parrot" = "badger") =>
      updateSourceFor({ app, platform: { OS: "ios", isTV }, build: { version: "0.3.1", installer: null, appleDistribution }, androidBuild: "play", language: "en" });
    const cases = {
      appstore: ios("appstore"),
      testflight: ios("testflight"),
      parrotAppstore: ios("appstore", false, "parrot"),
      parrotTestflight: ios("testflight", false, "parrot"),
      tvAppstore: ios("appstore", true),
      tvTestflight: ios("testflight", true),
      oldNative: ios(undefined),
      web: updateSourceFor({ app: "parrot", platform: { OS: "web" }, build: { version: null, installer: null }, androidBuild: "play", language: "en" }),
    };
    say("apple", cases);
    expect(cases).toEqual({
      appstore: { kind: "appstore", url: "itms-apps://apps.apple.com/app/id6834213191", viaInstaller: false },
      testflight: { kind: "testflight", url: "https://testflight.apple.com/join/YmGWM7jf", viaInstaller: false },
      parrotAppstore: { kind: "appstore", url: "itms-apps://apps.apple.com/app/id6834212693", viaInstaller: false },
      parrotTestflight: { kind: "testflight", url: "https://testflight.apple.com/join/gVnGuwSY", viaInstaller: false },
      tvAppstore: { kind: "appstore", url: null, viaInstaller: false },
      tvTestflight: { kind: "testflight", url: null, viaInstaller: false },
      oldNative: { kind: "unknown", url: null, viaInstaller: false },
      web: { kind: "unknown", url: null, viaInstaller: false },
    });
  });

  it("the Play package names are the apps' Android applicationIds (no stale `io.spacebadger.android`)", () => {
    const gradleId = (app: string) =>
      /applicationId "([^"]+)"/.exec(readFileSync(resolve(__dirname, `../../../apps/${app}/mobile/android/app/build.gradle`), "utf8"))?.[1];
    const fromGradle = { badger: gradleId("badger"), parrot: gradleId("parrot") };
    say("applicationId", { fromGradle, ANDROID_PACKAGE_NAMES });
    expect(fromGradle).toEqual(ANDROID_PACKAGE_NAMES);
  });

  it("the build flavour is Play by default and Google-free in the foss sibling Metro swaps in", () => {
    say("flavours", { ANDROID_BUILD, FOSS_BUILD });
    expect([ANDROID_BUILD, FOSS_BUILD]).toEqual(["play", "foss"]);
  });

  it("reads this device and never throws", () => {
    native.modules = { SpaceAppInfo: { appVersion: "0.1.3", installer: "org.fdroid.fdroid" } };
    const fdroid = deviceUpdateSource("parrot", "de");
    native.platform = undefined as unknown as { OS: string };
    const broken = deviceUpdateSource("parrot", "de");
    say("device", { fdroid, broken });
    expect(fdroid.kind).toBe("fdroid");
    expect(broken).toEqual({ kind: "unknown", url: null, viaInstaller: false });
  });

  it("the button asks the installer first, then opens the address, and opens nothing without one", async () => {
    const calls: string[] = [];
    native.modules = { SpaceAppInfo: { openInstaller: async () => (calls.push("installer"), true) } };
    const viaInstaller = await openUpdateSource(source("org.fdroid.fdroid"));
    say("installer opened", { viaInstaller, calls, opened: native.opened });
    expect(viaInstaller).toBe(true);
    expect(calls).toEqual(["installer"]);
    expect(native.opened).toEqual([]);

    native.modules = { SpaceAppInfo: { openInstaller: async () => (calls.push("installer-none"), false) } };
    const fallback = await openUpdateSource(source("org.fdroid.fdroid"));
    const apk = await openUpdateSource(source(null));
    say("url fallback", { fallback, apk, calls, opened: native.opened });
    expect([fallback, apk]).toEqual([true, true]);
    expect(calls).toEqual(["installer", "installer-none"]);
    expect(native.opened).toEqual(["https://packages.spacefleet.io/parrot/fdroid", "https://spacefleet.io/en/downloads?app=parrot#android-repo"]);

    const none = await openUpdateSource({ kind: "unknown", url: null, viaInstaller: false });
    native.openFails = true;
    const failed = await openUpdateSource(source(null));
    say("nothing to open", { none, failed });
    expect([none, failed]).toEqual([false, false]);
  });

  it("every source has its sentence and (but unknown) its button in every app language", () => {
    for (const language of ["en", "fr", "de", "es", "nl"]) {
      const json = JSON.parse(readFileSync(resolve(__dirname, `../src/i18n/${language}.json`), "utf8")) as {
        appUpdate: { tooOld: string; how: Record<string, string>; open: Record<string, string> };
        libraryFormat: Record<string, string>;
      };
      const how = UPDATE_SOURCE_KINDS.map((kind) => json.appUpdate.how[kind]);
      const open = UPDATE_SOURCE_KINDS.filter((kind) => kind !== "unknown").map((kind) => json.appUpdate.open[kind]);
      say(`copy ${language}`, { tooOld: json.appUpdate.tooOld, how, open });
      expect(json.appUpdate.tooOld).toContain("{{app}}");
      for (const line of how) expect(line).toContain("{{app}}");
      for (const label of open) expect(label?.length).toBeGreaterThan(0);
      expect(Object.keys(json.appUpdate.how).sort()).toEqual([...UPDATE_SOURCE_KINDS].sort());
      expect(Object.keys(json.libraryFormat).sort()).toEqual(["body", "title"]);
      // Product names are never translated.
      expect(json.appUpdate.how.play).toContain("Google Play");
      expect(json.appUpdate.how.fdroid).toContain("F-Droid");
      expect(json.appUpdate.how.obtainium).toContain("Obtainium");
      expect(json.appUpdate.how.testflight).toContain("TestFlight");
    }
  });
});

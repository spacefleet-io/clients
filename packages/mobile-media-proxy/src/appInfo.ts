import { NativeModules, Platform } from "react-native";
import type { SpaceAppId } from "@space/shared/appScope";
import type { ClientIdentity, ClientPlatform } from "@space/shared/appVersion";
import { installSourceFromInstaller, withInstallSource } from "@space/shared/installSource";

/**
 * REL-CD-29: what a phone or TV build of Badger or Parrot states about itself on every API call. The `SpaceAppInfo`
 * native module (AppInfoModule.kt, ios/Proxy/SpaceAppInfo.swift) lives in this package because it is the one native
 * library both apps already link on every platform.
 */
export type NativeAppInfo = {
  /**
   * The store version: Android `versionName`, iOS/tvOS `CFBundleShortVersionString`. `package.json`'s version is not
   * the store version (the release workflow stamps the tag into the native build only). Null where the module is
   * missing (an older native build under a newer bundle, tests): the app then states no version, and the API never
   * refuses it for one.
   */
  version: string | null;
  /** Android only: the installer's package name (raw, mapped on device before anything is sent); null when unknown. */
  installer: string | null;
  /**
   * Apple only: where this build came from, TestFlight (a sandbox receipt) or the App Store, so the update screen sends
   * the user to the right one. Absent elsewhere and from an older native build. Never sent to the API.
   */
  appleDistribution?: AppleDistribution;
};

export type AppleDistribution = "testflight" | "appstore";

type AppInfoConstants = { appVersion?: unknown; installer?: unknown; appleDistribution?: unknown };

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Reads the `SpaceAppInfo` constants, through the property first, then `getConstants()`. */
export const nativeAppInfo = (modules: Record<string, unknown> | undefined = NativeModules): NativeAppInfo => {
  const module = modules?.SpaceAppInfo as (AppInfoConstants & { getConstants?: () => AppInfoConstants }) | undefined;
  if (!module) return { version: null, installer: null };
  const constants = typeof module.appVersion === "string" ? module : (module.getConstants?.() ?? {});
  const info: NativeAppInfo = { version: text(constants.appVersion), installer: text(constants.installer) };
  const distribution = constants.appleDistribution;
  if (distribution === "testflight" || distribution === "appstore") info.appleDistribution = distribution;
  return info;
};

/**
 * REL-CD-29 update screen, Android only: asks the app that installed this build (Play, an F-Droid client, Amazon, any
 * other store) to show this app's page there, or opens that app when it shows no page (Obtainium). False when no
 * installer is known, it opens nothing, or the native method is missing (an older native build, Apple platforms).
 */
export const openInstallerListing = async (modules: Record<string, unknown> | undefined = NativeModules): Promise<boolean> => {
  const open = (modules?.SpaceAppInfo as { openInstaller?: () => Promise<boolean> } | undefined)?.openInstaller;
  if (typeof open !== "function") return false;
  try {
    return (await open()) === true;
  } catch (error) {
    console.warn("[app-info] openInstaller failed", error);
    return false;
  }
};

/** Where a build runs, in the API's platform names: a phone or a TV, Android or Apple. */
export const mobileClientPlatform = (platform: { OS: string; isTV?: boolean }): ClientPlatform => {
  const apple = platform.OS === "ios";
  if (platform.isTV) return apple ? "tvos" : "android-tv";
  return apple ? "ios" : "android";
};

/**
 * `badger/android/0.3.1+play` on Android (phone and TV: the installer's family, never its package name),
 * `parrot/ios/0.1.0` on Apple platforms. Null without a store version.
 */
export const mobileClientIdentity = (
  app: SpaceAppId,
  platform: { OS: string; isTV?: boolean },
  build: NativeAppInfo,
): ClientIdentity | null => {
  if (!build.version) return null;
  const source = platform.OS === "android" ? installSourceFromInstaller(build.installer) : null;
  return { app, platform: mobileClientPlatform(platform), version: withInstallSource(build.version, source) };
};

/**
 * This device's identity for `app`, for `setClientIdentity` while the app's API config loads. Never throws (a throw
 * there would stop the app from starting): an unreadable native module states no identity.
 */
export const deviceClientIdentity = (app: SpaceAppId): ClientIdentity | null => {
  try {
    return mobileClientIdentity(app, Platform, nativeAppInfo());
  } catch (error) {
    console.warn("[app-info] identity unavailable", error);
    return null;
  }
};

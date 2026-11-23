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
};

type AppInfoConstants = { appVersion?: unknown; installer?: unknown };

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Reads the `SpaceAppInfo` constants, through the property first, then `getConstants()`. */
export const nativeAppInfo = (modules: Record<string, unknown> | undefined = NativeModules): NativeAppInfo => {
  const module = modules?.SpaceAppInfo as (AppInfoConstants & { getConstants?: () => AppInfoConstants }) | undefined;
  if (!module) return { version: null, installer: null };
  const constants = typeof module.appVersion === "string" ? module : (module.getConstants?.() ?? {});
  return { version: text(constants.appVersion), installer: text(constants.installer) };
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

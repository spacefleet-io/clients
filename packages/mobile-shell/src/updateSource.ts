/**
 * REL-CD-29 (library change types 4): where this install's next version really comes from, for the update screens of
 * Badger and Parrot on phones and TVs (`MobileUpdateRequiredScreen`, Badger's `LibraryFormatTooNewScreen`). A store
 * app cannot replace itself, so the screen names the one place the update comes from and its one button opens it:
 *
 * - Apple: the App Store, or TestFlight for a TestFlight build (`appleDistribution`, a sandbox receipt). No button on
 *   the Apple TV (no store page opens from an app there); the sentence names where to go.
 * - Android, from the installer package (`SpaceAppInfo.installer`, never sent raw): Google Play, the Amazon Appstore,
 *   an F-Droid client (our repository, REL-DIST-21), Obtainium, any other store ("the store you installed it from"),
 *   or nobody / the system package installer / this app's own self-update: a hand-installed APK, whose download page
 *   depends on the build flavour (`ANDROID_BUILD`): the Google-free APK's short address, else the downloads page's
 *   "Without Google Play" window holding the APK with Google services (the two cannot update each other, WEB-DL-05).
 * - Nothing known (a native build without the module): the sentence says "from where you got it", no button.
 *
 * On Android the button first asks the installer itself to show the app (`openInstaller`: the real store app, even
 * with several installed), then falls back to the web address.
 */
import { Linking, NativeModules, Platform } from "react-native";
import type { SpaceAppId } from "@space/shared/appScope";
import { ANDROID_PACKAGES_HOST, ANDROID_PACKAGE_NAMES } from "@space/shared/androidRepo";
import { installSourceFromInstaller } from "@space/shared/installSource";
import { androidApkDownloadsUrl } from "@space/shared/websiteLinks";
import { nativeAppInfo, openInstallerListing, type NativeAppInfo } from "@space/mobile-media-proxy/app-info";
import { ANDROID_BUILD } from "./androidBuild";
import { scopeLogger } from "./logger";

const log = scopeLogger("update-source");

export const UPDATE_SOURCE_KINDS = ["appstore", "testflight", "play", "amazon", "fdroid", "obtainium", "apk", "store", "unknown"] as const;
export type UpdateSourceKind = (typeof UPDATE_SOURCE_KINDS)[number];

export type UpdateSource = {
  kind: UpdateSourceKind;
  /** What the button opens when the installer does not (or on Apple); null = no button. */
  url: string | null;
  /** Android: ask the installing app first (`SpaceAppInfo.openInstaller`). */
  viaInstaller: boolean;
};

/** App Store Connect app ids: the ones the release workflow uploads to (`ascAppId`; a test keeps the two equal). */
export const APPLE_APP_IDS: Readonly<Record<SpaceAppId, string>> = { badger: "6834213191", parrot: "6834212693" };
/**
 * Each app's TestFlight "Public beta" link. Not on the App Store yet, so a TestFlight install updates here; the public
 * link opens the TestFlight app on the device and still works in a browser when TestFlight is missing.
 */
export const TESTFLIGHT_PUBLIC_LINKS: Readonly<Record<SpaceAppId, string>> = {
  badger: "https://testflight.apple.com/join/YmGWM7jf",
  parrot: "https://testflight.apple.com/join/gVnGuwSY",
};

/** Installer names that mean "installed by hand": the shell, OnePlus's `pc`, `adb` (none at all counts too). */
const HAND_INSTALLERS: Readonly<Record<string, true>> = { "com.android.shell": true, pc: true, adb: true };
const AMAZON_APPSTORE = "com.amazon.venezia";

export type UpdateSourceInput = {
  app: SpaceAppId;
  platform: { OS: string; isTV?: boolean };
  build: NativeAppInfo;
  androidBuild: "play" | "foss";
  /** The app's language, for the downloads page. */
  language: string;
};

export const updateSourceFor = ({ app, platform, build, androidBuild, language }: UpdateSourceInput): UpdateSource => {
  if (platform.OS === "ios") {
    if (!build.appleDistribution) return { kind: "unknown", url: null, viaInstaller: false };
    const testflight = build.appleDistribution === "testflight";
    const url = platform.isTV
      ? null
      : testflight
        ? TESTFLIGHT_PUBLIC_LINKS[app]
        : `itms-apps://apps.apple.com/app/id${APPLE_APP_IDS[app]}`;
    return { kind: testflight ? "testflight" : "appstore", url, viaInstaller: false };
  }
  if (platform.OS !== "android") return { kind: "unknown", url: null, viaInstaller: false };
  const pkg = ANDROID_PACKAGE_NAMES[app];
  const installer = build.installer?.trim().toLowerCase() || null;
  const repoPage = `${ANDROID_PACKAGES_HOST}/${app}/fdroid`;
  // Nobody, the system installer, or this app itself (its self-update, a `.e2e` test build too): an APK by hand.
  if (!installer || HAND_INSTALLERS[installer] || installer.endsWith(".packageinstaller") || installer.startsWith(pkg)) {
    return { kind: "apk", url: androidBuild === "foss" ? repoPage : androidApkDownloadsUrl(app, language), viaInstaller: false };
  }
  if (installer === AMAZON_APPSTORE) {
    return { kind: "amazon", url: `https://www.amazon.com/gp/mas/dl/android?p=${pkg}`, viaInstaller: true };
  }
  const family = installSourceFromInstaller(installer);
  if (family === "play") return { kind: "play", url: `https://play.google.com/store/apps/details?id=${pkg}`, viaInstaller: true };
  if (family === "fdroid" || family === "obtainium") return { kind: family, url: repoPage, viaInstaller: true };
  return { kind: "store", url: `market://details?id=${pkg}`, viaInstaller: true };
};

/** This device's update source for `app`. Never throws: an unreadable native module gives "unknown". */
export const deviceUpdateSource = (app: SpaceAppId, language: string): UpdateSource => {
  try {
    return updateSourceFor({ app, platform: Platform, build: nativeAppInfo(), androidBuild: ANDROID_BUILD, language });
  } catch (error) {
    log.warn("update_source_unavailable", { message: String(error) });
    return { kind: "unknown", url: null, viaInstaller: false };
  }
};

/** The button: the installing app first, then the web address. True when something opened. */
export const openUpdateSource = async (source: UpdateSource): Promise<boolean> => {
  if (source.viaInstaller && (await openInstallerListing(NativeModules))) {
    log.info("update_source_opened", { kind: source.kind, via: "installer" });
    return true;
  }
  if (!source.url) return false;
  try {
    await Linking.openURL(source.url);
    log.info("update_source_opened", { kind: source.kind, via: "url" });
    return true;
  } catch (error) {
    log.warn("update_source_open_failed", { kind: source.kind, message: String(error) });
    return false;
  }
};

import type { InstallSource } from "./appVersion";

/**
 * REL-CD-29, OPS-BIZ-10: where an installed build came from, stated as semver build metadata on the version the app
 * already sends (`x-space-client: badger/android/0.3.1+play`), so the API can count installs per store while the
 * version parser and the minimum-version check keep ignoring everything after `+`. Only the coarse family leaves the
 * device, never the raw installer package name.
 */

/** Android installer package names (`InstallSourceInfo.installingPackageName`) of the stores we count. */
const ANDROID_INSTALLERS: Readonly<Record<string, InstallSource>> = Object.freeze({
  "com.android.vending": "play",
  // F-Droid and the clients that install from F-Droid repositories.
  "org.fdroid.fdroid": "fdroid",
  "org.fdroid.fdroid.privileged": "fdroid",
  "org.fdroid.basic": "fdroid",
  "com.looker.droidify": "fdroid",
  "com.machiav3lli.fdroid": "fdroid",
  "nya.kitsunyan.foxydroid": "fdroid",
  "dev.imranr.obtainium": "obtainium",
  "dev.imranr.obtainium.fdroid": "obtainium",
});

/** The family of an Android installer; any other installer, or none (browser + package installer, adb), is `sideload`. */
export const installSourceFromInstaller = (
  installer: string | null | undefined,
): Extract<InstallSource, "play" | "fdroid" | "obtainium" | "sideload"> => {
  const family = installer ? ANDROID_INSTALLERS[installer.trim().toLowerCase()] : undefined;
  return (family as "play" | "fdroid" | "obtainium" | undefined) ?? "sideload";
};

/**
 * How a packaged Linux desktop build was installed, from its environment: inside Flatpak (`FLATPAK_ID`), run as an
 * AppImage (`APPIMAGE`), else from a system package (deb, rpm, pacman).
 */
export const linuxInstallSource = (
  env: Readonly<Record<string, string | undefined>>,
): Extract<InstallSource, "flatpak" | "appimage" | "system"> => {
  if (env.FLATPAK_ID?.trim()) return "flatpak";
  if (env.APPIMAGE?.trim()) return "appimage";
  return "system";
};

/**
 * `0.3.1` + `play` → `0.3.1+play`. Unchanged without a source, or when the version already carries build metadata
 * (semver allows one `+`; such a build is counted without a source rather than sent malformed).
 */
export const withInstallSource = (version: string, source: InstallSource | null | undefined): string =>
  source && !version.includes("+") ? `${version}+${source}` : version;

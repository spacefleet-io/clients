/**
 * REL-UPD-06: who manages this install, read from Android's install source (`PackageManager.getInstallSourceInfo` on
 * Android 11+, `getInstallerPackageName` below). The app offers to update itself only when nobody else does.
 *
 * - `managed`: a store or updater app installed it (or started the install) and updates it: never offer.
 * - `unmanaged`: the APK was installed by hand (adb, the system package installer, opened from a browser or a file
 *   manager) or by this app's own earlier self-update: offer.
 * - `unknown`: an installer or initiator on neither list: never prompt; Settings only says a new version exists.
 *
 * The lists are the one place that names these apps (tests: `tests/install-source.test.ts`).
 */

/** Stores and updater apps that keep the app up to date themselves. */
export const MANAGING_INSTALLERS: Readonly<Record<string, true>> = {
  // Google Play (and its old installer name).
  "com.android.vending": true,
  "com.google.android.feedback": true,
  // F-Droid client, F-Droid Basic, the privileged extension.
  "org.fdroid.fdroid": true,
  "org.fdroid.basic": true,
  "org.fdroid.fdroid.privileged": true,
  // Droid-ify, Neo Store, Aurora Droid.
  "com.looker.droidify": true,
  "com.machiav3lli.fdroid": true,
  "com.aurora.adroid": true,
  // Obtainium and its F-Droid build.
  "dev.imranr.obtainium": true,
  "dev.imranr.obtainium.fdroid": true,
  // Aurora Store, Accrescent.
  "com.aurora.store": true,
  "app.accrescent.client": true,
  // Samsung Galaxy Store, Huawei AppGallery, Amazon Appstore (phones and Fire TV).
  "com.sec.android.app.samsungapps": true,
  "com.huawei.appmarket": true,
  "com.amazon.venezia": true,
  // Xiaomi GetApps, OPPO / OnePlus / realme App Market, vivo App Store.
  "com.xiaomi.mipicks": true,
  "com.xiaomi.market": true,
  "com.heytap.market": true,
  "com.oppo.market": true,
  "com.bbk.appstore": true,
  // APKPure, Uptodown, Aptoide.
  "com.apkpure.aegon": true,
  "com.uptodown": true,
  "cm.aptoide.pt": true,
};

/** The system package installer, which installs an APK the user opened (AOSP, Google, OEM builds). */
export const SYSTEM_INSTALLERS: Readonly<Record<string, true>> = {
  "com.android.packageinstaller": true,
  "com.google.android.packageinstaller": true,
  "com.samsung.android.packageinstaller": true,
  "com.miui.packageinstaller": true,
  "com.oplus.packageinstaller": true,
  "com.coloros.packageinstaller": true,
  "com.huawei.packageinstaller": true,
  "com.amazon.tv.packageinstaller": true,
  // `adb install` on the versions that record the shell rather than nobody.
  "com.android.shell": true,
};

/** Names some Android builds record as the installer of an `adb install` instead of nobody ("pc" on OnePlus). */
export const ADB_INSTALLERS: Readonly<Record<string, true>> = {
  pc: true,
  adb: true,
};

/** Any `*.packageinstaller` is an OEM's system installer, so a vendor missing above still counts. */
const isSystemInstaller = (name: string) => SYSTEM_INSTALLERS[name] || name.endsWith(".packageinstaller");

/** Browsers and file managers: an APK opened from them was downloaded by hand, so nobody updates it. */
export const HAND_INSTALL_INITIATORS: Readonly<Record<string, true>> = {
  // Browsers.
  "com.android.chrome": true,
  "com.chrome.beta": true,
  "org.chromium.chrome": true,
  "org.mozilla.firefox": true,
  "org.mozilla.firefox_beta": true,
  "org.mozilla.fenix": true,
  "org.mozilla.focus": true,
  "us.spotco.fennec_dos": true,
  "org.ironfoxoss.ironfox": true,
  "io.github.forkmaintainers.iceraven": true,
  "com.brave.browser": true,
  "com.sec.android.app.sbrowser": true,
  "com.microsoft.emmx": true,
  "com.opera.browser": true,
  "com.opera.mini.native": true,
  "com.vivaldi.browser": true,
  "com.duckduckgo.mobile.android": true,
  "org.torproject.torbrowser": true,
  "app.vanadium.browser": true,
  "org.cromite.cromite": true,
  "com.kiwibrowser.browser": true,
  "com.mi.globalbrowser": true,
  "com.heytap.browser": true,
  "com.huawei.browser": true,
  "com.amazon.cloud9": true,
  // TV sideloading apps (Downloader, Send Files to TV).
  "com.esaba.downloader": true,
  "com.yablio.sendfilestotv": true,
  // System downloads and files.
  "com.android.providers.downloads": true,
  "com.android.providers.downloads.ui": true,
  "com.android.documentsui": true,
  "com.google.android.documentsui": true,
  "com.google.android.apps.nbu.files": true,
  // OEM file managers.
  "com.sec.android.app.myfiles": true,
  "com.mi.android.globalFileexplorer": true,
  "com.android.fileexplorer": true,
  "com.oneplus.filemanager": true,
  "com.coloros.filemanager": true,
  "com.huawei.hidisk": true,
  // File managers.
  "me.zhanghai.android.files": true,
  "org.fossify.filemanager": true,
  "com.simplemobiletools.filemanager.pro": true,
  "com.amaze.filemanager": true,
  "pl.solidexplorer2": true,
  "bin.mt.plus": true,
  "com.mixplorer": true,
  "com.mixplorer.silver": true,
  "com.ghisler.android.TotalCommander": true,
  "com.lonelycatgames.Xplore": true,
  "com.alphainventor.filemanager": true,
  "com.cxinventor.file.explorer": true,
  "com.estrongs.android.pop": true,
  "com.mobisystems.fileman": true,
};

export type InstallSource = {
  /** The app that committed the install (`installingPackageName`), null for adb and some hand installs. */
  installing: string | null;
  /** The app that asked for the install (`initiatingPackageName`, Android 11+), null when unknown. */
  initiating: string | null;
};

export type InstallManager = "managed" | "unmanaged" | "unknown";

/** `self` is this app's own package name: an install it made through its own self-update stays its to update. */
export const classifyInstallSource = (source: InstallSource, self: string): InstallManager => {
  // An empty name is no name, and an adb installer name is the same as adb's usual nobody.
  const installing = source.installing && !ADB_INSTALLERS[source.installing] ? source.installing : null;
  const initiating = source.initiating || null;
  // A store that started the install through the system installer (F-Droid's and Droid-ify's legacy installers) or
  // committed it itself manages the app, whichever side names it.
  if ((installing && MANAGING_INSTALLERS[installing]) || (initiating && MANAGING_INSTALLERS[initiating])) return "managed";
  if (installing === self) return "unmanaged";
  if (installing !== null && !isSystemInstaller(installing)) return "unknown";
  // Installed by nobody (adb) or by the system installer: who asked for it decides.
  if (initiating === null || initiating === self || isSystemInstaller(initiating) || HAND_INSTALL_INITIATORS[initiating]) return "unmanaged";
  return "unknown";
};

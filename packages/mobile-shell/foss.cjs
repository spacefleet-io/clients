// The Google-free Android build (SF_FOSS=1): the F-Droid build and the APK published for phones without Google Play
// services (PLAT-MOBILE-06). One switch for every step that shapes the app, shared by Badger and Parrot:
// - autolinking (react-native.config.js) leaves the libraries that link Google Play services or Firebase out of the
//   Android build (`fossAutolinkExclusions`);
// - Metro swaps each JS import of those libraries for a stand-in, and any `<name>.ts(x)` module with a sibling
//   `<name>.foss.ts(x)` for that sibling (`withFossStubs`);
// - app/build.gradle and settings.gradle read the same variable for the native side.
// Unset, every step is exactly the Play build.
//
// The self-update (REL-UPD-06) rides the same switch: every foss build links @space/mobile-self-update (its code and
// its REQUEST_INSTALL_PACKAGES permission), so the APK we publish and the one f-droid.org rebuilds from
// scripts/android-foss-build.sh stay one identical, reproducible APK. The Play build never has it (Google Play policy).
// On device it acts only when no store or updater app manages the install.
const fs = require("fs");
const path = require("path");

const fossBuild = process.env.SF_FOSS === "1";
const selfUpdateBuild = fossBuild;

const SELF_UPDATE_PACKAGE = "@space/mobile-self-update";
const SELF_UPDATE_ROOT = path.resolve(__dirname, "../mobile-self-update");

/**
 * The `dependencies` entry for @space/mobile-self-update in an app's react-native.config.js: linked on Android in the
 * self-update build, unlinked everywhere else.
 */
const selfUpdateAutolink = (enabled = selfUpdateBuild) => ({
  [SELF_UPDATE_PACKAGE]: enabled ? { root: SELF_UPDATE_ROOT } : { root: SELF_UPDATE_ROOT, platforms: { android: null, ios: null } },
});

/**
 * Wraps a Metro `resolveRequest`: outside the self-update build, `@space/mobile-self-update` resolves to its stand-in
 * (`src/index.off.ts`, the same names doing nothing), so no updater code reaches the bundle.
 */
const withSelfUpdate = (resolveRequest, enabled = selfUpdateBuild) => {
  if (enabled) return resolveRequest;
  const stub = path.join(SELF_UPDATE_ROOT, "src/index.off.ts");
  return (context, moduleName, platform) =>
    moduleName === SELF_UPDATE_PACKAGE ? { type: "sourceFile", filePath: stub } : resolveRequest(context, moduleName, platform);
};

/** Native libraries that pull in Google Play services or Firebase (com.google.android.gms, com.google.mlkit, com.google.firebase). */
const PLAY_SERVICES_LIBRARIES = Object.freeze([
  "@react-native-firebase/app",
  "@react-native-firebase/messaging",
  "react-native-camera-kit",
  "react-native-google-cast",
]);

/** The stand-in for an import that has no module in this build: it loads and exports only `notInThisBuild`, which the importer checks to leave the feature off. */
const NOT_IN_THIS_BUILD = path.join(__dirname, "src/foss/notInThisBuild.ts");

/**
 * `dependencies` entries for an app's react-native.config.js: in the Google-free build, every Play services library the
 * app depends on is unlinked on Android. Empty otherwise.
 */
const fossAutolinkExclusions = (appDir, enabled = fossBuild) => {
  if (!enabled) return {};
  const { dependencies = {} } = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
  return Object.fromEntries(
    PLAY_SERVICES_LIBRARIES.filter((name) => name in dependencies).map((name) => [name, { platforms: { android: null } }]),
  );
};

/** `<dir>/<name>.foss.<ext>` beside a resolved source file, when the Google-free build has one. */
const fossSibling = (filePath) => {
  const match = /^(.*)\.(ts|tsx)$/.exec(filePath);
  if (!match || match[1].endsWith(".foss")) return null;
  const sibling = `${match[1]}.foss.${match[2]}`;
  return fs.existsSync(sibling) ? sibling : null;
};

/**
 * Wraps a Metro `resolveRequest`. In the Google-free build, an import named in `stubs` resolves to its stand-in (the
 * Firebase modules to that marker-only module), and a resolved source file with a `.foss` sibling to that sibling.
 */
const withFossStubs = (resolveRequest, stubs = {}, enabled = fossBuild) => {
  if (!enabled) return resolveRequest;
  const byName = {
    "@react-native-firebase/app": NOT_IN_THIS_BUILD,
    "@react-native-firebase/messaging": NOT_IN_THIS_BUILD,
    ...stubs,
  };
  return (context, moduleName, platform) => {
    if (byName[moduleName]) return { type: "sourceFile", filePath: byName[moduleName] };
    const resolution = resolveRequest(context, moduleName, platform);
    const sibling = resolution.type === "sourceFile" ? fossSibling(resolution.filePath) : null;
    return sibling ? { type: "sourceFile", filePath: sibling } : resolution;
  };
};

module.exports = { fossBuild, selfUpdateBuild, PLAY_SERVICES_LIBRARIES, fossAutolinkExclusions, withFossStubs, selfUpdateAutolink, withSelfUpdate };

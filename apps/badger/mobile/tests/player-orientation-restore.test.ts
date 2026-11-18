/**
 * Phones: the app is portrait-only, the player landscape-only (UX-ORIENT-01). TVs: never portrait (PLAT-TV-01).
 *
 * Field bugs this guards (OnePlus 6):
 * - With rotation free, the shell laid out sideways was unusable (posters sized for a 2280 px width, Media library header
 *   and tab bar filling most of the 1080 px height). MainActivity now locks phones to portrait at creation (not in the
 *   manifest, which would also lock TVs).
 * - Leaving the player used to clear the lock (`UNSPECIFIED` = follow the sensor); a phone lying flat or propped reports no
 *   orientation, so the shell stayed in landscape. Leaving the player now restores the orientation requested before it
 *   (PORTRAIT on phones).
 * The native modules are not unit-runnable from vitest, so this pins the contract in their sources (same approach as
 * playback-cache-pause.test.ts); the on-device proof is play -> back -> rotate -> screenshot in the PR.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ANDROID_MODULE = resolve(
  __dirname,
  "../../../../packages/mobile-mpv-playback/android/src/main/java/com/spacefleet/mpvplayback/mpv/MpvControlModule.kt",
);
const MANIFEST = resolve(__dirname, "../android/app/src/main/AndroidManifest.xml");
const MAIN_ACTIVITY = resolve(__dirname, "../android/app/src/main/java/com/spacebadger/mobile/MainActivity.kt");
const IOS_MODULE = resolve(__dirname, "../../../../packages/mobile-mpv-playback/ios/Player/MpvControl.swift");
const APP_DELEGATE = resolve(__dirname, "../ios/SpaceBadgerMobile/AppDelegate.swift");

/** The body of `setImmersiveLandscape`'s `else` (last player closing) branch. */
const closingBranch = (source: string): string => {
  const start = source.indexOf("fun setImmersiveLandscape");
  expect(start, "setImmersiveLandscape must exist").toBeGreaterThan(-1);
  const fn = source.slice(start);
  const elseAt = fn.indexOf("} else {");
  expect(elseAt, "player-closing branch").toBeGreaterThan(-1);
  return fn.slice(elseAt, fn.indexOf("promise.resolve(true)"));
};

describe("portrait app, landscape player (Android)", () => {
  const source = readFileSync(ANDROID_MODULE, "utf8");

  it("@req UX-ORIENT-01 @bugfix @regression-proof locks the app activity to portrait on phones, not on TVs", () => {
    const manifest = readFileSync(MANIFEST, "utf8");
    const activity = manifest.slice(manifest.indexOf('android:name=".MainActivity"'), manifest.indexOf("</activity>"));
    const main = readFileSync(MAIN_ACTIVITY, "utf8");
    console.info(`[player-orientation] MainActivity manifest:\n${activity.slice(0, 400)}`);
    console.info(`[player-orientation] MainActivity.onCreate:\n${main.slice(main.indexOf("fun onCreate"), main.indexOf("super.onCreate"))}`);
    expect(activity, "a manifest lock would also force portrait on TVs").not.toMatch(/android:screenOrientation=/);
    const onCreate = main.slice(main.indexOf("fun onCreate"), main.indexOf("super.onCreate"));
    // The TV check may be cached in a property (`private val television by lazy { isTelevision() }`).
    const tvProperty = /private val (\w+) by lazy \{ isTelevision\(\) \}/.exec(main)?.[1];
    const tvCheck = tvProperty ? `(?:isTelevision\\(\\)|${tvProperty})` : "isTelevision\\(\\)";
    expect(onCreate).toMatch(new RegExp(`if \\(!${tvCheck}\\) requestedOrientation = ActivityInfo\\.SCREEN_ORIENTATION_PORTRAIT`));
  });

  it("@req UX-ORIENT-01 @bugfix @regression-proof the player takes landscape and gives back the earlier orientation, never the sensor", () => {
    const branch = closingBranch(source);
    const fn = source.slice(source.indexOf("fun setImmersiveLandscape"));
    const opening = fn.slice(fn.indexOf("if (enabled) {"), fn.indexOf("} else if"));
    console.info(`[player-orientation] opening branch:\n${opening}`);
    console.info(`[player-orientation] closing branch:\n${branch}`);
    expect(opening).toMatch(/if \(playerScreens == 0\) orientationBeforePlayer = activity\.requestedOrientation/);
    expect(opening).toMatch(/requestedOrientation\s*=\s*ActivityInfo\.SCREEN_ORIENTATION_SENSOR_LANDSCAPE/);
    expect(branch).toMatch(/orientationBeforePlayer\?\.let \{ activity\.requestedOrientation = it \}/);
    expect(branch).toMatch(/orientationBeforePlayer = null/);
    expect(source, "UNSPECIFIED lets the sensor rotate the portrait-only shell").not.toMatch(/SCREEN_ORIENTATION_UNSPECIFIED/);
  });

  it("@bugfix @regression-proof keeps the landscape lock while an overlapping player screen is still mounted", () => {
    // A next-episode swap mounts the new player before the old one unmounts: restoring on the first unmount rotated the
    // player that is still on screen.
    expect(source).toMatch(/playerScreens\s*\+=\s*1/);
    expect(source).toMatch(/else if\s*\(playerScreens\s*>\s*1\)\s*\{[^}]*playerScreens\s*-=\s*1/);
  });

  it("@bugfix @regression-proof re-reads React Native's window metrics after the player's rotation round trip", () => {
    // Field bug: after play -> back the details sheet was laid out 2201 px wide on the 1080 px portrait screen (JS `Dimensions`
    // kept the landscape size: RN re-reads display metrics only when the rotation value changes, and that read can precede
    // the application resources' new configuration). Every later tap landed on nothing until the app was restarted.
    expect(source).toMatch(/DisplayMetricsHolder\.initDisplayMetrics\(app\)/);
    expect(source).toMatch(/emitDeviceEvent\(\s*"didUpdateDimensions"/);
    const entering = source.slice(source.indexOf("if (enabled) {"), source.indexOf("} else if (playerScreens > 1)"));
    expect(entering, "entering the player re-syncs too").toMatch(/scheduleDimensionResync\(activity\)/);
    expect(closingBranch(source), "leaving the player re-syncs").toMatch(/scheduleDimensionResync\(activity\)/);
  });
});

describe("portrait app, landscape player (iOS)", () => {
  const source = readFileSync(IOS_MODULE, "utf8");

  it("@req UX-ORIENT-01 the app delegate allows only the mask the player module sets, portrait by default", () => {
    const delegate = readFileSync(APP_DELEGATE, "utf8");
    expect(delegate).toMatch(/supportedInterfaceOrientationsFor window: UIWindow\?[\s\S]*?window !== self\.window, window\.windowLevel < \.alert else \{ return AppOrientation\.mask \}/);
    expect(source).toMatch(/static var mask: UIInterfaceOrientationMask = \.portrait/);
  });

  it("@req UX-ORIENT-01 sets the mask before requesting the rotation, and keeps landscape for an overlapping player", () => {
    const fn = source.slice(source.indexOf("func setImmersiveLandscape"));
    console.info(`[player-orientation] iOS setImmersiveLandscape:\n${fn.slice(0, 1200)}`);
    expect(fn.indexOf("AppOrientation.mask = mask")).toBeGreaterThan(-1);
    expect(fn.indexOf("AppOrientation.mask = mask")).toBeLessThan(fn.indexOf("requestGeometryUpdate"));
    expect(fn).toMatch(/if !enabled && AppOrientation\.playerScreens > 0 \{\s*resolve\(true\)\s*return/);
  });
});

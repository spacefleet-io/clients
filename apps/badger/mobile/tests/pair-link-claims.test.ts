import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");

describe("Badger claims only its own pairing links", () => {
  // @req ACCT-PAIR-06
  it("[badger-pair-claim-1] Android: a verified https://spacefleet.io/pair/badger filter, nothing for /pair/parrot", () => {
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    const filters = manifest.match(/<intent-filter[\s\S]*?<\/intent-filter>/gu) ?? [];
    const pair = filters.filter((f) => f.includes("/pair/"));
    console.info("[badger-pair-claim-1] pairing filters", JSON.stringify(pair));
    expect(pair).toHaveLength(1);
    expect(pair[0]).toContain('android:autoVerify="true"');
    expect(pair[0]).toContain('android:scheme="https" android:host="spacefleet.io" android:pathPrefix="/pair/badger"');
    expect(filters.join("")).not.toContain("/pair/parrot");
  });

  // @req ACCT-PAIR-06
  it("[badger-pair-claim-3] Android: still opens spacebadger://pair, the QR of desktops released before the web link", () => {
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    const legacy = (manifest.match(/<intent-filter[\s\S]*?<\/intent-filter>/gu) ?? []).filter((f) => f.includes('android:host="pair"'));
    console.info("[badger-pair-claim-3] legacy filter", JSON.stringify(legacy));
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toContain('android:scheme="spacebadger" android:host="pair"');
    expect(manifest).toContain("below the minimum supported version (REL-CD-08)");
    // The phones' shared intake (quality audit #3350 S21) reads the old link only when the app asks for it: Badger does.
    expect(read("src/navigation/AppNavigator.tsx")).toContain("createPendingPairLink({ legacy: true })");
    expect(read("../../../packages/mobile-shell/src/pairing-approve/pairLink.ts")).toContain("legacy ? parseLegacyPairLink(url) : null");
  });

  // @req ACCT-PAIR-06
  it("[badger-pair-claim-2] iOS: device builds carry applinks:spacefleet.io and hand Universal Links to JS", () => {
    const entitlements = read("ios/SpaceBadgerMobile/SpaceBadgerMobile-Device.entitlements");
    console.info("[badger-pair-claim-2] entitlements", entitlements.replace(/\s+/gu, " "));
    expect(entitlements).toContain("com.apple.developer.associated-domains");
    expect(entitlements).toContain("<string>applinks:spacefleet.io</string>");
    // Under the UIScene lifecycle (PLAT-MOBILE-09) a Universal Link reaches the scene, not the AppDelegate: while the app
    // runs through scene(_:continue:), on a cold start in the scene's connection options, handed to JS as launch options.
    // The scene code is the shared SpaceSceneDelegate (SiblingSignIn pod); the app's SceneDelegate only subclasses it.
    expect(read("ios/SpaceBadgerMobile/AppDelegate.swift")).toMatch(/class SceneDelegate: SpaceSceneDelegate \{\}/u);
    const swift = read("../../../packages/mobile-sibling/ios/SiblingSignIn/SpaceSceneDelegate.swift");
    expect(swift).toMatch(/func scene\(\s*_ scene: UIScene,\s*continue userActivity: NSUserActivity\s*\)/u);
    expect(swift).toContain("RCTLinkingManager.scene(scene, continue: userActivity)");
    expect(swift).toContain("options.userActivities.first");
    expect(swift).toContain("launch[.userActivityDictionary]");
  });
});

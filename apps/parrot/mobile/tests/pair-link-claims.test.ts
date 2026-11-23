import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");

describe("Parrot claims only its own pairing links", () => {
  // @req ACCT-PAIR-06
  it("[parrot-pair-claim-1] Android: a verified https://spacefleet.io/pair/parrot filter, nothing for /pair/badger or a pair scheme", () => {
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    const filters = manifest.match(/<intent-filter[\s\S]*?<\/intent-filter>/gu) ?? [];
    const pair = filters.filter((f) => f.includes("/pair/"));
    console.info("[parrot-pair-claim-1] pairing filters", JSON.stringify(pair));
    expect(pair).toHaveLength(1);
    expect(pair[0]).toContain('android:autoVerify="true"');
    expect(pair[0]).toContain('android:scheme="https" android:host="spacefleet.io" android:pathPrefix="/pair/parrot"');
    expect(filters.join("")).not.toContain("/pair/badger");
    expect(filters.join("")).not.toMatch(/android:host="pair"/u);
  });

  // @req ACCT-PAIR-06
  it("[parrot-pair-claim-2] iOS: device builds carry applinks:spacefleet.io and hand Universal Links to JS", () => {
    const entitlements = read("ios/Parrot/Parrot-Device.entitlements");
    console.info("[parrot-pair-claim-2] entitlements", entitlements.replace(/\s+/gu, " "));
    expect(entitlements).toContain("com.apple.developer.associated-domains");
    expect(entitlements).toContain("<string>applinks:spacefleet.io</string>");
    expect(read("ios/Parrot/AppDelegate.swift")).toContain("RCTLinkingManager.application(application, continue: userActivity");
  });
});

/**
 * @test-id MOBILE-SELF-UPDATE-OFFER-001
 * @level unit
 * @req REL-UPD-06
 * @why What a hand-installed Android app does with the newest APK of our repository: prompt, offer it in Settings, only
 *   mention it, or nothing. "Later" holds the prompt for a day; "Update automatically" off keeps it to Settings.
 */
import { describe, expect, it } from "vitest";
import type { RepoApk } from "@space/shared/androidRepo";
import { checkDue, DAY_MS, offerFor, sameSigners, type OfferInput } from "../src/decide";

const signer = "19c4be454fdfa4a4ee1e9dac053b1c2e269f788b95301ba3c91a1a479662f8c4";
const newest: RepoApk = { versionName: "0.1.10", versionCode: 16000, apkName: "badger-android-0.1.10-16000-foss.apk", sha256: "ab".repeat(32), size: 1, signers: [signer] };
const now = 1_795_000_000_000;
const base: OfferInput = { manager: "unmanaged", autoUpdate: true, installedVersionCode: 15767, installedSigners: [signer], newest, snoozedUntil: 0, now };

describe("the update offer (REL-UPD-06)", () => {
  // @req REL-UPD-06
  it("a hand install with a newer version is prompted", () => {
    expect(offerFor(base)).toBe("prompt");
  });

  // @req REL-UPD-06
  it("a store-managed install is never offered, even a newer version", () => {
    expect(offerFor({ ...base, manager: "managed" })).toBe("none");
  });

  // @req REL-UPD-06
  it("an unknown installer only gets the Settings line", () => {
    expect(offerFor({ ...base, manager: "unknown" })).toBe("info");
  });

  // @req REL-UPD-06
  it("nothing when current, when the feed has nothing, or when the new APK has another key", () => {
    expect(offerFor({ ...base, installedVersionCode: 16000 })).toBe("none");
    expect(offerFor({ ...base, installedVersionCode: 16001 })).toBe("none");
    expect(offerFor({ ...base, newest: null })).toBe("none");
    expect(offerFor({ ...base, installedSigners: ["cd".repeat(32)] })).toBe("none");
  });

  // @req REL-UPD-06
  it("Later and the switch turned off keep the update in Settings only", () => {
    expect(offerFor({ ...base, snoozedUntil: now + DAY_MS })).toBe("offer");
    expect(offerFor({ ...base, snoozedUntil: now })).toBe("prompt");
    expect(offerFor({ ...base, autoUpdate: false })).toBe("offer");
  });

  // @req REL-UPD-06
  it("checks on launch, then once a day", () => {
    expect(checkDue(0, now)).toBe(true);
    expect(checkDue(now - DAY_MS + 1, now)).toBe(false);
    expect(checkDue(now - DAY_MS, now)).toBe(true);
  });

  // @req REL-UPD-06
  it("signers compare as sets, case aside, and none never match", () => {
    expect(sameSigners([signer], [signer.toUpperCase()])).toBe(true);
    expect(sameSigners([signer, "ab".repeat(32)], ["ab".repeat(32), signer])).toBe(true);
    expect(sameSigners([signer], [signer, "ab".repeat(32)])).toBe(false);
    expect(sameSigners([], [])).toBe(false);
  });
});

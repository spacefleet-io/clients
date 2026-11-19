/**
 * @test-id SHARED-APP-FEATURES-001
 * @level unit
 *
 * UX-SETUP-10, UX-UPDATE-01: which profile gets a feature's setup step and which gets the "New in this update" window.
 * A profile created on or after the feature's `since` gets the step, one created before gets the window, and once the
 * profile's features hold the feature (`set` or `later`) neither shows again. The step and window texts exist in the 5
 * languages.
 */
import { describe, expect, it } from "vitest";
import {
  APP_FEATURES,
  APP_FEATURE_IDS,
  isAppFeatureId,
  isAppFeatureState,
  pendingSetupFeatures,
  pendingUpdateFeatures,
} from "../src/appFeatures";
import { profilesTexts, profilesTranslator } from "../src/profileTexts";

const since = APP_FEATURES.find((feature) => feature.id === "avatars")!.since;
const shifted = (ms: number) => new Date(Date.parse(since) + ms).toISOString();

describe("app features", () => {
  it("@req UX-SETUP-10 @req UX-UPDATE-01 avatars is the one feature, dated 19 November 2026", () => {
    expect(APP_FEATURE_IDS).toEqual(["avatars"]);
    expect(since).toBe("2026-11-19T00:00:00.000Z");
    expect(isAppFeatureId("avatars")).toBe(true);
    for (const bad of ["", "Avatars", "colours", 1, null, undefined]) expect(isAppFeatureId(bad)).toBe(false);
    for (const state of ["set", "later"]) expect(isAppFeatureState(state)).toBe(true);
    for (const bad of ["", "done", "Set", true, null, undefined]) expect(isAppFeatureState(bad)).toBe(false);
  });

  it("@req UX-SETUP-10 a profile created on or after the date gets the setup step, never the update window", () => {
    for (const createdAt of [since, shifted(1), shifted(86_400_000)]) {
      console.info(`[app-features] created ${createdAt}: setup=${pendingSetupFeatures({ createdAt, features: {} })}`);
      expect(pendingSetupFeatures({ createdAt, features: {} }), createdAt).toEqual(["avatars"]);
      expect(pendingUpdateFeatures({ createdAt, features: {} }), createdAt).toEqual([]);
    }
  });

  it("@req UX-UPDATE-01 a profile created before the date gets the update window, never the setup step", () => {
    for (const createdAt of [shifted(-1), "2026-01-01T12:00:00.000Z"]) {
      console.info(`[app-features] created ${createdAt}: update=${pendingUpdateFeatures({ createdAt, features: {} })}`);
      expect(pendingUpdateFeatures({ createdAt, features: {} }), createdAt).toEqual(["avatars"]);
      expect(pendingSetupFeatures({ createdAt, features: {} }), createdAt).toEqual([]);
    }
  });

  it("@req UX-SETUP-10 @req UX-UPDATE-01 a feature set or put off for later never shows again, on either side of the date", () => {
    for (const createdAt of [since, shifted(-1)]) {
      for (const state of ["set", "later"] as const) {
        expect(pendingSetupFeatures({ createdAt, features: { avatars: state } }), `${createdAt} ${state}`).toEqual([]);
        expect(pendingUpdateFeatures({ createdAt, features: { avatars: state } }), `${createdAt} ${state}`).toEqual([]);
      }
    }
  });

  it("@req UX-SETUP-10 @req UX-UPDATE-01 a profile without features (an older API) counts as nothing set up", () => {
    expect(pendingSetupFeatures({ createdAt: since })).toEqual(["avatars"]);
    expect(pendingUpdateFeatures({ createdAt: shifted(-1) })).toEqual(["avatars"]);
  });

  it("@req UX-SETUP-10 @req UX-UPDATE-01 the step and the window have every text in the 5 languages", () => {
    for (const [language, texts] of Object.entries(profilesTexts)) {
      for (const text of [texts.setup.title, texts.setup.lead, texts.setup.name, texts.setup.tvRename, texts.whatsNew.badge, texts.whatsNew.later]) {
        expect(text.trim(), language).not.toBe("");
      }
      for (const id of APP_FEATURE_IDS) {
        const feature = texts.whatsNew[id];
        for (const text of [feature.title, feature.text, feature.cta]) expect(text.trim(), `${language} ${id}`).not.toBe("");
        expect(feature.text, `${language} ${id}`).toContain("{{name}}");
      }
    }
    expect(profilesTranslator("en")("profiles.setup.title")).toBe("Your profile");
    expect(profilesTranslator("en")("profiles.whatsNew.avatars.text", { name: "Kids" })).toBe(
      "Profiles now have avatars, the same on every app. Choose one for Kids."
    );
    expect(profilesTranslator("fr")("profiles.whatsNew.badge")).toBe("Nouveau dans cette mise à jour");
  });
});

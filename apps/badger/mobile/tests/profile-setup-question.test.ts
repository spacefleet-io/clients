/**
 * @test-id BADGER-MOBILE-PROFILE-SETUP-001
 * @level unit
 * @why "Your profile" (UX-SETUP-10) and "New in this update" (UX-UPDATE-01) in Badger phone and TV: during the phone's
 *   first setup the step is a numbered step (the navigator stays on "setup"); otherwise it shows on its own screen right
 *   after the profile is picked, before the title question. An older profile's window comes last, over the app, once
 *   every question is behind it; "Choose my avatar" opens the same step screen.
 *
 * @req UX-SETUP-10[badger-mobile,badger-tv] @req UX-UPDATE-01[badger-mobile,badger-tv] @req UX-SETUP-03[badger-mobile]
 */
import { describe, expect, it, vi } from "vitest";
import { resolveNavigatorScreen } from "../src/navigation/resolveScreen";

vi.mock("react-native", () => ({ Platform: { isTV: false, OS: "android" } }));

const TAG = "[BADGER-MOBILE-PROFILE-SETUP-001]";

const gates = (patch: Partial<Parameters<typeof resolveNavigatorScreen>[0]> = {}) => {
  const screen = resolveNavigatorScreen({
    authLoading: false,
    user: { id: "u1" },
    contractIssue: null,
    formatTooNew: false,
    needsKey: false,
    errorReportsAnswered: true,
    initializing: false,
    datasetStatus: { core: true },
    profiles: "ready",
    ...patch,
  });
  console.info(TAG, "screen", JSON.stringify(patch), "->", screen);
  return screen;
};

describe("where Your profile shows (UX-SETUP-10)", () => {
  it("on its own right after the profile is picked and the library opens, before the title question", () => {
    expect(gates({ profileSetupQuestion: true })).toBe("profile-setup");
    expect(gates({ profileSetupQuestion: true, titleLanguageQuestion: true })).toBe("profile-setup");
    expect(gates({ profileSetupQuestion: false, titleLanguageQuestion: true })).toBe("title-language");
    expect(gates({ profileSetupQuestion: true, profiles: "choose" })).toBe("profiles");
    expect(gates({ profileSetupQuestion: true, needsKey: true })).toBe("onboarding");
    expect(gates({ profileSetupQuestion: true, datasetStatus: { core: false } })).toBe("loading-library");
  });

  it("never over the phone's open first setup, which asks it as a numbered step", () => {
    const setup = { done: false, step: "profileSetup" as const, languageReconciled: true };
    expect(gates({ profileSetupQuestion: true, setup })).toBe("setup");
    expect(gates({ profileSetupQuestion: true, setup: { ...setup, done: true } })).toBe("profile-setup");
  });

  it("on the TV (no phone setup), the same screen once its profile is picked", () => {
    expect(gates({ profileSetupQuestion: true, setup: undefined, tvLanguagePending: false })).toBe("profile-setup");
  });
});

describe("where New in this update shows (UX-UPDATE-01)", () => {
  it("last, over the app, once every question is answered", () => {
    expect(gates({ updateWindow: true })).toBe("whats-new");
    expect(gates({ updateWindow: false })).toBe("main");
    expect(gates({ updateWindow: true, titleLanguageQuestion: true })).toBe("title-language");
    expect(gates({ updateWindow: true, errorReportsAnswered: false })).not.toBe("whats-new");
    expect(gates({ updateWindow: true, setup: { done: false, step: "notifications", languageReconciled: true } })).toBe("setup");
    expect(gates({ updateWindow: true, profiles: "choose" })).toBe("profiles");
  });

  it("Choose my avatar opens the step screen in its place", () => {
    expect(gates({ updateSetUp: true })).toBe("profile-setup");
    expect(gates({ updateSetUp: false, updateWindow: true })).toBe("whats-new");
  });
});

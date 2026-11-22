import { describe, expect, it, vi } from "vitest";

vi.mock("@space/desktop-platform", () => ({ getDesktopPlatform: () => ({ id: "linux", paths: {} }) }));

import { setupStepAfterSiblingSignIn } from "../src/main/siblingSignIn";

/**
 * Signed in through Badger on this computer, Parrot already holds the library key Badger handed it, so its setup
 * goes on past the key step ("Parrot skips the library key screen too"): the user is never shown a key screen.
 * A setup already past the key step is left where it is.
 *
 * @req ACCT-PAIR-07[parrot]
 * @req UX-SETUP-06[parrot]
 */
const SUITE = "[parrot-sibling-setup]";

describe("Parrot setup after a same-device sign-in", () => {
  it.each([
    ["language", "profile"],
    ["libraryKey", "profile"],
  ] as const)("from %s, goes on past the key step to %s (the profile step skips itself when not counted)", (from, to) => {
    const next = setupStepAfterSiblingSignIn(from);
    console.info(SUITE, "step after sibling sign-in", { from, next });
    expect(next).toBe(to);
  });

  it.each(["profile", "folders", "startAtLogin", "errorReports"] as const)("leaves a setup already at %s where it is", (from) => {
    const next = setupStepAfterSiblingSignIn(from);
    console.info(SUITE, "step after sibling sign-in", { from, next });
    expect(next).toBeNull();
  });
});

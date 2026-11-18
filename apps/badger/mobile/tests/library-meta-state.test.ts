/**
 * @test-id MOBILE-LIBRARY-META-STATE-001
 * @level unit
 * @why The API answers `exists: false` both for "this account never had a
 *   library" and for "the snapshot could not be confirmed right now" (storage
 *   gateway HEAD failed). Mobile read every `exists: false` as an empty library
 *   and showed "No media yet" on an account holding three movies.
 * @bugfix @regression-proof Observed on the iOS sim 2026-10-16: meta returned
 *   `{exists:false, version:4062}` and the app rendered the empty home.
 */
import { describe, expect, it } from "vitest";
import { classifyLibraryMeta } from "@space/shared/libraryMetaState";
import { accountKeyState, generatedKeyAction, keyOnboardingStart } from "../src/lib/libraryMetaState";

describe("classifyLibraryMeta", () => {
  // @req LIB-SYNC-03[badger-mobile]
  it("treats a transient missing snapshot on an existing library as unavailable, not empty", () => {
    expect(classifyLibraryMeta({ exists: false, bootstrapRequired: false })).toBe("unavailable");
  });

  it("treats a never-created library as absent", () => {
    expect(classifyLibraryMeta({ exists: false, bootstrapRequired: true })).toBe("absent");
  });

  it("treats a reachable snapshot as present", () => {
    expect(classifyLibraryMeta({ exists: true, bootstrapRequired: false })).toBe("present");
  });
});

/**
 * @test-id MOBILE-LIBRARY-META-STATE-002
 * @level unit
 * @why The key screen generated a brand-new library key whenever the status
 * check threw (API hung), and "Continue" stored that generated key when the
 * check failed again or a library already existed. A generated key must only
 * ever be used for a library the server confirms was never created; anything
 * else would replace the user's real key and lock them out of their library.
 * @bugfix @regression-proof Observed 2026-10-16 with the dev API hung: the
 * iPhone key screen offered a generated key for an account holding v4062.
 */
describe("key onboarding never generates a key for an existing or unknown library", () => {
  it("asks for the existing key when the status check failed", () => {
    expect(keyOnboardingStart(null)).toBe("enter");
  });

  it("asks for the existing key when the library exists or is unavailable", () => {
    expect(keyOnboardingStart("present")).toBe("enter");
    expect(keyOnboardingStart("unavailable")).toBe("enter");
  });

  it("offers a generated key only for a never-created library", () => {
    expect(keyOnboardingStart("absent")).toBe("generate");
  });

  it("refuses to keep a generated key unless the library is still absent", () => {
    expect(generatedKeyAction("absent")).toBe("create");
    expect(generatedKeyAction("present")).toBe("enterExisting");
    expect(generatedKeyAction("unavailable")).toBe("retry");
    expect(generatedKeyAction(null)).toBe("retry");
  });
});

/**
 * @test-id MOBILE-LIBRARY-META-STATE-003
 * @level unit
 * @why Main 2026-11-12, from KeyProbeFix (791aa12f8): the API returns the account's key probe from Badger or Parrot.
 *   A key made in Parrot left Badger with no library of its own, so the key step read "no library" and would have
 *   made a second key. A probe from either app means the account has its key: ask for it, never generate one.
 * @req UX-KEY-01[badger-mobile,badger-tv]
 */
describe("accountKeyState: a probe from either app is the account's key", () => {
  it("reads a probe with no Badger library as an existing key", () => {
    const state = accountKeyState({ exists: false, bootstrapRequired: true, keyProbe: "probe" });
    console.info("[MOBILE-LIBRARY-META-STATE-003] probe, no Badger library:", state, keyOnboardingStart(state), generatedKeyAction(state));
    expect(state).toBe("present");
    expect(keyOnboardingStart(state)).toBe("enter");
    expect(generatedKeyAction(state)).toBe("enterExisting");
  });

  it("falls back to Badger's own library state when no app has a probe", () => {
    expect(accountKeyState({ exists: false, bootstrapRequired: true, keyProbe: null })).toBe("absent");
    expect(accountKeyState({ exists: false, bootstrapRequired: false, keyProbe: null })).toBe("unavailable");
    expect(accountKeyState({ exists: true, bootstrapRequired: false, keyProbe: null })).toBe("present");
  });
});

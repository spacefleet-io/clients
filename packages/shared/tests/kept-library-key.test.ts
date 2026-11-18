/**
 * @test-id PARROT-KEY-KEPT-001
 * @level unit
 * @bugfix @regression-proof
 * @why Found on the emulator (2026-11-08, ParrotGapsEmu): after the server rejected a saved session, Parrot sent the
 *   user back to sign-in (right) but also wiped the library key, so the key screen came back after signing in again.
 *   Badger's phone already keeps the key on a rejected session (`apps/badger/mobile/src/store/auth.tsx` drops only the
 *   token and user). Parrot's phone and desktop now do the same through this shared policy, and give the kept key back
 *   only to the same account. An explicit Sign out still forgets it.
 */
import { describe, expect, it } from "vitest";
import { keepsKeyOnSignIn, keyAfterSignedOut } from "../src/keptLibraryKey";

describe("keyAfterSignedOut", () => {
  it("keeps the library key when the server rejected the session", () => {
    const decision = keyAfterSignedOut("sessionRejected");
    console.info("key after signed out", { reason: "sessionRejected", decision });
    expect(decision).toBe("keep");
  });

  it("forgets the library key on an explicit sign-out", () => {
    const decision = keyAfterSignedOut("signOut");
    console.info("key after signed out", { reason: "signOut", decision });
    expect(decision).toBe("clear");
  });
});

describe("keepsKeyOnSignIn", () => {
  it("gives the kept key back to the account it came from", () => {
    const kept = keepsKeyOnSignIn({ keyOwnerId: "user-a", signedInUserId: "user-a" });
    console.info("same account signs in again", { kept });
    expect(kept).toBe(true);
  });

  it("drops the kept key when another account signs in on the phone", () => {
    const kept = keepsKeyOnSignIn({ keyOwnerId: "user-a", signedInUserId: "user-b" });
    console.info("another account signs in", { kept });
    expect(kept).toBe(false);
  });

  it("keeps a key that no rejected session left behind (paired sign-in brought it)", () => {
    const kept = keepsKeyOnSignIn({ keyOwnerId: null, signedInUserId: "user-b" });
    console.info("no kept key owner", { kept });
    expect(kept).toBe(true);
  });
});

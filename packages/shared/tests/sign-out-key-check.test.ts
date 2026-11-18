/**
 * @test-id SHARED-SIGNOUT-KEY-CHECK-001
 * @level unit
 * @req ACCT-DEV-03
 * @why Signing out forgets the library key, and without it the only way back in is typing it (QR pairing needs another
 *   device that still holds it). Every Badger and Parrot app asks for the "I've written it down" confirmation through this one
 *   decision: a device holding a key asks, one without a key signs out at once.
 */
import { describe, expect, it } from "vitest";
import { asksKeySavedBeforeSignOut } from "../src/keptLibraryKey";

describe("asksKeySavedBeforeSignOut", () => {
  it("asks when this device holds a library key", () => {
    const asks = asksKeySavedBeforeSignOut("a".repeat(44));
    console.info("[SHARED-SIGNOUT-KEY-CHECK-001] holds key", { asks });
    expect(asks).toBe(true);
  });

  it.each([null, undefined, ""])("signs out at once when this device holds no key (%p)", (stored) => {
    const asks = asksKeySavedBeforeSignOut(stored);
    console.info("[SHARED-SIGNOUT-KEY-CHECK-001] no key", { stored, asks });
    expect(asks).toBe(false);
  });
});

/**
 * @test-id SHARED-KEY-CHANGE-OFFERED-001
 * @level unit
 * @why ACCT-KEYCHG-04: an app offers a key change exactly when the server would accept it. With a device holding the
 *   current key (Settings) that is: no media, or this release re-seals it. Recovering with a new key after the key is
 *   lost can never re-seal media, so it needs no media whatever the release. An unknown answer offers nothing.
 */
import { describe, expect, it } from "vitest";
import { KEY_CHANGE_RELEASED, keyChangeOffered, keyRecoveryOffered } from "../src/keyChange";

describe("@req ACCT-KEYCHG-04[badger-desktop] @req ACCT-KEYCHG-04[badger-mobile] key change offered only when it would work", () => {
  it("this release does not re-seal media yet", () => {
    expect(KEY_CHANGE_RELEASED).toBe(false);
  });

  it.each([
    [null, false, false],
    [{ needsMediaReseal: true }, false, false],
    [{ needsMediaReseal: false }, true, true],
  ])("readiness %j: key change %s, recovery %s", (readiness, change, recovery) => {
    expect({ change: keyChangeOffered(readiness), recovery: keyRecoveryOffered(readiness) }).toEqual({ change, recovery });
  });
});

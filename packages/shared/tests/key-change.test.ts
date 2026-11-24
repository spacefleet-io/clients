/**
 * @test-id SHARED-KEY-CHANGE-OFFERED-001
 * @level unit
 * @why ACCT-KEYCHG-04: an app offers a key change exactly when the server would accept it. With a device holding the
 *   current key (Settings) that is: no media, or this release re-seals it. Recovering with a new key after the key is
 *   lost can never re-seal media, so it needs no media whatever the release. An unknown answer offers nothing.
 */
import { describe, expect, it } from "vitest";
import { KEY_CHANGE_RELEASED, keyChangeOffered, keyRecoveryOffered } from "../src/keyChange";

describe("@req ACCT-KEYCHG-04[badger-desktop] @req ACCT-KEYCHG-04[badger-mobile] @req ACCT-KEYCHG-04[parrot] key change offered only when it would work", () => {
  it("the desktops and Badger's phone re-seal media; Parrot's phone does not yet", () => {
    expect(KEY_CHANGE_RELEASED).toEqual({
      "badger-desktop": true,
      "parrot-desktop": true,
      "badger-mobile": true,
      "parrot-mobile": false,
    });
  });

  it.each([
    ["badger-desktop", null, false],
    ["badger-desktop", { needsMediaReseal: true }, true],
    ["parrot-desktop", { needsMediaReseal: true }, true],
    ["badger-mobile", { needsMediaReseal: true }, true],
    ["parrot-mobile", { needsMediaReseal: true }, false],
    ["badger-mobile", { needsMediaReseal: false }, true],
    ["badger-mobile", null, false],
  ] as const)("%s, readiness %j: key change %s", (surface, readiness, change) => {
    expect(keyChangeOffered(surface, readiness)).toBe(change);
  });

  it.each([
    [null, false],
    [{ needsMediaReseal: true }, false],
    [{ needsMediaReseal: false }, true],
  ])("readiness %j: recovery after a lost key %s, whatever the release", (readiness, recovery) => {
    expect(keyRecoveryOffered(readiness)).toBe(recovery);
  });
});

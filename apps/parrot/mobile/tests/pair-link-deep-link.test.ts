import { describe, expect, it, vi } from "vitest";
import { holdPairLink, onPairLink, takePairLink } from "../src/lib/pendingPairLink";

describe("a scanned pairing link opens Parrot's approve screen", () => {
  // @req ACCT-PAIR-06
  it("[parrot-pair-link-1] holds the code of a pairing link until the library takes it, once", () => {
    const seen = vi.fn();
    const stop = onPairLink(seen);
    expect(holdPairLink("https://spacefleet.io/pair/parrot?code=abcd-efgh")).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    const code = takePairLink();
    console.info("[parrot-pair-link-1] taken", code);
    expect(code).toBe("ABCDEFGH");
    expect(takePairLink()).toBeNull();
    stop();
  });

  // @req ACCT-PAIR-06
  it("[parrot-pair-link-2] a Badger device's link is approved here too (ACCT-PAIR-05); other links are not held", () => {
    expect(holdPairLink("https://spacefleet.io/pair/badger?code=ABCD-EFGH")).toBe(true);
    expect(takePairLink()).toBe("ABCDEFGH");
    for (const url of ["parrot://auth/provider?signinCode=x", "https://spacefleet.io/en/downloads", "spacebadger://pair?code=ABCDEFGH", null]) {
      expect(holdPairLink(url)).toBe(false);
    }
    console.info("[parrot-pair-link-2] nothing held after non-pairing links");
    expect(takePairLink()).toBeNull();
  });
});

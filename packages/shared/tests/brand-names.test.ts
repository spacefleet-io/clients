import { describe, expect, it } from "vitest";
import { BRAND_NAMES, hasBrandName, splitBrandNames } from "../src/brandNames";

// @req UX-I18N-13[web,api,badger-web-player,parrot-web-player]
describe("the product names a translating browser or mail client must keep", () => {
  it("splits a text around each name, keeping the other words", () => {
    const parts = splitBrandNames("Get Badger and Parrot on SpaceFleet");
    console.log("[brand] parts", parts);
    expect(parts).toEqual([
      { text: "Get ", brand: false },
      { text: "Badger", brand: true },
      { text: " and ", brand: false },
      { text: "Parrot", brand: true },
      { text: " on ", brand: false },
      { text: "SpaceFleet", brand: true },
    ]);
  });

  it("reads SpaceBadger as one name, and the all-caps logo text as a name", () => {
    expect(splitBrandNames("SpaceBadger")).toEqual([{ text: "SpaceBadger", brand: true }]);
    expect(splitBrandNames("SPACEFLEET")).toEqual([{ text: "SPACEFLEET", brand: true }]);
  });

  it("matches a name joined by a hyphen, not inside a longer word, an address or another case", () => {
    expect(splitBrandNames("Badger-Maskottchen")[0]).toEqual({ text: "Badger", brand: true });
    for (const text of ["spacefleet.io", "/badger", "Badgers", "Parrots", "Parroting", "parrot"]) {
      expect(hasBrandName(text), text).toBe(false);
    }
  });

  it("knows every product", () => {
    expect([...BRAND_NAMES].sort()).toEqual(["Badger", "Parrot", "SpaceBadger", "SpaceFleet", "SpaceParrot"]);
  });
});

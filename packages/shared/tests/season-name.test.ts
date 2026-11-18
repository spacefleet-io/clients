import { describe, expect, it } from "vitest";
import { seasonDisplayName } from "../src/seasonName";

const fr = (season: number) => ({ specials: "Épisodes spéciaux", season: `Saison ${season}` });

// @bugfix badger-desktop-walk-8-season-names
// @regression-proof The Office's season cards read "Specials" / "Season 1" (TMDB's English names) in a French UI.
describe("seasonDisplayName", () => {
  it("names generic and missing season names in the UI language", () => {
    const cases: [number, string | null, string][] = [
      [0, "Specials", "Épisodes spéciaux"],
      [1, "Season 1", "Saison 1"],
      [9, "season 9", "Saison 9"],
      [2, "", "Saison 2"],
      [0, null, "Épisodes spéciaux"],
      [3, "The Final Chapter", "The Final Chapter"],
      [4, "Saison 4", "Saison 4"],
    ];
    for (const [season, stored, expected] of cases) {
      const got = seasonDisplayName(season, stored, fr(season));
      console.log(`[season-name] ${season}/${stored} -> ${got}`);
      expect(got).toBe(expected);
    }
  });
});

import { describe, expect, it } from "vitest";
import { foldSearchText, fuzzyRank, fuzzyScore } from "../src/fuzzySearch";

const log = (msg: string) => console.info(`[fuzzySearch.test] ${msg}`);

/**
 * @level unit
 * @why Chris (2026-11-09 hand-try): "The search should also be fuzzy, 'linet park' should work". The search palette
 *   of Badger and Parrot ranks the library with this one matcher, so a typo of one or two letters per word must still
 *   find the title, artist or person, the right result must rank first, and unrelated names must stay out.
 */
describe("fuzzy search (UX-SEARCH-02)", () => {
  // @req UX-SEARCH-02[badger-desktop,badger-web-player,parrot,parrot-web-player]
  it("finds Linnet Park from 'linet park' and Harry Potter from 'harry poter'", () => {
    const linnet = fuzzyScore("linet park", "Linnet Park");
    const potter = fuzzyScore("harry poter", "Harry Potter and the Philosopher's Stone");
    log(`linet park -> ${linnet}; harry poter -> ${potter}`);
    expect(linnet).not.toBeNull();
    expect(potter).not.toBeNull();
  });

  // @req UX-SEARCH-02[badger-desktop,badger-web-player,parrot,parrot-web-player]
  it("ranks the intended name first among look-alikes and leaves unrelated names out", () => {
    const names = ["Park Lane", "Linnet Park", "Lincoln", "Pine Field", "Linnet Park Live", "Cloudline"];
    const ranked = fuzzyRank(names, "linet park", (n) => [n]);
    log(`ranked: ${JSON.stringify(ranked.map((r) => [r.item, Number(r.score.toFixed(2))]))}`);
    expect(ranked[0]?.item).toBe("Linnet Park");
    expect(ranked.map((r) => r.item)).toContain("Linnet Park Live");
    expect(ranked.map((r) => r.item)).not.toContain("Cloudline");
    expect(ranked.map((r) => r.item)).not.toContain("Pine Field");
  });

  // @req UX-SEARCH-02[badger-desktop,badger-web-player,parrot,parrot-web-player]
  it("matches while typing (prefixes), ignores accents and case, and swaps of two letters", () => {
    const cases: Array<[string, string]> = [
      ["linnet p", "Linnet Park"],
      ["chloe", "Chloé"],
      ["metropolis", "Metrópolis"],
      ["MÉTROPOLIS", "Metropolis"],
      ["linet park", "Linnet Park"],
      ["MATRXI", "The Matrix"],
      ["inceptoin", "Inception"],
      ["linnetpark", "Linnet Park"],
    ];
    for (const [q, text] of cases) {
      const s = fuzzyScore(q, text);
      log(`${q} -> ${text}: ${s}`);
      expect(s, `${q} should match ${text}`).not.toBeNull();
    }
    expect(foldSearchText("Élodie")).toBe("elodie");
  });

  // @req UX-SEARCH-02[badger-desktop,badger-web-player,parrot,parrot-web-player]
  it("does not accept typos in very short words, nor an empty query", () => {
    const cases: Array<[string, string]> = [
      ["cat", "Car"],
      ["up", "Us"],
      ["", "Linnet Park"],
      ["harry poter", "Hairy Spotter Club"],
    ];
    for (const [q, text] of cases) {
      const s = fuzzyScore(q, text);
      log(`${q} -> ${text}: ${s}`);
      expect(s, `${q} should not match ${text}`).toBeNull();
    }
  });

  // @req UX-SEARCH-02[badger-desktop,badger-web-player,parrot,parrot-web-player]
  it("searches secondary fields (people, artists) and reports which field matched", () => {
    const titles = [
      { title: "The Matrix", cast: ["Keanu Reeves", "Carrie-Anne Moss"] },
      { title: "Speed", cast: ["Keanu Reeves", "Sandra Bullock"] },
      { title: "Gravity", cast: ["Sandra Bullock"] },
    ];
    const ranked = fuzzyRank(titles, "keanu reves", (t) => [t.title, ...t.cast]);
    log(`ranked: ${JSON.stringify(ranked.map((r) => [r.item.title, r.field, Number(r.score.toFixed(2))]))}`);
    expect(ranked.map((r) => r.item.title).sort()).toEqual(["Speed", "The Matrix"]);
    expect(ranked.every((r) => r.field === 1)).toBe(true);
    const byTitle = fuzzyRank(titles, "speed", (t) => [t.title, ...t.cast]);
    expect(byTitle[0]).toMatchObject({ field: 0 });
  });
});

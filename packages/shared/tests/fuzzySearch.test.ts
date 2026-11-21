import { describe, expect, it } from "vitest";
import { createFuzzyIndex, foldSearchText, fuzzyRank, fuzzyScore, searchFuzzyGroups } from "../src/fuzzySearch";
import { phoneSearchStrings, searchPaletteStrings } from "../src/searchPaletteStrings";

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

/**
 * @level unit
 * @why Chris, 2026-11-19: the phone apps get a search button in the bar's centre that "autocompletes as the user types,
 *   fusy searches" through shows/movies/episodes (Badger) and artists/albums/songs (Parrot). The phone answers every
 *   keystroke from an index built once (UX-PHONE-12): it must give exactly the desktop matcher's scores and order, the
 *   groups with no match drop out, a group keeps its best few and says how many more match, and the words exist in the
 *   five languages for both apps.
 */
describe("the phone search's index and groups (UX-PHONE-12)", () => {
  const songs = [
    { title: "Linnet Park", artist: "Nova", album: "Low Orbit" },
    { title: "Park Lane", artist: "Linnet", album: "High Note" },
    { title: "Cloudline", artist: "Bérénice", album: "Été" },
    { title: "Low Orbit", artist: "Nova", album: "Low Orbit" },
    { title: "Pine Field", artist: "Nova", album: "Middle Ground" },
  ];
  const fields = (s: (typeof songs)[number]) => [s.title, s.artist, s.album];

  // @req UX-PHONE-12[badger-mobile,parrot]
  it("an index built once ranks and scores exactly as the desktop matcher, for every query", () => {
    const index = createFuzzyIndex(songs, fields);
    for (const query of ["linet park", "nova", "berenice ete", "orbit low", "zzz", "", "  ", "p"]) {
      const indexed = index.search(query);
      const direct = songs
        .map((item, order) => {
          const scores = fields(item).map((text, f) => {
            const s = fuzzyScore(query, text);
            return s === null ? null : f === 0 ? s : s * 0.85;
          });
          const best = Math.max(...scores.map((s) => s ?? -1));
          return { item, order, score: best, field: scores.indexOf(best) };
        })
        .filter((hit) => hit.score >= 0)
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .map(({ item, score, field }) => ({ item, score, field }));
      log(`index "${query}": ${JSON.stringify(indexed.map((h) => [h.item.title, Number(h.score.toFixed(3)), h.field]))}`);
      expect(indexed).toEqual(direct);
      expect(fuzzyRank(songs, query, fields)).toEqual(indexed);
    }
  });

  // @req UX-PHONE-12[badger-mobile,parrot]
  it("groups keep their order, drop out when nothing matches, and keep their best few with the full count", () => {
    type Item = string | (typeof songs)[number];
    const names = (item: Item) => (typeof item === "string" ? [item] : fields(item));
    const groups = [
      { id: "artists", index: createFuzzyIndex<Item>(["Nova", "Linnet", "Bérénice"], names) },
      { id: "albums", index: createFuzzyIndex<Item>(["Low Orbit", "High Note", "Été"], names) },
      { id: "songs", index: createFuzzyIndex<Item>(songs, names) },
    ];
    const nova = searchFuzzyGroups(groups, "nova", 1);
    log(`nova: ${JSON.stringify(nova.map((g) => [g.id, g.total, g.hits.length]))}`);
    expect(nova.map((g) => g.id)).toEqual(["artists", "songs"]);
    expect(nova.find((g) => g.id === "songs")).toMatchObject({ total: 3 });
    expect(nova.every((g) => g.hits.length === 1)).toBe(true);
    // A group opened in full ("N more") keeps more than the others.
    const opened = searchFuzzyGroups(groups, "nova", (id) => (id === "songs" ? 50 : 1));
    const openedSongs = opened.find((g) => g.id === "songs")!.hits.map((h) => (typeof h.item === "string" ? h.item : h.item.title));
    expect(openedSongs).toEqual(["Linnet Park", "Low Orbit", "Pine Field"]);
    expect(searchFuzzyGroups(groups, "qqqq", 5)).toEqual([]);
    expect(searchFuzzyGroups(groups, "", 5)).toEqual([]);
  });

  // @req UX-PHONE-12[badger-mobile,parrot]
  it("keeps typos working but leaves out names that only look like the start of the query", () => {
    // Main, relaying Chris's review of the real apps (2026-11-20): "star" listed Toy Story and Granite State, "adle"
    // listed Billie Eilish's "When We All Fall Asleep".
    const found: Array<[string, string]> = [
      ["brekaing", "Breaking Bad"],
      ["adle", "Adele"],
      ["mandalorain", "The Mandalorian"],
      ["brekai", "Breaking Bad"],
      ["star", "Star Wars"],
      ["star", "Chapter Eight: The Battle of Starcourt"],
      ["linetpark", "Linnet Park"],
    ];
    const left: Array<[string, string]> = [
      ["star", "Toy Story"],
      ["star", "Granite State"],
      ["star", "Storyboards & Animatics"],
      ["adle", "When We All Fall Asleep, Where Do We Go?"],
      ["back", "Michael Jackson"],
      ["brek", "Breaking Bad"],
    ];
    for (const [q, text] of found) {
      const s = fuzzyScore(q, text);
      log(`${q} -> ${text}: ${s}`);
      expect(s, `${q} should match ${text}`).not.toBeNull();
    }
    for (const [q, text] of left) {
      const s = fuzzyScore(q, text);
      log(`${q} -> ${text}: ${s}`);
      expect(s, `${q} should not match ${text}`).toBeNull();
    }
  });

  // @req UX-PHONE-12[badger-mobile,parrot]
  it("has its words in the five languages for both apps, the button named as the desktop palette", () => {
    for (const language of ["en", "fr", "nl", "de", "es", "pt-BR", undefined]) {
      const badger = phoneSearchStrings("badger", language);
      const parrot = phoneSearchStrings("parrot", language);
      log(`${language}: ${badger.button} | ${badger.placeholder} | ${parrot.placeholder} | ${JSON.stringify([badger.groups, parrot.groups])}`);
      expect(badger.button).toBe(searchPaletteStrings("badger", language).title);
      expect(Object.keys(badger.groups)).toEqual(["shows", "movies", "episodes"]);
      expect(Object.keys(parrot.groups)).toEqual(["artists", "albums", "songs"]);
      for (const strings of [badger, parrot]) {
        for (const value of [strings.button, strings.placeholder, strings.hint, strings.empty, strings.close, strings.clear, ...Object.values(strings.groups)]) {
          expect(value.trim().length).toBeGreaterThan(0);
        }
        expect(strings.more).toContain("{{count}}");
      }
    }
    expect(phoneSearchStrings("badger", "fr").groups.shows).toBe("Séries TV");
    expect(phoneSearchStrings("parrot", "fr").groups.songs).toBe("Titres");
    expect(phoneSearchStrings("parrot", "fr").more).toBe("{{count}} autres");
    expect(phoneSearchStrings("parrot", "de").groups.albums).toBe("Alben");
    expect(phoneSearchStrings("parrot", "xx")).toEqual(phoneSearchStrings("parrot", "en"));
  });
});

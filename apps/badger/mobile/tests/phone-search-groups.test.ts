/**
 * @test-id MOBILE-PHONE-SEARCH-GROUPS-001
 * @level unit
 * @req UX-PHONE-12[badger-mobile]
 * @why Chris, 2026-11-20 (relayed by Main): a show found by its name lists the show alone, not all its episodes; an
 *   episode is listed only when its own title matches. Builds the real three search groups and searches them.
 */
import { describe, expect, it } from "vitest";
import { searchFuzzyGroups } from "@space/shared/fuzzySearch";
import type { MediaRow } from "@space/shared/libraryTypes";
import { buildBadgerSearchGroups, type BadgerSearchItem, type SearchEpisode } from "../src/lib/phoneSearch";

const log = (step: string, detail: unknown) => console.info(`[MOBILE-PHONE-SEARCH-GROUPS-001] ${step}`, JSON.stringify(detail));

const media = (id: string, title: string, type: "tv" | "movie"): MediaRow => ({ id, title, originalTitle: null, type }) as unknown as MediaRow;
const episode = (id: string, mediaId: string, n: number, title: string): SearchEpisode => ({
  id,
  mediaId,
  seasonNumber: 1,
  episodeNumber: n,
  title,
  stillPath: null,
});

const library = [media("bb", "Breaking Bad", "tv"), media("st", "Stranger Things", "tv"), media("tf", "The Fly", "movie")];
const episodes = [
  episode("bb1", "bb", 1, "Pilot"),
  episode("bb2", "bb", 2, "Cat's in the Bag..."),
  episode("bb3", "bb", 3, "...And the Bag's in the River"),
  episode("st1", "st", 1, "Chapter One: The Vanishing of Will Byers"),
];

const nameOf = (item: BadgerSearchItem) => (item.kind === "title" ? item.media.title : `${item.show.title} / ${item.episode.title}`);
const search = (query: string) => {
  const groups = searchFuzzyGroups(buildBadgerSearchGroups(library, episodes), query, 10);
  return Object.fromEntries(groups.map((g) => [g.id, g.hits.map((h) => nameOf(h.item))]));
};

describe("Badger phone search groups (UX-PHONE-12)", () => {
  it("a show found by its name (typo or not) lists the show alone, never its episodes", () => {
    const exact = search("breaking bad");
    const typo = search("brekaing");
    log("show name", { exact, typo });
    expect(exact).toEqual({ shows: ["Breaking Bad"] });
    expect(typo).toEqual({ shows: ["Breaking Bad"] });
  });

  it("an episode is listed when its own title matches", () => {
    const pilot = search("pilot");
    const bag = search("bag");
    log("episode title", { pilot, bag });
    expect(pilot).toEqual({ episodes: ["Breaking Bad / Pilot"] });
    expect(bag.episodes).toEqual(["Breaking Bad / Cat's in the Bag...", "Breaking Bad / ...And the Bag's in the River"]);
    expect(bag.shows).toBeUndefined();
  });
});

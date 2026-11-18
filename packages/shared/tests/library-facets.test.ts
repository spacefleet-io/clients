import { describe, expect, it } from "vitest";
import {
  libraryFacetOptions,
  libraryFacetValues,
  libraryFacetsMatch,
  libraryQualityBucket,
  libraryWatchState,
} from "../src/libraryFacets";
import { filterLibraryItems } from "../src/libraryView";

const LOG = "[library-facets]";

// @req UX-LIB-03
describe("[library-facets] the Filter modal's quality, director, language and watch-state keys", () => {
  it("buckets qualities as 4K / 2K / 1080p / 720p / SD and progress as unwatched / in progress / watched", () => {
    const buckets = ["4K", "2160p", "2K", "1440p", "1080p", "720p", "480p", "144p", "bogus", "4kp", null].map((quality) => libraryQualityBucket(quality));
    const states = [0, 1.9, 2, 50, 94.9, 95, 100].map((pct) => libraryWatchState(pct));
    console.info(`${LOG} buckets=${JSON.stringify(buckets)} states=${JSON.stringify(states)}`);
    expect(buckets).toEqual(["4k", "4k", "2k", "2k", "1080p", "720p", "sd", "sd", null, null, null]);
    expect(states).toEqual(["unwatched", "unwatched", "in-progress", "in-progress", "in-progress", "watched", "watched"]);
  });

  it("keeps a title when it has any pick of every facet picked, and offers only the keys titles hold", () => {
    const metropolis = libraryFacetValues({ qualities: ["1080p", "480p"], directors: ["Fritz Lang"], audioLanguages: ["ger"], subtitleLanguages: ["en", "fr"], progressPct: 100 });
    const nosferatu = libraryFacetValues({ qualities: ["720p"], directors: ["F. W. Murnau"], audioLanguages: ["de"], progressPct: 40 });
    const lookup = new Map([["m", metropolis], ["n", nosferatu]]);
    const items = [
      { id: "m", type: "movie" as const, title: "Metropolis", year: "1927", addedAt: "", genres: [] },
      { id: "n", type: "movie" as const, title: "Nosferatu", year: "1922", addedAt: "", genres: [] },
    ];
    const run = (selection: Parameters<typeof libraryFacetsMatch>[1]) =>
      filterLibraryItems({ items, query: "", selectedGenres: [], selectedActors: [], castLookup: new Map(), facets: { selection, lookup } }).map((item) => item.id);
    const results = {
      none: run({}),
      sd: run({ qualities: ["sd"] }),
      german: run({ audioLanguages: ["de"] }),
      lang: run({ directors: ["fritz lang"], watchStates: ["in-progress"] }),
      either: run({ watchStates: ["watched", "in-progress"] }),
      frSubs: run({ subtitleLanguages: ["fr"] }),
    };
    const options = libraryFacetOptions(lookup.values());
    console.info(`${LOG} results=${JSON.stringify(results)} options=${JSON.stringify(options)}`);
    expect(results).toEqual({ none: ["m", "n"], sd: ["m"], german: ["m", "n"], lang: [], either: ["m", "n"], frSubs: ["m"] });
    expect(options).toEqual({
      qualities: ["1080p", "720p", "sd"],
      directors: ["f. w. murnau", "fritz lang"],
      audioLanguages: ["de"],
      subtitleLanguages: ["en", "fr"],
      watchStates: ["in-progress", "watched"],
    });
  });
});

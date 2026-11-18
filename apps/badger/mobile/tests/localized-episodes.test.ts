/**
 * @test-id MOBILE-LOCALIZED-EPISODES-001
 * @level unit
 *
 * LIB-LANG-01: the title page's episode list and the player (header, next-episode card, resume prompt) name episodes
 * from one source. Only names and synopses change; ids and numbers stay, so playback is untouched.
 */
import { describe, expect, it } from "vitest";
import { episodeKey, type LocalizedEpisodeMap } from "@space/metadata-client";
import type { MediaDetails, MediaEpisode } from "@space/shared/libraryTypes";
import { localizeEpisode, localizePlayback, localizeShowDetails } from "../src/lib/playback/localizedEpisodes";

const episode = (n: number, name: string, overview: string | null = null): MediaEpisode => ({
  id: `ep-${n}`, seasonNumber: 1, episodeNumber: n, name, overview, stillPath: null, airDate: null,
});
const details = { id: "show", type: "tv", tmdbId: 1, title: "The Show", episodes: [episode(1, "Pilot", "Stored"), episode(2, "The Return"), episode(3, "Finale")] } as unknown as MediaDetails;
const fr: LocalizedEpisodeMap = new Map([
  [episodeKey(1, 1), { name: "Le pilote", overview: "Résumé" }],
  [episodeKey(1, 2), { name: "Le retour", overview: null }],
  [episodeKey(1, 3), { name: null, overview: null }],
]);

/** @req LIB-LANG-01[badger-mobile,badger-tv] */
describe("episode names in the interface language (LIB-LANG-01)", () => {
  it("localizes name and synopsis, keeping the stored text where the language has none", () => {
    expect(localizeEpisode(episode(1, "Pilot", "Stored"), fr)).toEqual({ ...episode(1, "Pilot"), name: "Le pilote", overview: "Résumé" });
    expect(localizeEpisode(episode(2, "The Return", "Stored"), fr)).toMatchObject({ id: "ep-2", name: "Le retour", overview: "Stored" });
    expect(localizeEpisode(episode(3, "Finale"), fr).name).toBe("Finale");
    expect(localizeEpisode(null, fr)).toBeNull();
  });

  it("the player's episodes come from the same map as the episode list", () => {
    const list = localizeShowDetails(details, fr)!.episodes.map((e) => e.name);
    const session = { details, episode: details.episodes[0]!, nextEpisode: details.episodes[1]!, previousEpisode: null, playUrl: "u" };
    const shown = localizePlayback(session, fr);
    expect(list).toEqual(["Le pilote", "Le retour", "Finale"]);
    expect([shown.episode?.name, shown.nextEpisode?.name]).toEqual([list[0], list[1]]);
    expect([shown.episode?.id, shown.nextEpisode?.id, shown.playUrl]).toEqual(["ep-1", "ep-2", "u"]);
  });

  it("returns the same objects while nothing is localized (a film, offline, lookup running)", () => {
    const session = { details, episode: details.episodes[0]!, nextEpisode: null, previousEpisode: null };
    expect(localizeShowDetails(details, new Map())).toBe(details);
    expect(localizePlayback(session, new Map())).toBe(session);
  });
});

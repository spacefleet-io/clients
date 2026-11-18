// A show's episode names and synopses in the app's language (LIB-LANG-01). The library keeps one name and synopsis per
// episode, fetched in the show's language when it was added, so every app asks the metadata service for the show's
// details in its own interface language (one answer carries every episode), kept in the library per language
// (LIB-LANG-02, `localizedTexts.ts`), and shows the stored text only as the last resort. Portable: no React, no DOM,
// no node:*.
import type { DetailsTexts } from "./localizedTexts";
import { OVERVIEW_FALLBACK_LANGUAGE } from "./overviews";

/** One episode as TMDB names it in one language. */
export type EpisodeText = { seasonNumber: number; episodeNumber: number; name: string | null; overview: string | null };

/** An episode's name and synopsis in the interface language, else English; null where neither has one. */
export type LocalizedEpisode = { name: string | null; overview: string | null };

/** Keyed by `episodeKey(season, episode)`. */
export type LocalizedEpisodeMap = ReadonlyMap<string, LocalizedEpisode>;

/**
 * Every episode of one show in one language. `episodeKeys` are the library's episodes (`episodeKey`): an episode the
 * kept texts never heard of asks again (new episodes). May reject (offline, no ticket, …).
 */
export type FetchEpisodes = (tvId: number, language: string, episodeKeys?: readonly string[]) => Promise<readonly EpisodeText[]>;

export const episodeKey = (seasonNumber: number, episodeNumber: number) => `${seasonNumber}:${episodeNumber}`;

const textOrNull = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

/** How an app asks: the episodes of the show's texts, from the library row else one details lookup. */
export const detailsEpisodes =
  (source: Pick<DetailsTexts, "texts">): FetchEpisodes =>
  async (tvId, language, episodeKeys) =>
    (await source.texts("tv", tvId, language, episodeKeys)).episodes;

/** The synopsis to show for a stored episode: the localized one when known, else the stored one. */
export const localizedEpisodeOverview = (
  episodes: LocalizedEpisodeMap,
  episode: { seasonNumber: number; episodeNumber: number; overview: string | null }
): string | null => episodes.get(episodeKey(episode.seasonNumber, episode.episodeNumber))?.overview ?? episode.overview;

export const EMPTY_EPISODES: LocalizedEpisodeMap = new Map();

export interface LocalizedEpisodes {
  /** The episodes already resolved for this show and language, or undefined (not resolved yet). */
  peek(tvId: number, language: string): LocalizedEpisodeMap | undefined;
  /**
   * Whether the resolved episodes speak for every one of `episodeKeys`: each carried by the answer, or asked for and
   * absent upstream. A library episode this session never heard of (added mid-session by a sync or an import) is not
   * covered, so the next `load` asks again (LIB-LANG-02, new episodes).
   */
  covers(tvId: number, language: string, episodeKeys?: readonly string[]): boolean;
  /**
   * The show's episodes in `language`, each name and synopsis TMDB lacks there taken from English. Never rejects: a
   * failure answers an empty map and is not kept, so the next call asks again. One request per (show, language) at a
   * time, plus one in English only when an episode lacks text; answers are kept for the session and asked again only
   * for an episode they do not cover.
   */
  load(tvId: number, language: string, fetchEpisodes: FetchEpisodes, episodeKeys?: readonly string[]): Promise<LocalizedEpisodeMap>;
  clear(): void;
}

const toMap = (episodes: readonly EpisodeText[]) => {
  const map = new Map<string, LocalizedEpisode>();
  for (const episode of episodes) {
    map.set(episodeKey(episode.seasonNumber, episode.episodeNumber), {
      name: textOrNull(episode.name),
      overview: textOrNull(episode.overview),
    });
  }
  return map;
};

export function createLocalizedEpisodes(): LocalizedEpisodes {
  /** `covered`: every episode key the answer speaks for, the ones it carries and the ones it was asked for. */
  const resolved = new Map<string, { episodes: LocalizedEpisodeMap; covered: ReadonlySet<string> }>();
  const pending = new Map<string, Promise<LocalizedEpisodeMap>>();
  const coversKeys = (key: string, episodeKeys: readonly string[] | undefined) => {
    const known = resolved.get(key);
    return known !== undefined && (episodeKeys ?? []).every((episode) => known.covered.has(episode));
  };

  /** `keep` false: the English half failed, so the answer is shown but asked again next time. */
  const resolve = async (tvId: number, language: string, fetchEpisodes: FetchEpisodes, episodeKeys?: readonly string[]) => {
    const own = toMap(await fetchEpisodes(tvId, language, episodeKeys));
    const lacking = [...own.values()].some((episode) => episode.name === null || episode.overview === null);
    if (!lacking || language === OVERVIEW_FALLBACK_LANGUAGE) return { episodes: own, keep: true };
    let english: Map<string, LocalizedEpisode>;
    try {
      english = toMap(await fetchEpisodes(tvId, OVERVIEW_FALLBACK_LANGUAGE, episodeKeys));
    } catch {
      return { episodes: own, keep: false };
    }
    for (const [key, episode] of own) {
      const fallback = english.get(key);
      if (!fallback) continue;
      own.set(key, { name: episode.name ?? fallback.name, overview: episode.overview ?? fallback.overview });
    }
    return { episodes: own, keep: true };
  };

  const load: LocalizedEpisodes["load"] = (tvId, language, fetchEpisodes, episodeKeys) => {
    const key = `${tvId}:${language}`;
    const known = resolved.get(key);
    if (known && coversKeys(key, episodeKeys)) return Promise.resolve(known.episodes);
    const inFlight = pending.get(key);
    // A load in flight may have been asked without some of these episodes: they ask once it settles.
    if (inFlight) {
      return inFlight.then((episodes) =>
        coversKeys(key, episodeKeys) ? resolved.get(key)!.episodes : resolved.has(key) ? load(tvId, language, fetchEpisodes, episodeKeys) : episodes
      );
    }
    const task = resolve(tvId, language, fetchEpisodes, episodeKeys)
      .then(({ episodes, keep }) => {
        if (keep) resolved.set(key, { episodes, covered: new Set([...episodes.keys(), ...(episodeKeys ?? [])]) });
        return episodes as LocalizedEpisodeMap;
      })
      .catch(() => EMPTY_EPISODES)
      .finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };

  return {
    peek: (tvId, language) => resolved.get(`${tvId}:${language}`)?.episodes,
    covers: (tvId, language, episodeKeys) => coversKeys(`${tvId}:${language}`, episodeKeys),
    load,
    clear() {
      resolved.clear();
      pending.clear();
    },
  };
}

/** The page-wide cache every screen of an app shares (re-opening a show costs no ticket). */
export const localizedEpisodes: LocalizedEpisodes = createLocalizedEpisodes();

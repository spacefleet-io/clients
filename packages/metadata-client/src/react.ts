/**
 * React wiring for LIB-LANG-01, shared by Badger desktop, phone, TV and web player: a title's synopsis in the
 * interface language. Shows the stored synopsis while the lookup runs, then the one in the interface language (or in
 * English when TMDB has none in it); the stored one stays when neither exists, offline, or with no way to ask.
 */
import { useEffect, useState } from "react";
import type { TmdbMediaType } from "@space/shared/api";
import { localizedOverviews, type FetchOverview, type LocalizedOverviews } from "./overviews";
import { EMPTY_EPISODES, episodeKey, localizedEpisodes, type FetchEpisodes, type LocalizedEpisodeMap, type LocalizedEpisodes } from "./episodes";

export type OverviewTitle = {
  /** Changes when another title is shown, even with the same TMDB id (a re-match). */
  id: string;
  type: TmdbMediaType;
  tmdbId: number | null;
  /** The synopsis the library stored for this title. */
  overview: string | null;
} | null;

/**
 * @param fetchOverview how this app asks the metadata service for one synopsis; null when it cannot (signed out).
 *   Read when the title or language changes, not on every render.
 */
export function useLocalizedOverview(
  title: OverviewTitle,
  language: string,
  fetchOverview: FetchOverview | null,
  cache: LocalizedOverviews = localizedOverviews
): string | null {
  const stored = title?.overview ?? null;
  const type = title?.type ?? null;
  const tmdbId = title?.tmdbId ?? null;
  const known = type !== null && tmdbId !== null ? cache.peek(type, tmdbId, language) : undefined;
  const [overview, setOverview] = useState<string | null>(known ?? stored);
  const canFetch = fetchOverview !== null;

  useEffect(() => {
    if (type === null || tmdbId === null || !fetchOverview) {
      setOverview(stored);
      return undefined;
    }
    const cached = cache.peek(type, tmdbId, language);
    if (cached !== undefined) {
      setOverview(cached ?? stored);
      return undefined;
    }
    // Never the previous title's synopsis under a new poster.
    setOverview(stored);
    let live = true;
    void cache.load(type, tmdbId, language, fetchOverview).then((fetched) => {
      if (live && fetched !== null) setOverview(fetched);
    });
    return () => {
      live = false;
    };
    // `stored` and `fetchOverview` are left out on purpose: a library sync rewriting the same synopsis, or a new
    // closure each render, must not ask again. `canFetch` re-runs it when signing in makes asking possible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title?.id, type, tmdbId, language, canFetch, cache]);

  return overview;
}

export type EpisodesShow = {
  /** Changes when another title is shown, even with the same TMDB id (a re-match). */
  id: string;
  type: TmdbMediaType;
  tmdbId: number | null;
  /** The library's episodes: one the kept texts never heard of (new episodes) asks again (LIB-LANG-02). */
  episodes?: readonly { seasonNumber: number; episodeNumber: number }[];
} | null;

/**
 * A show's episode names and synopses in the interface language, else English (LIB-LANG-01), keyed by
 * `episodeKey(season, episode)`. Empty while the lookup runs, for a movie, offline or with no way to ask: render sites
 * read `localizedEpisodeOverview(map, episode)` (or `map.get(key)?.name ?? episode.name`) so the stored text shows then.
 *
 * @param fetchEpisodes how this app asks the metadata service for a show's episodes; null when it cannot (signed
 *   out). Read when the show or language changes, not on every render.
 */
export function useLocalizedEpisodes(
  show: EpisodesShow,
  language: string,
  fetchEpisodes: FetchEpisodes | null,
  cache: LocalizedEpisodes = localizedEpisodes
): LocalizedEpisodeMap {
  const tvId = show?.type === "tv" ? show.tmdbId : null;
  const [episodes, setEpisodes] = useState<LocalizedEpisodeMap>(
    () => (tvId !== null ? cache.peek(tvId, language) : undefined) ?? EMPTY_EPISODES
  );
  const canFetch = fetchEpisodes !== null;
  // The library's episodes, as one value: an episode a sync or an import adds while the page is open re-runs the
  // effect, and asks only when the session's answer never heard of it (LIB-LANG-02, new episodes).
  const episodeSignature = show?.episodes?.map((episode) => episodeKey(episode.seasonNumber, episode.episodeNumber)).join(",");

  useEffect(() => {
    if (tvId === null || !fetchEpisodes) {
      setEpisodes(EMPTY_EPISODES);
      return undefined;
    }
    const episodeKeys = episodeSignature === undefined ? undefined : episodeSignature ? episodeSignature.split(",") : [];
    const cached = cache.peek(tvId, language);
    // Never the previous show's episodes under a new poster; the kept ones stay while a new episode is asked.
    setEpisodes(cached ?? EMPTY_EPISODES);
    if (cached && cache.covers(tvId, language, episodeKeys)) return undefined;
    let live = true;
    void cache.load(tvId, language, fetchEpisodes, episodeKeys).then((fetched) => {
      if (live) setEpisodes(fetched);
    });
    return () => {
      live = false;
    };
    // `fetchEpisodes` is left out on purpose: a new closure each render must not ask again. `canFetch` re-runs it
    // when signing in makes asking possible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show?.id, tvId, language, canFetch, cache, episodeSignature]);

  return episodes;
}

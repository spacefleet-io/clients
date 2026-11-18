// A title's synopsis in the app's language (LIB-LANG-01). The library keeps one overview per title, fetched in the
// title/artwork language when the title was added (a German film in "auto" mode stores a German synopsis), so every
// app shows the synopsis in its own interface language, kept in the library per language (LIB-LANG-02,
// `localizedTexts.ts`), and the stored one only as the last resort. Portable: no React, no DOM, no node:*.
import type { TmdbMediaType } from "@space/shared/api";
import type { DetailsTexts } from "./localizedTexts";

/** The language asked when the interface language has no synopsis on TMDB. */
export const OVERVIEW_FALLBACK_LANGUAGE = "en";

/** The synopsis of one title in one language, or null when TMDB has none. May reject (offline, no ticket, …). */
export type FetchOverview = (type: TmdbMediaType, tmdbId: number, language: string) => Promise<string | null>;

/** How an app asks: the synopsis of the title's texts, from the library row else one details lookup. */
export const detailsOverview =
  (source: Pick<DetailsTexts, "texts">): FetchOverview =>
  async (type, tmdbId, language) =>
    (await source.texts(type, tmdbId, language)).overview;

export interface LocalizedOverviews {
  /** The synopsis already resolved for this title and language: a string, null (none in either language), or undefined (not resolved yet). */
  peek(type: TmdbMediaType, tmdbId: number, language: string): string | null | undefined;
  /**
   * The synopsis in `language`, else in English, else null. Never rejects: a failure answers null and is not kept,
   * so the next call asks again. One request per (title, language) at a time; answers are kept for the session.
   */
  load(type: TmdbMediaType, tmdbId: number, language: string, fetchOverview: FetchOverview): Promise<string | null>;
  clear(): void;
}

const keyOf = (type: TmdbMediaType, tmdbId: number, language: string) => `${type}:${tmdbId}:${language}`;

const textOrNull = (value: string | null | undefined) => (typeof value === "string" && value.trim() ? value : null);

export function createLocalizedOverviews(): LocalizedOverviews {
  const resolved = new Map<string, string | null>();
  const pending = new Map<string, Promise<string | null>>();

  const resolve = async (type: TmdbMediaType, tmdbId: number, language: string, fetchOverview: FetchOverview) => {
    const own = textOrNull(await fetchOverview(type, tmdbId, language));
    if (own !== null || language === OVERVIEW_FALLBACK_LANGUAGE) return own;
    return textOrNull(await fetchOverview(type, tmdbId, OVERVIEW_FALLBACK_LANGUAGE));
  };

  return {
    peek: (type, tmdbId, language) => resolved.get(keyOf(type, tmdbId, language)),
    load(type, tmdbId, language, fetchOverview) {
      const key = keyOf(type, tmdbId, language);
      if (resolved.has(key)) return Promise.resolve(resolved.get(key) ?? null);
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      const task = resolve(type, tmdbId, language, fetchOverview)
        .then((overview) => {
          resolved.set(key, overview);
          return overview;
        })
        .catch(() => null)
        .finally(() => pending.delete(key));
      pending.set(key, task);
      return task;
    },
    clear() {
      resolved.clear();
      pending.clear();
    },
  };
}

/** The page-wide cache every screen of an app shares (re-opening a title costs no ticket). */
export const localizedOverviews: LocalizedOverviews = createLocalizedOverviews();

/**
 * A title's synopsis and episode texts in one language, kept in the library (LIB-LANG-02).
 *
 * One `setting.set` record per title and language, keyed by the title's provider identity so a re-match reads the
 * right row:
 *   key   `localized_text_v1:<type>:<catalogId>:<language>`
 *   value JSON `{v: 1, overview, episodes: [[season, episode, name, overview], …], absent: ["s:e", …], fetchedAt,
 *               originalLanguage?}`
 * `absent` lists the library's episodes the answer did not have, so a library episode in neither list (new episodes)
 * tells the reader the row is out of date. `originalLanguage` (the title's original language, from the same answer)
 * lets a trailer refresh read it here instead of asking the title's details again; rows kept before it was added
 * lack it. Same transport as `track_prefs_v1:`: no op-shape change, old clients store the key and ignore it (and the
 * extra field). Portable: no DOM, no node:*.
 */

export const LOCALIZED_TEXT_KEY_PREFIX = "localized_text_v1:";

export const localizedTextKey = (type: "movie" | "tv", catalogId: number, language: string) =>
  `${LOCALIZED_TEXT_KEY_PREFIX}${type}:${catalogId}:${language}`;

export const isLocalizedTextKey = (key: string) => key.startsWith(LOCALIZED_TEXT_KEY_PREFIX);

/** One episode's name and synopsis; null where the answer has none. */
export type LocalizedTextEpisode = { seasonNumber: number; episodeNumber: number; name: string | null; overview: string | null };

export type LocalizedTextRecord = {
  overview: string | null;
  episodes: readonly LocalizedTextEpisode[];
  /** `"season:episode"` keys of library episodes the answer lacked when it was fetched. */
  absent: readonly string[];
  fetchedAt: string;
  /** The title's original language (ISO 639-1) the answer named; absent in rows kept before it was added. */
  originalLanguage?: string | null;
};

const textOrNull = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

export const serializeLocalizedText = (record: LocalizedTextRecord): string =>
  JSON.stringify({
    v: 1,
    overview: record.overview,
    episodes: record.episodes.map((episode) => [episode.seasonNumber, episode.episodeNumber, episode.name, episode.overview]),
    absent: record.absent,
    fetchedAt: record.fetchedAt,
    ...(textOrNull(record.originalLanguage) ? { originalLanguage: record.originalLanguage } : {}),
  });

/** The stored record, or null for a missing, deleted (`""`), unreadable or newer-version value. */
export const parseLocalizedText = (value: string | null | undefined): LocalizedTextRecord | null => {
  if (!value) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { v?: unknown; overview?: unknown; episodes?: unknown; absent?: unknown; fetchedAt?: unknown; originalLanguage?: unknown };
  if (row.v !== 1 || !Array.isArray(row.episodes)) return null;
  const episodes: LocalizedTextEpisode[] = [];
  for (const entry of row.episodes) {
    if (!Array.isArray(entry)) continue;
    const [seasonNumber, episodeNumber, name, overview] = entry as unknown[];
    if (typeof seasonNumber !== "number" || typeof episodeNumber !== "number") continue;
    episodes.push({ seasonNumber, episodeNumber, name: textOrNull(name), overview: textOrNull(overview) });
  }
  return {
    overview: textOrNull(row.overview),
    episodes,
    absent: Array.isArray(row.absent) ? row.absent.filter((key): key is string => typeof key === "string") : [],
    fetchedAt: typeof row.fetchedAt === "string" ? row.fetchedAt : "",
    ...(textOrNull(row.originalLanguage) ? { originalLanguage: row.originalLanguage as string } : {}),
  };
};

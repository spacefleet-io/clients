// A title's synopsis and episode texts in one language, read from the library first (LIB-LANG-02). The details
// answer is asked once per title and language, by the first device that shows it, and kept in the library as a
// synced `setting.set` row (`@space/shared/localizedTexts`); every later page, on every device, reads that row. The
// row is asked again only when the library holds an episode it has never heard of (new episodes). Portable: no React,
// no DOM, no node:*.
import type { TmdbMediaType } from "@space/shared/api";
import {
  localizedTextKey,
  parseLocalizedText,
  serializeLocalizedText,
  type LocalizedTextEpisode,
  type LocalizedTextRecord,
} from "@space/shared/localizedTexts";

/** The open library's settings, as each app reads and writes them (a write is a synced `setting.set`). */
export interface LocalizedTextLibrary {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

/** The part of a details answer the texts come from. */
export type DetailsTextItem = {
  overview?: string | null;
  episodes?: readonly { seasonNumber: number; episodeNumber: number; name?: string | null; overview?: string | null }[] | null;
  /** Kept with the texts so a trailer refresh reads it instead of asking the details again. */
  originalLanguage?: string | null;
};

/** How the app asks the metadata service for one details answer. May reject (offline, no ticket, …). */
export type AskDetails = (type: TmdbMediaType, tmdbId: number, language: string) => Promise<{ item: DetailsTextItem }>;

export interface DetailsTexts {
  /**
   * The texts of one title in one language: the library row when it covers `episodeKeys` (`"season:episode"` of the
   * library's episodes), else one lookup, written back as the row. One request per (title, language) at a time.
   * Rejects only when the lookup fails and no row is kept.
   */
  texts(type: TmdbMediaType, tmdbId: number, language: string, episodeKeys?: readonly string[]): Promise<LocalizedTextRecord>;
  /** Keeps an answer a refresh or an import already fetched, with no lookup. */
  put(type: TmdbMediaType, tmdbId: number, language: string, item: DetailsTextItem, episodeKeys?: readonly string[]): Promise<void>;
  /**
   * The title's original language as the kept answer in `language` names it. With no row naming it (none kept yet,
   * or a row kept before it was), asks that answer once per title and language this session and keeps it.
   */
  originalLanguage(type: TmdbMediaType, tmdbId: number, language: string): Promise<string | null>;
}

export type DetailsTextsDeps = {
  details: AskDetails;
  /** The open library, or null (none open yet, signed out): the texts are then asked and not kept. */
  library: () => LocalizedTextLibrary | null;
  now?: () => string;
  /** Milliseconds, for how fresh an answer of this session is. */
  clock?: () => number;
  onError?: (stage: "read" | "write", error: unknown) => void;
};

/** How long an answer of this session speaks for episodes it lacks (one page asks synopsis and episodes together). */
export const ANSWER_FRESH_MS = 60_000;

const textOrNull = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

const covers = (record: LocalizedTextRecord, episodeKeys: readonly string[] | undefined) => {
  if (!episodeKeys?.length) return true;
  const known = new Set(record.absent);
  for (const episode of record.episodes) known.add(`${episode.seasonNumber}:${episode.episodeNumber}`);
  return episodeKeys.every((key) => known.has(key));
};

const recordOf = (item: DetailsTextItem, episodeKeys: readonly string[] | undefined, fetchedAt: string): LocalizedTextRecord => {
  const episodes: LocalizedTextEpisode[] = (Array.isArray(item.episodes) ? item.episodes : []).map((episode) => ({
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
    name: textOrNull(episode.name),
    overview: textOrNull(episode.overview),
  }));
  const answered = new Set(episodes.map((episode) => `${episode.seasonNumber}:${episode.episodeNumber}`));
  return {
    overview: textOrNull(item.overview),
    episodes,
    absent: (episodeKeys ?? []).filter((key) => !answered.has(key)),
    fetchedAt,
    ...(textOrNull(item.originalLanguage) ? { originalLanguage: item.originalLanguage } : {}),
  };
};

export function createDetailsTexts(deps: DetailsTextsDeps): DetailsTexts {
  const now = deps.now ?? (() => new Date().toISOString());
  const clock = deps.clock ?? Date.now;
  const onError = deps.onError ?? (() => undefined);
  /** Rows this session already read or wrote: a second page of the same title reads no library either. */
  const known = new Map<string, LocalizedTextRecord>();
  /**
   * When the service answered a row in this session: within `ANSWER_FRESH_MS` an episode the answer lacks is absent
   * upstream, not new (the synopsis and the episodes of one page ask at the same moment).
   */
  const answeredAt = new WeakMap<LocalizedTextRecord, number>();
  const freshAnswer = (record: LocalizedTextRecord) => clock() - (answeredAt.get(record) ?? Number.NEGATIVE_INFINITY) < ANSWER_FRESH_MS;
  const pending = new Map<string, Promise<LocalizedTextRecord>>();
  /** Per title and language, the one lookup `originalLanguage` asked this session (a null answer is kept too). */
  const originalAsked = new Map<string, Promise<string | null>>();

  const keep = async (library: LocalizedTextLibrary | null, key: string, record: LocalizedTextRecord) => {
    known.set(key, record);
    if (!library) return;
    try {
      await library.write(key, serializeLocalizedText(record));
    } catch (error) {
      onError("write", error);
    }
  };

  /** The row this session knows, else the library's (null when none, or the library cannot be read). */
  const readRow = async (library: LocalizedTextLibrary | null, key: string): Promise<LocalizedTextRecord | null> => {
    const seen = known.get(key);
    if (seen || !library) return seen ?? null;
    try {
      return parseLocalizedText(await library.read(key));
    } catch (error) {
      onError("read", error);
      return null;
    }
  };

  /**
   * The open library. Another library (a switch, a sign-out) forgets this session's rows, so they are read from (and
   * kept in) the library now open.
   */
  let rowsOf: LocalizedTextLibrary | null = null;
  const openLibrary = () => {
    const library = deps.library();
    if (library !== rowsOf) {
      known.clear();
      originalAsked.clear();
      rowsOf = library;
    }
    return library;
  };

  const resolve = async (type: TmdbMediaType, tmdbId: number, language: string, episodeKeys: readonly string[] | undefined) => {
    const key = localizedTextKey(type, tmdbId, language);
    const library = openLibrary();
    const stored = await readRow(library, key);
    if (stored && covers(stored, episodeKeys)) {
      known.set(key, stored);
      return stored;
    }
    if (stored && freshAnswer(stored)) {
      // Asked a moment ago without these episodes (the synopsis): they are absent upstream, no second lookup.
      const absent = [...new Set([...stored.absent, ...(episodeKeys ?? [])])];
      const extended = recordOf(
        { overview: stored.overview, episodes: stored.episodes, originalLanguage: stored.originalLanguage },
        absent,
        stored.fetchedAt
      );
      answeredAt.set(extended, answeredAt.get(stored)!);
      await keep(library, key, extended);
      return extended;
    }
    let answer: { item: DetailsTextItem };
    try {
      answer = await deps.details(type, tmdbId, language);
    } catch (error) {
      // An out-of-date row still beats no text; it is asked again next session.
      if (stored) return stored;
      throw error;
    }
    const record = recordOf(answer.item, episodeKeys, now());
    answeredAt.set(record, clock());
    await keep(library, key, record);
    return record;
  };

  const texts: DetailsTexts["texts"] = (type, tmdbId, language, episodeKeys) => {
    const key = localizedTextKey(type, tmdbId, language);
    const inFlight = pending.get(key);
    // A synopsis read in flight may hold an out-of-date row: the episodes then ask once it settles.
    if (inFlight) return inFlight.then((record) => (covers(record, episodeKeys) ? record : texts(type, tmdbId, language, episodeKeys)));
    const task = resolve(type, tmdbId, language, episodeKeys).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };

  const sameTexts = (a: LocalizedTextRecord, b: LocalizedTextRecord) =>
    serializeLocalizedText({ ...a, fetchedAt: "" }) === serializeLocalizedText({ ...b, fetchedAt: "" });

  const put: DetailsTexts["put"] = async (type, tmdbId, language, item, episodeKeys) => {
    const key = localizedTextKey(type, tmdbId, language);
    const library = openLibrary();
    const record = recordOf(item, episodeKeys, now());
    const stored = await readRow(library, key);
    // An unchanged answer (a show refresh with no new episode) costs no synced write.
    if (stored && sameTexts(stored, record)) {
      known.set(key, stored);
      return;
    }
    await keep(library, key, record);
  };

  const originalLanguage: DetailsTexts["originalLanguage"] = async (type, tmdbId, language) => {
    const key = localizedTextKey(type, tmdbId, language);
    const library = openLibrary();
    const stored = await readRow(library, key);
    if (stored?.originalLanguage) {
      known.set(key, stored);
      return stored.originalLanguage;
    }
    const asked = originalAsked.get(key);
    if (asked) return asked;
    const task = (async () => {
      // No row yet: the texts lookup the detail page makes anyway (deduplicated with it), kept as that language's texts.
      if (!stored) return (await texts(type, tmdbId, language)).originalLanguage ?? null;
      // A row kept before the original language was: asked once, its absent episodes still listed as absent.
      const answer = await deps.details(type, tmdbId, language);
      const record = recordOf(answer.item, stored.absent, now());
      answeredAt.set(record, clock());
      await keep(library, key, record);
      return record.originalLanguage ?? null;
    })();
    originalAsked.set(key, task);
    // A failed lookup (offline, no ticket) is not an answer: the next refresh asks again.
    task.catch(() => originalAsked.delete(key));
    return task;
  };

  return { texts, put, originalLanguage };
}

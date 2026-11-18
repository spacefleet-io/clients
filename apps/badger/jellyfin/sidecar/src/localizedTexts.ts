import { OVERVIEW_FALLBACK_LANGUAGE, type AskDetails, type DetailsTexts } from "@space/metadata-client";
import { localizedTextKey, parseLocalizedText, type LocalizedTextRecord } from "@space/shared/localizedTexts";

// LIB-LANG-01/02 in the Jellyfin sidecar: a title's synopsis and its episodes' names and synopses in Jellyfin's
// interface language, English where that language has none, the library's own text as the last resort. The texts of
// one title in one language are the synced `localized_text_v1:` row every Badger app reads and writes. Building the
// library for Jellyfin only reads rows; the background run (`askTexts`, scheduled by the runtime) asks the `details`
// lookup for a title and language no row covers yet and keeps the answer as the row.

/** No lookup while the ticket reserve is at or below this: tickets stay for matches (as the artwork copies). */
export const TEXTS_TICKET_FLOOR = 100;

type TextsMediaType = "movie" | "tv";

/** What reading the kept rows needs from the open library. */
export type TextsReader = { getSetting(key: string): { value: string | null } | null | undefined };

/** Jellyfin's interface language as the rows key it ("fr-FR" -> "fr"), English when unset or unreadable. */
export const uiLanguageOf = (tag: string | null | undefined) => {
  const match = /^([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]+)*$/.exec((tag ?? "").trim());
  return match?.[1]?.toLowerCase() ?? OVERVIEW_FALLBACK_LANGUAGE;
};

export const episodeKeysOf = (episodes: readonly { seasonNumber: number; episodeNumber: number }[]) =>
  episodes.map((episode) => `${episode.seasonNumber}:${episode.episodeNumber}`);

const readRow = (reader: TextsReader, type: TextsMediaType, tmdbId: number, language: string) =>
  parseLocalizedText(reader.getSetting(localizedTextKey(type, tmdbId, language))?.value ?? null);

const covers = (record: LocalizedTextRecord, episodeKeys: readonly string[]) => {
  const known = new Set(record.absent);
  for (const episode of record.episodes) known.add(`${episode.seasonNumber}:${episode.episodeNumber}`);
  return episodeKeys.every((key) => known.has(key));
};

/** The row misses a synopsis or an episode text English may have. */
const lacking = (record: LocalizedTextRecord) =>
  record.overview === null || record.episodes.some((episode) => episode.name === null || episode.overview === null);

/** True when a lookup is due: no row covers the library's episodes in `language`, or English where it lacks texts. */
export const needsTexts = (reader: TextsReader, type: TextsMediaType, tmdbId: number, language: string, episodeKeys: readonly string[]) => {
  const own = readRow(reader, type, tmdbId, language);
  if (!own || !covers(own, episodeKeys)) return true;
  if (language === OVERVIEW_FALLBACK_LANGUAGE || !lacking(own)) return false;
  const english = readRow(reader, type, tmdbId, OVERVIEW_FALLBACK_LANGUAGE);
  return !english || !covers(english, episodeKeys);
};

/** Asks the texts of one title (the row when it covers the episodes, else one lookup kept as the row), then English
 * where the language lacks some. */
export const askTexts = async (texts: DetailsTexts, type: TextsMediaType, tmdbId: number, language: string, episodeKeys: readonly string[]) => {
  const own = await texts.texts(type, tmdbId, language, episodeKeys);
  if (language !== OVERVIEW_FALLBACK_LANGUAGE && lacking(own)) await texts.texts(type, tmdbId, OVERVIEW_FALLBACK_LANGUAGE, episodeKeys);
};

export type KeptTexts = {
  overview: string | null;
  episode(seasonNumber: number, episodeNumber: number): { name: string | null; overview: string | null } | null;
};

/** The kept texts of one title in `language`, English filling what it lacks, field by field; null when no row is kept. */
export const keptTexts = (reader: TextsReader, type: TextsMediaType, tmdbId: number, language: string): KeptTexts | null => {
  const rows = [readRow(reader, type, tmdbId, language)];
  if (language !== OVERVIEW_FALLBACK_LANGUAGE) rows.push(readRow(reader, type, tmdbId, OVERVIEW_FALLBACK_LANGUAGE));
  const kept = rows.filter((row): row is LocalizedTextRecord => row !== null);
  if (kept.length === 0) return null;
  const episodes = new Map<string, { name: string | null; overview: string | null }>();
  for (const row of [...kept].reverse()) {
    for (const episode of row.episodes) {
      const key = `${episode.seasonNumber}:${episode.episodeNumber}`;
      const before = episodes.get(key);
      episodes.set(key, { name: episode.name ?? before?.name ?? null, overview: episode.overview ?? before?.overview ?? null });
    }
  }
  return {
    overview: kept.map((row) => row.overview).find((overview) => overview !== null) ?? null,
    episode: (seasonNumber, episodeNumber) => episodes.get(`${seasonNumber}:${episodeNumber}`) ?? null,
  };
};

/** Why a background lookup was not sent: the run stopped (sign-out, stop) or the ticket reserve is at its floor. */
export class TextsHeldError extends Error {}

/** Tries of one lookup the metadata service asked to wait on (429/503, unreachable) before the title waits for the next run. */
export const TEXTS_LOOKUP_TRIES = 3;

/**
 * The background run's `details` lookup: waits out the metadata service's pause, keeps the ticket reserve above
 * {@link TEXTS_TICKET_FLOOR}, and asks the same title again after a pause. `onFailure` answers true when the failure
 * paused lookups ("slow down", unreachable): the lookup is then tried again once the pause is over, up to
 * {@link TEXTS_LOOKUP_TRIES} times; any other failure ends the title's run.
 */
export const pacedDetails = (deps: {
  details: AskDetails;
  countTickets: () => Promise<number>;
  pausedForMs: () => number;
  alive: () => boolean;
  onFailure: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}): AskDetails => {
  const sleep =
    deps.sleep ??
    ((ms: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    });
  return async (type, tmdbId, language) => {
    for (let attempt = 1; ; attempt += 1) {
      for (let wait = deps.pausedForMs(); wait > 0; wait = deps.pausedForMs()) {
        if (!deps.alive()) throw new TextsHeldError("texts_stopped");
        await sleep(wait);
      }
      if (!deps.alive()) throw new TextsHeldError("texts_stopped");
      if ((await deps.countTickets()) <= TEXTS_TICKET_FLOOR) throw new TextsHeldError("ticket_floor");
      try {
        return await deps.details(type, tmdbId, language);
      } catch (error) {
        if (!deps.onFailure(error) || attempt >= TEXTS_LOOKUP_TRIES) throw error;
      }
    }
  };
};

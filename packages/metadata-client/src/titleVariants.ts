// ACCT-PROF-03: brings the library's titles, posters and backdrops in line with the account's language and its
// profiles' options, in the background. For each matched movie and show:
//   - the media row holds the account-language set: fetched again when it was last fetched in another language
//     (a library made under the old "auto" title language, an account language change), unless the user edited it;
//   - the `title_variants_v1:<media id>` row holds the original set while a profile uses "Original version" and the
//     original differs from the account's set; it is dropped when no profile needs it any more.
// Each media costs at most two lookups, the pass goes one media at a time with a pause between lookups, and it stops
// when the ticket reserve says so or the app asks it to yield; every write is final, so the next pass resumes.
// Portable: no React, no DOM, no node:*.
import type { TmdbMediaType } from "@space/shared/api";
import { normalizeMediaLanguageCode } from "@space/shared/mediaLanguageDisplay";
import {
  isLatinOriginal,
  needsTitleFallback,
  originalSetLanguage,
  parseTitleVariants,
  serializeTitleVariants,
  TITLE_FALLBACK_LANGUAGE,
  titleVariantsKey,
  type TitleArt,
  type TitleLanguage,
  type TitleVariants,
  type TitleVariantSet,
} from "@space/shared/titleLanguage";

/** One movie or show of the library, as its media row holds it. */
export type TitleVariantsMedia = TitleArt & {
  id: string;
  type: TmdbMediaType;
  /** Null for a media matched to nothing: it has no other language to fetch. */
  tmdbId: number | null;
  originalTitle: string | null;
  originalLanguage: string | null;
};

/** The open library, as each app reads and writes it. */
export interface TitleVariantsLibrary {
  listMedia(): Promise<readonly TitleVariantsMedia[]>;
  /** A synced setting's value, or null. */
  read(key: string): Promise<string | null>;
  /** A synced `setting.set`. */
  write(key: string, value: string): Promise<void>;
  /**
   * Replaces the media row's title, poster and backdrop when it still holds `expected` (compare-and-set: an edit made
   * meanwhile wins). Returns false when the row changed or is gone.
   */
  replaceTitleArt(mediaId: string, expected: TitleArt, next: TitleArt): Promise<boolean>;
}

/** The part of a details answer the sets come from. */
export type TitleArtItem = {
  title: string;
  originalTitle?: string | null;
  originalLanguage?: string | null;
  posterPath: string | null;
  backdropPath: string | null;
};

/** How the app asks the metadata service for one details answer. May reject (offline, no ticket, …). */
export type AskTitleArt = (type: TmdbMediaType, tmdbId: number, language: string) => Promise<{ item: TitleArtItem }>;

export type ReconcileTitleVariantsDeps = {
  library: TitleVariantsLibrary;
  details: AskTitleArt;
  /** The account's language (UX-I18N-07). */
  accountLanguage: string;
  /** Every profile's option; one "original" is enough to keep original sets. */
  profileOptions: readonly TitleLanguage[];
  /**
   * The old library-wide `library_metadata_language` value ("auto" or a language), read only to know which language
   * a row of a library without variant rows was fetched in. Null when the library never had it ("auto").
   */
  legacyLibraryLanguage?: string | null;
  /** Checked before each lookup; false stops the pass (the reserve is kept for the user's own lookups). */
  canSpend?: () => boolean | Promise<boolean>;
  /** Checked between media; true stops the pass so a lookup the user is waiting for goes first. */
  shouldYield?: () => boolean;
  /** Called after a media row got a new poster or backdrop path, so the app copies it into the vault (META-ART-01). */
  onRowArtChanged?: (mediaId: string) => void;
  /**
   * Copies one picture of an original set into the user's storage (the app's artwork copy `upload`, META-ART-01):
   * `{status: "ok", key}` stores the asset key in the variant row, `{status: "missing"}` drops the picture, anything
   * else keeps the TMDB path for the next pass. Without it the original pictures stay TMDB paths.
   */
  uploadArtwork?: (kind: "poster" | "backdrop", path: string) => Promise<{ status: "ok"; key: string } | { status: string }>;
  /** Pause after each lookup, in milliseconds. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  onError?: (mediaId: string, error: unknown) => void;
};

export type ReconcileTitleVariantsResult = {
  checked: number;
  lookups: number;
  rowsReplaced: number;
  variantsWritten: number;
  failed: number;
  /** Stopped before the end (tickets, yield): the next pass resumes. */
  stopped: boolean;
};

/** Default pause after a lookup: the pass runs in the background, never in a burst. */
export const TITLE_VARIANTS_PAUSE_MS = 1_500;

const AUTO = "auto";
/** A TMDB image path (`/abc.jpg`), as `isTmdbImagePath` in `@space/library-db-definition/artworkCopy`. */
const TMDB_PATH = /^\/[^/]/;

/**
 * The language a row of a library without variant rows was fetched in: unknown ("und", so it is fetched again) for a
 * title not in Latin letters, else the old library language when one was pinned, else the old "auto" choice (the
 * original language when written in Latin letters, else the app's).
 */
const legacyRowLanguage = (media: TitleVariantsMedia, legacy: string | null | undefined, account: string): string => {
  if (needsTitleFallback(media.title)) return "und";
  if (legacy && legacy !== AUTO) return normalizeMediaLanguageCode(legacy);
  const original = normalizeMediaLanguageCode(media.originalLanguage);
  return original !== "und" && isLatinOriginal(media) ? original : account;
};

/**
 * True when the row's title is the work's original title in non-Latin letters while the record gave it another one:
 * an app from before ACCT-PROF-03 put it back, not the user, so the row is fetched again.
 */
const holdsNonLatinOriginal = (media: TitleVariantsMedia, stored: TitleVariants): boolean =>
  media.title !== stored.rowTitle &&
  needsTitleFallback(media.title) &&
  (media.title.trim() === media.originalTitle?.trim() || media.title.trim() === stored.original?.title.trim());

const sameArt = (a: TitleArt, b: TitleArt) => a.title === b.title && a.posterPath === b.posterPath && a.backdropPath === b.backdropPath;

const sameVariants = (a: TitleVariants | null, b: TitleVariants) =>
  !!a &&
  a.rowLanguage === b.rowLanguage &&
  a.rowTitle === b.rowTitle &&
  (a.original === b.original ||
    (!!a.original && !!b.original && a.original.language === b.original.language && sameArt(a.original, b.original)));

export const reconcileTitleVariants = async (deps: ReconcileTitleVariantsDeps): Promise<ReconcileTitleVariantsResult> => {
  const {
    library,
    details,
    profileOptions,
    legacyLibraryLanguage,
    canSpend,
    shouldYield,
    onRowArtChanged,
    uploadArtwork,
    pauseMs = TITLE_VARIANTS_PAUSE_MS,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = () => new Date().toISOString(),
    onError,
  } = deps;
  const account = normalizeMediaLanguageCode(deps.accountLanguage);
  const wantsOriginal = profileOptions.includes("original");
  const result: ReconcileTitleVariantsResult = { checked: 0, lookups: 0, rowsReplaced: 0, variantsWritten: 0, failed: 0, stopped: false };

  /** One lookup, or null when the pass must stop (no ticket to spare). */
  const ask = async (media: TitleVariantsMedia & { tmdbId: number }, language: string): Promise<TitleArtItem | null> => {
    if (canSpend && !(await canSpend())) return null;
    result.lookups += 1;
    try {
      return (await details(media.type, media.tmdbId, language)).item;
    } finally {
      if (pauseMs > 0) await sleep(pauseMs);
    }
  };

  for (const media of await library.listMedia()) {
    if (shouldYield?.()) {
      result.stopped = true;
      break;
    }
    if (media.tmdbId === null) continue;
    const matched = media as TitleVariantsMedia & { tmdbId: number };
    result.checked += 1;
    try {
      const key = titleVariantsKey(media.id);
      const stored = parseTitleVariants(await library.read(key));
      const resetToOriginal = stored !== null && holdsNonLatinOriginal(media, stored);
      const rowLanguage = resetToOriginal ? "und" : (stored?.rowLanguage ?? legacyRowLanguage(media, legacyLibraryLanguage, account));
      // A row whose title is not the one it was given was edited by the user: it stays as it is.
      const edited = stored !== null && media.title !== stored.rowTitle && !resetToOriginal;
      // An original set in non-Latin letters is never kept (ACCT-PROF-03), whichever app wrote it.
      const storedOriginal = stored?.original && !needsTitleFallback(stored.original.title) ? stored.original : null;
      let next: TitleVariants = { rowLanguage, rowTitle: stored?.rowTitle ?? media.title, original: storedOriginal, fetchedAt: stored?.fetchedAt ?? "" };

      if (!edited && rowLanguage !== account) {
        let item = await ask(matched, account);
        if (!item) {
          result.stopped = true;
          break;
        }
        if (needsTitleFallback(item.title)) {
          item = await ask(matched, TITLE_FALLBACK_LANGUAGE);
          if (!item) {
            result.stopped = true;
            break;
          }
        }
        const art: TitleArt = { title: item.title, posterPath: item.posterPath, backdropPath: item.backdropPath };
        if (!sameArt(art, media)) {
          if (!(await library.replaceTitleArt(media.id, media, art))) continue;
          result.rowsReplaced += 1;
          if (art.posterPath !== media.posterPath || art.backdropPath !== media.backdropPath) onRowArtChanged?.(media.id);
        }
        next = { ...next, rowLanguage: account, rowTitle: art.title, fetchedAt: now() };
      } else if (!stored) {
        next = { ...next, rowLanguage: account, rowTitle: media.title };
      }

      const originalLanguage = wantsOriginal ? originalSetLanguage(media, account) : null;
      if (!originalLanguage) {
        next = { ...next, original: null };
      } else if (next.original?.language !== originalLanguage) {
        const item = await ask(matched, originalLanguage);
        if (!item) {
          result.stopped = true;
          break;
        }
        const original: TitleVariantSet = {
          language: originalLanguage,
          title: media.originalTitle?.trim() || item.originalTitle?.trim() || item.title,
          posterPath: item.posterPath,
          backdropPath: item.backdropPath,
        };
        next = { ...next, original, fetchedAt: now() };
      }

      // META-ART-01: the original set's pictures are copied into the user's storage like the row's; a picture not
      // copied yet keeps its TMDB path (the row's picture shows meanwhile) and the next pass retries it.
      if (next.original && uploadArtwork) {
        let original = next.original;
        for (const [field, kind] of [["posterPath", "poster"], ["backdropPath", "backdrop"]] as const) {
          const path = original[field];
          if (!path || !TMDB_PATH.test(path)) continue;
          if (canSpend && !(await canSpend())) break;
          const outcome = await uploadArtwork(kind, path);
          if (outcome.status === "ok" && "key" in outcome) original = { ...original, [field]: outcome.key };
          else if (outcome.status === "missing") original = { ...original, [field]: null };
        }
        next = { ...next, original };
      }

      if (!sameVariants(stored, next)) {
        await library.write(key, serializeTitleVariants(next));
        result.variantsWritten += 1;
      }
    } catch (error) {
      result.failed += 1;
      onError?.(media.id, error);
    }
  }
  return result;
};

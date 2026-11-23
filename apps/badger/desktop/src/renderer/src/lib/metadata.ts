import {
  searchMetadata,
  getMetadataDetails,
  getMetadataTrailers,
  TitleSearchResult,
  TitleType,
  TitleDetails,
  Trailer,
} from "@/api";
import { isClientUiLanguage } from "@space/shared";
import { needsTitleFallback, TITLE_FALLBACK_LANGUAGE } from "@space/shared/titleLanguage";
import { createDetailsTexts, detailsEpisodes, detailsOverview, type DetailsTextItem, type LocalizedTextLibrary } from "@space/metadata-client";
import type { LibraryDb } from "@/lib/libraryDb";
import { rendererLogger } from "@/logger";

// Every the catalog lookup goes through the SpaceFleet metadata service (META-DIRECT-03: the desktop never calls
// the catalog itself; the user's own-key mode was removed).

const normalizeGenreIds = (value: unknown): number[] => {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((genre) => (typeof genre === "number" ? genre : Number(genre?.id)))
    .filter((genreId: number) => Number.isFinite(genreId));
};

export const searchTitles = (token: string, type: TitleType, query: string, page = 1) =>
  searchMetadata(token, type, query, page);

export const getTitleDetails = async (token: string, type: TitleType, id: number, language = "en") => {
  const result = await getMetadataDetails(token, type, id, language);
  const item = result.item;
  return { ...item, genres: normalizeGenreIds(item.genres) };
};

// LIB-LANG-02: a title's synopsis and episode texts per language are kept in the library (a synced `setting.set` row),
// so the detail dialog reads them there and asks the metadata service only when no device kept them yet. The open
// library is registered by `libraryContext` (`setDesktopTextsLibrary`), null while none is open.
let textsLibrary: LocalizedTextLibrary | null = null;

export const setDesktopTextsLibrary = (db: Pick<LibraryDb, "getSetting" | "setSetting"> | null) => {
  textsLibrary = db
    ? {
        read: async (key) => (await db.getSetting(key))?.value ?? null,
        write: async (key, value) => {
          await db.setSetting(key, value);
        },
      }
    : null;
};

const detailsTexts = createDetailsTexts({
  details: (type, id, language) => getMetadataDetails("", type, id, language),
  library: () => textsLibrary,
  onError: (stage, error) =>
    rendererLogger
      .child({ scope: "metadata" })
      .warn({ error: error instanceof Error ? error.message : String(error) }, `[metadata] texts.library.${stage}.failed`),
});

// Every episode's name and synopsis of one show in one language, for `useLocalizedEpisodes` (LIB-LANG-01/02).
// `episodeKeys` are the library's episodes: one the kept texts never heard of asks again (new episodes).
export const getLocalizedEpisodes = (_token: string, tvId: number, language: string, episodeKeys?: readonly string[]) =>
  detailsEpisodes(detailsTexts)(tvId, language, episodeKeys);

// The synopsis in a given language, for the live per-device description overlay (LIB-LANG-01/02).
export const getLocalizedOverview = (_token: string, type: TitleType, id: number, language: string): Promise<string | null> =>
  detailsOverview(detailsTexts)(type, id, language);

// A refresh that already fetched a title's details in a language keeps its texts for that language: no lookup.
export const keepLocalizedTexts = (type: TitleType, id: number, language: string, item: DetailsTextItem, episodeKeys?: readonly string[]) =>
  detailsTexts.put(type, id, language, item, episodeKeys);

// The original language a trailer refresh asks trailers in (after a trailer-language change): the stored one, else
// the one the kept texts in `language` name, else asked once per title and language and kept (LIB-LANG-02).
export const trailerOriginalLanguage = async (
  _token: string,
  title: { type: TitleType; catalogId: number; originalLanguage?: string | null },
  language: string
): Promise<string | null> => title.originalLanguage ?? detailsTexts.originalLanguage(title.type, title.catalogId, language);

// The language the detail page reads a title's texts in (`useLocalizedOverview` / `useLocalizedEpisodes`): an import
// that fetched the details in it keeps that answer, so the first page asks nothing (LIB-LANG-02).
const textsLanguageOf = (uiLanguage: string) => (isClientUiLanguage(uiLanguage) ? uiLanguage : "en");

// The import preview's answers in that language, by `type:id:language`, until the title is imported: a title only
// previewed writes no row to the library. The newest few only (a preview session looks at a handful of hits).
const previewTexts = new Map<string, DetailsTextItem>();
const PREVIEW_TEXTS_KEPT = 32;

type LocalizedFields = {
  title: string;
  originalTitle: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string | null;
};

const fetchHitInLanguage = async (
  token: string,
  hit: TitleSearchResult,
  language: string,
  keepTexts: boolean
): Promise<LocalizedFields | null> => {
  try {
    const { item } = await getMetadataDetails(token, hit.type, hit.id, language);
    if (keepTexts) {
      previewTexts.delete(`${hit.type}:${hit.id}:${language}`);
      previewTexts.set(`${hit.type}:${hit.id}:${language}`, item);
      if (previewTexts.size > PREVIEW_TEXTS_KEPT) previewTexts.delete(previewTexts.keys().next().value!);
    }
    return {
      title: typeof item.title === "string" ? item.title : "",
      originalTitle: item.originalTitle ?? null,
      posterPath: item.posterPath ?? null,
      backdropPath: item.backdropPath ?? null,
      overview: typeof item.overview === "string" && item.overview ? item.overview : null,
    };
  } catch {
    return null;
  }
};

// Localize an already-identified search hit for the import-modal preview pane. The search answers in English, so
// a French film comes back as "Hate" with its English poster and synopsis. ACCT-PROF-03: the library stores every
// title, poster and backdrop in the account's language (`accountLanguage`, UX-I18N-07), with the English answer
// when the account-language title is not in Latin letters (`needsTitleFallback`); the synopsis is the account's.
// One metadata-service call at most, none for an English account.
export const localizeSearchResultForLibrary = async (
  token: string,
  hit: TitleSearchResult,
  opts: { accountLanguage: string }
): Promise<TitleSearchResult> => {
  const account = opts.accountLanguage || "en";
  if (account === TITLE_FALLBACK_LANGUAGE) return hit;
  const fetched = await fetchHitInLanguage(token, hit, account, account === textsLanguageOf(account));
  if (!fetched) return hit;
  // The search hit is the English answer.
  const art = needsTitleFallback(fetched.title) ? hit : fetched;
  return {
    ...hit,
    title: art.title || hit.title,
    originalTitle: fetched.originalTitle ?? hit.originalTitle,
    posterPath: art.posterPath ?? hit.posterPath,
    backdropPath: art.backdropPath ?? hit.backdropPath,
    overview: fetched.overview ?? hit.overview,
  };
};

// Full details (seasons, episodes, cast) for a NEW import, in the account's language (ACCT-PROF-03): the stored
// title, poster and backdrop are the account-language set from the start, the English one when that title is not
// in Latin letters. The original-language set a profile may want is fetched later by the title-variants pass
// (`titleVariantsPass.ts`). The account-language answer is kept as the title's texts (LIB-LANG-02).
export const getTitleDetailsForLibrary = async (
  token: string,
  type: TitleType,
  id: number,
  opts: { accountLanguage: string }
): Promise<TitleDetails> => {
  const account = opts.accountLanguage || "en";
  const textsLanguage = textsLanguageOf(account);
  const previewKey = `${type}:${id}:${textsLanguage}`;
  const previewed = previewTexts.get(previewKey);
  previewTexts.delete(previewKey);
  const localized = await getTitleDetails(token, type, id, account);
  const textsAnswer = account === textsLanguage ? localized : previewed;
  if (textsAnswer) await detailsTexts.put(type, id, textsLanguage, textsAnswer);
  if (account === TITLE_FALLBACK_LANGUAGE || !needsTitleFallback(localized.title)) return localized;
  const english = await getTitleDetails(token, type, id, TITLE_FALLBACK_LANGUAGE);
  return { ...localized, title: english.title, posterPath: english.posterPath, backdropPath: english.backdropPath };
};

export const getTitleTrailers = async (token: string, type: TitleType, id: number, language: string) => {
  const result = await getMetadataTrailers(token, type, id, language);
  return result.trailers;
};

export const getTitleTrailersForLanguages = async (
  token: string,
  type: TitleType,
  id: number,
  languages: Array<string | null | undefined>
) => {
  const uniqueLanguages = Array.from(
    new Set(languages.map((lang) => (typeof lang === "string" ? lang.trim() : "")).filter(Boolean))
  );
  if (uniqueLanguages.length === 0) return [];
  const results = await Promise.all(
    uniqueLanguages.map((lang) => getTitleTrailers(token, type, id, lang))
  );
  const merged = new Map<string, Trailer>();
  results.flat().forEach((trailer) => {
    const key = `${trailer.provider}:${trailer.key}:${trailer.language}`;
    merged.set(key, trailer);
  });
  const all = Array.from(merged.values());
  const official = all.filter((trailer) => trailer.official);
  return official.length > 0 ? official : all;
};

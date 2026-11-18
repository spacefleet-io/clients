/**
 * The detail pages' synopsis and episode texts on the phone and TV, read from the library first (LIB-LANG-02): the
 * first device that shows a title in a language asks the metadata service once and keeps the answer in the library;
 * every later page reads it. No React Native import: the library store and tests import it as is.
 */
import { createDetailsTexts, detailsEpisodes, detailsOverview, type AskDetails, type LocalizedTextLibrary } from "@space/metadata-client";

/** The open library's settings, as `LibraryDb` exposes them. */
export type KeptTextsLibrary = {
  readSetting(key: string): Promise<string | null>;
  writeSetting(key: string, value: string): Promise<void>;
};

let openLibrary: LocalizedTextLibrary | null = null;

/** The library store registers the open library, and none when it closes (sign-out): texts are then asked, not kept. */
export const setMobileTextsLibrary = (db: KeptTextsLibrary | null) => {
  openLibrary = db ? { read: (key) => db.readSetting(key), write: (key, value) => db.writeSetting(key, value) } : null;
};

export const createKeptTexts = (deps: { details: AskDetails; onError?: (stage: "read" | "write", error: unknown) => void }) => {
  const texts = createDetailsTexts({ details: deps.details, library: () => openLibrary, onError: deps.onError });
  return {
    /** A title's synopsis in one language, for `useLocalizedOverview` (LIB-LANG-01). */
    fetchOverview: detailsOverview(texts),
    /** A show's episode names and synopses in one language, for `useLocalizedEpisodes` (LIB-LANG-01). */
    fetchEpisodes: detailsEpisodes(texts),
  };
};

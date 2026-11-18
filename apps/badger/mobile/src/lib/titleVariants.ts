/**
 * ACCT-PROF-03 on the phone and the TV: keeps each title's variant row (`title_variants_v1:<media id>`) and media row
 * in line with the profiles' title-language choices, in the background (`reconcileTitleVariants` in
 * `@space/metadata-client`). One pass runs at a time; a request made while one runs starts one more pass after it, so
 * a profile's new choice or a new account language is never lost. Screens never wait for it: they keep showing the
 * old titles until a pass replaces them.
 *
 * Kept free of native modules so it is testable; `libraryTitleVariants.ts` supplies the device's pieces.
 */
import {
  TITLE_VARIANTS_PAUSE_MS,
  reconcileTitleVariants,
  type AskTitleArt,
  type ReconcileTitleVariantsDeps,
  type ReconcileTitleVariantsResult,
} from "@space/metadata-client";
import { MAIN_VIEWING_SCOPE, viewingScopeFor, type ViewingScope } from "@space/shared/profileViewing";
import { profileTitleLanguage, type TitleLanguage } from "@space/shared/titleLanguage";
import type { ProfileSettings } from "@space/shared/profileSettings";
import type { MediaRow } from "@space/shared/libraryTypes";
import type { TitleArt } from "@space/shared/titleLanguage";

/** The old library-wide language setting; read only to know which language an old row was fetched in. */
export const LEGACY_LIBRARY_LANGUAGE_KEY = "library_metadata_language";

/** The open library's part the pass uses (`LibraryDb`). */
export type TitleVariantsDb = {
  listMedia(): Promise<MediaRow[]>;
  readSetting(key: string): Promise<string | null>;
  writeSetting(key: string, value: string): Promise<void>;
  replaceTitleArt(mediaId: string, expected: TitleArt, next: TitleArt): Promise<boolean>;
  getProfileSettings(scope: ViewingScope): Promise<ProfileSettings | null>;
};

export type TitleVariantsProfile = { id: string; isMain: boolean };

export type TitleVariantsRunnerDeps = {
  db: TitleVariantsDb;
  /** Every profile of the account (the store's current list). */
  profiles: () => readonly TitleVariantsProfile[];
  /** The account's language (UX-I18N-07); the app shows it. */
  accountLanguage: () => string;
  details: AskTitleArt;
  canSpend: () => Promise<boolean>;
  uploadArtwork: NonNullable<ReconcileTitleVariantsDeps["uploadArtwork"]>;
  /** A row got a new poster or backdrop path: the artwork copy runs for it (META-ART-01). */
  onRowArtChanged: (mediaId: string) => void;
  /** A pass replaced rows or wrote variant rows: the screens re-read. */
  onChanged: () => void;
  log: (event: string, detail: Record<string, unknown>) => void;
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type TitleVariantsRunner = {
  /** Runs a pass now, or one more after the running one. */
  request: (reason: string) => void;
  /** Resolves once no pass runs or waits. */
  idle: () => Promise<void>;
  /** The library closed: the running pass stops at its next title and nothing more runs. */
  stop: () => void;
};

/** Every profile's option; a profile that never answered counts as "app". No list yet: the main profile's. */
export const profileTitleOptions = async (db: TitleVariantsDb, profiles: readonly TitleVariantsProfile[]): Promise<TitleLanguage[]> => {
  const scopes = profiles.length > 0 ? profiles.map((profile) => viewingScopeFor(profile)) : [MAIN_VIEWING_SCOPE];
  return Promise.all(scopes.map(async (scope) => profileTitleLanguage(await db.getProfileSettings(scope))));
};

export const startTitleVariants = (deps: TitleVariantsRunnerDeps): TitleVariantsRunner => {
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;

  const pass = async (reason: string): Promise<ReconcileTitleVariantsResult> => {
    const { db } = deps;
    const profileOptions = await profileTitleOptions(db, deps.profiles());
    const legacyLibraryLanguage = await db.readSetting(LEGACY_LIBRARY_LANGUAGE_KEY);
    const accountLanguage = deps.accountLanguage();
    deps.log("title_variants.pass.start", { reason, accountLanguage, profileOptions, legacyLibraryLanguage });
    return reconcileTitleVariants({
      library: {
        listMedia: () => db.listMedia(),
        read: (key) => db.readSetting(key),
        write: (key, value) => db.writeSetting(key, value),
        replaceTitleArt: (mediaId, expected, next) => db.replaceTitleArt(mediaId, expected, next),
      },
      details: deps.details,
      accountLanguage,
      profileOptions,
      legacyLibraryLanguage,
      canSpend: deps.canSpend,
      shouldYield: () => stopped,
      onRowArtChanged: deps.onRowArtChanged,
      uploadArtwork: deps.uploadArtwork,
      pauseMs: deps.pauseMs ?? TITLE_VARIANTS_PAUSE_MS,
      sleep: deps.sleep,
      onError: (mediaId, error) =>
        deps.log("title_variants.media.failed", { mediaId, reason: error instanceof Error ? error.message : String(error) }),
    });
  };

  const loop = async (reason: string) => {
    let why = reason;
    do {
      again = false;
      try {
        const result = await pass(why);
        deps.log("title_variants.pass.done", { reason: why, ...result });
        if (!stopped && (result.rowsReplaced > 0 || result.variantsWritten > 0)) deps.onChanged();
      } catch (error) {
        deps.log("title_variants.pass.failed", { reason: why, message: error instanceof Error ? error.message : String(error) });
      }
      why = "again";
    } while (again && !stopped);
    running = null;
  };

  return {
    request: (reason) => {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      running = loop(reason);
    },
    idle: async () => {
      while (running) await running;
    },
    stop: () => {
      stopped = true;
    },
  };
};

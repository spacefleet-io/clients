/**
 * ACCT-PROF-03 on the desktop: the background pass that keeps, for each movie and show, the title, poster and backdrop
 * set every profile needs (`reconcileTitleVariants` in `@space/metadata-client`). It runs after the library opens and
 * again when a profile's option or the account language changes; the titles shown meanwhile stay until replaced.
 */
import {
  reconcileTitleVariants,
  TITLE_VARIANTS_PAUSE_MS,
  type AskTitleArt,
  type ReconcileTitleVariantsResult,
} from "@space/metadata-client";
import type { TitleArt, TitleLanguage } from "@space/shared/titleLanguage";
import type { MediaRow } from "@space/shared/libraryTypes";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "title-variants" });

/** Lets the library settle and the first screen render before the first lookup. */
export const TITLE_VARIANTS_START_DELAY_MS = 5_000;

/** The open library, as the pass reads and writes it (the desktop `LibraryDb`). */
export type TitleVariantsDb = {
  listMedia(): Promise<MediaRow[]>;
  getSetting(key: string): Promise<{ value: string } | null>;
  setSetting(key: string, value: string): Promise<unknown>;
  replaceMediaTitleArt(mediaId: string, expected: TitleArt, next: TitleArt): Promise<boolean>;
};

export type TitleVariantsPassInputs = {
  db: TitleVariantsDb;
  /** The metadata service's details lookup in one language. */
  details: AskTitleArt;
  accountLanguage: string;
  profileOptions: readonly TitleLanguage[];
  /** The old `library_metadata_language` value, read only to know what an untracked row was fetched in. */
  legacyLibraryLanguage: string | null;
  /** Tickets left in the reserve; the pass stops at `ticketFloor`. */
  ticketsLeft: () => Promise<number>;
  ticketFloor: number;
  onRowArtChanged: (mediaId: string) => void;
  uploadArtwork: (kind: "poster" | "backdrop", path: string) => Promise<{ status: "ok"; key: string } | { status: string }>;
  /** Called once after a pass that changed the library (re-reads the snapshot). */
  onChanged: () => Promise<unknown>;
  startDelayMs?: number;
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Starts the pass after the start delay; `stop` ends it between titles (sign-out, a newer pass, library closed). */
export const startTitleVariantsReconcile = (
  inputs: TitleVariantsPassInputs
): { stop: () => void; done: Promise<ReconcileTitleVariantsResult | null> } => {
  let stopped = false;
  const sleep = inputs.sleep ?? defaultSleep;
  const done = sleep(inputs.startDelayMs ?? TITLE_VARIANTS_START_DELAY_MS).then(async () => {
    if (stopped) return null;
    const { db } = inputs;
    log.info(
      { accountLanguage: inputs.accountLanguage, profileOptions: inputs.profileOptions, legacy: inputs.legacyLibraryLanguage },
      "title variants pass start"
    );
    const result = await reconcileTitleVariants({
      library: {
        listMedia: () => db.listMedia(),
        read: async (key) => (await db.getSetting(key))?.value ?? null,
        write: async (key, value) => {
          await db.setSetting(key, value);
        },
        replaceTitleArt: (mediaId, expected, next) => db.replaceMediaTitleArt(mediaId, expected, next),
      },
      details: inputs.details,
      accountLanguage: inputs.accountLanguage,
      profileOptions: inputs.profileOptions,
      legacyLibraryLanguage: inputs.legacyLibraryLanguage,
      canSpend: async () => (await inputs.ticketsLeft()) > inputs.ticketFloor,
      shouldYield: () => stopped,
      onRowArtChanged: inputs.onRowArtChanged,
      uploadArtwork: inputs.uploadArtwork,
      pauseMs: inputs.pauseMs ?? TITLE_VARIANTS_PAUSE_MS,
      sleep,
      onError: (mediaId, error) => log.warn({ mediaId, err: String(error) }, "title variants lookup failed"),
    });
    log.info(result, "title variants pass done");
    if (result.rowsReplaced > 0 || result.variantsWritten > 0) await inputs.onChanged();
    return result;
  });
  return {
    stop: () => {
      stopped = true;
    },
    done: done.catch((err: unknown) => {
      log.warn({ err: String(err) }, "title variants pass failed");
      return null;
    }),
  };
};

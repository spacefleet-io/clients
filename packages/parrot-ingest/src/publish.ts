import { isParrotPublishConflict, publishParrotEditsWith, type ParrotEditsState } from "@space/parrot-core";
import type { fetchLibrarySnapshot, publishLibrarySnapshot } from "@space/library-db-runtime/snapshotTransport";
import type { ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { PARROT_OP_STREAM_VERSION } from "@space/parrot-library-db-definition/ops";
import { applyParrotOps, openParrotLibrary, serializeParrotLibrary, type ParrotLibraryDb } from "./library";

export const PARROT_APP_ID = "parrot" as const;

/** The two snapshot calls a save makes; tests swap them for in-memory fakes. */
export type ParrotSnapshotTransport = {
  fetchSnapshot: typeof fetchLibrarySnapshot;
  publishSnapshot: typeof publishLibrarySnapshot;
};

/** An open library and the server version it was read at (0: the server has none yet). */
export type ParrotLibraryState = ParrotEditsState<ParrotLibraryDb>;

export type ParrotPublishOptions = {
  transport: ParrotSnapshotTransport;
  token: string;
  libraryKeyBase64: string;
  log?: (message: string) => void;
  /** Frees a library the save replaced on a replay (closes it by default); an app whose window still reads it waits. */
  close?: (db: ParrotLibraryDb) => void;
};

/** The account's latest Parrot library, opened (a new empty one when there is none). */
export const fetchParrotLibraryState = async (options: ParrotPublishOptions): Promise<ParrotLibraryState> => {
  const snapshot = await options.transport.fetchSnapshot({ token: options.token, keyBase64: options.libraryKeyBase64, appId: PARROT_APP_ID });
  options.log?.(snapshot ? `[parrot-publish] library snapshot v${snapshot.snapshotVersion}` : "[parrot-publish] no library snapshot yet");
  return { db: openParrotLibrary(snapshot?.dbBytes ?? null), baseVersion: snapshot?.snapshotVersion ?? 0 };
};

/**
 * The desktop's save: the shared replay-once loop of @space/parrot-core (`publishParrotEditsWith`) over this
 * process's SQLite and the Node snapshot transport (PAR-UP-03, PAR-PL-03). `state.db` already holds this save's ops.
 */
export const publishParrotEdits = (
  state: ParrotLibraryState,
  replay: (latest: ParrotLibraryDb) => readonly ParrotLibraryOp[] | Promise<readonly ParrotLibraryOp[]>,
  options: ParrotPublishOptions
): Promise<number> =>
  publishParrotEditsWith(state, replay, {
    loadLatest: () => fetchParrotLibraryState(options),
    applyOps: applyParrotOps,
    publish: async (db, baseVersion) =>
      (
        await options.transport.publishSnapshot({
          token: options.token,
          keyBase64: options.libraryKeyBase64,
          dbBytes: serializeParrotLibrary(db),
          baseVersion,
          appId: PARROT_APP_ID,
          opStreamVersion: PARROT_OP_STREAM_VERSION,
        })
      ).version,
    isConflict: isParrotPublishConflict,
    close: options.close ?? ((db) => db.close()),
    log: options.log,
  });

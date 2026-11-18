// Saving library edits as a new encrypted snapshot (PAR-UP-03, PAR-PL-03), the loop every Parrot client shares: the
// desktop (Node, packages/parrot-ingest/src/publish.ts), the browser (@space/web-vault/librarySnapshotPublish) and the
// phone. No Node, no SQLite engine here: each client passes how it opens, changes and publishes its own database.
import type { ParrotLibraryOp } from "@space/parrot-library-db-definition";

/** An open library and the server version it was read at (0: the server has none yet). */
export type ParrotEditsState<Db> = { db: Db; baseVersion: number };

export type ParrotPublishEditsDeps<Db> = {
  /** The account's latest snapshot, opened (an empty library at version 0 when there is none). */
  loadLatest: () => Promise<ParrotEditsState<Db>>;
  /** Applies ops to an open library, in one transaction (async for SQLite clients that only run async). */
  applyOps: (db: Db, ops: readonly ParrotLibraryOp[]) => void | Promise<void>;
  /** Publishes `db` as the snapshot after `baseVersion`; resolves to the server's new version. */
  publish: (db: Db, baseVersion: number) => Promise<number>;
  /** True when `publish` failed because another device published first (`isParrotPublishConflict` by default). */
  isConflict: (error: unknown) => boolean;
  /** Frees a library this save no longer holds. */
  close?: (db: Db) => void;
  log?: (message: string) => void;
};

/**
 * The API's answer when the snapshot's base version is stale: HTTP 409 (ApiError or anything carrying `status`).
 * A 409 `library_format_downgrade` is not one: the account's library is in a newer format than this build writes,
 * so replaying on it fails the same way; this build must update instead (LIB-FMT-05, LIB-FMT-09).
 */
export const isParrotPublishConflict = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  error.status === 409 &&
  !("payload" in error && (error.payload as { error?: unknown } | null)?.error === "library_format_downgrade");

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Publishes `state.db`, where this save's ops are already applied, over `state.baseVersion`. When another device
 * published first, it opens the latest snapshot, applies `replay(latest)` (the same change rebuilt on that library)
 * and publishes ONCE more. Any other failure, or a second conflict, throws. `state` then holds the library the save
 * ended on: the published one with its new version, or after a failed replay the latest library plus the replayed
 * ops (unpublished). The replaced database is closed only once the latest one is open, so `state` always works.
 */
export const publishParrotEditsWith = async <Db>(
  state: ParrotEditsState<Db>,
  replay: (latest: Db) => readonly ParrotLibraryOp[] | Promise<readonly ParrotLibraryOp[]>,
  deps: ParrotPublishEditsDeps<Db>
): Promise<number> => {
  const log = deps.log ?? (() => undefined);
  let version: number;
  try {
    version = await deps.publish(state.db, state.baseVersion);
  } catch (error) {
    if (!deps.isConflict(error)) {
      log(`[parrot-publish] publish on v${state.baseVersion} failed (${errorText(error)})`);
      throw error;
    }
    log(`[parrot-publish] publish on v${state.baseVersion} failed (${errorText(error)}); replaying on the latest snapshot`);
    const latest = await deps.loadLatest();
    let ops: readonly ParrotLibraryOp[];
    try {
      ops = await replay(latest.db);
      await deps.applyOps(latest.db, ops);
    } catch (replayError) {
      deps.close?.(latest.db);
      throw replayError;
    }
    deps.close?.(state.db);
    state.db = latest.db;
    state.baseVersion = latest.baseVersion;
    log(`[parrot-publish] replayed ${ops.length} op(s) on v${latest.baseVersion}`);
    version = await deps.publish(state.db, state.baseVersion);
  }
  state.baseVersion = version;
  log(`[parrot-publish] published library snapshot v${version}`);
  return version;
};

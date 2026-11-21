import {
  PARROT_LIBRARY_SCHEMA_VERSION,
  ParrotLibraryTooNewError,
  parrotLibraryMigrationStatements,
} from "@space/parrot-library-db-definition/migrations";
import { isSplitTrackFile, type ParrotLibraryOp } from "@space/parrot-library-db-definition/ops";
import { LIBRARY_SCHEMA_REASON, requireLibraryUpdate } from "@space/shared/appVersion";

/**
 * The statements that bring a library file at `fileVersion` to the schema it is kept at while its songs are stored
 * whole (schema 10; a file already at 11 stays there). A file at a schema this build does not know (another device
 * saved it with a newer Parrot) latches the update screen with reason `library_schema` before the error propagates, so
 * every Parrot app asks for an update instead of failing silently (PAR-FMT-01, API-VER-01).
 */
export const parrotLibraryUpgradeStatements = (fileVersion: number): string[] => {
  try {
    return parrotLibraryMigrationStatements(fileVersion);
  } catch (error) {
    if (error instanceof ParrotLibraryTooNewError) requireLibraryUpdate(LIBRARY_SCHEMA_REASON);
    throw error;
  }
};

/**
 * The statements to run before applying `ops` to a library at `fileVersion`: schema 11 when one of them stores a file
 * in parts (only imports for an account switched to it make such a change, API-VER-01), none otherwise.
 */
export const parrotLibraryStatementsForOps = (fileVersion: number, ops: readonly ParrotLibraryOp[]): string[] =>
  ops.some((op) => op.type === "track_file.upsert" && isSplitTrackFile(op.payload.file))
    ? parrotLibraryMigrationStatements(fileVersion, PARROT_LIBRARY_SCHEMA_VERSION)
    : [];

/**
 * UX-JOBS-01: the import jobs list main keeps in userData/import-jobs.json, and how an import cut short by Parrot
 * closing is recorded: failed, with IMPORT_INTERRUPTED so the card says to import the folder again.
 */
import { IMPORT_INTERRUPTED, importJobRetryable, type ParrotImportJob, type ParrotImportStatus } from "../shared/ipc";

export type StoredImportJob = ParrotImportJob & { userId: string };

export const importEnded = (phase: ParrotImportStatus["phase"]) => phase === "done" || phase === "failed" || phase === "cancelled";

/**
 * The jobs read back at start. A scan waiting for its confirm uploaded nothing and is gone with the quit; an import
 * still running when Parrot quit cannot resume (its scan lived in memory), so it shows as failed, interrupted.
 */
export const restoreImportJobs = (stored: unknown, now: number): StoredImportJob[] => {
  if (!Array.isArray(stored)) return [];
  return (stored as StoredImportJob[])
    .filter((job) => job.status.phase !== "review")
    .map((job) =>
      importEnded(job.status.phase)
        ? job
        : { ...job, finishedAt: job.finishedAt ?? now, status: { ...job.status, running: false, phase: "failed", currentFile: null, error: IMPORT_INTERRUPTED } }
    );
};

/**
 * The error a stopped import records. Closing Parrot aborts the import and closes the light-copy encoder window, so
 * the import ends on that abort or on "the encoder window closed": both are Parrot closing, not a fault in the import.
 */
export const importStopError = (error: unknown, appClosing: boolean): string =>
  appClosing ? IMPORT_INTERRUPTED : error instanceof Error ? error.message : String(error);

/**
 * UX-JOBS-03: what "Import again" reads. A stopped import starts over from its folders (the songs it already added
 * come back as "already there"); an import that ended with some files not added tries only those files.
 */
export const retrySources = (job: ParrotImportJob): string[] =>
  job.status.phase === "failed" ? job.sources : job.failures.map((failure) => failure.file);

/**
 * UX-JOBS-03: the job as the window gets it, saying whether every file "Import again" would read is gone from where
 * it was (moved, renamed or deleted, or a drive unplugged): then the card offers "Find the folder" instead.
 */
export const withSourcesMissing = (job: ParrotImportJob, exists: (path: string) => boolean): ParrotImportJob =>
  importJobRetryable(job) ? { ...job, sourcesMissing: retrySources(job).every((path) => !exists(path)) } : job;

/**
 * UX-JOBS-01: the import jobs list main keeps in userData/import-jobs.json, and how an import cut short by Parrot
 * closing is recorded: failed, with IMPORT_INTERRUPTED so the card says to import the folder again.
 */
import type { ParrotCoverImage, ParrotImportEdit } from "@space/parrot-ingest";
import { isTerminalIngestJobStatus, type IngestJobRecord } from "@space/runtime-jobs";
import {
  IMPORT_INTERRUPTED,
  importJobRetryable,
  type ParrotImportJob,
  type ParrotImportRow,
  type ParrotImportSong,
  type ParrotImportStatus,
} from "../shared/ipc";

export type StoredImportJob = ParrotImportJob & { userId: string };

export const importEnded = (phase: ParrotImportStatus["phase"]) => phase === "done" || phase === "failed" || phase === "cancelled";

/**
 * The jobs read back at start. A scan waiting for its confirm uploaded nothing and is gone with the quit; an import
 * still running when Parrot quit shows as failed, interrupted, until main resumes it from its jobs and its resume
 * record (PAR-UP-13: then it runs again); one main cannot resume stays so.
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

/**
 * UX-ADD-01: what a scan asked for does next. While an import runs or its scan waits in the review, songs dropped on
 * the window or picked with the "+" wait behind it, each source once, instead of being refused; once it has ended
 * (or its review was answered) they start the next scan, which stops at its own review. `dropped` is empty when main
 * asks whether the waiting sources may start now.
 */
export const nextImportSources = (
  status: Pick<ParrotImportStatus, "running" | "phase">,
  queued: readonly string[],
  dropped: readonly string[]
): { start: string[] | null; queued: string[] } => {
  const sources = [...new Set([...queued, ...dropped])];
  if (status.running || status.phase === "scanning" || status.phase === "review") return { start: null, queued: sources };
  return { start: sources.length > 0 ? sources : null, queued: [] };
};

/**
 * PAR-UP-13 / RT-LIFE-04: what an import's review decided, kept in userData/import-resume/<importId>.json while it
 * runs so its jobs resume after Parrot quits: the songs, the user's edits, the folders, the files the scan could not
 * read and the pictures an edit chose. The artist photos the review fetched are not kept (they are fetched again).
 */
export type ParrotImportResumeRecord = {
  version: 1;
  importId: string;
  userId: string;
  files: string[];
  edits: Array<[string, ParrotImportEdit]>;
  folders: string[];
  unreadable: Array<{ file: string; error: string }>;
  pictures: Record<string, { mime: string; base64: string }>;
};

/** The resume record read back: maps again, pictures as bytes. */
export type ParrotImportResume = {
  importId: string;
  userId: string;
  files: string[];
  edits: Map<string, ParrotImportEdit>;
  folders: string[];
  unreadable: Array<{ file: string; error: string }>;
  pictures: Map<string, ParrotCoverImage>;
};

export const importResumeRecord = (input: {
  importId: string;
  userId: string;
  files: string[];
  edits: ReadonlyMap<string, ParrotImportEdit>;
  folders: string[];
  unreadable: Array<{ file: string; error: string }>;
  pictures: ReadonlyMap<string, ParrotCoverImage>;
}): ParrotImportResumeRecord => {
  const pictures: ParrotImportResumeRecord["pictures"] = {};
  for (const edit of input.edits.values()) {
    const picture = edit.coverPicture ? input.pictures.get(edit.coverPicture) : undefined;
    if (edit.coverPicture && picture) pictures[edit.coverPicture] = { mime: picture.mime, base64: Buffer.from(picture.bytes).toString("base64") };
  }
  return {
    version: 1,
    importId: input.importId,
    userId: input.userId,
    files: [...input.files],
    edits: [...input.edits],
    folders: [...input.folders],
    unreadable: [...input.unreadable],
    pictures,
  };
};

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The record as written by importResumeRecord, or null when it is not one (another version, a half-written file). */
export const readImportResume = (stored: unknown): ParrotImportResume | null => {
  if (!stored || typeof stored !== "object") return null;
  const record = stored as Partial<ParrotImportResumeRecord>;
  if (record.version !== 1 || typeof record.importId !== "string" || typeof record.userId !== "string") return null;
  if (!isStringList(record.files) || !isStringList(record.folders) || !Array.isArray(record.edits) || !Array.isArray(record.unreadable)) return null;
  if (!record.pictures || typeof record.pictures !== "object") return null;
  const pictures = new Map<string, ParrotCoverImage>();
  for (const [key, picture] of Object.entries(record.pictures)) pictures.set(key, { mime: picture.mime, bytes: new Uint8Array(Buffer.from(picture.base64, "base64")) });
  return {
    importId: record.importId,
    userId: record.userId,
    files: record.files,
    edits: new Map(record.edits),
    folders: record.folders,
    unreadable: record.unreadable,
    pictures,
  };
};

const parrotPayload = (job: IngestJobRecord) => job.payload as { userId?: unknown; importId?: unknown; file?: unknown; index?: unknown };

/**
 * PAR-UP-13: which import resumes at start. Only this account's Parrot imports with a job not ended count; the newest
 * of them whose resume record is still there resumes (all its jobs, so the ended songs count too); every other one
 * has its unfinished jobs dropped (cancelled): its review is gone, and the jobs panel says to import it again.
 */
export const resumePlan = (
  jobs: readonly IngestJobRecord[],
  userId: string,
  hasResume: (importId: string) => boolean
): { resume: { importId: string; jobs: IngestJobRecord[] } | null; drop: IngestJobRecord[] } => {
  const groups = new Map<string, IngestJobRecord[]>();
  for (const job of jobs) {
    if (job.app !== "parrot" || parrotPayload(job).userId !== userId) continue;
    const group = groups.get(job.groupId) ?? [];
    group.push(job);
    groups.set(job.groupId, group);
  }
  const unfinished = [...groups].filter(([, group]) => group.some((job) => !isTerminalIngestJobStatus(job.status)));
  const newest = (group: IngestJobRecord[]) => group.reduce((latest, job) => (job.createdAt > latest ? job.createdAt : latest), "");
  unfinished.sort(([, a], [, b]) => newest(b).localeCompare(newest(a)));
  const resumed = unfinished.find(([importId]) => hasResume(importId)) ?? null;
  return {
    resume: resumed ? { importId: resumed[0], jobs: resumed[1] } : null,
    drop: unfinished.filter((entry) => entry !== resumed).flatMap(([, group]) => group.filter((job) => !isTerminalIngestJobStatus(job.status))),
  };
};

/**
 * UX-JOBS-02: the running import's songs for the Jobs panel, in import order: each song's own job and its light copy.
 * A waiting job's place in line counts the waiting jobs of its kind before it (the engine starts them in that order).
 */
export const importSongRows = (jobs: readonly IngestJobRecord[]): ParrotImportSong[] => {
  const index = (job: IngestJobRecord) => Number(parrotPayload(job).index ?? 0);
  const sorted = [...jobs].sort((a, b) => index(a) - index(b));
  const places = new Map<string, number>();
  for (const kind of ["source", "format"]) {
    let place = 0;
    for (const job of sorted) if (job.kind === kind && job.status === "queued") places.set(job.jobId, ++place);
  }
  const row = (job: IngestJobRecord): ParrotImportRow => ({
    jobId: job.jobId,
    status: job.status,
    stage: job.stageCode,
    progressPct: job.progressPct,
    placeInLine: places.get(job.jobId) ?? null,
    error: job.errorMessage,
  });
  const songs = new Map<number, ParrotImportSong>();
  for (const job of sorted) {
    if (job.kind !== "source") continue;
    songs.set(index(job), { file: String(parrotPayload(job).file ?? ""), source: row(job), light: null });
  }
  for (const job of sorted) {
    const song = job.kind === "format" ? songs.get(index(job)) : undefined;
    if (song) song.light = row(job);
  }
  return [...songs.values()];
};

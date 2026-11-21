/**
 * OFFL-FILE-01, ACCT-EXPORT-01 (Chris 2026-11-21): "Download everything" saves the whole library as plain audio files
 * into a folder the user picks, in the background, one export at a time. The list is kept in
 * userData/export-jobs.json so the Jobs panel still shows ended exports after a restart, and an export Parrot's
 * closing cut short goes on at the next start with the songs it had not saved yet. The saved files are the user's:
 * nothing here tracks them once they are written.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  PARROT_EXPORT_SPARE_BYTES,
  ParrotExportNoSpaceError,
  type ParrotExportProgress,
  type ParrotExportResult,
  type ParrotExportSong,
  type ParrotLibraryDb,
} from "@space/parrot-ingest";
import {
  EXPORT_FOLDER_MISSING,
  EXPORT_NO_SPACE,
  type ParrotExportJob,
  type ParrotExportPreview,
  type ParrotExportStart,
} from "../shared/ipc";

/** One export as kept on disk: whose it is, and the songs already in the folder (a resumed export skips them). */
export type StoredExportJob = ParrotExportJob & { userId: string; doneTrackIds: string[] };

/** Writes `songs` under `dest` (main binds `exportParrotSongs` to the library, its key and the chunk reader). */
export type ParrotExportRun = (input: {
  /** The library the songs were listed from; main holds it open for the run. */
  db: ParrotLibraryDb;
  songs: readonly ParrotExportSong[];
  dest: string;
  signal: AbortSignal;
  onProgress?: (progress: ParrotExportProgress) => void;
  onSongDone?: (trackId: string) => void;
}) => Promise<ParrotExportResult>;

export type ParrotExportJobsDeps = {
  /** userData/export-jobs.json */
  file: string;
  /** The signed-in account; '' when signed out. */
  userId: () => string;
  db: () => ParrotLibraryDb | null;
  listSongs: (db: ParrotLibraryDb) => ParrotExportSong[];
  /** The folder dialog; null when the user closed it. */
  pickFolder: () => Promise<string | null>;
  freeBytes: (dir: string) => Promise<number>;
  folderExists?: (dir: string) => boolean;
  run: ParrotExportRun;
  /** Sends the account's list to the window. */
  emit: (jobs: ParrotExportJob[]) => void;
  log: (line: string) => void;
  now?: () => number;
};

export type ParrotExportJobs = {
  preview: () => ParrotExportPreview;
  start: () => Promise<ParrotExportStart>;
  list: () => ParrotExportJob[];
  cancel: (id: string) => ParrotExportJob[];
  dismiss: (id: string) => ParrotExportJob[];
  /** Queues the signed-in account's exports Parrot's closing cut short; call once its library is open. */
  resume: () => void;
  /** Settles once no export runs or waits. */
  idle: () => Promise<void>;
  /**
   * Stops the running export without ending it (quit, sign-out, the library closing): it waits as "queued", and
   * `resume` goes on with the songs it had not saved yet.
   */
  pause: () => void;
};

const EXPORT_JOBS_KEPT = 50;
/** Progress reaches the window at most this often; a song's end and a job's end always do. */
const EMIT_EVERY_MS = 250;

const ended = (phase: ParrotExportJob["phase"]) => phase === "done" || phase === "failed" || phase === "cancelled";

const restore = (file: string, log: (line: string) => void): StoredExportJob[] => {
  if (!existsSync(file)) return [];
  try {
    const stored = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(stored) ? (stored as StoredExportJob[]) : [];
  } catch (error) {
    log(`[export] jobs list unreadable, starting empty: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
};

export const createParrotExportJobs = (deps: ParrotExportJobsDeps): ParrotExportJobs => {
  const now = deps.now ?? Date.now;
  const folderExists = deps.folderExists ?? existsSync;
  let jobs = restore(deps.file, deps.log);
  let current: { job: StoredExportJob; abort: AbortController } | null = null;
  let pumping: Promise<void> = Promise.resolve();
  let paused = false;
  let lastEmit = 0;

  const view = ({ userId: _userId, doneTrackIds: _done, ...job }: StoredExportJob): ParrotExportJob => job;
  const mine = () => jobs.filter((job) => job.userId === deps.userId());
  const list = () => mine().map(view);

  const save = () => {
    try {
      writeFileSync(deps.file, JSON.stringify(jobs));
    } catch (error) {
      deps.log(`[export] jobs list not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const send = (persist: boolean) => {
    if (persist) save();
    lastEmit = now();
    deps.emit(list());
  };

  const finish = (job: StoredExportJob, phase: "done" | "failed" | "cancelled", error: string | null) => {
    job.phase = phase;
    job.error = error;
    job.current = null;
    job.finishedAt = now();
    deps.log(`[export] job ${job.id} ${phase}${error ? ` (${error})` : ""}: ${job.doneSongs}/${job.totalSongs} songs, ${job.failures.length} failed`);
  };

  const runOne = async (job: StoredExportJob) => {
    const db = deps.db();
    if (!db) {
      // Signed out or the library closed meanwhile: the export waits for the next start.
      deps.log(`[export] job ${job.id} waits: no library open`);
      return;
    }
    if (!folderExists(job.dest)) {
      finish(job, "failed", EXPORT_FOLDER_MISSING);
      send(true);
      return;
    }
    const done = new Set(job.doneTrackIds);
    const songs = deps.listSongs(db).filter((song) => !done.has(song.trackId));
    const abort = new AbortController();
    current = { job, abort };
    job.phase = "running";
    const baseSongs = job.doneSongs;
    const baseBytes = job.doneBytes;
    send(true);
    deps.log(`[export] job ${job.id} runs ${songs.length} song(s) into ${job.dest} (${done.size} saved before)`);
    try {
      const result = await deps.run({
        db,
        songs,
        dest: job.dest,
        signal: abort.signal,
        onProgress: (progress) => {
          job.doneBytes = baseBytes + progress.doneBytes;
          job.current = progress.current;
          if (now() - lastEmit >= EMIT_EVERY_MS) send(false);
        },
        onSongDone: (trackId) => {
          job.doneTrackIds.push(trackId);
          job.doneSongs = baseSongs + job.doneTrackIds.length - done.size;
          send(true);
        },
      });
      const titles = new Map(songs.map((song) => [song.trackId, song.title]));
      job.failures.push(...result.failed.map((each) => ({ title: titles.get(each.trackId) ?? each.title, reason: each.reason })));
      if (paused) return requeue(job);
      if (result.stopped === "cancelled") finish(job, "cancelled", null);
      else if (result.stopped === "no-space") finish(job, "failed", EXPORT_NO_SPACE);
      else finish(job, "done", null);
    } catch (error) {
      if (paused) return requeue(job);
      const reason = error instanceof ParrotExportNoSpaceError ? EXPORT_NO_SPACE : error instanceof Error ? error.message : String(error);
      finish(job, abort.signal.aborted ? "cancelled" : "failed", abort.signal.aborted ? null : reason);
    } finally {
      current = null;
      if (!paused) send(true);
    }
  };

  /** A paused export waits for `resume`; its saved songs are in the list already. */
  const requeue = (job: StoredExportJob) => {
    job.phase = "queued";
    job.current = null;
    deps.log(`[export] job ${job.id} paused after ${job.doneSongs}/${job.totalSongs} songs`);
    send(true);
  };

  /** Runs the waiting exports, oldest first, one at a time. */
  const pump = () => {
    pumping = pumping.then(async () => {
      for (;;) {
        if (paused) return;
        const next = mine()
          .filter((job) => job.phase === "queued")
          .at(-1);
        if (!next) return;
        await runOne(next);
        if (next.phase === "queued" || next.phase === "running") return;
      }
    });
    return pumping;
  };

  const preview = (): ParrotExportPreview => {
    const db = deps.db();
    const songs = db ? deps.listSongs(db) : [];
    return { songs: songs.length, bytes: songs.reduce((sum, song) => sum + song.sizeBytes, 0) };
  };

  const start = async (): Promise<ParrotExportStart> => {
    const db = deps.db();
    if (!db) return { ok: false, reason: "no-library" };
    const songs = deps.listSongs(db);
    if (songs.length === 0) return { ok: false, reason: "empty" };
    const dest = await deps.pickFolder();
    if (!dest) return { ok: false, reason: "no-folder" };
    const totalBytes = songs.reduce((sum, song) => sum + song.sizeBytes, 0);
    const free = await deps.freeBytes(dest);
    if (free < totalBytes + PARROT_EXPORT_SPARE_BYTES) {
      deps.log(`[export] refused: ${totalBytes} bytes into ${dest}, ${free} free`);
      return { ok: false, reason: "no-space", neededBytes: totalBytes + PARROT_EXPORT_SPARE_BYTES, freeBytes: free };
    }
    const job: StoredExportJob = {
      id: randomUUID(),
      userId: deps.userId(),
      dest,
      startedAt: now(),
      finishedAt: null,
      phase: "queued",
      doneSongs: 0,
      totalSongs: songs.length,
      doneBytes: 0,
      totalBytes,
      current: null,
      error: null,
      failures: [],
      doneTrackIds: [],
    };
    jobs = [job, ...jobs].slice(0, EXPORT_JOBS_KEPT);
    deps.log(`[export] job ${job.id} queued: ${songs.length} song(s), ${totalBytes} bytes into ${dest}`);
    send(true);
    void pump();
    return { ok: true, job: view(job) };
  };

  const cancel = (id: string): ParrotExportJob[] => {
    const job = mine().find((entry) => entry.id === id);
    if (job && current?.job === job) current.abort.abort();
    else if (job && job.phase === "queued") {
      finish(job, "cancelled", null);
      send(true);
    }
    return list();
  };

  const dismiss = (id: string): ParrotExportJob[] => {
    const job = mine().find((entry) => entry.id === id);
    if (job && ended(job.phase)) {
      jobs = jobs.filter((entry) => entry !== job);
      send(true);
    }
    return list();
  };

  const resume = () => {
    paused = false;
    const cut = mine().filter((job) => job !== current?.job && (job.phase === "running" || job.phase === "queued"));
    if (cut.length === 0) return;
    for (const job of cut) job.phase = "queued";
    deps.log(`[export] resuming ${cut.length} export(s)`);
    send(true);
    void pump();
  };

  const idle = async () => {
    for (;;) {
      const seen = pumping;
      await seen;
      if (seen === pumping) return;
    }
  };

  const pause = () => {
    paused = true;
    current?.abort.abort();
  };

  return { preview, start, list, cancel, dismiss, resume, idle, pause };
};

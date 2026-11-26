/**
 * @test-id PARROT-DESKTOP-EXPORT-JOBS-001
 * @level unit (main's export queue: start checks, one export at a time, cancel, the list kept in userData, resume)
 * @why OFFL-FILE-01, ACCT-EXPORT-01 (Chris 2026-11-21): "Download everything" (Settings, the only export) saves the
 *   whole library as plain files into a folder the user picks, in the background. Nothing starts without a folder or
 *   without room on its disk (OFFL-SAFE-02); an export Parrot's closing cut short goes on at the next start with the
 *   songs not yet saved.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ParrotExportResult, ParrotExportSong } from "@space/parrot-ingest";
import { createParrotExportJobs, type ParrotExportJobs, type ParrotExportRun } from "../src/main/exportJobs";
import { EXPORT_FOLDER_MISSING, EXPORT_NO_SPACE, type ParrotExportJob } from "../src/shared/ipc";

const SUITE = "[PARROT-DESKTOP-EXPORT-JOBS-001]";
const log = (message: string, detail?: unknown) => console.log(`${SUITE} ${message}`, detail === undefined ? "" : JSON.stringify(detail));

const song = (trackId: string, albumId: string, sizeBytes = 1000): ParrotExportSong => ({
  trackId,
  fileId: `f-${trackId}`,
  albumId,
  title: `Song ${trackId}`,
  artist: "Nina Simone",
  albumArtist: "Nina Simone",
  album: `Album ${albumId}`,
  number: 1,
  disc: null,
  discCount: 1,
  albumTrackCount: 1,
  year: null,
  genre: null,
  sizeBytes,
  coverObjectKey: null,
});

const LIBRARY = [song("a1", "al-a"), song("a2", "al-a"), song("b1", "al-b")];

/** Lets queued promise callbacks run; the queue writes its list with sync fs calls, so no real time passes. */
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

type Harness = {
  jobs: ParrotExportJobs;
  file: string;
  emitted: ParrotExportJob[][];
  runs: Array<{ dest: string; trackIds: string[] }>;
  picks: () => number;
  /** Lets the song the fake run waits on finish. */
  release: () => Promise<void>;
  /** Every song from now on finishes at once. */
  releaseAll: () => void;
};

const harness = (
  opts: {
    folder?: string | null;
    free?: number;
    user?: string;
    file?: string;
    run?: ParrotExportRun;
    exists?: (dir: string) => boolean;
    library?: ParrotExportSong[];
    onEnded?: (job: ParrotExportJob) => void;
  } = {},
): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "parrot-export-jobs-"));
  const file = opts.file ?? join(dir, "export-jobs.json");
  const emitted: ParrotExportJob[][] = [];
  const runs: Array<{ dest: string; trackIds: string[] }> = [];
  let picks = 0;
  let auto = false;
  const gates: Array<() => void> = [];
  const gate = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (auto) resolve();
    else gates.push(resolve);
    return promise;
  };
  const defaultRun: ParrotExportRun = async ({ songs, dest, signal, onProgress, onSongDone }) => {
    runs.push({ dest, trackIds: songs.map((each) => each.trackId) });
    const result: ParrotExportResult = { written: [], failed: [], stopped: null };
    for (const each of songs) {
      // Each song waits for `release()`, so the test sees the job running.
      await gate();
      if (signal.aborted) {
        result.stopped = "cancelled";
        break;
      }
      onProgress?.({ doneSongs: result.written.length, totalSongs: songs.length, doneBytes: 0, totalBytes: 0, failed: 0, current: each.title });
      result.written.push({ trackId: each.trackId, path: join(dest, each.trackId) });
      onSongDone?.(each.trackId);
    }
    return result;
  };
  const jobs = createParrotExportJobs({
    file,
    userId: () => opts.user ?? "u1",
    db: () => ({}) as never,
    listSongs: (_db) => opts.library ?? LIBRARY,
    pickFolder: async () => {
      picks += 1;
      return opts.folder === undefined ? "/media/stick/Music" : opts.folder;
    },
    freeBytes: async () => opts.free ?? 10 ** 12,
    folderExists: opts.exists ?? (() => true),
    run: opts.run ?? defaultRun,
    emit: (list) => emitted.push(list),
    onEnded: opts.onEnded,
    log: (line) => log(line),
  });
  const release = async () => {
    await flush();
    gates.shift()?.();
    await flush();
  };
  const releaseAll = () => {
    auto = true;
    for (const open of gates.splice(0)) open();
  };
  return { jobs, file, emitted, runs, picks: () => picks, release, releaseAll };
};

const drain = async (h: Harness) => {
  h.releaseAll();
  await h.jobs.idle();
};

describe("Parrot export jobs", () => {
  it("previews the songs and bytes of the whole library, highest quality as listed", () => {
    const h = harness();
    const preview = h.jobs.preview();
    log("preview", preview);
    expect(preview).toEqual({ songs: 3, bytes: 3000 });
  });

  it("does not ask for a folder when there is nothing to save, and stops when no folder is picked", async () => {
    const empty = harness({ library: [] });
    const none = await empty.jobs.start();
    log("empty", { none, picks: empty.picks() });
    expect(none).toEqual({ ok: false, reason: "empty" });
    expect(empty.picks()).toBe(0);

    const cancelled = harness({ folder: null });
    const result = await cancelled.jobs.start();
    log("no folder", result);
    expect(result).toEqual({ ok: false, reason: "no-folder" });
    expect(cancelled.jobs.list()).toEqual([]);
  });

  it("refuses to start without room for every song plus the spare (OFFL-SAFE-02)", async () => {
    const h = harness({ free: 2000 });
    const result = await h.jobs.start();
    log("no space", result);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "no-space", freeBytes: 2000 });
    expect(h.runs).toEqual([]);
  });

  it("runs one export at a time and keeps the list in userData", async () => {
    const h = harness();
    const first = await h.jobs.start();
    const second = await h.jobs.start();
    log("started", { first, second, list: h.jobs.list().map((job) => [job.id, job.phase]) });
    expect(first.ok && second.ok).toBe(true);
    expect(h.jobs.list().map((job) => job.phase)).toEqual(["queued", "running"]);
    await drain(h);
    const list = h.jobs.list();
    log("ended", list);
    expect(h.runs.map((run) => run.trackIds)).toEqual([
      ["a1", "a2", "b1"],
      ["a1", "a2", "b1"],
    ]);
    expect(list.map((job) => [job.phase, job.doneSongs, job.totalSongs])).toEqual([
      ["done", 3, 3],
      ["done", 3, 3],
    ]);
    const saved = JSON.parse(readFileSync(h.file, "utf8"));
    log("saved", saved);
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ userId: "u1", doneTrackIds: ["a1", "a2", "b1"], phase: "done" });
    expect(h.emitted.length).toBeGreaterThan(2);
  });

  it("cancels the running export and a waiting one; the saved songs stay", async () => {
    const h = harness();
    const running = await h.jobs.start();
    const waiting = await h.jobs.start();
    if (!running.ok || !waiting.ok) throw new Error("did not start");
    await h.release();
    h.jobs.cancel(waiting.job.id);
    h.jobs.cancel(running.job.id);
    await drain(h);
    const list = h.jobs.list();
    log("cancelled", list);
    expect(list.map((job) => [job.id, job.phase, job.doneSongs])).toEqual([
      [waiting.job.id, "cancelled", 0],
      [running.job.id, "cancelled", 1],
    ]);
    expect(h.runs).toHaveLength(1);
    h.jobs.dismiss(waiting.job.id);
    expect(h.jobs.list().map((job) => job.id)).toEqual([running.job.id]);
  });

  it("pauses at sign-out or quit and goes on with the songs not yet saved", async () => {
    const h = harness();
    const started = await h.jobs.start();
    if (!started.ok) throw new Error("did not start");
    await h.release();
    h.jobs.pause();
    await h.release();
    await h.jobs.idle();
    log("paused", h.jobs.list());
    expect(h.jobs.list()[0]).toMatchObject({ phase: "queued", doneSongs: 1 });
    h.jobs.resume();
    await drain(h);
    log("resumed", { runs: h.runs, list: h.jobs.list() });
    expect(h.runs.map((run) => run.trackIds)).toEqual([["a1", "a2", "b1"], ["a2", "b1"]]);
    expect(h.jobs.list()[0]).toMatchObject({ phase: "done", doneSongs: 3 });
  });

  it("reports failed songs by title and a disk that filled up as no-space", async () => {
    const h = harness({
      run: async ({ songs, onSongDone }) => {
        onSongDone?.(songs[0]!.trackId);
        return { written: [{ trackId: songs[0]!.trackId, path: "x" }], failed: [{ trackId: songs[1]!.trackId, title: songs[1]!.title, reason: "storage unreachable" }], stopped: "no-space" };
      },
    });
    await h.jobs.start();
    await h.jobs.idle();
    const [job] = h.jobs.list();
    log("job", job);
    expect(job).toMatchObject({ phase: "failed", error: EXPORT_NO_SPACE, failures: [{ title: "Song a2", reason: "storage unreachable" }] });
  });

  // @req UX-NOTICE-06[parrot]: main hears each export end once, for the system notification while the window is hidden.
  it("tells main once when each export ends: done, failed or cancelled", async () => {
    const ended: Array<[string, string]> = [];
    const done = harness({ onEnded: (job) => ended.push([job.phase, job.dest]) });
    await done.jobs.start();
    await drain(done);
    const noSpace = harness({
      onEnded: (job) => ended.push([job.phase, job.dest]),
      run: async () => ({ written: [], failed: [], stopped: "no-space" }),
    });
    await noSpace.jobs.start();
    await noSpace.jobs.idle();
    const cancelled = harness({ onEnded: (job) => ended.push([job.phase, job.dest]) });
    const started = await cancelled.jobs.start();
    if (!started.ok) throw new Error("did not start");
    cancelled.jobs.cancel(started.job.id);
    await drain(cancelled);
    log("ended", ended);
    expect(ended.map(([phase]) => phase)).toEqual(["done", "failed", "cancelled"]);
    expect(ended[0]![1]).toBe("/media/stick/Music");
  });

  it("goes on at the next start with the songs not yet saved, for that account only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "parrot-export-resume-"));
    const file = join(dir, "export-jobs.json");
    const cut: ParrotExportJob & { userId: string; doneTrackIds: string[] } = {
      id: "j1",
      userId: "u1",
      dest: "/media/stick/Music",
      startedAt: 1,
      finishedAt: null,
      phase: "running",
      doneSongs: 1,
      totalSongs: 3,
      doneBytes: 1000,
      totalBytes: 3000,
      current: "Song a2",
      error: null,
      failures: [],
      doneTrackIds: ["a1"],
    };
    const gone = { ...cut, id: "j2", dest: "/media/gone", phase: "queued" as const, doneSongs: 0, doneTrackIds: [] };
    const other = { ...cut, id: "j3", userId: "u2" };
    writeFileSync(file, JSON.stringify([cut, gone, other]));
    const h = harness({ file, exists: (path) => path !== "/media/gone" });
    log("restored", h.jobs.list());
    expect(h.jobs.list().map((job) => job.id)).toEqual(["j1", "j2"]);
    h.jobs.resume();
    await drain(h);
    const list = h.jobs.list();
    log("resumed", { runs: h.runs, list });
    expect(h.runs).toEqual([{ dest: "/media/stick/Music", trackIds: ["a2", "b1"] }]);
    expect(list.find((job) => job.id === "j1")).toMatchObject({ phase: "done", doneSongs: 3, totalSongs: 3 });
    expect(list.find((job) => job.id === "j2")).toMatchObject({ phase: "failed", error: EXPORT_FOLDER_MISSING });
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).find((job: { id: string }) => job.id === "j3")).toMatchObject({ userId: "u2", phase: "running" });
  });
});

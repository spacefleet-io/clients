/**
 * @level integration
 * @bugfix @regression-proof issue #25 P16 (data loss: storage GC deleted the
 * uploaded-but-uncommitted segments of requeued engineV2 jobs).
 *
 * Confirm run 1791373829836: format jobs were SIGTERMed (stack restarts) and
 * requeued. A job whose upload step had finished kept `uploaded=true` for
 * every object in its job_state, but its commit step had not run. On restart
 * the startup storage GC saw those objects as unreferenced and deleted them
 * (`badger.storage.gc.run` missingKeys 722/921/654). The requeued upload step
 * trusted `uploaded=true`, skipped them, the commit pointed the library at
 * deleted keys and playback failed with `source_missing`.
 *
 * This drives the real pieces end to end against one in-memory object store:
 *   1. `uploadProducedMedia` is SIGTERMed mid-upload (its objects are left
 *      behind unreferenced), the requeued run finishes the upload step, then
 *      the runtime is SIGTERMed again before the commit step.
 *   2. "Restart": the startup GC and the user-triggered GC run, both while
 *      the engine still reports the requeued job and, on another device that
 *      cannot see that job, with no unfinished engine job at all.
 *   3. The requeued upload step runs again; every key the commit would write
 *      must exist in the store.
 * A second case deletes uploaded objects behind the job's back (a GC from an
 * older client) and requires the requeued upload step to heal them.
 *
 * @bugfix @regression-proof issue #25 (CI flake, run 9097: "expected [] to
 * have a length of 11"). The SIGTERM is an in-process abort, so the killed
 * run's in-flight uploads kept running after `uploadProducedMedia` rejected
 * and their job_state saves could land after the requeued run's, clobbering
 * it with the dead run's stale state. A real SIGTERM writes nothing after the
 * kill, so the dead run now uploads under its own token, the fake refuses its
 * uploads after the SIGTERM however late they arrive, its store drops every
 * save issued after the SIGTERM, and the requeued run starts only once the
 * saves issued before it have landed. The upload that triggers the SIGTERM
 * returns only after the requeued run finished (the worst ordering CI hit,
 * every time), which proves no late write from the dead run reaches job_state.
 */
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResumableJobStateStore, loadJobStateSync } from "@space/content-core";
import {
  configureMediaIngestRuntime,
  uploadProducedMedia,
  type ProducedMedia,
} from "@space/ingest-core/mediaProcessor";
import type { LibrarySnapshot } from "@space/shared/libraryTypes";
import { BadgerModule } from "../src/modules/badger";

const SUITE = "badger-gc-resume-heals-after-sigterm";
const USER_ID = "u-p16";
const JOB_ID = "j-format-360p";
const PLACEMENT_ID = "placement-p16-media";
const SEGMENTS = 10;
// The 360p format job of the confirm run: one video output, its own job.
const OUTPUT_IDS = ["video-360p-h264"] as const;
const VARIANT = "360p";
// An already-committed title (referenced by the library) and a genuine
// orphan, both uploaded a month ago: the GC is live and does reclaim.
const COMMITTED_KEYS = ["lib-title-init", "lib-title-seg-1"];
const OLD_ORPHAN_KEY = "old-orphan-from-cancelled-ingest";
const A_MONTH_AGO = Date.now() - 30 * 24 * 60 * 60 * 1000;

type GcInternals = { tryBackgroundGc(trigger: "startup" | "interval"): Promise<void> };

/** Encoded-but-not-uploaded job state, as `produceMediaOutputs` leaves it. */
const seedEncodedJob = async (jobDir: string) => {
  const outputs = [];
  for (const id of OUTPUT_IDS) {
    const kind = id.startsWith("audio") ? "audio" : "video";
    const outputDir = join(jobDir, "outputs", id);
    await fs.mkdir(outputDir, { recursive: true });
    const initPath = join(outputDir, "init-0.mp4");
    await fs.writeFile(initPath, Buffer.from(`init-${id}`));
    const segments = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const segPath = join(outputDir, `seg-${String(i + 1).padStart(5, "0")}.m4s`);
      await fs.writeFile(segPath, Buffer.from(`seg-${id}-${i}-${"x".repeat(256)}`));
      segments.push({ path: segPath, startSeconds: i * 12, uploaded: false });
    }
    outputs.push({
      id,
      kind,
      quality: kind === "video" ? "360p" : "audio",
      codec: kind === "video" ? "h264" : "aac",
      codecString: kind === "video" ? "avc1.640028" : "mp4a.40.2",
      segmentSeconds: 12,
      outputDir,
      init: { path: initPath },
      segments,
      durationSeconds: SEGMENTS * 12,
      encodingComplete: true,
      ...(kind === "audio" ? { language: "eng", label: "Main" } : {}),
    });
  }
  const state = {
    version: 1,
    inputPath: "/tmp/movie.mkv",
    userId: USER_ID,
    createdAt: new Date().toISOString(),
    outputs,
    subtitles: [],
  };
  await fs.writeFile(join(jobDir, "job_state.json"), JSON.stringify(state, null, 2));
};

const committedKeysOf = (produced: ProducedMedia) => [
  ...produced.videoFormats.flatMap((f) => [f.initKey, ...f.chunks.map((c) => c.key)]),
  ...produced.audioTracks.flatMap((t) => [t.initKey, ...t.chunks.map((c) => c.key)]),
];

// job_state.json plus the upload ledger: finished chunks are appended to the
// ledger and only folded into job_state.json by a full save (issue #671, R7).
const readPersistedUploadedKeys = async (jobDir: string) => {
  const state = loadJobStateSync<{
    outputs: Array<{ init: { uploaded?: boolean; key?: string }; segments: Array<{ uploaded?: boolean; key?: string }> }>;
  }>(join(jobDir, "job_state.json"))!;
  return state.outputs.flatMap((o) => [o.init, ...o.segments]).filter((s) => s.uploaded && s.key).map((s) => s.key as string);
};

describe(`[${SUITE}] SIGTERM during ingest → restart → GC → requeued upload → commit`, () => {
  let root = "";
  let jobDir = "";
  /** The vault: object key → last upload time (ms). */
  let store: Map<string, number>;
  let deletedByGc: string[];
  let uploads: string[];
  let headCalls: string[][];
  let gcLogLines: string[];
  let abortAfterUploads: number;
  /** Releases the upload that delivered the SIGTERM (it hangs until then). */
  let releaseSigtermUpload: (() => void) | null;
  /**
   * The run that gets SIGTERMed. Its uploads carry its own token, so the fake
   * refuses them after the kill however late they arrive (an in-flight upload
   * of the dead run must not land during the requeued run).
   */
  let killedRun: { token: string; controller: AbortController } | null;
  const mods: BadgerModule[] = [];

  beforeEach(async () => {
    process.env.BADGER_GC_INTERVAL_MS = "0";
    root = mkdtempSync(join(tmpdir(), "sf-p16-gc-resume-"));
    jobDir = join(root, "jobs", USER_ID, JOB_ID);
    await seedEncodedJob(jobDir);
    store = new Map([...COMMITTED_KEYS, OLD_ORPHAN_KEY].map((key) => [key, A_MONTH_AGO]));
    deletedByGc = [];
    uploads = [];
    headCalls = [];
    gcLogLines = [];
    abortAfterUploads = Number.POSITIVE_INFINITY;
    releaseSigtermUpload = null;
    killedRun = null;
    console.info(`[${SUITE}:setup] root=${root} jobDir=${jobDir}`);

    configureMediaIngestRuntime({
      resolveJobDir: (userId: string, jobId: string) => join(root, "jobs", userId, jobId),
      encryptMediaObject: (bytes: Buffer) => bytes,
      uploadStorageObject: async (token: string, key: string) => {
        const run = killedRun?.token === token ? killedRun : null;
        // A killed process uploads nothing more.
        if (run?.controller.signal.aborted) throw new Error("CANCELLED");
        store.set(key, Date.now());
        uploads.push(key);
        if (run && uploads.length >= abortAfterUploads) {
          console.info(`[${SUITE}] SIGTERM after upload #${uploads.length} (${key}); this upload returns only after the requeued run`);
          run.controller.abort(new Error("SIGTERM"));
          await new Promise<void>((resolve) => {
            releaseSigtermUpload = resolve;
          });
          console.info(`[${SUITE}] SIGTERM upload ${key} released`);
        }
        return key;
      },
      headStorageObjects: async (_token: string, keys: string[]) => {
        headCalls.push([...keys]);
        return Object.fromEntries(keys.map((key) => [key, store.has(key)]));
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        console.info(`[${SUITE}] fetch ${init?.method ?? "GET"} ${url}`);
        const keys = [...store.keys()];
        if (url.endsWith("/storage/objects")) return Response.json({ keys });
        if (url.endsWith("/storage/objects/by-app")) {
          return Response.json({
            keys,
            objects: keys.map((key) => ({ key, updatedAt: new Date(store.get(key) ?? 0).toISOString() })),
          });
        }
        if (url.endsWith("/storage/delete")) {
          const body = JSON.parse(String(init?.body)) as { keys: string[] };
          for (const key of body.keys) store.delete(key);
          deletedByGc.push(...body.keys);
          console.info(`[${SUITE}] /storage/delete keys=${JSON.stringify(body.keys)}`);
          return Response.json({ deleted: body.keys.length, reclaimedBytes: 0 });
        }
        if (url.endsWith("/storage/quota/reconcile")) return Response.json({ ok: true });
        throw new Error(`[${SUITE}] unexpected fetch ${url}`);
      }),
    );
    const realLog = console.log;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes("badger.storage.gc")) gcLogLines.push(line);
      realLog(...args);
    });
  });

  afterEach(() => {
    for (const mod of mods.splice(0)) mod.shutdown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.BADGER_GC_INTERVAL_MS;
    console.info(`[${SUITE}:teardown] removing root=${root}`);
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * SIGTERM mid-upload, requeued run completes the upload step, SIGTERM
   * before the commit step. Returns the keys job_state marked uploaded.
   */
  const uploadThenSigtermBeforeCommit = async (afterUploads: number) => {
    abortAfterUploads = afterUploads;
    const args = {
      token: "tok",
      userId: USER_ID,
      jobId: JOB_ID,
      placementId: PLACEMENT_ID,
      scope: "format" as const,
      variant: VARIANT,
    };
    const run = { token: "tok-killed-run", controller: new AbortController() };
    killedRun = run;
    // The killed run's own store. A killed process writes nothing after the
    // kill: saves issued after the SIGTERM are dropped; saves already started
    // are recorded so the requeued run starts only once they have landed.
    const deadRunStore = await ResumableJobStateStore.open<unknown>({ jobDir, inputPath: "", userId: USER_ID });
    const deadRunSignal = run.controller.signal;
    const deadRunSaves: Promise<void>[] = [];
    let droppedDeadRunSaves = 0;
    const realSave = deadRunStore.save.bind(deadRunStore);
    vi.spyOn(deadRunStore, "save").mockImplementation(() => {
      if (deadRunSignal.aborted) {
        droppedDeadRunSaves += 1;
        console.info(`[${SUITE}:sigterm] dead run job_state save #${droppedDeadRunSaves} after SIGTERM dropped`);
        return Promise.resolve();
      }
      const save = realSave();
      deadRunSaves.push(save);
      return save;
    });
    // A chunk finishing records itself by appending to the ledger, not by
    // save(): a killed process appends nothing either.
    const realRecord = deadRunStore.recordCompletedPart.bind(deadRunStore);
    vi.spyOn(deadRunStore, "recordCompletedPart").mockImplementation((...recordArgs) => {
      if (deadRunSignal.aborted) {
        droppedDeadRunSaves += 1;
        console.info(`[${SUITE}:sigterm] dead run ledger append #${droppedDeadRunSaves} after SIGTERM dropped`);
        return Promise.resolve();
      }
      const record = realRecord(...recordArgs);
      deadRunSaves.push(record);
      return record;
    });
    const firstRun = await uploadProducedMedia({
      ...args,
      token: run.token,
      stateStore: deadRunStore,
      signal: deadRunSignal,
    }).then(
      () => "completed",
      (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
    const leftBehind = [...store.keys()];
    await Promise.all(deadRunSaves);
    console.info(
      `[${SUITE}:sigterm] dead run settled: savesLanded=${deadRunSaves.length} savesDropped=${droppedDeadRunSaves} ` +
        `persistedAtDeath=${JSON.stringify(await readPersistedUploadedKeys(jobDir))}`,
    );
    abortAfterUploads = Number.POSITIVE_INFINITY;
    await uploadProducedMedia(args); // the requeued run: a fresh process, its own token
    const requeuedPersisted = await readPersistedUploadedKeys(jobDir);
    // The upload in flight at the SIGTERM completes now, after the requeued
    // run. Its continuation is microtasks only up to its job_state save, so
    // that save is issued (and dropped) before setImmediate fires; any save
    // that did start is awaited before job_state is read.
    releaseSigtermUpload?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.all(deadRunSaves);
    const persisted = await readPersistedUploadedKeys(jobDir);
    console.info(
      `[${SUITE}:sigterm] firstRun=${firstRun} leftBehindByFirstRun=${leftBehind.length} uploads=${uploads.length} ` +
        `deadRunSavesLanded=${deadRunSaves.length} deadRunSavesDropped=${droppedDeadRunSaves} ` +
        `requeuedPersisted=${requeuedPersisted.length} ` +
        `persistedUploaded=${JSON.stringify(persisted)} store=${store.size} — SIGTERM before commit`,
    );
    expect(firstRun).toMatch(/^rejected/);
    expect(persisted).toEqual(requeuedPersisted);
    expect(persisted).toHaveLength(OUTPUT_IDS.length * (SEGMENTS + 1));
    // The upload released after the requeued run did try to save: the late
    // write this case guards against was exercised, and it left no trace.
    expect(droppedDeadRunSaves).toBeGreaterThan(0);
    return persisted;
  };

  /** A restarted runtime: startup sweep, then the user-triggered GC. */
  const restartAndCollect = async (label: string, unfinishedEngineJobs: number) => {
    const mod = new BadgerModule({ countUnfinishedEngineJobs: async () => unfinishedEngineJobs });
    mods.push(mod);
    mod.setBackendToken("tok-gc-123456");
    vi.spyOn(mod.libraryDbService, "getSnapshot").mockReturnValue({
      media: [],
      playlists: [],
      mediaDetails: [
        {
          formats: [{ initKey: COMMITTED_KEYS[0], chunks: [{ key: COMMITTED_KEYS[1] }] }],
          audioTracks: [],
          subtitleTracks: [],
        },
      ],
    } as unknown as LibrarySnapshot);
    await (mod as unknown as GcInternals).tryBackgroundGc("startup");
    const manual = await mod.execute({
      requestId: `gc-${label}`,
      module: "badger",
      command: "badger.storage.gc",
      payload: { dryRun: false },
    });
    console.info(
      `[${SUITE}:restart:${label}] unfinishedEngineJobs=${unfinishedEngineJobs} manual=${JSON.stringify(manual.response)} ` +
        `deletedByGc=${JSON.stringify(deletedByGc)} gcLog=${JSON.stringify(gcLogLines)}`,
    );
  };

  const resumeAndCommitKeys = async (label: string) => {
    const uploadsBefore = uploads.length;
    const result = await uploadProducedMedia({
      token: "tok",
      userId: USER_ID,
      jobId: JOB_ID,
      placementId: PLACEMENT_ID,
      scope: "format",
      variant: VARIANT,
    });
    const committed = committedKeysOf(result.produced);
    const missing = committed.filter((key) => !store.has(key));
    console.info(
      `[${SUITE}:resume:${label}] reuploaded=${uploads.length - uploadsBefore} headCalls=${JSON.stringify(headCalls)} ` +
        `committed=${JSON.stringify(committed)} missingFromStore=${JSON.stringify(missing)}`,
    );
    return { committed, missing, result };
  };

  it("no GC on restart deletes what the requeued job uploaded, and the commit's keys all exist", async () => {
    const persisted = await uploadThenSigtermBeforeCommit(5);

    // Same device: the engine still reports the requeued job.
    await restartAndCollect("engine-sees-job", 1);
    // Another device of the account: its engine has no unfinished job, so only
    // the grace age protects these freshly uploaded objects.
    await restartAndCollect("other-device", 0);

    // Only the month-old orphan goes; nothing the requeued job uploaded does.
    expect(deletedByGc).toEqual([OLD_ORPHAN_KEY]);
    for (const key of [...persisted, ...COMMITTED_KEYS]) expect(store.has(key)).toBe(true);
    expect(gcLogLines.some((line) => line.includes('"reason":"active_engine_jobs"'))).toBe(true);

    const { committed, missing } = await resumeAndCommitKeys("after-gc");
    expect(committed).toHaveLength(OUTPUT_IDS.length * (SEGMENTS + 1));
    expect(missing).toEqual([]);
    // Nothing was lost, so nothing had to be uploaded again.
    expect(committed.sort()).toEqual([...persisted].sort());
  });

  it("a resume re-uploads resumed objects that vanished from storage, so the commit's keys all exist", async () => {
    const persisted = await uploadThenSigtermBeforeCommit(6);
    // Worst case: something outside this runtime (an older client's GC)
    // deleted part of what the job had marked uploaded.
    const vanished = persisted.filter((_, i) => i % 2 === 0);
    for (const key of vanished) store.delete(key);
    console.info(`[${SUITE}:vanished] ${JSON.stringify(vanished)}`);

    const uploadsBefore = uploads.length;
    const { committed, missing, result } = await resumeAndCommitKeys("after-external-delete");
    expect(headCalls.at(-1)?.sort()).toEqual([...persisted].sort());
    expect(committed.filter((key) => vanished.includes(key))).toEqual([]);
    expect(missing).toEqual([]);
    expect(committed).toHaveLength(OUTPUT_IDS.length * (SEGMENTS + 1));
    expect(uploads.length - uploadsBefore).toBe(vanished.length);
    expect(result.uploadedKeys).toHaveLength(vanished.length);
  });
});

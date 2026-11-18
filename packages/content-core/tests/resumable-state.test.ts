import { mkdtempSync, promises as fsp, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumableJobStateStore } from "../src/resumableState";

// On assertion failure, dump the reopened store state so an output/skip-analysis
// mismatch is diagnosable offline. try/catch so a dump failure can't mask the
// real assertion.
const dumpStateSnapshot = (label: string, ctx: { reopened?: ResumableJobStateStore }) => {
  try {
    console.error(`=== [resumable-state:${label}] snapshot ===`);
    if (ctx.reopened) {
      console.error(`reopened full state:\n${JSON.stringify(ctx.reopened.getState(), null, 2)}`);
    } else {
      console.error(`reopened: (not available)`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("media job state store", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    console.info(`[resumable-state:teardown] cleaning ${roots.length} temp root(s)`);
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const createRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "sf-media-job-state-"));
    roots.push(root);
    console.info(`[resumable-state:setup] created temp root=${root}`);
    return root;
  };

  it("@bugfix @regression-proof reopens persisted job state instead of recreating outputs from scratch", async () => {
    const root = createRoot();
    const jobDir = join(root, "job-1");
    const first = await ResumableJobStateStore.open({
      jobDir,
      inputPath: "/tmp/input.mkv",
      userId: "user-1",
    });
    const output = first.ensureOutput("video-source", "video", 12);
    output.encodingComplete = true;
    output.quality = "1080p";
    output.segments.push({ path: "/tmp/seg-1.m4s", uploaded: true, key: "obj-1", sizeBytes: 100 });
    await first.save();
    console.info(
      `[resumable-state:save] saved jobDir=${jobDir} output=video-source quality=1080p encodingComplete=true segments=${output.segments.length}`,
    );

    console.info(`[resumable-state:reopen] reopening jobDir=${jobDir} to verify persisted outputs`);
    const reopened = await ResumableJobStateStore.open({
      jobDir,
      inputPath: "/tmp/input.mkv",
      userId: "user-1",
    });
    console.info(`[resumable-state:reopen] reopened outputs.length=${reopened.getState().outputs.length}`);

    try {
      expect(reopened.getState().outputs).toEqual([
        expect.objectContaining({
          id: "video-source",
          quality: "1080p",
          encodingComplete: true,
          segments: [expect.objectContaining({ key: "obj-1", uploaded: true, sizeBytes: 100 })],
        }),
      ]);
    } catch (err) {
      dumpStateSnapshot("reopen-outputs", { reopened });
      throw err;
    }
  });

  it("persists skip analysis through the dedicated store API", async () => {
    const root = createRoot();
    const store = await ResumableJobStateStore.open({
      jobDir: join(root, "job-2"),
      inputPath: "/tmp/input.mkv",
      userId: "user-2",
    });

    console.info(`[resumable-state:skip-analysis] setting skip analysis source=the-intro-db confidence=0.91 segments=1`);
    store.setSkipAnalysis({
      source: "the-intro-db",
      confidence: 0.91,
      segments: [{ startSeconds: 12, endSeconds: 42 }],
    });
    await store.save();

    console.info(`[resumable-state:skip-analysis] reopening job-2 to verify persisted skip analysis`);
    const reopened = await ResumableJobStateStore.open({
      jobDir: join(root, "job-2"),
      inputPath: "/tmp/input.mkv",
      userId: "user-2",
    });
    console.info(
      `[resumable-state:skip-analysis] reopened skipAnalysis=${JSON.stringify(reopened.getState().skipAnalysis)}`,
    );

    try {
      expect(reopened.getState().skipAnalysis).toEqual({
        source: "the-intro-db",
        confidence: 0.91,
        segments: [{ startSeconds: 12, endSeconds: 42 }],
      });
    } catch (err) {
      dumpStateSnapshot("reopen-skip-analysis", { reopened });
      throw err;
    }
  });

  /**
   * @bugfix @regression-proof issue #25 (CI run 8612, badger-gc-resume-heals-after-sigterm):
   * every chunk upload calls save(), so several saves hit job_state.json at
   * once. A plain writeFile truncates the file before writing it; a requeued
   * run whose open() read inside that window got unparsable JSON, readJson
   * swallowed it, and the job restarted from an EMPTY state (outputs: []) —
   * every uploaded flag gone. The fault injection below holds a writeFile
   * between "file truncated" and "content written", which is what the OS
   * does to a non-atomic write under load.
   */
  it("@bugfix @regression-proof a reader during a save sees the last complete state, never a truncated file", async () => {
    const root = createRoot();
    const jobDir = join(root, "job-3");
    const store = await ResumableJobStateStore.open({ jobDir, inputPath: "/tmp/input.mkv", userId: "user-3" });
    const output = store.ensureOutput("video-360p", "video", 12);
    output.segments.push({ path: "/tmp/seg-1.m4s", uploaded: true, key: "obj-1", sizeBytes: 100 });
    await store.save();
    console.info(`[resumable-state:torn-write] saved baseline with 1 uploaded segment`);

    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let heldPath = "";
    const realWriteFile = fsp.writeFile.bind(fsp);
    vi.spyOn(fsp, "writeFile").mockImplementation(async (...args: Parameters<typeof fsp.writeFile>) => {
      const [path] = args;
      if (!heldPath && String(path).startsWith(jobDir)) {
        heldPath = String(path);
        writeFileSync(heldPath, ""); // truncated, content not yet written
        console.info(`[resumable-state:torn-write] holding write to ${heldPath} after truncate`);
        await gate;
      }
      return realWriteFile(...args);
    });

    output.segments.push({ path: "/tmp/seg-2.m4s", uploaded: true, key: "obj-2", sizeBytes: 100 });
    const pendingSave = store.save();
    await vi.waitFor(() => expect(heldPath).not.toBe(""));

    let reopenedOutputs: unknown = null;
    try {
      const reader = await ResumableJobStateStore.open({ jobDir, inputPath: "/tmp/input.mkv", userId: "user-3" })
        .then((reopened) => reopened.getState().outputs)
        .catch((err: unknown) => `open rejected: ${err instanceof Error ? err.message : String(err)}`);
      reopenedOutputs = reader;
      console.info(`[resumable-state:torn-write] reader during save saw ${JSON.stringify(reopenedOutputs)}`);
      expect(reopenedOutputs).toEqual([
        expect.objectContaining({
          id: "video-360p",
          segments: [expect.objectContaining({ key: "obj-1", uploaded: true })],
        }),
      ]);
    } finally {
      releaseWrite();
      await pendingSave.catch(() => undefined);
    }
  });

  it("concurrent saves leave the newest state on disk", async () => {
    const root = createRoot();
    const jobDir = join(root, "job-4");
    const store = await ResumableJobStateStore.open({ jobDir, inputPath: "/tmp/input.mkv", userId: "user-4" });
    const output = store.ensureOutput("video-360p", "video", 12);
    const saves: Array<Promise<void>> = [];
    for (let i = 0; i < 50; i++) {
      output.segments.push({ path: `/tmp/seg-${i}.m4s`, uploaded: true, key: `obj-${i}`, sizeBytes: 100 });
      saves.push(store.save());
    }
    await Promise.all(saves);
    const onDisk = JSON.parse(await fsp.readFile(join(jobDir, "job_state.json"), "utf8")) as {
      outputs: Array<{ segments: unknown[] }>;
    };
    const leftovers = (await fsp.readdir(jobDir)).filter((name) => name !== "job_state.json");
    console.info(
      `[resumable-state:concurrent] onDisk segments=${onDisk.outputs[0]?.segments.length} leftovers=${JSON.stringify(leftovers)}`,
    );
    expect(onDisk.outputs[0]?.segments).toHaveLength(50);
    expect(leftovers).toEqual([]);
  });

  it("refuses to restart a job from scratch when job_state.json is unreadable", async () => {
    const root = createRoot();
    const jobDir = join(root, "job-5");
    await fsp.mkdir(jobDir, { recursive: true });
    writeFileSync(join(jobDir, "job_state.json"), '{"version":1,"outputs":[{"id":"video-36');
    const outcome = await ResumableJobStateStore.open({ jobDir, inputPath: "/tmp/input.mkv", userId: "user-5" }).then(
      (store) => `opened with outputs=${JSON.stringify(store.getState().outputs)}`,
      (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.info(`[resumable-state:corrupt] ${outcome}`);
    expect(outcome).toMatch(/^rejected: JOB_STATE_CORRUPT/);
  });
});

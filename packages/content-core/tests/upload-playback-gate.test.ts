/**
 * #25 "uploads while a video plays" (Chris 2026-10-13): the ingest upload pool
 * obeys one of three modes while mpv is playing:
 *   full     - no change
 *   throttle - at most 2 chunks in flight, a short pause between chunks
 *   pause    - no new chunk starts; in-flight chunks finish; resumes by itself
 * The gate is a short lease, not a switch: when the desktop stops renewing it
 * (mpv exit / crash / app crash) uploads come back without anyone asking.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdaptivePool } from "../src/storageTransport/adaptivePool";
import {
  PLAYBACK_LEASE_MS_DEFAULT,
  THROTTLE_MAX_CONCURRENCY,
  THROTTLE_PACING_MS,
  createUploadPlaybackGate,
  uploadPlaybackGate,
  type UploadPlaybackGate,
} from "../src/storageTransport/uploadPlaybackGate";
import { uploadEncryptedObjectFile } from "../src/storageTransport/encryptedUploader";

const P = "[upload-playback-gate]";

type Deferred = { promise: Promise<string>; resolve: () => void; started: boolean; name: string };

/** Tasks that stay in flight until the test releases them. */
const makeTasks = (names: string[], trace: string[]) => {
  const tasks = names.map<Deferred & { run: () => Promise<string> }>((name) => {
    let resolve!: () => void;
    const promise = new Promise<string>((res) => {
      resolve = () => res(name);
    });
    const entry = {
      name,
      promise,
      resolve,
      started: false,
      run: () => {
        entry.started = true;
        trace.push(`start:${name}`);
        return promise.then((v) => {
          trace.push(`end:${name}`);
          return v;
        });
      },
    };
    return entry;
  });
  return tasks;
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const startedCount = (tasks: Deferred[]) => tasks.filter((t) => t.started).length;

describe("upload playback gate + AdaptivePool", () => {
  let trace: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    trace = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    uploadPlaybackGate.update({ mode: "full", playbackActive: false });
  });

  const dump = (label: string, pool: AdaptivePool, tasks: Deferred[], gate: UploadPlaybackGate) => {
    console.error(
      `${P} snapshot ${label}: pool=${JSON.stringify(pool.getStats())} gate=${JSON.stringify(gate.getState())} started=${tasks
        .filter((t) => t.started)
        .map((t) => t.name)
        .join(",")} trace=${trace.join(" ")}`,
    );
  };

  it("full: playback changes nothing", async () => {
    const gate = createUploadPlaybackGate();
    const pool = new AdaptivePool({ initialConcurrency: 6, maxConcurrency: 6, gate });
    gate.update({ mode: "full", playbackActive: true });
    const tasks = makeTasks(["a", "b", "c", "d", "e", "f"], trace);
    const done = tasks.map((t) => pool.run(t.run));
    await flush();
    try {
      expect(startedCount(tasks)).toBe(6);
    } catch (err) {
      dump("full", pool, tasks, gate);
      throw err;
    }
    tasks.forEach((t) => t.resolve());
    await Promise.all(done);
  });

  it("@req MPV-PREV-03 subscribers hear playback start and end even in full mode, and the lease running out", async () => {
    const gate = createUploadPlaybackGate();
    const heard: boolean[] = [];
    gate.subscribe(() => heard.push(gate.getState().playbackActive));
    gate.update({ mode: "full", playbackActive: true, leaseMs: 15_000 });
    gate.update({ mode: "full", playbackActive: true, leaseMs: 15_000 }); // heartbeat: no change
    gate.update({ mode: "full", playbackActive: false });
    gate.update({ mode: "full", playbackActive: true, leaseMs: 15_000 });
    await vi.advanceTimersByTimeAsync(15_001);
    console.info(`${P} playback-notify heard=${JSON.stringify(heard)} state=${JSON.stringify(gate.getState())}`);
    expect(heard).toEqual([true, false, true, false]);
  });

  it("throttle: while playback is active at most 2 chunks are in flight, and the cap lifts when playback stops", async () => {
    const gate = createUploadPlaybackGate();
    const pool = new AdaptivePool({ initialConcurrency: 8, maxConcurrency: 8, gate });
    gate.update({ mode: "throttle", playbackActive: true });
    const tasks = makeTasks(["a", "b", "c", "d", "e", "f"], trace);
    const done = tasks.map((t) => pool.run(t.run));
    await flush();
    try {
      expect(THROTTLE_MAX_CONCURRENCY).toBe(2);
      expect(startedCount(tasks)).toBe(2);
      expect(pool.getStats().active).toBe(2);
      // Playback stops: the rest starts without anyone calling the pool.
      gate.update({ mode: "throttle", playbackActive: false });
      await flush();
      expect(startedCount(tasks)).toBe(6);
    } catch (err) {
      dump("throttle", pool, tasks, gate);
      throw err;
    }
    tasks.forEach((t) => t.resolve());
    await vi.advanceTimersByTimeAsync(THROTTLE_PACING_MS * 10);
    await Promise.all(done);
  });

  it("throttle: a finished chunk is followed by a short pause before the next one starts", async () => {
    const gate = createUploadPlaybackGate();
    const pool = new AdaptivePool({ initialConcurrency: 8, maxConcurrency: 8, gate });
    gate.update({ mode: "throttle", playbackActive: true });
    const tasks = makeTasks(["a", "b", "c"], trace);
    const done = tasks.map((t) => pool.run(t.run));
    await flush();
    expect(startedCount(tasks)).toBe(2);
    tasks[0]!.resolve();
    await flush();
    try {
      expect(tasks[2]!.started).toBe(false);
      expect(pool.getStats().active + pool.getStats().cooling).toBeLessThanOrEqual(2);
      await vi.advanceTimersByTimeAsync(THROTTLE_PACING_MS - 1);
      expect(tasks[2]!.started).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(tasks[2]!.started).toBe(true);
    } catch (err) {
      dump("throttle-pacing", pool, tasks, gate);
      throw err;
    }
    tasks.forEach((t) => t.resolve());
    await vi.advanceTimersByTimeAsync(THROTTLE_PACING_MS * 5);
    await Promise.all(done);
  });

  it("pause: in-flight chunks finish untouched, nothing new starts, and playback stopping resumes the queue", async () => {
    const gate = createUploadPlaybackGate();
    const pool = new AdaptivePool({ initialConcurrency: 3, maxConcurrency: 3, gate });
    const tasks = makeTasks(["a", "b", "c", "d", "e"], trace);
    const done = tasks.map((t) => pool.run(t.run));
    await flush();
    expect(startedCount(tasks)).toBe(3);

    gate.update({ mode: "pause", playbackActive: true });
    tasks[0]!.resolve();
    tasks[1]!.resolve();
    tasks[2]!.resolve();
    await flush();
    try {
      // The three in-flight chunks completed with their own values.
      await expect(Promise.all(done.slice(0, 3))).resolves.toEqual(["a", "b", "c"]);
      // d and e stay queued, even though slots are free.
      expect(startedCount(tasks)).toBe(3);
      expect(pool.getStats()).toMatchObject({ active: 0, queued: 2 });
      await vi.advanceTimersByTimeAsync(PLAYBACK_LEASE_MS_DEFAULT - 1_000);
      expect(startedCount(tasks)).toBe(3);

      gate.update({ mode: "pause", playbackActive: false });
      await flush();
      expect(startedCount(tasks)).toBe(5);
    } catch (err) {
      dump("pause", pool, tasks, gate);
      throw err;
    }
    tasks[3]!.resolve();
    tasks[4]!.resolve();
    await expect(Promise.all(done)).resolves.toEqual(["a", "b", "c", "d", "e"]);
  });

  it("pause: switching the mode to full during playback resumes the queue at once (Settings change is live)", async () => {
    const gate = createUploadPlaybackGate();
    const pool = new AdaptivePool({ initialConcurrency: 4, maxConcurrency: 4, gate });
    gate.update({ mode: "pause", playbackActive: true });
    const tasks = makeTasks(["a", "b", "c"], trace);
    const done = tasks.map((t) => pool.run(t.run));
    await flush();
    expect(startedCount(tasks)).toBe(0);
    gate.update({ mode: "full", playbackActive: true });
    await flush();
    try {
      expect(startedCount(tasks)).toBe(3);
    } catch (err) {
      dump("pause-to-full", pool, tasks, gate);
      throw err;
    }
    tasks.forEach((t) => t.resolve());
    await Promise.all(done);
  });

  it("pause: a stopped lease renewal (mpv crash, app crash) resumes by itself; renewal keeps it paused", async () => {
    const gate = createUploadPlaybackGate();
    const pool = new AdaptivePool({ initialConcurrency: 4, maxConcurrency: 4, gate });
    gate.update({ mode: "pause", playbackActive: true });
    const tasks = makeTasks(["a"], trace);
    const done = pool.run(tasks[0]!.run);
    await flush();
    expect(tasks[0]!.started).toBe(false);

    // Heartbeats keep the pause going for far longer than one lease.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(PLAYBACK_LEASE_MS_DEFAULT / 2);
      gate.update({ mode: "pause", playbackActive: true });
    }
    try {
      expect(tasks[0]!.started).toBe(false);
      expect(gate.getState().effective).toBe("pause");

      // Nobody renews: the lease runs out and the chunk starts.
      await vi.advanceTimersByTimeAsync(PLAYBACK_LEASE_MS_DEFAULT + 1);
      expect(gate.getState()).toMatchObject({ playbackActive: false, effective: "full" });
      expect(tasks[0]!.started).toBe(true);
    } catch (err) {
      dump("lease-expiry", pool, tasks, gate);
      throw err;
    }
    tasks[0]!.resolve();
    await done;
  });

  it("pause: a failed chunk is retried only after playback is over (no start during pause)", async () => {
    const gate = createUploadPlaybackGate();
    const pool = new AdaptivePool({ initialConcurrency: 2, maxConcurrency: 2, maxRetries: 2, gate });
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("CHUNK_UPLOAD_FAILED_503");
      return "ok";
    });
    const done = pool.run(flaky);
    await flush();
    expect(calls).toBe(1);
    gate.update({ mode: "pause", playbackActive: true });
    // Backoff (1-2 s) elapses while paused: the retry waits in the queue.
    await vi.advanceTimersByTimeAsync(5_000);
    gate.update({ mode: "pause", playbackActive: true });
    try {
      expect(calls).toBe(1);
      gate.update({ mode: "pause", playbackActive: false });
      await vi.advanceTimersByTimeAsync(10);
      await expect(done).resolves.toBe("ok");
      expect(calls).toBe(2);
    } catch (err) {
      console.error(`${P} snapshot retry-in-pause calls=${calls} pool=${JSON.stringify(pool.getStats())}`);
      throw err;
    }
  });

  it("@bugfix @regression-proof pause: cancelling a chunk that is waiting for its retry rejects it with CANCELLED at once, without starting it again", async () => {
    const gate = createUploadPlaybackGate();
    const pool = new AdaptivePool({ initialConcurrency: 2, maxConcurrency: 2, maxRetries: 2, gate });
    const abort = new AbortController();
    const flaky = vi.fn(async () => {
      throw new Error("CHUNK_UPLOAD_FAILED_503");
    });
    const done = pool.run(flaky, { signal: abort.signal });
    const settled = done.then(
      () => "resolved",
      (err: Error) => err.message,
    );
    await flush();
    expect(flaky).toHaveBeenCalledTimes(1);
    gate.update({ mode: "pause", playbackActive: true });
    console.error(`${P} retry-cancel: backoff elapses while paused, the retry sits in the queue`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pool.getStats()).toMatchObject({ active: 0, queued: 1 });
    abort.abort();
    await flush();
    try {
      await expect(settled).resolves.toBe("CANCELLED");
      expect(pool.getStats()).toMatchObject({ active: 0, queued: 0 });
      expect(flaky).toHaveBeenCalledTimes(1);
    } catch (err) {
      console.error(`${P} retry-cancel FAILED calls=${flaky.mock.calls.length} pool=${JSON.stringify(pool.getStats())}`);
      throw err;
    }
  });

  it("pause: cancelling a queued chunk rejects it with CANCELLED without ever starting it; the others stay queued", async () => {
    const gate = createUploadPlaybackGate();
    const pool = new AdaptivePool({ initialConcurrency: 4, maxConcurrency: 4, gate });
    gate.update({ mode: "pause", playbackActive: true });
    const tasks = makeTasks(["a", "b"], trace);
    const abort = new AbortController();
    const cancelled = pool.run(tasks[0]!.run, { signal: abort.signal });
    const kept = pool.run(tasks[1]!.run);
    await flush();
    abort.abort();
    try {
      await expect(cancelled).rejects.toThrow("CANCELLED");
      expect(tasks[0]!.started).toBe(false);
      expect(pool.getStats().queued).toBe(1);
      gate.update({ mode: "pause", playbackActive: false });
      await flush();
      expect(tasks[0]!.started).toBe(false);
      expect(tasks[1]!.started).toBe(true);
    } catch (err) {
      dump("cancel-queued", pool, tasks, gate);
      throw err;
    }
    tasks[1]!.resolve();
    await kept;
  });

  it("@bugfix @regression-proof pause: a queued chunk runs in the async context of whoever queued it (the per-job library key lives there), not of whoever lifted the pause", async () => {
    const jobKey = new AsyncLocalStorage<string | null>();
    const gate = createUploadPlaybackGate();
    const pool = new AdaptivePool({ initialConcurrency: 2, maxConcurrency: 2, gate });
    gate.update({ mode: "pause", playbackActive: true });
    const seen: Array<string | null | undefined> = [];
    const readKey = async () => {
      seen.push(jobKey.getStore());
      return "ok";
    };
    console.error(`${P} context: queue two chunks inside two job scopes while paused`);
    const done = [
      jobKey.run("key-job-1", () => pool.run(readKey)),
      jobKey.run("key-job-2", () => pool.run(readKey)),
    ];
    await flush();
    expect(seen).toEqual([]);
    console.error(`${P} context: lift the pause from outside any job scope (heartbeat / mpv-exit path)`);
    gate.update({ mode: "pause", playbackActive: false });
    await flush();
    try {
      await expect(Promise.all(done)).resolves.toEqual(["ok", "ok"]);
      expect(seen).toEqual(["key-job-1", "key-job-2"]);
    } catch (err) {
      console.error(`${P} context FAILED seen=${JSON.stringify(seen)} stats=${JSON.stringify(pool.getStats())}`);
      throw err;
    }
  });

  it("a signal that is already aborted rejects without queueing", async () => {
    const pool = new AdaptivePool({ initialConcurrency: 1 });
    const abort = new AbortController();
    abort.abort();
    const task = vi.fn(async () => "x");
    await expect(pool.run(task, { signal: abort.signal })).rejects.toThrow("CANCELLED");
    expect(task).not.toHaveBeenCalled();
  });

  it("a lease longer than the cap is clamped, and 0/negative leases mean inactive", () => {
    const gate = createUploadPlaybackGate();
    gate.update({ mode: "pause", playbackActive: true, leaseMs: 3_600_000 });
    expect(gate.getState().leaseMs).toBeLessThanOrEqual(60_000);
    gate.update({ mode: "pause", playbackActive: true, leaseMs: 0 });
    expect(gate.getState().playbackActive).toBe(false);
  });

  it("the real ingest uploader (global pool + singleton gate) starts no object while paused and uploads it after", async () => {
    const encryptObject = vi.fn((b: Buffer) => b);
    const uploadObject = vi.fn(async (_t: string, key: string) => key);
    const dir = await mkdtemp(join(tmpdir(), "sf-upload-gate-"));
    await writeFile(join(dir, "seg-1.m4s"), "payload");
    const file = `${dir}/seg-1.m4s`;
    uploadPlaybackGate.update({ mode: "pause", playbackActive: true });
    const done = uploadEncryptedObjectFile({ encryptObject, uploadObject }, "tok", file);
    await vi.advanceTimersByTimeAsync(1_000);
    try {
      expect(uploadObject).not.toHaveBeenCalled();
      uploadPlaybackGate.update({ mode: "pause", playbackActive: false });
      await vi.advanceTimersByTimeAsync(50);
      const res = await done;
      expect(uploadObject).toHaveBeenCalledTimes(1);
      expect(res.sizeBytes).toBe(7);
    } catch (err) {
      console.error(`${P} snapshot real-uploader gate=${JSON.stringify(uploadPlaybackGate.getState())} uploadCalls=${uploadObject.mock.calls.length}`);
      throw err;
    }
  });
});

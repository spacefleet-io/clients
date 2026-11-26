/**
 * @bugfix transcode-not-gated-during-playback @regression-proof
 *
 * Real ffmpeg, real OS calls (Linux): a frozen ffmpeg burns no CPU and its
 * output is byte-identical to an uninterrupted run; a throttled one runs on
 * one core and gets its cores back; cancel works on a frozen one; a transcode
 * that would START during pause waits instead; a wall-clock timeout does not
 * count the time the child was frozen.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMediaBinary, syntheticYuvInput, writeSyntheticYuv } from "@space/media-deps";
import { createFfmpegTask, encodePlaybackGate, runFfmpeg } from "../src/index";

const linux = process.platform === "linux";
const ffmpegAvailable = requireMediaBinary("ffmpeg", (() => {
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    return true;
  } catch {
    console.info("[playback-gate-ffmpeg:detect] ffmpeg NOT on PATH — real-ffmpeg tests will skip");
    return false;
  }
})());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const clkTck = Number(execSync("getconf CLK_TCK").toString().trim()) || 100;

/** utime + stime of the whole process (all threads), in clock ticks, and its state letter. */
const readProc = (pid: number): { ticks: number; state: string } | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: rest[0]!, ticks: Number(rest[11]) + Number(rest[12]) };
  } catch {
    return null;
  }
};

const allowedList = (pid: number): string => {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return /Cpus_allowed_list:\s*(\S+)/.exec(status)?.[1] ?? "";
};

const taskAllowedLists = (pid: number): string[] =>
  execSync(`ls /proc/${pid}/task`)
    .toString()
    .trim()
    .split("\n")
    .map((tid) => allowedList(Number(tid)));

/** Per thread of `pid`: utime + stime in clock ticks and the CPU it is on (field 39 of /proc/<pid>/task/<tid>/stat). */
const threadCpus = (pid: number): Map<string, { ticks: number; cpu: number }> => {
  const out = new Map<string, { ticks: number; cpu: number }>();
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    try {
      const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      out.set(tid, { ticks: Number(rest[11]) + Number(rest[12]), cpu: Number(rest[36]) });
    } catch {
      // the thread exited between ls and read
    }
  }
  return out;
};

/**
 * Samples `pid`'s threads every 50 ms for `ms` and returns the CPUs a thread was on right after it used CPU time.
 * Unlike a CPU-time total, this does not depend on how busy the rest of the host is.
 */
const cpusRunOn = async (pid: number, ms: number): Promise<{ cpus: Set<number>; samples: number }> => {
  const cpus = new Set<number>();
  let prev = threadCpus(pid);
  let samples = 0;
  for (const end = performance.now() + ms; performance.now() < end; ) {
    await sleep(50);
    const now = threadCpus(pid);
    for (const [tid, { ticks, cpu }] of now) {
      const before = prev.get(tid);
      if (before && ticks > before.ticks) {
        cpus.add(cpu);
        samples += 1;
      }
    }
    prev = now;
  }
  return { cpus, samples };
};

const cpuCount = (list: string): number =>
  list.split(",").reduce((n, part) => {
    const [lo, hi] = part.split("-").map(Number);
    return n + ((hi ?? lo!) - lo! + 1);
  }, 0);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The shipped ffmpeg has no testsrc2: encodes read block-noise clips written by beforeAll (640x360 or 1280x720). */
let clipDir = "";
const clip = (height: 360 | 720, rate: number, seconds: number) =>
  syntheticYuvInput(join(clipDir, `${height}.yuv`), { width: height === 360 ? 640 : 1280, height, rate, seconds });

/** Deterministic single-threaded x264 encode of a synthetic clip into `out` (the shipped ffmpeg has no md5 muxer). */
const deterministicEncodeArgs = (seconds: number, out: string) => [
  ...clip(360, 25, seconds),
  "-c:v", "libx264", "-preset", "medium", "-threads", "1",
  "-fflags", "+bitexact", "-flags:v", "+bitexact", "-bitexact",
  "-f", "matroska", out,
];

const md5OfFile = (path: string): string => createHash("md5").update(readFileSync(path)).digest("hex");

const resetGate = () => {
  encodePlaybackGate.setPolicy("full", { reason: "test-reset" });
};

// Writing the ~55 MB of raw clips took over vitest's 10 s hook default on a loaded runner (ci run 34040).
beforeAll(() => {
  clipDir = mkdtempSync(join(tmpdir(), "sf-gate-clips-"));
  writeSyntheticYuv(join(clipDir, "360.yuv"), { width: 640, height: 360, frames: 50 });
  writeSyntheticYuv(join(clipDir, "720.yuv"), { width: 1280, height: 720, frames: 30 });
}, 60_000);
afterAll(() => rmSync(clipDir, { recursive: true, force: true }));

describe.skipIf(!linux || !ffmpegAvailable)("playback gate with a real ffmpeg (Linux) @bugfix @regression-proof", () => {
  it("pause: the frozen ffmpeg uses ~0 CPU, makes no progress, and its output is byte-identical to an uninterrupted run", async () => {
    const baselineOut = join(clipDir, "baseline.mkv");
    await createFfmpegTask(deterministicEncodeArgs(12, baselineOut), {
      progress: { output: "stderr" },
    }).promise;
    const baselineMd5 = md5OfFile(baselineOut);
    console.info("[playback-gate-ffmpeg:identical] baseline md5 =", baselineMd5);

    let pid: number | undefined;
    let frames = 0;
    const resumedOut = join(clipDir, "resumed.mkv");
    const task = createFfmpegTask(deterministicEncodeArgs(12, resumedOut), {
      playbackGated: true,
      progress: {
        output: "stderr",
        onUpdate: (stats) => {
          frames = stats.frame ?? frames;
        },
      },
      onSpawn: (child) => {
        pid = child.pid;
      },
    });
    try {
      for (let waited = 0; frames < 40 && waited < 20_000; waited += 20) await sleep(20);
      expect(frames).toBeGreaterThanOrEqual(40);
      expect(pid).toBeTypeOf("number");

      encodePlaybackGate.setPolicy("pause", { reason: "test" });
      await sleep(300); // let in-flight output drain
      const before = readProc(pid!)!;
      const framesBefore = frames;
      await sleep(1500);
      const after = readProc(pid!)!;
      const cpuPercent = ((after.ticks - before.ticks) / clkTck / 1.5) * 100;
      console.info(
        `[playback-gate-ffmpeg:identical] frozen: state=${after.state} cpu=${cpuPercent.toFixed(1)}% frames ${framesBefore} -> ${frames}`
      );
      expect(after.state).toBe("T");
      expect(cpuPercent).toBeLessThan(2);
      expect(frames).toBe(framesBefore);
      expect(task.status).toBe("running");

      encodePlaybackGate.setPolicy("full", { reason: "test" });
      await task.promise;
      console.info(`[playback-gate-ffmpeg:identical] resumed run md5 = ${md5OfFile(resumedOut)}, frames = ${frames}`);
      expect(md5OfFile(resumedOut)).toBe(baselineMd5);
      expect(frames).toBe(12 * 25);
    } finally {
      resetGate();
      task.cancel();
    }
  }, 60_000);

  it("throttle: a running ffmpeg is confined to ONE core live, uses about one core, and gets all its cores back", async () => {
    const original = allowedList(process.pid);
    if (cpuCount(original) < 2) {
      console.info("[playback-gate-ffmpeg:throttle] fewer than 2 allowed CPUs — nothing to confine, skipping");
      return;
    }
    let pid: number | undefined;
    const task = createFfmpegTask(
      [
        ...clip(720, 60, 120),
        "-c:v", "libx264", "-preset", "medium", "-threads", String(Math.min(4, cpuCount(original))),
        "-f", "null", "-",
      ],
      {
        playbackGated: true,
        progress: { enabled: false },
        onSpawn: (child) => {
          pid = child.pid;
        },
      }
    );
    try {
      await sleep(1500);
      expect(pid).toBeTypeOf("number");
      // Before the throttle every thread may run on every allowed CPU, so the throttle is what confines it.
      const fullLists = taskAllowedLists(pid!);
      let since = performance.now();
      const fullBefore = readProc(pid!)!;
      const fullRun = await cpusRunOn(pid!, 1000);
      const fullAfter = readProc(pid!)!;
      // Divided by the measured wall time: sampling makes the window run past its nominal length.
      const fullCores = (fullAfter.ticks - fullBefore.ticks) / clkTck / ((performance.now() - since) / 1000);

      encodePlaybackGate.setPolicy("throttle", { reason: "test" });
      await sleep(300);
      const lists = taskAllowedLists(pid!);
      since = performance.now();
      const t0 = readProc(pid!)!;
      const throttledRun = await cpusRunOn(pid!, 2000);
      const t1 = readProc(pid!)!;
      const throttledCores = (t1.ticks - t0.ticks) / clkTck / ((performance.now() - since) / 1000);
      // CPU time is logged, not compared: the encoder runs niced (INGS-LANE-01), so how much it gets in each window
      // depends on the rest of the host (quick-checks run 52284: 0.80 core at full, 0.94 throttled).
      console.info(
        `[playback-gate-ffmpeg:throttle] original=${original} before=${[...new Set(fullLists)].join("|")} allowed per thread=${[...new Set(lists)].join("|")}` +
          ` full=${fullCores.toFixed(2)} cores on cpus ${[...fullRun.cpus].sort((a, b) => a - b).join(",")} (${fullRun.samples} samples)` +
          ` throttled=${throttledCores.toFixed(2)} cores on cpus ${[...throttledRun.cpus].sort((a, b) => a - b).join(",")} (${throttledRun.samples} samples)`
      );
      expect(new Set(fullLists)).toEqual(new Set([original]));
      expect(new Set(lists).size).toBe(1);
      expect(cpuCount(lists[0]!)).toBe(1);
      // Live: every thread that used CPU while throttled was on that one core, and the encode kept running.
      expect(throttledRun.samples).toBeGreaterThan(0);
      expect([...throttledRun.cpus]).toEqual([Number(lists[0])]);
      expect(throttledCores).toBeLessThan(1.25);

      encodePlaybackGate.setPolicy("full", { reason: "test" });
      await sleep(300);
      const restored = taskAllowedLists(pid!);
      console.info("[playback-gate-ffmpeg:throttle] restored per thread =", [...new Set(restored)]);
      expect(new Set(restored)).toEqual(new Set([original]));
    } finally {
      resetGate();
      task.cancel();
      await task.promise.catch(() => {});
    }
  }, 60_000);

  it("throttle: an ffmpeg that STARTS during throttle is on one core from its first moments", async () => {
    if (cpuCount(allowedList(process.pid)) < 2) return;
    encodePlaybackGate.setPolicy("throttle", { reason: "test" });
    let pid: number | undefined;
    const task = createFfmpegTask(
      [...clip(360, 25, 60), "-c:v", "libx264", "-threads", "2", "-f", "null", "-"],
      {
        playbackGated: true,
        progress: { enabled: false },
        onSpawn: (child) => {
          pid = child.pid;
        },
      }
    );
    try {
      await sleep(1200);
      const lists = taskAllowedLists(pid!);
      console.info("[playback-gate-ffmpeg:throttle-spawn] per thread =", [...new Set(lists)]);
      expect(new Set(lists).size).toBe(1);
      expect(cpuCount(lists[0]!)).toBe(1);
    } finally {
      resetGate();
      task.cancel();
      await task.promise.catch(() => {});
    }
  }, 30_000);

  it("pause: a transcode that would start during pause WAITS (no process), and starts when the policy lifts", async () => {
    encodePlaybackGate.setPolicy("pause", { reason: "test" });
    let pid: number | undefined;
    const task = createFfmpegTask(
      ["-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=0.5", "-f", "null", "-"],
      {
        playbackGated: true,
        progress: { enabled: false },
        onSpawn: (child) => {
          pid = child.pid;
        },
      }
    );
    try {
      await sleep(800);
      console.info("[playback-gate-ffmpeg:wait] pid while paused =", pid, "waiting =", encodePlaybackGate.snapshot().waiting);
      expect(pid).toBeUndefined();
      expect(encodePlaybackGate.snapshot().waiting).toBe(1);
      encodePlaybackGate.setPolicy("full", { reason: "test" });
      await task.promise;
      expect(pid).toBeTypeOf("number");
      expect(task.status).toBe("finished");
    } finally {
      resetGate();
    }
  }, 30_000);

  it("pause: cancelling a transcode that is still waiting to start never spawns it", async () => {
    encodePlaybackGate.setPolicy("pause", { reason: "test" });
    let pid: number | undefined;
    const task = createFfmpegTask(["-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=5", "-f", "null", "-"], {
      playbackGated: true,
      progress: { enabled: false },
      onSpawn: (child) => {
        pid = child.pid;
      },
    });
    try {
      await sleep(200);
      task.cancel();
      await expect(task.promise).rejects.toThrow();
      expect(pid).toBeUndefined();
      expect(task.status).toBe("cancelled");
      expect(encodePlaybackGate.snapshot().waiting).toBe(0);
    } finally {
      resetGate();
    }
  }, 30_000);

  it("pause: cancelling a FROZEN ffmpeg terminates it promptly", async () => {
    let pid: number | undefined;
    const task = createFfmpegTask(
      [...clip(360, 25, 120), "-c:v", "libx264", "-threads", "1", "-f", "null", "-"],
      {
        playbackGated: true,
        progress: { enabled: false },
        onSpawn: (child) => {
          pid = child.pid;
        },
      }
    );
    try {
      await sleep(800);
      encodePlaybackGate.setPolicy("pause", { reason: "test" });
      await sleep(300);
      expect(readProc(pid!)!.state).toBe("T");
      const cancelledAt = Date.now();
      task.cancel();
      await task.promise.catch(() => {});
      const ms = Date.now() - cancelledAt;
      console.info(`[playback-gate-ffmpeg:cancel-frozen] gone after ${ms} ms, alive=${isAlive(pid!)}`);
      expect(ms).toBeLessThan(5000);
      expect(isAlive(pid!)).toBe(false);
    } finally {
      resetGate();
    }
  }, 30_000);

  it("pause: an ffmpeg that is NOT gated (probe, preview) is untouched", async () => {
    encodePlaybackGate.setPolicy("pause", { reason: "test" });
    try {
      const result = await runFfmpeg(["-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=0.3", "-f", "null", "-"], {
        progress: { enabled: false },
        timeoutMs: 10_000,
      });
      expect(result.code).toBe(0);
    } finally {
      resetGate();
    }
  }, 30_000);

  it("a wall-clock timeoutMs does NOT count the time the child was frozen (or waiting to start)", async () => {
    // `-re` paces the source in real time: ~1.5 s of running time. The timeout is 2.5 s.
    // Frozen for 4 s in the middle: without suspension-aware timers it would fire at 2.5 s.
    const started = Date.now();
    const run = runFfmpeg(["-re", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=1.5", "-f", "null", "-"], {
      playbackGated: true,
      progress: { enabled: false },
      timeoutMs: 2500,
    });
    try {
      await sleep(500);
      encodePlaybackGate.setPolicy("pause", { reason: "test" });
      await sleep(4000);
      encodePlaybackGate.setPolicy("full", { reason: "test" });
      const result = await run;
      const elapsed = Date.now() - started;
      console.info(`[playback-gate-ffmpeg:timeout] finished after ${elapsed} ms wall (2.5 s timeout, 4 s frozen), code=${result.code}`);
      expect(result.code).toBe(0);
      expect(elapsed).toBeGreaterThan(4000);
    } finally {
      resetGate();
    }
  }, 30_000);

  it("a timeout still fires for a gated child that is running (not frozen)", async () => {
    const run = runFfmpeg(["-re", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=30", "-f", "null", "-"], {
      playbackGated: true,
      progress: { enabled: false },
      timeoutMs: 600,
    });
    await expect(run).rejects.toThrow(/timed out after 600ms/);
  }, 30_000);
});

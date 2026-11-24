import { once } from "node:events";
import { getDesktopPlatform } from "@space/desktop-platform";
import { type ChildGate, encodePlaybackGate, NOT_GATED_CHILD } from "./playbackGate";
import { backgroundEncodePriority } from "./resourcePolicy";

type SpawnOptions = {
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Optional source of bytes to pipe to the child's stdin. When provided,
   * the spawned process is started with stdin set to pipe, the iterable is
   * drained into stdin in order, and stdin is closed after the last chunk.
   *
   * Caller is responsible for using `pipe:0` in its ffmpeg `-i` arg.
   * Write errors (EPIPE) are tolerated — they surface via the child's
   * exit code, not via the pump task.
   */
  stdin?: AsyncIterable<Uint8Array> | null;
};

type CommandOptions = SpawnOptions & {
  ffmpegPath?: string;
  ffprobePath?: string;
  /**
   * Override the child's niceness (default: `resolveFfmpegNiceness()`, below
   * normal). Pass `0` to run at normal priority — only for a foreground
   * operation the user is actively waiting on.
   */
  niceness?: number;
  /**
   * A transcode that competes with video playback: while a video plays it
   * obeys the per-computer playback policy (`encodePlaybackGate`): one core
   * under `throttle`; waits to start and is frozen in place under `pause`.
   * Probes, previews and ffprobe leave it off.
   */
  playbackGated?: boolean;
  /** Called once the child exists, with its pid (e.g. to record an encoder lease). */
  onSpawn?: (child: { pid: number | undefined }) => void;
};

type ProgressStats = {
  frame?: number;
  fps?: number;
  bitrateKbps?: number;
  totalSizeBytes?: number;
  outTimeMs?: number;
  outTime?: string;
  speed?: string;
  progress?: string;
  percent?: number;
  etaMs?: number | null;
};

type TaskStatus = "queued" | "running" | "finished" | "failed" | "cancelled";

type ProgressOptions = {
  enabled?: boolean;
  durationMs?: number | null;
  output?: "stdout" | "stderr";
  onUpdate?: (stats: ProgressStats) => void;
};

type LogOptions = {
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
};

export type FfmpegTask = {
  status: TaskStatus;
  stats: ProgressStats;
  error: Error | null;
  result: { stdout: string; stderr: string; code: number } | null;
  promise: Promise<{ stdout: string; stderr: string; code: number }>;
  cancel: () => void;
  /**
   * True while the encode is frozen by the playback policy, or waiting for
   * `pause` to end before it may start. A wall-clock timer around the task
   * must not count that time.
   */
  isSuspended: () => boolean;
  /** Called when `isSuspended()` flips. Returns an unsubscribe. */
  onSuspendedChange: (listener: (suspended: boolean) => void) => () => void;
};

const hasBun = typeof (globalThis as typeof globalThis & { Bun?: { spawn?: unknown } }).Bun !== "undefined";

// Bun's `proc.stdin` when `stdin: "pipe"` is a `FileSink`, NOT a
// `WritableStream`. FileSink exposes `.write()` / `.end()` / `.flush()`
// — close to Node's writable, but no `.getWriter()`. Declaring the type
// loosely here keeps us decoupled from `@types/bun` (this package has
// no Bun-types dep) AND fixes the runtime crash that occurred when the
// retranscode pipeline tried `proc.stdin.getWriter()` and blew up with
// "TypeError: target.getWriter is not a function" (replan jobs would
// stick at 1% with this in the runtime log).
type BunSinkLike = {
  write: (chunk: Uint8Array) => number | Promise<number>;
  end: () => unknown;
  flush?: () => Promise<number> | number | undefined;
};
/** How long a cancelled ffmpeg gets to exit on SIGTERM before it is SIGKILLed (Bun path; the node path SIGKILLs). */
const FFMPEG_KILL_GRACE_MS = 750;

type BunSpawnLike = {
  spawn: (
    command: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      stdout: "pipe";
      stderr: "pipe";
      stdin?: "pipe";
      detached?: boolean;
      windowsHide?: boolean;
    }
  ) => {
    pid?: number;
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    stdin?: BunSinkLike;
    exited: Promise<number>;
    kill: (signal?: number | string) => void;
  };
};

const pumpWebStream = async (
  target: WritableStream<Uint8Array>,
  source: AsyncIterable<Uint8Array>,
): Promise<void> => {
  const writer = target.getWriter();
  try {
    for await (const chunk of source) {
      try {
        await writer.write(chunk);
      } catch {
        return;
      }
    }
    try {
      await writer.close();
    } catch {
      /* already closed */
    }
  } finally {
    try {
      writer.releaseLock();
    } catch {
      /* already released */
    }
  }
};

/**
 * Bytes the stdin pump may hand to a Bun FileSink before it waits for the
 * sink to drain into the child. Bun's FileSink buffers without bound: before
 * #25 the pump wrote every chunk the moment the source produced it, so a
 * retranscode (source = download + decrypt, far faster than a CPU encode)
 * parked the whole source in runtime memory (+450 MB RSS per job, 2.6 GB
 * footprint peaks on the ultimate stress run). 4 MiB keeps ffmpeg fed (it
 * also has the kernel pipe buffer and its own demux buffer) while capping the
 * pump's share of RSS at about one HLS segment above this mark.
 */
export const STDIN_HIGH_WATER_MARK_BYTES = 4 * 1024 * 1024;

export type StdinPumpStats = {
  /** Bytes handed to the sink. */
  bytes: number;
  chunks: number;
  /** Most bytes handed to the sink and not yet confirmed drained. */
  peakPendingBytes: number;
  highWaterMark: number;
  /** Times the pump paused for the sink to drain. */
  drainWaits: number;
  drainWaitMs: number;
};

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/**
 * Pump an AsyncIterable of bytes into a Bun FileSink (what `Bun.spawn`
 * gives us for `proc.stdin` when `stdin: "pipe"`). Mirrors the contract
 * of `pumpWebStream` / `pumpNodeStream` — exists because Bun's FileSink
 * is its own shape: `.write()` / `.end()`, no `.getWriter()`.
 *
 * Backpressure: a FileSink accepts every write and buffers it. The pump
 * counts bytes written since the sink last drained; once that reaches
 * `highWaterMark` it awaits `flush()`, which (verified on Bun 1.3.5 with a
 * slow child) resolves only when the buffer has been written to the pipe, or
 * when the child is gone. A promise returned by `write()` is awaited too.
 * While it waits, the next source chunk is already being fetched, so the
 * encoder is not starved by the download of the next piece. That prefetched
 * pull is marked handled as soon as it starts: a source that fails during
 * the wait (a cancelled job) must not become an unhandled rejection, which
 * exits a Bun process. The failure surfaces when the pump awaits the pull.
 *
 * `onDone` receives the run's stats once stdin has been ended, whichever
 * way the pump finished.
 *
 * `onSourceError` (#25 P11) runs when the SOURCE fails, BEFORE stdin is
 * ended: the caller kills the child there, so ffmpeg never sees a clean EOF
 * on a truncated input (it would finalize a partial rendition and exit 0).
 *
 * Exposed via `__testOnly` for unit coverage; runtime callers use it
 * through the Bun spawn branch in `runShell`.
 */
const pumpBunSink = async (
  target: BunSinkLike,
  source: AsyncIterable<Uint8Array>,
  options: {
    highWaterMark?: number;
    onDone?: (stats: StdinPumpStats) => void;
    onSourceError?: (err: unknown) => void;
  } = {},
): Promise<void> => {
  const highWaterMark = options.highWaterMark ?? STDIN_HIGH_WATER_MARK_BYTES;
  const stats: StdinPumpStats = {
    bytes: 0,
    chunks: 0,
    peakPendingBytes: 0,
    highWaterMark,
    drainWaits: 0,
    drainWaitMs: 0,
  };
  let pending = 0;
  const iterator = source[Symbol.asyncIterator]();
  // A pull can reject while the pump is busy awaiting a write() or flush()
  // (#25: a cancelled retranscode's source throws CANCELLED on the prefetched
  // pull). Mark it handled the moment it starts, else that window is an
  // unhandled rejection and Bun exits the process. `await next` below still
  // throws, so the error still reaches `onSourceError`.
  const pull = () => {
    const pulled = iterator.next();
    pulled.catch(() => undefined);
    return pulled;
  };
  let next: Promise<IteratorResult<Uint8Array>> | null = null;
  try {
    next = pull();
    while (true) {
      const result: IteratorResult<Uint8Array> = await next;
      next = null;
      if (result.done) break;
      // Prefetch: the next piece downloads while this one drains.
      next = pull();
      const chunk = result.value;
      try {
        const written = target.write(chunk);
        pending += chunk.byteLength;
        stats.bytes += chunk.byteLength;
        stats.chunks += 1;
        if (pending > stats.peakPendingBytes) stats.peakPendingBytes = pending;
        if (isThenable(written)) await written;
        if (pending >= highWaterMark && target.flush) {
          const flushed = target.flush();
          if (isThenable(flushed)) {
            const waitStart = performance.now();
            stats.drainWaits += 1;
            await flushed;
            stats.drainWaitMs += performance.now() - waitStart;
          }
          pending = 0;
        }
      } catch {
        return;
      }
    }
  } catch (err) {
    options.onSourceError?.(err);
  } finally {
    if (next) {
      // Left early (write or source failed): stop the source.
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
    try {
      const ended = target.end();
      if (isThenable(ended)) {
        await ended;
      }
    } catch {
      /* already ended */
    }
    options.onDone?.(stats);
  }
};

const pumpNodeStream = async (
  target: NodeJS.WritableStream,
  source: AsyncIterable<Uint8Array>,
  options: { onSourceError?: (err: unknown) => void } = {},
): Promise<void> => {
  try {
    for await (const chunk of source) {
      const ok = target.write(chunk);
      if (!ok) {
        try {
          await once(target as unknown as NodeJS.EventEmitter, "drain");
        } catch {
          return;
        }
      }
    }
  } catch (err) {
    // Same contract as pumpBunSink. Before #25 P11 this path swallowed the
    // error and never ended stdin, so the child waited for input forever.
    options.onSourceError?.(err);
  }
  try {
    target.end();
  } catch {
    /* already ended */
  }
};

const parseProgressLine = (line: string) => {
  const [rawKey, rawValue] = line.trim().split("=");
  if (!rawKey || typeof rawValue === "undefined") return null;
  return { key: rawKey.trim(), value: rawValue.trim() };
};

const updateProgressStats = (
  stats: ProgressStats,
  key: string,
  value: string,
  durationMs?: number | null
) => {
  const parseClockTime = (clock: string) => {
    const parts = clock.trim().split(":").map((part) => Number(part));
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
    const [hours, minutes, secondsRaw] = parts;
    const seconds = Math.floor(secondsRaw);
    const millis = Math.round((secondsRaw - seconds) * 1000);
    return ((hours * 3600 + minutes * 60 + seconds) * 1000 + millis);
  };

  if (key === "frame") stats.frame = Number(value);
  if (key === "fps") stats.fps = Number(value);
  if (key === "bitrate") {
    const match = value.match(/([0-9.]+)\s*kbits?\/s/i);
    stats.bitrateKbps = match ? Number(match[1]) : Number(value);
  }
  if (key === "total_size") stats.totalSizeBytes = Number(value);
  if (key === "out_time_ms") {
    const micro = Number(value);
    stats.outTimeMs = Number.isFinite(micro) ? Math.floor(micro / 1000) : undefined;
  }
  if (key === "out_time") {
    stats.outTime = value;
    if (!Number.isFinite(stats.outTimeMs ?? NaN)) {
      const parsed = parseClockTime(value);
      if (parsed !== null) stats.outTimeMs = parsed;
    }
  }
  if (key === "speed") stats.speed = value;
  if (key === "progress") {
    stats.progress = value;
    if (value === "end") {
      stats.percent = 100;
      stats.etaMs = 0;
    }
  }

  if (durationMs && Number.isFinite(stats.outTimeMs ?? NaN)) {
    const outMs = Math.max(0, stats.outTimeMs ?? 0);
    const ratio = durationMs > 0 ? Math.min(1, outMs / durationMs) : 0;
    if (stats.progress !== "end") {
      stats.percent = Math.min(99, Math.round(ratio * 100));
    }
    const remainingMs = Math.max(0, durationMs - outMs);
    stats.etaMs = Number.isFinite(remainingMs) ? remainingMs : null;
  }
};

const readLinesFromStream = async (stream: ReadableStream, onLine: (line: string) => void) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      onLine(line);
      index = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) onLine(buffer);
};

const readLinesFromNodeStream = async (
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void
) => {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: stream });
  for await (const line of rl) {
    onLine(String(line));
  }
};

/**
 * Every ffmpeg/ffprobe child spawned through this package is registered with
 * `backgroundEncodePriority` (see `resourcePolicy.ts`): it starts below normal
 * priority (`FFMPEG_BACKGROUND_NICENESS`), drops to the lowest/IDLE level
 * while a playback session is active, and is untracked when it exits. The
 * original reason it exists: the ingest engine pipelines a format job's
 * `transcode` step (this ffmpeg) against a sibling job's `upload` step
 * (AES-GCM chunk encryption in the runtime, unniced) per the step-lane
 * model; the second reason
 * (the one that matters on a 4-core i5 without a GPU encoder) is that a
 * libx264/libx265 retranscode must not steal CPU from mpv playback and the UI.
 *
 * Linux nice range is -20..19; positive values are non-privileged. Windows
 * maps the value onto a priority class. Sandboxed-permissions failures are
 * tolerated (the encode still runs, just at normal priority) but logged once
 * so a "why is playback still stuttering" investigation can see it.
 */
const spawnCommand = async (
  command: string,
  args: string[],
  options?: SpawnOptions & {
    onStdout?: (line: string) => void;
    onStderr?: (line: string) => void;
    captureStdout?: boolean;
    captureStderr?: boolean;
    onStart?: (controller: { kill: () => void; pid: number | undefined; gate: ChildGate }) => void;
    /** Override the default niceness (`resolveFfmpegNiceness()`); `0` = normal priority. */
    niceness?: number;
    /** Register with `encodePlaybackGate` (see `CommandOptions.playbackGated`). */
    playbackGated?: boolean;
  }
) => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const captureStdout = options?.captureStdout ?? true;
  const captureStderr = options?.captureStderr ?? true;
  // #25 P7: an encoder must die with the process that spawned it (a SIGKILLed
  // runtime runs no cleanup; its ffmpeg children used to encode on as orphans).
  // `wrap` the argv before the spawn, `afterSpawn` right after it. A command
  // the platform cannot wrap still runs; the encoder-lease reaper
  // (`@space/ingest-core` encoderLease.ts) is the second line of defence.
  const { childLifetime, spawnOptions } = getDesktopPlatform().processes;
  const spawnArgv = await childLifetime.wrap(command, args, options?.env);
  // spawnOptions: the runtime has no console (the app spawns it detached), so on Windows a console child (ffmpeg,
  // ffprobe) spawned without windowsHide gets its own visible console window, and closing that window kills it.

  // #25 P11: set when the stdin source failed. The child is SIGKILLed first
  // (SIGTERM would let ffmpeg finalize the truncated input and exit 0), and
  // the caller gets the source error instead of ffmpeg's EOF complaint.
  let stdinSourceError: unknown = undefined;
  const onStdinSourceError = (pid: number | undefined, kill: () => void) => (err: unknown) => {
    stdinSourceError = err;
    console.warn(
      JSON.stringify({
        event: "ffmpeg.stdin.source_failed",
        pid,
        error: err instanceof Error ? err.message : String(err),
        action: "child SIGKILLed before stdin EOF",
      })
    );
    kill();
  };

  if (hasBun) {
    const BunRef = (globalThis as typeof globalThis & { Bun: BunSpawnLike }).Bun;
    const proc = BunRef.spawn([spawnArgv.command, ...spawnArgv.args], {
      ...spawnOptions({ detached: false }),
      cwd: options?.cwd,
      env: options?.env,
      stdout: "pipe",
      stderr: "pipe",
      ...(options?.stdin ? { stdin: "pipe" as const } : {}),
    });
    const untrackPriority = backgroundEncodePriority.track(proc.pid, options?.niceness);
    // Registered before onStart so a freeze/one-core policy already in force
    // applies to the child before the caller can see it. A frozen process
    // ignores SIGTERM until it is continued: every kill thaws first.
    const gate = options?.playbackGated ? encodePlaybackGate.attach(proc.pid) : NOT_GATED_CHILD;
    const untrack = () => {
      untrackPriority();
      gate.release();
    };
    childLifetime.afterSpawn(proc.pid);
    options?.onStart?.({
      kill: () => {
        gate.resumeNow();
        proc.kill();
        // MPV-PREV-07 (imports always first): SIGTERM lets ffmpeg tear down at its own pace (a hardware decoder took
        // seconds); a cancel must free the machine within about a second, so the kill escalates.
        const escalate = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }, FFMPEG_KILL_GRACE_MS);
        void proc.exited.then(
          () => clearTimeout(escalate),
          () => clearTimeout(escalate)
        );
      },
      pid: proc.pid,
      gate,
    });

    if (options?.stdin && proc.stdin) {
      // Bun's proc.stdin is a FileSink, not a WritableStream. Use the
      // FileSink-aware pump (see comment on BunSinkLike for the crash
      // history this guards against). One info line per piped run, so a
      // memory regression in the stdin path shows up in runtime.log.
      const pid = proc.pid;
      void pumpBunSink(proc.stdin, options.stdin, {
        onDone: (stats) => {
          console.info(
            JSON.stringify({
              event: "ffmpeg.stdin.pump_done",
              pid,
              bytes: stats.bytes,
              chunks: stats.chunks,
              peakPendingBytes: stats.peakPendingBytes,
              highWaterMark: stats.highWaterMark,
              drainWaits: stats.drainWaits,
              drainWaitMs: Math.round(stats.drainWaitMs),
            })
          );
        },
        onSourceError: onStdinSourceError(pid, () => proc.kill("SIGKILL")),
      });
    }
    if (proc.stdout) {
      void readLinesFromStream(proc.stdout, (line) => {
        if (captureStdout) stdoutChunks.push(line);
        options?.onStdout?.(line);
      });
    }
    if (proc.stderr) {
      void readLinesFromStream(proc.stderr, (line) => {
        if (captureStderr) stderrChunks.push(line);
        options?.onStderr?.(line);
      });
    }

    const code = await proc.exited;
    untrack();
    return {
      stdout: stdoutChunks.join("\n"),
      stderr: stderrChunks.join("\n"),
      code,
      stdinSourceError,
    };
  }

  const { spawn } = await import("node:child_process");
  const proc = spawn(spawnArgv.command, spawnArgv.args, {
    ...spawnOptions({ detached: false }),
    cwd: options?.cwd,
    env: options?.env,
    stdio: options?.stdin
      ? ["pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"],
  });
  const untrackPriority = backgroundEncodePriority.track(proc.pid ?? undefined, options?.niceness);
  const gate = options?.playbackGated ? encodePlaybackGate.attach(proc.pid ?? undefined) : NOT_GATED_CHILD;
  const untrack = () => {
    untrackPriority();
    gate.release();
  };
  childLifetime.afterSpawn(proc.pid);
  options?.onStart?.({
    kill: () => {
      gate.resumeNow();
      proc.kill("SIGKILL");
    },
    pid: proc.pid ?? undefined,
    gate,
  });

  if (options?.stdin && proc.stdin) {
    void pumpNodeStream(proc.stdin, options.stdin, {
      onSourceError: onStdinSourceError(proc.pid ?? undefined, () => proc.kill("SIGKILL")),
    });
  }
  if (proc.stdout) {
    void readLinesFromNodeStream(proc.stdout, (line) => {
      if (captureStdout) stdoutChunks.push(line);
      options?.onStdout?.(line);
    });
  }
  if (proc.stderr) {
    void readLinesFromNodeStream(proc.stderr, (line) => {
      if (captureStderr) stderrChunks.push(line);
      options?.onStderr?.(line);
    });
  }

  // A spawn failure (ENOENT for a missing binary, EACCES) emits `error`, and
  // `close` is not guaranteed after it: without this listener the promise
  // never settled and the error escaped as an uncaught exception.
  const code = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (exitCode) => resolve(exitCode ?? 0));
  }).finally(untrack);

  return {
    stdout: stdoutChunks.join("\n"),
    stderr: stderrChunks.join("\n"),
    code,
    stdinSourceError,
  };
};

export const createFfmpegTask = (
  args: string[],
  options?: CommandOptions & { progress?: ProgressOptions; log?: LogOptions }
): FfmpegTask => {
  const stats: ProgressStats = {};
  let status: TaskStatus = "queued";
  let cancelled = false;
  let error: Error | null = null;
  let result: { stdout: string; stderr: string; code: number } | null = null;

  const progress = options?.progress;
  const progressEnabled = progress?.enabled ?? true;
  const progressOutput = progress?.output ?? "stdout";
  const logHandler = options?.log?.onLine;

  const finalArgs = progressEnabled
    ? [
        "-progress",
        progressOutput === "stderr" ? "pipe:2" : "pipe:1",
        "-nostats",
        "-hide_banner",
        ...args,
      ]
    : ["-hide_banner", ...args];

  let cancelFn: (() => void) | null = null;

  // Playback-gate bookkeeping. `suspended` = frozen child OR still waiting to
  // start under `pause`; wall-clock timers around the task listen to it.
  let waitingToStart = false;
  let childFrozen = false;
  let waitAbort: AbortController | null = null;
  const suspendListeners = new Set<(suspended: boolean) => void>();
  const isSuspended = () => waitingToStart || childFrozen;
  const emitSuspended = () => {
    for (const listener of [...suspendListeners]) listener(isSuspended());
  };

  const handleLine = (line: string, stream: "stdout" | "stderr") => {
    const parsed = parseProgressLine(line);
    if (progressEnabled && parsed && progressOutput === stream) {
      updateProgressStats(stats, parsed.key, parsed.value, progress?.durationMs ?? null);
      progress?.onUpdate?.(stats);
      return;
    }
    if (logHandler) {
      logHandler(line, stream);
    }
  };

  const promise = (async () => {
    status = "running";
    if (options?.playbackGated && encodePlaybackGate.getPolicy() === "pause") {
      // No new transcode starts while a video plays under `pause`.
      waitAbort = new AbortController();
      waitingToStart = true;
      emitSuspended();
      const runnable = await encodePlaybackGate.whenRunnable(waitAbort.signal);
      waitingToStart = false;
      waitAbort = null;
      emitSuspended();
      if (!runnable || cancelled) {
        status = "cancelled";
        error = new Error("ffmpeg cancelled before it started (waiting for playback to end)");
        throw error;
      }
    }
    const res = await spawnCommand(options?.ffmpegPath ?? "ffmpeg", finalArgs, {
      cwd: options?.cwd,
      env: options?.env,
      stdin: options?.stdin ?? null,
      niceness: options?.niceness,
      playbackGated: options?.playbackGated,
      captureStdout: !progressEnabled || progressOutput !== "stdout",
      captureStderr: !progressEnabled || progressOutput !== "stderr",
      onStdout: (line) => handleLine(line, "stdout"),
      onStderr: (line) => handleLine(line, "stderr"),
      onStart: (controller) => {
        cancelFn = controller.kill;
        childFrozen = controller.gate.isSuspended();
        controller.gate.onSuspendedChange((frozen) => {
          childFrozen = frozen;
          emitSuspended();
        });
        if (childFrozen) emitSuspended();
        options?.onSpawn?.({ pid: controller.pid });
        // cancel() can land while spawnCommand awaits the setpriv probe, before
        // any kill handle exists: kill the child as soon as it has one.
        if (cancelled) controller.kill();
      },
    });

    result = res;
    if (res.stdinSourceError !== undefined) {
      // Checked before the exit code: the child was SIGKILLed for it, and on
      // the node path a signal exit even reads as code 0.
      const cause = res.stdinSourceError;
      status = cancelled ? "cancelled" : "failed";
      error = new Error(`ffmpeg stdin source failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
        cause,
      });
      throw error;
    }
    if (res.code !== 0) {
      status = cancelled ? "cancelled" : "failed";
      error = new Error(res.stderr || `ffmpeg exited with code ${res.code}`);
      throw error;
    }
    status = "finished";
    return res;
  })();

  return {
    get status() {
      return status;
    },
    get stats() {
      return stats;
    },
    get error() {
      return error;
    },
    get result() {
      return result;
    },
    promise,
    cancel: () => {
      if (status !== "running") return;
      cancelled = true;
      status = "cancelled";
      waitAbort?.abort();
      cancelFn?.();
    },
    isSuspended,
    onSuspendedChange: (listener) => {
      suspendListeners.add(listener);
      return () => {
        suspendListeners.delete(listener);
      };
    },
  };
};

export const runFfmpeg = async (
  args: string[],
  options?: CommandOptions & {
    progress?: ProgressOptions;
    /**
     * Kill the child and reject if it is still running after this many
     * milliseconds. Used by short capability probes so a wedged driver can't
     * hang the caller forever.
     */
    timeoutMs?: number;
  }
) => {
  const task = createFfmpegTask(args, options);
  const timeoutMs = options?.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) return task.promise;
  let timedOut = false;
  // The budget is RUNNING time: while the playback policy has the child frozen
  // (or the task is waiting to start), the clock stops, so a frozen encode is
  // never "timed out" and killed. Resumes with whatever budget was left.
  let remainingMs = timeoutMs;
  let armedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    armedAt = Date.now();
    timer = setTimeout(() => {
      timedOut = true;
      task.cancel();
    }, Math.max(1, remainingMs));
  };
  const disarm = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    remainingMs -= Date.now() - armedAt;
  };
  const stopListening = task.onSuspendedChange((suspended) => (suspended ? disarm() : timer === null && arm()));
  if (!task.isSuspended()) arm();
  try {
    const result = await task.promise;
    // ffmpeg handles SIGTERM by finalising and exiting 0, so a killed run can
    // "succeed" — a timeout must still be reported as a failure.
    if (timedOut) throw new Error(`ffmpeg timed out after ${timeoutMs}ms`);
    return result;
  } catch (err) {
    if (timedOut) throw new Error(`ffmpeg timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    stopListening();
    disarm();
  }
};

export type FfprobeStream = Record<string, unknown> & {
  index?: number;
  codec_name?: string;
  codec_long_name?: string;
  codec_type?: string;
  codec_tag_string?: string;
  codec_tag?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  duration?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  time_base?: string;
  tags?: Record<string, unknown>;
  language?: string | null;
  title?: string | null;
};

export type FfprobeFormat = Record<string, unknown> & {
  filename?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  format_name?: string;
  format_long_name?: string;
  tags?: Record<string, unknown>;
};

export type FfprobeData = {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
};

export type FfprobeResult<T extends FfprobeData = FfprobeData> = {
  data: T;
  streams: FfprobeStream[];
};

const normalizeProbeStream = (stream: Record<string, unknown>) => {
  const tags = (stream.tags ?? {}) as Record<string, unknown>;
  const language =
    (tags.language as string | undefined) ??
    (tags.LANGUAGE as string | undefined) ??
    null;
  const title =
    (tags.title as string | undefined) ??
    (tags.TITLE as string | undefined) ??
    null;
  return { ...stream, language, title };
};

export const runFfprobe = async <T extends FfprobeData = FfprobeData>(
  args: string[],
  options?: CommandOptions
): Promise<FfprobeResult<T>> => {
  const result = await spawnCommand(options?.ffprobePath ?? "ffprobe", args, {
    cwd: options?.cwd,
    env: options?.env,
    captureStdout: true,
    captureStderr: true,
    niceness: options?.niceness,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || `ffprobe exited with code ${result.code}`);
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) {
    throw new Error("ffprobe returned empty output");
  }
  try {
    const data = JSON.parse(trimmed) as T;
    const streamsRaw = (data as { streams?: Record<string, unknown>[] }).streams ?? [];
    const streams = streamsRaw.map(normalizeProbeStream);
    return { data, streams };
  } catch {
    throw new Error("ffprobe returned invalid JSON");
  }
};

export {
  createEncodePlaybackGate,
  encodePlaybackGate,
  type ChildGate,
  type EncodePlaybackGate,
  type EncodePlaybackPolicy,
} from "./playbackGate";

export {
  backgroundEncodePriority,
  buildFfmpegThreadArgs,
  createBackgroundPriorityController,
  FFMPEG_BACKGROUND_NICENESS,
  FFMPEG_MAX_THREADS,
  FFMPEG_NICE_ENV,
  FFMPEG_PLAYBACK_ACTIVE_NICENESS,
  FFMPEG_RESERVED_CORES,
  FFMPEG_THREADS_ENV,
  resolveFfmpegNiceness,
  resolveFfmpegThreads,
  type BackgroundPriorityController,
  type BackgroundPriorityDeps,
} from "./resourcePolicy";

/**
 * Test-only surface for the internal stream-pump helpers. Not part of
 * the public API — exists so the regression tests for the Bun FileSink
 * crash (see `pumpBunSink` JSDoc) can run without spawning ffmpeg.
 */
export const __testOnly = {
  pumpBunSink,
};

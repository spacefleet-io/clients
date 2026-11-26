import { constants, getPriority, setPriority } from "node:os";
import { getDesktopPlatform } from "@space/desktop-platform";
import { getEffectiveCpuCount } from "./hostCpu";

/**
 * Resource policy for background ffmpeg work (ingest transcodes, add-quality
 * retranscodes, previews, probes).
 *
 * Reference hardware is a 5-10 year old 4-core Core i5 with 8 GB RAM and no
 * usable GPU encoder: libx264/libx265 on the CPU while the user is playing
 * something back through mpv. Every ffmpeg we spawn therefore:
 *   1. runs below normal priority, so mpv + the UI win every contended
 *      scheduling decision (the encode only gets what playback leaves idle);
 *   2. is capped to `cores - 2` worker threads (decoder, filter graph and
 *      encoder), so two cores are never claimed by the encode;
 * and the engine additionally limits concurrent encodes on low core counts
 * (see `clampLaneCapsForHost` in packages/runtime-jobs-engine/src/engineV2Lanes.ts).
 */

/**
 * Cores that background encodes never claim. Playback (mpv decode + vo), the
 * renderer and the runtime's own event loop live there.
 */
export const FFMPEG_RESERVED_CORES = 2;

/**
 * Upper bound on encoder worker threads. x264/x265 stop scaling long before
 * this; the cap only keeps very wide hosts (32+ threads) from spawning an
 * absurd thread pool per ffmpeg for no throughput gain.
 */
export const FFMPEG_MAX_THREADS = 16;

/**
 * Default niceness for background ffmpeg/ffprobe children.
 *
 * 10 = `os.constants.priority.PRIORITY_BELOW_NORMAL`. That is deliberate:
 * libuv maps `os.setPriority` values onto Windows priority classes in coarse
 * steps (19 → IDLE, 10 → BELOW_NORMAL, 0 → NORMAL, ...), so any value in
 * 1..9 silently stays at NORMAL on Windows. On Linux/macOS nice 10 gives the
 * encode roughly a tenth of an unniced thread's CPU weight while both compete
 * for the same core, and exactly as much as it wants when a core is idle.
 */
export const FFMPEG_BACKGROUND_NICENESS: number = constants.priority.PRIORITY_BELOW_NORMAL;

/**
 * Niceness for background ffmpeg children while the user is watching
 * something (an active playback session). 19 = `PRIORITY_LOW`, which libuv
 * maps to the IDLE priority class on Windows: the encode then only runs on
 * CPU that mpv, the renderer and the runtime leave unused. On Linux nice 19
 * gets ~1.5 % of a nice-0 thread's weight on a contended core (nice 10 gets
 * ~10 %), and still all of an idle core.
 */
export const FFMPEG_PLAYBACK_ACTIVE_NICENESS: number = constants.priority.PRIORITY_LOW;

/** Env knob: override the niceness applied to ffmpeg children (integer, `0` = normal priority). */
export const FFMPEG_NICE_ENV = "SF_FFMPEG_NICE";
/** Env knob: override the ffmpeg worker-thread cap (integer; `0` = let ffmpeg pick, i.e. one per core or more). */
export const FFMPEG_THREADS_ENV = "SF_FFMPEG_THREADS";

const parseIntegerEnv = (raw: string | undefined): number | null => {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
};

/**
 * Niceness to apply to ffmpeg children. `SF_FFMPEG_NICE` wins when it is a
 * valid integer in libuv's -20..19 range (operator knob, both with and
 * without playback). Otherwise below-normal, or lowest/IDLE while a playback
 * session is active.
 */
export const resolveFfmpegNiceness = (
  env: Record<string, string | undefined> = process.env,
  playbackActive: boolean = backgroundEncodePriority.isPlaybackActive()
): number => {
  const override = parseIntegerEnv(env[FFMPEG_NICE_ENV]);
  if (override != null && override >= -20 && override <= 19) return override;
  return playbackActive ? FFMPEG_PLAYBACK_ACTIVE_NICENESS : FFMPEG_BACKGROUND_NICENESS;
};

export type BackgroundPriorityDeps = {
  setPriority: (pid: number, value: number) => void;
  /** Niceness of this process: children are never raised above it. */
  getOwnPriority: () => number;
  /**
   * Kernel thread ids of `pid` (`getDesktopPlatform().processes.listThreadIds`).
   * Where niceness is per THREAD (Linux: `setpriority(PRIO_PROCESS, pid)` only
   * touches the thread whose tid is `pid`), re-prioritising a running encoder
   * means touching every x264/x265 worker thread; elsewhere it is `[pid]`.
   */
  listThreadIds: (pid: number) => number[];
  env: Record<string, string | undefined>;
  info: (message: string, data: Record<string, unknown>) => void;
  warn: (message: string, data: Record<string, unknown>) => void;
};

export type BackgroundPriorityController = {
  isPlaybackActive: () => boolean;
  /**
   * Lower a freshly spawned background child to the current policy niceness
   * and keep re-prioritising it on playback transitions until the returned
   * `untrack` runs (call it when the child exits). `override` (an explicit
   * per-spawn niceness) pins the child: it is applied once and never moved.
   */
  track: (pid: number | undefined, override?: number) => () => void;
  /**
   * Playback started (`true`) or the last session ended (`false`). Every
   * tracked, non-pinned child is re-prioritised immediately; children
   * spawned later start at the new level.
   */
  setPlaybackActive: (active: boolean, context?: Record<string, unknown>) => void;
  trackedCount: () => number;
};

/**
 * Process-wide background-encode priority: the "throttle encodes while the
 * user is watching" half of P23 (ultimate confirm run 2026-10-07: background
 * format encodes competed with mpv for the same cores for whole sessions).
 *
 * Linux/macOS caveat: an unprivileged process may lower a child's priority
 * but not raise it back, so a child reniced to 19 during playback can stay
 * at 19 until it exits (logged once). That costs nothing when the machine is
 * otherwise idle — nice only matters under contention — and children spawned
 * after playback start at the normal background level again. Windows
 * priority classes move freely both ways.
 */
export const createBackgroundPriorityController = (
  overrides: Partial<BackgroundPriorityDeps> = {}
): BackgroundPriorityController => {
  const deps: BackgroundPriorityDeps = {
    setPriority,
    getOwnPriority: () => getPriority(0),
    listThreadIds: (pid) => getDesktopPlatform().processes.listThreadIds(pid),
    env: process.env,
    info: (message, data) => console.info(message, data),
    warn: (message, data) => console.warn(message, data),
    ...overrides,
  };
  let playbackActive = false;
  const children = new Map<number, { pinned: boolean }>();
  let applyFailureLogged = false;

  /** Returns the number of threads that could NOT be set. */
  const apply = (pid: number, niceness: number): number => {
    // `setPriority` is absolute. Never RAISE the child above its parent: a
    // runtime launched already niced (service manager, `nice`, a low-priority
    // launcher) must not have its ffmpeg children jump ahead of it.
    const value = Math.max(niceness, deps.getOwnPriority());
    const ids = deps.listThreadIds(pid);
    let failed = 0;
    let firstError: string | null = null;
    for (const id of ids) {
      try {
        deps.setPriority(id, value);
      } catch (err) {
        failed += 1;
        firstError ??= err instanceof Error ? err.message : String(err);
      }
    }
    if (failed > 0 && !applyFailureLogged) {
      applyFailureLogged = true;
      deps.warn("[ffmpeg] could not change child priority (logged once)", {
        pid,
        niceness: value,
        threads: ids.length,
        failed,
        error: firstError,
        playbackActive,
      });
    }
    return failed;
  };

  return {
    isPlaybackActive: () => playbackActive,
    track: (pid, override) => {
      if (typeof pid !== "number") return () => {};
      const pinned = override !== undefined;
      const niceness = override ?? resolveFfmpegNiceness(deps.env, playbackActive);
      if (niceness !== 0) apply(pid, niceness);
      children.set(pid, { pinned });
      return () => {
        children.delete(pid);
      };
    },
    setPlaybackActive: (active, context = {}) => {
      if (active === playbackActive) return;
      playbackActive = active;
      const niceness = resolveFfmpegNiceness(deps.env, active);
      let reniced = 0;
      let failed = 0;
      for (const [pid, child] of children) {
        if (child.pinned || niceness === 0) continue;
        if (apply(pid, niceness) === 0) reniced += 1;
        else failed += 1;
      }
      deps.info("[ffmpeg] background encode priority", {
        playbackActive: active,
        niceness,
        tracked: children.size,
        reniced,
        failed,
        ...context,
      });
    },
    trackedCount: () => children.size,
  };
};

/** The runtime-wide controller every `@space/ffmpeg` spawn registers with. */
export const backgroundEncodePriority: BackgroundPriorityController = createBackgroundPriorityController();

/**
 * Worker threads a single background ffmpeg may use: `cores - 2`, clamped to
 * `[1, FFMPEG_MAX_THREADS]`. `cores` defaults to the effective CPU count
 * (`getEffectiveCpuCount` in `./hostCpu`: affinity / cpuset, clamped by a
 * cgroup v2 `cpu.max` quota), never `os.cpus().length`.
 *
 * Returns `0` when the operator disabled the cap (`SF_FFMPEG_THREADS=0`),
 * meaning "do not pass any thread flags".
 */
export const resolveFfmpegThreads = (
  cores: number = getEffectiveCpuCount().count,
  env: Record<string, string | undefined> = process.env
): number => {
  const override = parseIntegerEnv(env[FFMPEG_THREADS_ENV]);
  if (override != null && override >= 0) return Math.min(override, 256);
  const usable = Number.isFinite(cores) ? Math.trunc(cores) : 1;
  return Math.min(FFMPEG_MAX_THREADS, Math.max(1, usable - FFMPEG_RESERVED_CORES));
};

/**
 * Thread-limiting flags for a video re-encode, split by where they belong on
 * the ffmpeg command line:
 *   - `input`  — before `-i`: caps the (software) decoder's thread pool;
 *   - `output` — after `-i`, before the output: caps the encoder
 *     (`-threads`) and the filter graph's slice threads (`-filter_threads`,
 *     which drives `scale`).
 *
 * `softwareEncoder` gates the encoder-side flags: hardware encoders have no
 * CPU worker pool, but their CPU-side decode + filter work is still capped
 * through `input` and `-filter_threads`.
 *
 * `x265` additionally emits `-x265-params pools=N`. libx265 ignores
 * ffmpeg's `-threads` for its worker pool (measured on a 4-core affinity
 * mask: `-threads 2` still used 3.2 cores, `pools=2` used 2.1), so its pool
 * has to be capped through its own parameter.
 */
export const buildFfmpegThreadArgs = (
  options: { threads?: number; softwareEncoder: boolean; x265?: boolean } = { softwareEncoder: true }
): { input: string[]; output: string[] } => {
  const threads = options.threads ?? resolveFfmpegThreads();
  if (threads <= 0) return { input: [], output: [] };
  const n = String(threads);
  const encoderFlags = options.softwareEncoder
    ? ["-threads", n, ...(options.x265 ? ["-x265-params", `pools=${n}`] : [])]
    : [];
  return {
    input: ["-threads", n],
    output: [...encoderFlags, "-filter_threads", n],
  };
};

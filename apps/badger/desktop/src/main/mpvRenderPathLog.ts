import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyMpvRenderPath,
  describeMpvRenderPath,
  parseMpvRenderLog,
  readMpvRenderPath,
  type MpvRenderClass,
  setProperty,
  type MpvRenderLog,
  type MpvSend,
} from "@space/mpv-protocol";

export type MpvRenderPathLog = {
  info: (fields: object, msg: string) => void;
  warn: (fields: object, msg: string) => void;
};

export type MpvLaunchLogFileInput = {
  /** Debug/dev logging or SF_MPV_EXTERNAL_LOG=1 / SF_MPV_EXTERNAL_LOG_FILE set. */
  shouldLog: boolean;
  /** SF_MPV_EXTERNAL_LOG_FILE (trimmed). */
  logFileEnv: string | undefined;
  tmp: string;
  /** The app's pid: a transient log carries it, so a later start can tell an orphan from a live launch. */
  pid: number;
  now: number;
};

export type MpvLaunchLogFile = {
  path: string;
  /** false: production's transient log, deleted when mpv exits (or by the next start's sweep after a crash). */
  keep: boolean;
};

/**
 * Every launch writes an mpv log (#25): the GPU name, the software GL mpv
 * rejected and a d3d11 WARP device are only in it, and the render-path line
 * needs them in production too. Without debug logging it is transient, and
 * createMpvRenderPathReporter closes it (`set_property log-file ""`) once that
 * line is logged.
 *
 * Cost (Linux test machine, mpv 0.41): ~100-250 KB at startup; while open, a few KB/s
 * (the log file is always debug level, --msg-level cannot lower it). Closing
 * it at runtime was checked not to hang mpv 0.41 (#25: Linux NVIDIA 18 runs,
 * Windows d3d11 90 runs; IPC kept answering in <3 ms, playback continued,
 * nothing written after the close).
 */
export const planMpvLaunchLogFile = (input: MpvLaunchLogFileInput): MpvLaunchLogFile => {
  if (input.logFileEnv) return { path: input.logFileEnv, keep: true };
  if (input.shouldLog) return { path: join(input.tmp, `sf-mpv-external-${input.now}.log`), keep: true };
  return { path: join(input.tmp, `sf-mpv-transient-${input.pid}-${input.now}.log`), keep: false };
};

const TRANSIENT_LOG_NAME = /^sf-mpv-transient-(\d+)-\d+\.log$/;

export type MpvLaunchLogSweepInput = {
  tmp: string;
  /** Whether the app process that wrote a transient log still runs (this one, or another instance). */
  isAlive: (pid: number) => boolean;
  log: MpvRenderPathLog;
  remove?: (path: string) => Promise<void>;
};

/**
 * App start: delete the transient mpv logs whose app process is gone. mpv's
 * exit handler deletes them normally; an app crash or kill skips it, and
 * Windows never clears %TEMP%. Kept (debug) logs are never touched. Never throws.
 */
export const sweepStaleMpvLaunchLogs = async (input: MpvLaunchLogSweepInput): Promise<void> => {
  const remove = input.remove ?? ((path: string) => rm(path, { force: true }));
  let names: string[];
  try {
    names = await readdir(input.tmp);
  } catch (error) {
    input.log.warn({ tmp: input.tmp, error: error instanceof Error ? error.message : String(error) }, "stale transient mpv logs not swept");
    return;
  }
  let removed = 0;
  let kept = 0;
  for (const name of names) {
    const pid = TRANSIENT_LOG_NAME.exec(name)?.[1];
    if (pid === undefined) continue;
    if (input.isAlive(Number(pid))) {
      kept += 1;
      continue;
    }
    const path = join(input.tmp, name);
    try {
      await remove(path);
      removed += 1;
    } catch (error) {
      input.log.warn({ logFile: path, error: error instanceof Error ? error.message : String(error) }, "stale transient mpv log not removed");
    }
  }
  input.log.info({ removed, kept }, "stale transient mpv logs swept");
};

/** `process.kill(pid, 0)`: true while the process exists (EPERM = exists, owned by someone else). */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readRenderLog = async (logFile: string | null): Promise<MpvRenderLog | undefined> => {
  if (logFile === null) return undefined;
  try {
    return parseMpvRenderLog(await readFile(logFile, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * One production log line per file mpv plays (#25, MPV-GPU-02 #448) with the
 * render path mpv ended up on: GPU vo or the CPU fallback, the GPU context,
 * the hardware decoder ("no" = software), and from the launch's mpv log file
 * the GPU it rendered on, the software GL it rejected, a d3d11 WARP device.
 * Call it on each file's first frame: hwdec-current has no decoder to report
 * on before, and it is per file (one mpv process plays the next episode and
 * every ABR reload, and another codec can fall back to software). Call
 * `startFile()` on mpv's start-file: the next report then logs again; a
 * report with the same values as the last line in the same file is skipped
 * (like Android's MpvPlaybackReport). `closeLog` (transient logs) and
 * `onRenderPath` (the GPU probe memory, mpvGpuMemory.ts) act on the launch's
 * first report only: the log exists for that first line, and the GPU memory
 * learns one verdict per launch. `onRenderPath` is not called when the path
 * could not be read.
 * @bugfix mpv-transient-log-written-all-session
 * @bugfix mpv-render-path-logged-once-per-launch
 */
export const createMpvRenderPathReporter = (deps: {
  send: MpvSend;
  log: MpvRenderPathLog;
  launchId: number;
  logFile: string | null;
  closeLog: boolean;
  onRenderPath?: (renderClass: MpvRenderClass, description: string) => void;
}) => {
  let launchReported = false;
  // Fields of the last line logged since the last start-file; null = log the next one.
  let lastLogged: string | null = null;
  const report = async (): Promise<void> => {
    try {
      const path = await readMpvRenderPath(deps.send);
      const renderLog = await readRenderLog(deps.logFile);
      const renderClass = classifyMpvRenderPath(path, renderLog);
      const description = describeMpvRenderPath(path, renderLog);
      const fields = {
        launchId: deps.launchId,
        ...path,
        ...renderClass,
        renderer: renderLog?.renderer ?? null,
        softwareRejected: renderLog?.softwareRejected ?? [],
        softwareAdapter: renderLog?.softwareAdapter ?? false,
      };
      const signature = JSON.stringify(fields);
      if (signature === lastLogged) return;
      lastLogged = signature;
      deps.log.info(fields, `mpv render path: ${description}`);
      if (launchReported) return;
      launchReported = true;
      deps.onRenderPath?.(renderClass, description);
    } catch (error) {
      deps.log.warn({ launchId: deps.launchId, error: error instanceof Error ? error.message : String(error) }, "mpv render path read failed");
      return;
    }
    if (!deps.closeLog || deps.logFile === null) return;
    try {
      if (!(await setProperty(deps.send, "log-file", ""))) {
        deps.log.warn({ launchId: deps.launchId, logFile: deps.logFile }, "transient mpv log not closed");
      }
    } catch (error) {
      deps.log.warn({ launchId: deps.launchId, logFile: deps.logFile, error: error instanceof Error ? error.message : String(error) }, "transient mpv log not closed");
    }
  };
  return Object.assign(report, {
    /** mpv start-file: the next file's first frame logs its render path again. */
    startFile: (): void => {
      lastLogged = null;
    },
  });
};

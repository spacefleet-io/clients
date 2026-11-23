/**
 * Step log sink for engineV2 badger steps (issue #671, R9).
 *
 * The encode / upload libraries report their tool output (ffmpeg stderr,
 * `pct MiB/s eta` upload lines, HW-fallback and probe lines) through an
 * `onLog(line)` callback. The engineV2 steps used to pass a no-op, so the file
 * users send us (`runtime.log`) held nothing about WHY an encode or upload
 * failed. This sink:
 *
 *  - writes every line as `[runtime][job <id>][<step>] <line>`,
 *  - rate-limits progress-style lines (ffmpeg `frame=`/`size=`, upload
 *    `MiB/s`) to one per {@link PROGRESS_LINE_INTERVAL_MS},
 *  - caps the lines written per step run at {@link MAX_LINES_PER_STEP}
 *    (a warning-spamming encoder must not flood the log),
 *  - keeps the last {@link TAIL_LINES} lines (whatever the cap) so the step
 *    can log them next to the error when it throws.
 */

export const PROGRESS_LINE_INTERVAL_MS = 10_000;
export const MAX_LINES_PER_STEP = 1000;
export const TAIL_LINES = 40;

const PROGRESS_LINE = /(^|\]\s*)(frame=|size=\s*\d|time=\d\d:)|MiB\/s|\b\d{1,3}(\.\d+)?%\s*$/;

export const isProgressLine = (line: string): boolean => PROGRESS_LINE.test(line);

export type StepLogSink = {
  /** Pass as the library's `onLog`. */
  onLog(line: string): void;
  /** The last lines seen (oldest first), for a failure report. */
  tail(): string[];
  /** Log the failure together with the tail. Call from the step's catch. */
  logFailure(err: unknown): void;
};

export type StepLogSinkOptions = {
  jobId: string;
  stepKind: string;
  /** Test seam; defaults to `Date.now`. */
  now?: () => number;
  /** Test seam; defaults to `console`. */
  sink?: Pick<Console, "info" | "error">;
};

export const createStepLogSink = (opts: StepLogSinkOptions): StepLogSink => {
  const now = opts.now ?? Date.now;
  const out = opts.sink ?? console;
  const prefix = `[runtime][job ${opts.jobId}][${opts.stepKind}]`;
  const tailBuf: string[] = [];
  let written = 0;
  let suppressed = 0;
  let capNoticeLogged = false;
  let lastProgressAt = Number.NEGATIVE_INFINITY;

  const onLog = (raw: string): void => {
    const line = raw.replace(/\s+$/, "");
    if (line.length === 0) return;
    tailBuf.push(line);
    if (tailBuf.length > TAIL_LINES) tailBuf.shift();
    if (isProgressLine(line)) {
      const t = now();
      if (t - lastProgressAt < PROGRESS_LINE_INTERVAL_MS) return;
      lastProgressAt = t;
    }
    if (written >= MAX_LINES_PER_STEP) {
      suppressed += 1;
      if (!capNoticeLogged) {
        capNoticeLogged = true;
        out.info(
          `${prefix} log cap of ${MAX_LINES_PER_STEP} lines reached; further lines are kept only in the failure tail`
        );
      }
      return;
    }
    written += 1;
    out.info(`${prefix} ${line}`);
  };

  return {
    onLog,
    tail: () => [...tailBuf],
    logFailure: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      out.error(
        `${prefix} failed: ${message}\n${prefix} last ${tailBuf.length} output lines` +
          `${suppressed > 0 ? ` (${suppressed} earlier lines were not logged)` : ""}:\n` +
          tailBuf.map((l) => `${prefix}   ${l}`).join("\n")
      );
    },
  };
};

/**
 * Run a step's tool call with a {@link StepLogSink}: `fn` receives the sink's
 * `onLog`; a throw that is not an abort/cancel logs the failure with the tail
 * of the tool output, then rethrows unchanged.
 */
export const runWithStepLog = async <T>(
  ctx: { job: { jobId: string }; signal: AbortSignal },
  stepKind: string,
  fn: (onLog: (line: string) => void) => Promise<T>
): Promise<T> => {
  const sink = createStepLogSink({ jobId: ctx.job.jobId, stepKind });
  try {
    return await fn(sink.onLog);
  } catch (err) {
    if (!ctx.signal.aborted) sink.logFailure(err);
    throw err;
  }
};

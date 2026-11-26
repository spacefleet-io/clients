/**
 * One retry loop for every app and service (#3350 C10, REL-FAM-03). A failure worth another try waits the longer of
 * the caller's backoff and the wait the failure itself named (its `Retry-After`), so a refusal is never asked again
 * sooner than the service said. Each caller keeps its own policy: which failures pass, the backoff, the longest wait.
 * A caller whose tries answer with a result instead of throwing (an exit code, a "stale" verdict) names the results
 * worth another try with `retryValue`.
 */

export type RetryOptions<T = unknown> = {
  /** Tries in all, the first included; at least 1. */
  attempts: number;
  /** Whether the failure of try `attempt` is worth another try; any other is thrown at once. Default: every failure. */
  retryable?: (error: unknown, attempt: number) => boolean;
  /** Whether the result of try `attempt` is worth another try; the last try's result is returned as it came. Default: none. */
  retryValue?: (value: T, attempt: number) => boolean;
  /** The wait the failure itself named, in seconds (a `Retry-After`), or undefined when it named none. */
  retryAfterSeconds?: (error: unknown) => number | undefined;
  /** The least wait in ms after the failure of try `attempt`, given the wait before it (0 before the second try). Default 0. */
  backoffMs?: (attempt: number, previousWaitMs: number) => number;
  /** The longest wait in ms. Default: none. */
  maxWaitMs?: number;
  /**
   * A wait over `maxWaitMs`: `give-up` throws the failure at once (asked sooner than its `Retry-After`, the service would
   * only refuse again); `cap` waits `maxWaitMs` and tries again. Default `give-up`.
   */
  overMaxWait?: "give-up" | "cap";
  /** Told of each wait before it starts: the try that failed, the wait, its failure (or the result `retryValue` accepted). */
  onRetry?: (retry: { attempt: number; waitMs: number; error?: unknown; value?: T }) => void;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/**
 * Runs `run(attempt)` until it settles, trying again after a failure `retryable` accepts or a result `retryValue`
 * accepts. The last try's failure, a failure that is not retryable, or one whose wait is over `maxWaitMs` with
 * `give-up` is thrown as it came; a result is returned as it came in the same cases.
 */
export const retry = async <T>(run: (attempt: number) => Promise<T>, options: RetryOptions<T>): Promise<T> => {
  const attempts = Math.max(1, Math.floor(options.attempts) || 1);
  const sleep = options.sleep ?? defaultSleep;
  let previousWaitMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    let outcome: { error: unknown } | { value: T };
    try {
      outcome = { value: await run(attempt) };
    } catch (error) {
      if (attempt >= attempts || (options.retryable && !options.retryable(error, attempt))) throw error;
      outcome = { error };
    }
    if ("value" in outcome && (attempt >= attempts || !options.retryValue?.(outcome.value, attempt))) return outcome.value;
    const namedMs = "error" in outcome ? (options.retryAfterSeconds?.(outcome.error) ?? 0) * 1000 : 0;
    let waitMs = Math.max(0, options.backoffMs?.(attempt, previousWaitMs) ?? 0, namedMs);
    if (options.maxWaitMs !== undefined && waitMs > options.maxWaitMs) {
      if ((options.overMaxWait ?? "give-up") === "give-up") {
        if ("error" in outcome) throw outcome.error;
        return outcome.value;
      }
      waitMs = options.maxWaitMs;
    }
    previousWaitMs = waitMs;
    options.onRetry?.({ attempt, waitMs, ...outcome });
    if (waitMs > 0) await sleep(waitMs);
  }
};

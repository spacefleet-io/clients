// A lookup the service refused as busy (429 `rate_limited`, 503 `ticket_store_unavailable` / `upstream_capacity`) is
// asked again after the wait the service named, never sooner, each wait at least twice the one before. The service's
// limits stay as they are: this only spares the user an error for a refusal that a few seconds would have answered.

import { retry } from "@space/shared/retry";
import { MetadataUnavailableError } from "./client";
import { defaultTimers, type Timers } from "./types";

export interface LookupRetryOptions {
  /** Tries in all, the first included. Default 3. */
  attempts?: number;
  /** Longest single wait in seconds; a refusal asking for longer is passed on at once. Default 10. */
  maxWaitSeconds?: number;
  timers?: Timers;
  /** Told of each wait before it starts (seconds, the try that follows it, from 2). */
  onRetry?: (waitSeconds: number, attempt: number, error: MetadataUnavailableError) => void;
}

/**
 * Runs `task`, asking again when it throws `MetadataUnavailableError`: after `Retry-After` (1 s when the service named
 * none), doubled on each refusal in a row. Any other error, the last try's refusal, or a wait over `maxWaitSeconds` is
 * thrown as it came.
 */
export const withLookupRetry = async <T>(task: () => Promise<T>, options: LookupRetryOptions = {}): Promise<T> => {
  const timers = options.timers ?? defaultTimers;
  return retry(task, {
    attempts: options.attempts ?? 3,
    retryable: (error) => error instanceof MetadataUnavailableError,
    retryAfterSeconds: (error) => (error instanceof MetadataUnavailableError ? error.retryAfterSeconds : undefined),
    backoffMs: (_attempt, previousWaitMs) => Math.max(1000, previousWaitMs * 2),
    maxWaitMs: (options.maxWaitSeconds ?? 10) * 1000,
    overMaxWait: "give-up",
    onRetry: ({ attempt, waitMs, error }) => {
      if (error instanceof MetadataUnavailableError) options.onRetry?.(waitMs / 1000, attempt + 1, error);
    },
    sleep: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      timers.setTimeout(resolve, ms);
      return promise;
    },
  });
};

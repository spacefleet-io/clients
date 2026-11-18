// A lookup the service refused as busy (429 `rate_limited`, 503 `ticket_store_unavailable` / `upstream_capacity`) is
// asked again after the wait the service named, never sooner, each wait at least twice the one before. The service's
// limits stay as they are: this only spares the user an error for a refusal that a few seconds would have answered.

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
  const attempts = Math.max(1, options.attempts ?? 3);
  const maxWaitSeconds = options.maxWaitSeconds ?? 10;
  const timers = options.timers ?? defaultTimers;
  let previousWait = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (!(error instanceof MetadataUnavailableError) || attempt >= attempts) throw error;
      const wait = Math.max(error.retryAfterSeconds ?? 1, previousWait * 2, 1);
      if (wait > maxWaitSeconds) throw error;
      previousWait = wait;
      options.onRetry?.(wait, attempt + 1, error);
      await new Promise<void>((resolve) => timers.setTimeout(resolve, wait * 1000));
    }
  }
};

import { retry } from "@space/shared/retry";

export type RetryOptions = {
  attempts: number;
  baseDelayMs?: number;
  /** Return false to stop retrying and throw immediately (e.g. a final 402 `subscription_unpaid`). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
};

export const runWithRetries = async <T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions
) => {
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 0));
  try {
    return await retry(fn, {
      attempts: options.attempts,
      retryable: options.shouldRetry,
      backoffMs: (attempt) => baseDelayMs * attempt,
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error("retry_failed");
  }
};

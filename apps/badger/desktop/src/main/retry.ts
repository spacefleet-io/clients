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
  const attempts = Math.max(1, Math.floor(options.attempts));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 0));
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      if (options.shouldRetry && !options.shouldRetry(error, attempt)) break;
      const delay = baseDelayMs > 0 ? baseDelayMs * attempt : 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("retry_failed");
};

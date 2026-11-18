/**
 * Exponential backoff schedule for the library SSE stream.
 * Pure module so it can be imported from `.test.ts` files without forcing the
 * vitest transformer down the JSX path.
 */
export const STREAM_BACKOFF_BASE_MS = 1_000;
export const STREAM_BACKOFF_CAP_MS = 30_000;

export const computeStreamBackoff = (attempts: number): number => {
  if (attempts < 0) return STREAM_BACKOFF_BASE_MS;
  const delay = STREAM_BACKOFF_BASE_MS * Math.pow(2, attempts);
  return Math.min(delay, STREAM_BACKOFF_CAP_MS);
};

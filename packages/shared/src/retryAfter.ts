/** One year: the longest `Retry-After` honoured, whichever form it came in. */
export const MAX_RETRY_AFTER_SECONDS = 31_536_000;

/**
 * Parses a `Retry-After` header (delta seconds or HTTP date, RFC 9110 §10.2.3) into whole seconds >= 0, capped at a
 * year; undefined when absent or unreadable. A date in the past reads 0.
 */
export function parseRetryAfterSeconds(header: string | null | undefined, nowMs: number): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/u.test(value)) return Math.min(Number(value), MAX_RETRY_AFTER_SECONDS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, Math.ceil((at - nowMs) / 1000)), MAX_RETRY_AFTER_SECONDS);
}

/**
 * Retries a user-started metadata lookup (import search, Add to library) through the service's passing failures:
 * - `MetadataUnavailableError`: a 429 past the lookup pacer, a 503 outbound cap or ticket store. Waits its
 *   `Retry-After`, at least an exponential backoff.
 * - a 5xx `MetadataRequestError`: the service failed this one request (a restart, for one).
 * - a network failure: fetch rejects with a `TypeError` when the connection drops.
 * The others wait the exponential backoff. Any other error (no ticket, a refused ticket, a 4xx, a bad answer), or the
 * last attempt's, is thrown at once: waiting would not change it.
 */
import { MetadataRequestError, MetadataUnavailableError } from "@space/metadata-client";
import { retry } from "@space/shared/retry";

export const METADATA_RETRY_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;
const MAX_WAIT_MS = 30_000;

export const withMetadataRetry = <T>(
  run: () => Promise<T>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> =>
  retry(run, {
    attempts: options.attempts ?? METADATA_RETRY_ATTEMPTS,
    retryable: (error) =>
      error instanceof MetadataUnavailableError ||
      (error instanceof MetadataRequestError && error.status >= 500) ||
      error instanceof TypeError,
    retryAfterSeconds: (error) => (error instanceof MetadataUnavailableError ? error.retryAfterSeconds : undefined),
    backoffMs: (attempt) => BASE_BACKOFF_MS * 2 ** (attempt - 1),
    // INGS-RESUME-01: a lookup the user started waits at most 30 s, then asks again rather than failing outright.
    maxWaitMs: MAX_WAIT_MS,
    overMaxWait: "cap",
    sleep: options.sleep,
  });

/** How long one automatic lookup attempt may go unanswered before the import gives up on it (INGS-IDENT-02). */
export const METADATA_LOOKUP_TIMEOUT_MS = 20_000;

/** A lookup attempt got no answer within its deadline. Not retried: the import shows a final state instead. */
export class MetadataLookupTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`metadata lookup did not answer within ${timeoutMs} ms`);
    this.name = "MetadataLookupTimeoutError";
  }
}

/**
 * Settles with `run()`, or rejects with `MetadataLookupTimeoutError` once `timeoutMs` passes without an answer, so a
 * lookup that never answers ends in a final state rather than a spinner forever. A late answer is ignored.
 */
export const withMetadataTimeout = <T>(run: () => Promise<T>, timeoutMs = METADATA_LOOKUP_TIMEOUT_MS): Promise<T> => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new MetadataLookupTimeoutError(timeoutMs)), timeoutMs);
  run().then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    }
  );
  return promise;
};

/**
 * Rejects when `promise` has not settled within `ms`. The request itself is not cancelled (RN's `fetch`
 * has no timeout and the shared API client takes no signal): the caller just stops waiting for it.
 *
 * The message carries "Network request failed" so a stalled request is classified exactly like a refused one
 * (offline banner, retry on network recovery) by the library store's error helpers.
 */
export const withNetworkTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Network request failed: ${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

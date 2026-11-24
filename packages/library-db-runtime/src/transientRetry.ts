import { retry } from "@space/shared/retry";

/**
 * STOR-BW-14: a library database sync never fails because the link was busy. A transfer whose session dropped, timed out or got a 5xx is
 * tried again (the gateway serves library data first at every load level, so the retry is served at once) instead of failing the whole sync.
 * A refusal (4xx other than 429) or a gateway download error code is final: retrying only delays the failure.
 */
export const TRANSIENT_RETRY_ATTEMPTS = 3;

export const isPermanentTransferError = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  return (typeof status === "number" && status >= 400 && status < 500 && status !== 429) || message.startsWith("TUNNEL_DOWNLOAD_ERROR_");
};

export const retryTransient = <T>(
  run: () => Promise<T>,
  onRetry: (attempt: number, error: unknown) => void = () => undefined,
  delayMs = 250
): Promise<T> =>
  retry(run, {
    attempts: TRANSIENT_RETRY_ATTEMPTS,
    retryable: (error) => !isPermanentTransferError(error),
    backoffMs: (attempt) => delayMs * attempt,
    onRetry: ({ attempt, error }) => onRetry(attempt, error),
  });

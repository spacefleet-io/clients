/**
 * `subscription_unpaid` handling (#145 step 5).
 *
 * The API and the storage gateway answer 402 `{ error: "subscription_unpaid", wipeAt }`
 * for playback and upload once the paid period ended. Both `ApiError` (api.ts)
 * and `StorageTunnelError` (storageTunnel.ts) carry `status` + `payload`, so the
 * check is duck-typed and works for either without a circular import.
 */
export const SUBSCRIPTION_UNPAID_CODE = "subscription_unpaid";

type StatusPayloadError = { status?: unknown; payload?: unknown; message?: unknown };

const readPayload = (err: unknown): Record<string, unknown> | null => {
  if (!err || typeof err !== "object") return null;
  const payload = (err as StatusPayloadError).payload;
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
};

export const isSubscriptionUnpaidError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  if ((err as StatusPayloadError).status !== 402) return false;
  const code = readPayload(err)?.error ?? (err as StatusPayloadError).message;
  return code === SUBSCRIPTION_UNPAID_CODE;
};

/** ISO wipe date carried by a `subscription_unpaid` error, or null when absent/invalid. */
export const readSubscriptionUnpaidWipeAt = (err: unknown): string | null => {
  if (!isSubscriptionUnpaidError(err)) return null;
  const wipeAt = readPayload(err)?.wipeAt;
  if (typeof wipeAt !== "string" || Number.isNaN(Date.parse(wipeAt))) return null;
  return wipeAt;
};

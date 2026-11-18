/** HTTP-ish status carried by StorageTunnelError / api errors (`status` field or `api_<status>` message). */
export const errorStatus = (error: unknown): number | null => {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  const match = error instanceof Error ? /^api_(\d{3})$/.exec(error.message) : null;
  return match ? Number(match[1]) : null;
};

/** JSON payload of a StorageTunnelError (e.g. `{error:"subscription_unpaid", wipeAt}`). */
export const errorPayload = (error: unknown): Record<string, unknown> => {
  if (error && typeof error === "object" && "payload" in error && error.payload && typeof error.payload === "object") {
    return Object.fromEntries(Object.entries(error.payload));
  }
  return {};
};

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const isUnauthorizedError = (error: unknown) =>
  errorStatus(error) === 401 || /\b401\b|unauthorized|api_401/i.test(errorMessage(error));

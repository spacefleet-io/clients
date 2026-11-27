const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;

const readErrorStatus = (error: unknown) => {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
};

export const shouldClearSessionFromAuthError = (error: unknown) => {
  const status = readErrorStatus(error);
  return status === STATUS_UNAUTHORIZED || status === STATUS_FORBIDDEN;
};

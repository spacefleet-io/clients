const ACTIONABLE_MESSAGE_PATTERNS = ["Native SQLite binding mismatch"];

export const getActionableDesktopErrorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
  if (!message) return null;
  return ACTIONABLE_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern)) ? message : null;
};

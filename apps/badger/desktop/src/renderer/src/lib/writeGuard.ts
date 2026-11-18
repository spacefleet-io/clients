export const ensureWriteAllowed = (systemIssue: string | null) => {
  if (!systemIssue) return;
  throw new Error(`LIBRARY_WRITE_BLOCKED:${systemIssue}`);
};


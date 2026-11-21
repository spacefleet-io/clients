/**
 * Error message of an offline save the runtime refused for lack of disk space (OFFL-SAFE-02), at the start of the
 * download step: `OFFLINE_INSUFFICIENT_DISK_SPACE:<requiredBytes>:<freeBytes>`. The desktop jobs sidebar reads it back to
 * show the same "Not enough free disk space" message as the download prompt, so both sides share the format.
 */
export const OFFLINE_INSUFFICIENT_DISK_SPACE = "OFFLINE_INSUFFICIENT_DISK_SPACE";

export const offlineDiskSpaceErrorMessage = (requiredBytes: number, freeBytes: number) =>
  `${OFFLINE_INSUFFICIENT_DISK_SPACE}:${Math.max(0, Math.trunc(requiredBytes))}:${Math.max(0, Math.trunc(freeBytes))}`;

export const parseOfflineDiskSpaceError = (
  message: string | null | undefined
): { requiredBytes: number; freeBytes: number } | null => {
  const match = /^OFFLINE_INSUFFICIENT_DISK_SPACE:(\d+):(\d+)$/.exec(message?.trim() ?? "");
  return match ? { requiredBytes: Number(match[1]), freeBytes: Number(match[2]) } : null;
};

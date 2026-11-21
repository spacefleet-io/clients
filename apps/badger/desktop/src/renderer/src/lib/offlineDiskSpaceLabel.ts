import type { TFunction } from "i18next";
import { formatLocalizedStorage, formatLocalizedStorageUsage } from "@space/shared/format";
import { parseOfflineDiskSpaceError } from "@space/shared/offlineDiskSpace";

/**
 * The space a download needs against the space free, ordered as the bytes are (STOR-UNIT-01) and written in the
 * interface language (STOR-UNIT-02); an unknown side is "?".
 */
export const neededAndFree = (
  requiredBytes: number | null | undefined,
  freeBytes: number | null | undefined,
  locale: string,
) => {
  if (requiredBytes == null || freeBytes == null) {
    return {
      required: requiredBytes == null ? "?" : formatLocalizedStorage(requiredBytes, locale),
      free: freeBytes == null ? "?" : formatLocalizedStorage(freeBytes, locale),
    };
  }
  const { used, limit } = formatLocalizedStorageUsage(requiredBytes, freeBytes, locale);
  return { required: used, free: limit };
};

/**
 * "Not enough free disk space (… needed, … free)" for an offline save the runtime refused at the start of its download
 * step (OFFL-SAFE-02), read from the job's error message; null for any other error. The interface language is read
 * only for that error.
 */
export const offlineDiskSpaceJobMessage = (
  error: string | null | undefined,
  t: TFunction,
  locale: () => string,
): string | null => {
  const parsed = parseOfflineDiskSpaceError(error);
  if (!parsed) return null;
  return t(
    "library.offline.modal.errors.insufficient_disk_space",
    neededAndFree(parsed.requiredBytes, parsed.freeBytes, locale()),
  );
};

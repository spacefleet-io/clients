/**
 * How "Download everything" (ACCT-EXPORT-01) reports back: the runtime's answer (or main's refusal) turned into an
 * outcome and its toast. The files land as plain MKV/MP4 at the highest stored quality (OFFL-QUAL-01, never asked)
 * and the app does not track them afterwards; progress shows in the jobs sidebar.
 */
import type { TFunction } from "i18next";
import type { BadgerExportSubmitResult } from "@space/runtime-contracts/badger/export";
import { formatLocalizedStorage } from "@space/shared/format";
import { isExportIpcError, type ExportIpcError } from "./exportIpc";

/** What one export request ended as, for the toast. */
export type ExportOutcome =
  | { kind: "submitted"; count: number; skipped: number; destDir: string }
  | { kind: "failed"; message: string };

/** The user-facing reason for a refused export, from the runtime's or main's error code. */
export const exportErrorMessage = (
  t: TFunction,
  error: { errorCode?: string | null; message?: string | null; requiredBytes?: number; freeBytes?: number },
  locale: string,
): string => {
  switch (error.errorCode) {
    case "insufficient_disk_space":
      return t("library.export.errors.insufficient_disk_space", {
        required: error.requiredBytes == null ? "?" : formatLocalizedStorage(error.requiredBytes, locale),
        free: error.freeBytes == null ? "?" : formatLocalizedStorage(error.freeBytes, locale),
      });
    case "not_authenticated":
    case "library_db_not_open":
    case "dest_not_writable":
    case "dest_not_picked":
    case "nothing_to_export":
      return t(`library.export.errors.${error.errorCode}`);
    default:
      return t("library.export.errors.generic", { reason: error.message ?? error.errorCode ?? "" });
  }
};

/** Maps a submit result (or IPC error) to an outcome. */
export const exportOutcomeFromResult = (
  t: TFunction,
  result: BadgerExportSubmitResult | ExportIpcError,
  destDir: string,
  locale: string,
): ExportOutcome => {
  if (isExportIpcError(result)) return { kind: "failed", message: exportErrorMessage(t, result, locale) };
  if ("errorCode" in result) return { kind: "failed", message: exportErrorMessage(t, result, locale) };
  return { kind: "submitted", count: result.submitted.length, skipped: result.skipped.length, destDir };
};

/** The toast text for an outcome. */
export const exportOutcomeToast = (t: TFunction, outcome: ExportOutcome): string => {
  if (outcome.kind === "failed") return outcome.message;
  return t("library.export.submittedToast", { count: outcome.count, folder: outcome.destDir });
};

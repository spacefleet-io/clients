/**
 * The renderer side of export (OFFL-FILE-01 "Download file", ACCT-EXPORT-01 "Download everything"): pick a folder,
 * then hand the runtime one job per file. The files land as plain MKV/MP4 at the highest stored quality
 * (OFFL-QUAL-01, never asked) and the app does not track them afterwards; progress shows in the jobs sidebar.
 */
import type { TFunction } from "i18next";
import type { BadgerExportSubmitResult, ExportContainer } from "@space/runtime-contracts/badger/export";
import { formatLocalizedStorage } from "@space/shared/format";
import { callExportSubmit, isExportIpcError, pickExportFolder, type ExportIpcError } from "./exportIpc";
import { rendererLogger } from "@/logger";

const exportLog = rendererLogger.child({ scope: "export" });

/** What one export request ended as, for the toast. */
export type ExportOutcome =
  | { kind: "cancelled" }
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

/**
 * "Download file" on a title or an episode: asks for a folder, then exports the title's files straight into it
 * (flat layout, OFFL-FILE-02 names). `fileIds` narrows a show to one episode.
 */
export const exportTitleFiles = async (input: {
  t: TFunction;
  locale: string;
  mediaId: string;
  fileIds?: string[];
  container: ExportContainer;
}): Promise<ExportOutcome> => {
  const { t, locale, mediaId, fileIds, container } = input;
  try {
    const destDir = await pickExportFolder();
    exportLog.info({ mediaId, fileIds: fileIds?.length ?? 0, container, picked: destDir !== null }, "export_folder_picked");
    if (!destDir) return { kind: "cancelled" };
    const result = await callExportSubmit({
      mediaIds: [mediaId],
      ...(fileIds && fileIds.length > 0 ? { fileIds } : {}),
      destDir,
      container,
      layout: "flat",
    });
    const outcome = exportOutcomeFromResult(t, result, destDir, locale);
    exportLog.info({ mediaId, outcome: outcome.kind }, "export_title_submitted");
    return outcome;
  } catch (err) {
    exportLog.warn({ mediaId, error: String(err) }, "export_title_failed");
    return { kind: "failed", message: exportErrorMessage(t, { message: err instanceof Error ? err.message : String(err) }, locale) };
  }
};

/** The toast text for an outcome; null when the user cancelled the folder dialog. */
export const exportOutcomeToast = (t: TFunction, outcome: ExportOutcome): string | null => {
  if (outcome.kind === "cancelled") return null;
  if (outcome.kind === "failed") return outcome.message;
  return t("library.export.submittedToast", { count: outcome.count, folder: outcome.destDir });
};

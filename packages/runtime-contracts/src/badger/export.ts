import { z } from "zod";
import { defineCommand } from "../helpers";

// ---------------------------------------------------------------------------
// Export = plain video files the user keeps (OFFL-FILE-01 "Download file",
// ACCT-EXPORT-01 "Download everything"). Separate from offline playback: an
// exported file lands in a folder the user picked, at the highest stored
// quality (OFFL-QUAL-01, never asked), and the app does not track it (no
// `media_local_downloads` row, not listed under offline content).
//
// Scope: either `all: true` (every title of the library) or `mediaIds`,
// optionally narrowed to `fileIds` (one episode).
// ---------------------------------------------------------------------------

export const exportContainerSchema = z.enum(["mkv", "mp4"]);
export type ExportContainer = z.infer<typeof exportContainerSchema>;

/** `flat`: straight into the picked folder. `library`: Movies/… and Shows/<Show>/Season NN/… */
export const exportLayoutSchema = z.enum(["flat", "library"]);

const exportScopeShape = {
  all: z.boolean().optional(),
  mediaIds: z.array(z.string().min(1)).optional(),
  fileIds: z.array(z.string().min(1)).optional(),
};

const exportSkipReasonSchema = z.enum(["no-quality-available", "no-file"]);

const exportSkippedItemSchema = z.object({
  mediaId: z.string().min(1),
  reason: exportSkipReasonSchema,
});

// ---------------------------------------------------------------------------
// `badger.export.estimate` — what "Download everything" asks the user to
// confirm: how many files, their total size, and the free space on the disk
// of the picked folder.
// ---------------------------------------------------------------------------

export const badgerExportEstimatePayloadSchema = z.object({
  ...exportScopeShape,
  destDir: z.string().min(1),
  container: exportContainerSchema,
});

export const badgerExportEstimateResultSchema = z.object({
  count: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
  freeBytesAvailable: z.number().int().min(0),
  sufficientSpace: z.boolean(),
  skipped: z.array(exportSkippedItemSchema),
});

export const badgerExportEstimate = defineCommand({
  name: "badger.export.estimate" as const,
  module: "badger",
  payloadSchema: badgerExportEstimatePayloadSchema,
  resultSchema: badgerExportEstimateResultSchema,
});

// ---------------------------------------------------------------------------
// `badger.export.submit` — one runtime job (kind `export`) per file. Re-checks
// free space on the destination disk (the user may confirm much later).
// ---------------------------------------------------------------------------

export const badgerExportSubmitPayloadSchema = z.object({
  ...exportScopeShape,
  destDir: z.string().min(1),
  container: exportContainerSchema,
  layout: exportLayoutSchema,
});

const exportSubmittedJobSchema = z.object({
  mediaId: z.string().min(1),
  fileId: z.string().min(1),
  jobId: z.string().min(1),
});

const exportSubmitErrorCodeSchema = z.enum([
  "insufficient_disk_space",
  "library_db_not_open",
  "not_authenticated",
  "dest_not_writable",
  "nothing_to_export",
]);

export const badgerExportSubmitResultSchema = z.union([
  z.object({
    submitted: z.array(exportSubmittedJobSchema),
    skipped: z.array(exportSkippedItemSchema),
  }),
  z.object({
    errorCode: exportSubmitErrorCodeSchema,
    requiredBytes: z.number().int().min(0).optional(),
    freeBytes: z.number().int().min(0).optional(),
  }),
]);

export const badgerExportSubmit = defineCommand({
  name: "badger.export.submit" as const,
  module: "badger",
  payloadSchema: badgerExportSubmitPayloadSchema,
  resultSchema: badgerExportSubmitResultSchema,
});

export type BadgerExportEstimatePayload = z.infer<typeof badgerExportEstimatePayloadSchema>;
export type BadgerExportEstimateResult = z.infer<typeof badgerExportEstimateResultSchema>;
export type BadgerExportSubmitPayload = z.infer<typeof badgerExportSubmitPayloadSchema>;
export type BadgerExportSubmitResult = z.infer<typeof badgerExportSubmitResultSchema>;

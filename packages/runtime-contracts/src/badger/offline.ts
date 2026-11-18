import { z } from "zod";
import { defineCommand } from "../helpers";

// ---------------------------------------------------------------------------
// Quality + container enums used across the offline commands.
//
// An offline quality is a stored rendition label (`1080p`, `720p`, also
// non-preset heights such as `420p` from a 1002x420 ingest). The user picks
// it in the download prompt (OFFL-QUAL-01); there is no default download
// quality. Choice listing and fallback live in
// `@space/shared/offlineQualityChoice`.
// ---------------------------------------------------------------------------

export const offlineQualitySchema = z.string().regex(/^\d{3,4}p$/);

export const offlineContainerSchema = z.enum(["mkv", "mp4"]);
export type OfflineContainer = z.infer<typeof offlineContainerSchema>;

const offlineSkipReasonSchema = z.enum([
  "already-local",
  "no-quality-available",
  "no-file",
]);

// ---------------------------------------------------------------------------
// `badger.offline.estimate_size`
//
// Pre-confirmation modal data: per-item size breakdown, total bytes, free disk
// space, and the human-readable filename that the runtime would write. Also
// reports which subtitle tracks would be dropped under MP4 mode (ASS / PGS
// cannot embed cleanly in MP4 without lossy conversion — we skip them).
//
// Precedence: when `fileIds` is set, `mediaIds` is still required for grouping
// (the runtime walks the libraryDb per mediaId), but the file selection
// narrows to the listed files only — files NOT in `fileIds` are skipped even
// when they belong to one of the supplied `mediaIds`. When `fileIds` is
// absent, ALL files of the requested `mediaIds` are considered (legacy
// behaviour). The renderer uses the narrow form for episode/season scopes
// where the parent show mediaId is sent but only a subset of episode files
// should be measured.
// ---------------------------------------------------------------------------

export const badgerOfflineEstimateSizePayloadSchema = z.object({
  mediaIds: z.array(z.string().min(1)).min(1),
  /** Quality picked in the download prompt (OFFL-QUAL-01). Each file gets
   *  this quality, else its nearest lower one, else its nearest higher one.
   *  Absent: each file at its highest stored quality (the first choice). */
  quality: offlineQualitySchema.optional(),
  container: offlineContainerSchema,
  /** Optional narrow-scope filter. When set, the runtime restricts the
   *  estimate to files whose id is in this list (intersected with the
   *  per-media file enumeration). When absent or empty, all files of the
   *  requested `mediaIds` are considered. */
  fileIds: z.array(z.string().min(1)).optional(),
});

const offlineEstimateItemSchema = z.object({
  mediaId: z.string().min(1),
  fileId: z.string().min(1),
  selectedQuality: offlineQualitySchema,
  videoBytes: z.number().int().min(0),
  audioBytes: z.number().int().min(0),
  subtitleBytes: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
  alreadyLocal: z.boolean(),
  expectedFilename: z.string().min(1),
  /** Subtitle track labels (or languages) that will be dropped because the
   *  selected container (MP4) cannot embed them. Always empty in MKV mode. */
  skippedSubsForContainer: z.array(z.string()),
});

const offlineEstimateSkippedItemSchema = z.object({
  mediaId: z.string().min(1),
  reason: offlineSkipReasonSchema,
});

const offlineQualityChoiceSchema = z.object({
  quality: offlineQualitySchema,
  /** Size of the files still to download when this quality is picked. */
  totalBytes: z.number().int().min(0),
  /** Files without this quality, grouped by the quality they get instead. */
  fallbacks: z.array(z.object({ quality: offlineQualitySchema, count: z.number().int().min(1) })),
});

export const badgerOfflineEstimateSizeResultSchema = z.object({
  items: z.array(offlineEstimateItemSchema),
  skipped: z.array(offlineEstimateSkippedItemSchema),
  totalBytes: z.number().int().min(0),
  freeBytesAvailable: z.number().int().min(0),
  sufficientSpace: z.boolean(),
  /** Every quality the files still to download offer, highest first, with
   *  the batch size at that quality (OFFL-QUAL-01). */
  qualityChoices: z.array(offlineQualityChoiceSchema),
  /** True when one of those files has more than one quality: the
   *  confirmation asks which one. */
  prompt: z.boolean(),
});

export const badgerOfflineEstimateSize = defineCommand({
  name: "badger.offline.estimate_size" as const,
  module: "badger",
  payloadSchema: badgerOfflineEstimateSizePayloadSchema,
  resultSchema: badgerOfflineEstimateSizeResultSchema,
});

// ---------------------------------------------------------------------------
// `badger.offline.download_submit`
//
// Spawns one runtime ingest job per file to download. Returns either the
// submission record (with the new jobIds for renderer subscriptions) or a
// typed error code the modal maps to UI copy. The submit handler re-checks
// free disk space as defense-in-depth — the modal showed the estimate, the
// user could click much later.
//
// Precedence: same as `estimate_size` — when `fileIds` is set, `mediaIds`
// is still required for grouping but the submission narrows to the listed
// files only. When absent, all files of the requested `mediaIds` are
// candidates. The renderer uses the narrow form for episode/season scopes
// to avoid over-downloading adjacent episodes/seasons that share the parent
// show mediaId.
// ---------------------------------------------------------------------------

export const badgerOfflineDownloadSubmitPayloadSchema = z.object({
  mediaIds: z.array(z.string().min(1)).min(1),
  /** Quality picked in the download prompt; same resolution as the estimate. */
  quality: offlineQualitySchema.optional(),
  container: offlineContainerSchema,
  /** Smart-fill toggle — when true (the renderer default for parent scopes),
   *  items that are already locally present are filtered out before submission
   *  rather than rejected. */
  skipAlreadyLocal: z.boolean().default(true),
  /** Optional narrow-scope filter. When set, the runtime restricts submission
   *  to files whose id is in this list (intersected with the per-media file
   *  enumeration). When absent or empty, all files of the requested
   *  `mediaIds` are submitted. */
  fileIds: z.array(z.string().min(1)).optional(),
});

const offlineSubmittedJobSchema = z.object({
  mediaId: z.string().min(1),
  fileId: z.string().min(1),
  jobId: z.string().min(1),
  groupId: z.string().min(1),
});

const offlineSubmitErrorCodeSchema = z.enum([
  "insufficient_disk_space",
  "library_db_not_open",
  "not_authenticated",
]);

export const badgerOfflineDownloadSubmitResultSchema = z.union([
  z.object({
    submitted: z.array(offlineSubmittedJobSchema),
    skipped: z.array(offlineEstimateSkippedItemSchema),
  }),
  z.object({
    errorCode: offlineSubmitErrorCodeSchema,
    requiredBytes: z.number().int().min(0).optional(),
    freeBytes: z.number().int().min(0).optional(),
  }),
]);

export const badgerOfflineDownloadSubmit = defineCommand({
  name: "badger.offline.download_submit" as const,
  module: "badger",
  payloadSchema: badgerOfflineDownloadSubmitPayloadSchema,
  resultSchema: badgerOfflineDownloadSubmitResultSchema,
});

// ---------------------------------------------------------------------------
// `badger.offline.delete_local`
//
// Cancels any in-flight download jobs whose target files fall under the scope,
// unlinks the on-disk files, then drops the matching `media_local_downloads`
// rows. Scopes:
//   - `media` — every file under the mediaId (covers a movie, a TV show
//     entirely, or any other parent-grouping case).
//   - `season` — every file under (mediaId AND seasonNumber). Enumerated via
//     the libraryDb's file list. Used by the season-card hover button on the
//     media details dialog.
//   - `file` — a single file id (used by the per-episode delete button).
// ---------------------------------------------------------------------------

export const badgerOfflineDeleteLocalPayloadSchema = z.object({
  scope: z.discriminatedUnion("type", [
    z.object({ type: z.literal("media"), mediaId: z.string().min(1) }),
    z.object({
      type: z.literal("season"),
      mediaId: z.string().min(1),
      seasonNumber: z.number().int(),
    }),
    z.object({ type: z.literal("file"), fileId: z.string().min(1) }),
  ]),
});

export const badgerOfflineDeleteLocalResultSchema = z.object({
  deleted: z.number().int().min(0),
  freedBytes: z.number().int().min(0),
  cancelledJobIds: z.array(z.string().min(1)),
});

export const badgerOfflineDeleteLocal = defineCommand({
  name: "badger.offline.delete_local" as const,
  module: "badger",
  payloadSchema: badgerOfflineDeleteLocalPayloadSchema,
  resultSchema: badgerOfflineDeleteLocalResultSchema,
});

// ---------------------------------------------------------------------------
// `badger.offline.list_local`
//
// Typed wrapper the renderer uses to hydrate offline badges across dashboard /
// library / media modal without a direct library-DB read path. Filter by
// mediaIds when known (modal open); omit for full-library hydration.
// ---------------------------------------------------------------------------

export const badgerOfflineListLocalPayloadSchema = z.object({
  mediaIds: z.array(z.string().min(1)).optional(),
});

const offlineLocalEntrySchema = z.object({
  mediaId: z.string().min(1),
  fileId: z.string().min(1),
  quality: offlineQualitySchema,
  container: offlineContainerSchema,
  totalBytes: z.number().int().min(0),
  downloadedAt: z.string().min(1),
  localPath: z.string().min(1),
});

export const badgerOfflineListLocalResultSchema = z.object({
  entries: z.array(offlineLocalEntrySchema),
});

export const badgerOfflineListLocal = defineCommand({
  name: "badger.offline.list_local" as const,
  module: "badger",
  payloadSchema: badgerOfflineListLocalPayloadSchema,
  resultSchema: badgerOfflineListLocalResultSchema,
});

// ---------------------------------------------------------------------------
// `badger.offline.reconcile`
//
// Catches the case where the user renamed / moved / deleted a downloaded file
// from outside the app. For each row in `media_local_downloads` (filtered by
// mediaIds when supplied), stat the file; drop rows whose file is gone, or
// whose on-disk size no longer matches the recorded `total_bytes`. Runs on
// runtime start (full sweep) and on media-modal open (targeted sweep).
// ---------------------------------------------------------------------------

export const badgerOfflineReconcilePayloadSchema = z.object({
  mediaIds: z.array(z.string().min(1)).optional(),
});

const offlineDroppedEntrySchema = z.object({
  mediaId: z.string().min(1),
  fileId: z.string().min(1),
  reason: z.enum(["missing", "size_mismatch"]),
});

export const badgerOfflineReconcileResultSchema = z.object({
  dropped: z.array(offlineDroppedEntrySchema),
});

export const badgerOfflineReconcile = defineCommand({
  name: "badger.offline.reconcile" as const,
  module: "badger",
  payloadSchema: badgerOfflineReconcilePayloadSchema,
  resultSchema: badgerOfflineReconcileResultSchema,
});

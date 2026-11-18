/**
 * Phase 2 handlers for the five `badger.offline.*` commands.
 *
 * Each handler is a thin orchestration over the BadgerLibraryDbService +
 * the EngineV2 + the offline-deps registry. Heavy lifting (chunks → decrypt
 * → mux → DB row) lives in `steps/offlineDownload.ts`; this module:
 *
 *   - estimates: walks each requested media, picks the best ≤ preferred
 *     quality available, sums chunk sizes, computes the expected filename,
 *     checks free disk space, and reports `skippedSubsForContainer` for MP4.
 *   - submits: re-runs the estimate (defense-in-depth), then submits one
 *     `IngestJobRecord` per non-skipped file to engineV2 (kind="download").
 *   - deletes: finds matching local rows + non-terminal jobs, cancels jobs
 *     with bounded-poll-until-terminal, unlinks files, drops DB rows.
 *   - lists: pass-through query to `listLocalDownloads`.
 *   - reconciles: stat each row's `local_path`; drop missing or size-mismatched.
 *
 * All five handlers run synchronously w.r.t. the runtime command dispatcher
 * (no background actors). Long-running work is captured in the engineV2
 * download jobs and observed via the existing jobs SSE stream.
 */

import { promises as fs } from "node:fs";
import { statfsSync } from "node:fs";
import { join as joinPath } from "node:path";
import crypto from "node:crypto";
import {
  badgerOfflineEstimateSize,
  badgerOfflineDownloadSubmit,
  badgerOfflineDeleteLocal,
  badgerOfflineListLocal,
  badgerOfflineReconcile,
} from "@space/runtime-contracts/badger/offline";
import {
  listOfflineQualityChoices,
  offlineQualityHeight,
  resolveOfflineQuality,
  type OfflineQualityChoice,
  type OfflineQualityFile,
} from "@space/shared/offlineQualityChoice";
import {
  buildOfflineFilename,
  sanitizeOfflineFilename,
} from "@space/shared/offlineFilename";
import type { EngineV2 } from "../../core/jobs/engineV2";
import type {
  IngestJobRecord,
  IngestJobStatus,
} from "@space/runtime-jobs";
import type { BadgerLibraryDbService } from "../badgerLibraryDb";
import type {
  OfflineDownloadManifest,
  ManifestVideoChunk,
  ManifestAudioTrack,
  ManifestSubtitleTrack,
} from "./steps/offlineDownload";

// Plumb common types for callers in `apps/runtime/src/modules/badger.ts`.
export type OfflineEstimatePayload = ReturnType<
  typeof badgerOfflineEstimateSize.payloadSchema.parse
>;
export type OfflineEstimateResult = ReturnType<
  typeof badgerOfflineEstimateSize.resultSchema.parse
>;
export type OfflineSubmitPayload = ReturnType<
  typeof badgerOfflineDownloadSubmit.payloadSchema.parse
>;
export type OfflineSubmitResult = ReturnType<
  typeof badgerOfflineDownloadSubmit.resultSchema.parse
>;
export type OfflineDeletePayload = ReturnType<
  typeof badgerOfflineDeleteLocal.payloadSchema.parse
>;
export type OfflineDeleteResult = ReturnType<
  typeof badgerOfflineDeleteLocal.resultSchema.parse
>;
export type OfflineListPayload = ReturnType<
  typeof badgerOfflineListLocal.payloadSchema.parse
>;
export type OfflineListResult = ReturnType<
  typeof badgerOfflineListLocal.resultSchema.parse
>;
export type OfflineReconcilePayload = ReturnType<
  typeof badgerOfflineReconcile.payloadSchema.parse
>;
export type OfflineReconcileResult = ReturnType<
  typeof badgerOfflineReconcile.resultSchema.parse
>;

// 100 MB safety margin per the plan §B-4 (the same statfsSync pattern the
// uploads use, so disk-low behaviour stays consistent).
const FREE_DISK_SAFETY_MARGIN_BYTES = 100 * 1024 * 1024;

// MP4-incompatible subtitle formats are reported via the contract's
// `skippedSubsForContainer` field. ASS / SSA / PGS / SUP cannot embed
// cleanly in MP4 without lossy conversion; SRT / VTT pass through to
// `mov_text`. Anything else (unknown) is treated as skippable too.
const isMp4CompatibleSub = (raw: string | null | undefined): boolean => {
  const fmt = (raw ?? "").toLowerCase();
  return fmt === "srt" || fmt === "vtt" || fmt === "webvtt";
};

// ---------------------------------------------------------------------------
// Shared dep contract for all five handlers.
// ---------------------------------------------------------------------------

export interface BadgerOfflineHandlerDeps {
  engine: EngineV2;
  libraryDb: BadgerLibraryDbService;
  /** Returns the active session token. Null when no user is signed in. */
  resolveToken(): string | null;
  /** Returns the library encryption key (base64). Null when no key set. */
  resolveLibraryKey(): string | null;
  /**
   * Returns the absolute path of the per-library offline dir. Used by the
   * estimate handler for the `statfsSync` free-bytes probe and by the
   * delete handler when unlinking files (paths in the DB are absolute, so
   * delete doesn't need it — but reconcile does for `fs.access` checks).
   */
  resolveOfflineDir(libraryId: string): string;
  /**
   * Optional override for the active library id. Defaults to "default" —
   * the desktop runs with a single library per signed-in user today, so a
   * literal "default" is fine for v1; revisit when multi-library lands.
   */
  resolveLibraryId?(): string;
}

const resolveLibraryIdSafe = (deps: BadgerOfflineHandlerDeps): string =>
  deps.resolveLibraryId?.() ?? "default";

// ---------------------------------------------------------------------------
// Estimate handler
// ---------------------------------------------------------------------------

interface EstimateItem {
  mediaId: string;
  fileId: string;
  selectedQuality: string;
  videoBytes: number;
  audioBytes: number;
  subtitleBytes: number;
  totalBytes: number;
  alreadyLocal: boolean;
  expectedFilename: string;
  skippedSubsForContainer: string[];
}

interface SkippedItem {
  mediaId: string;
  reason: "already-local" | "no-quality-available" | "no-file";
}

interface InternalEstimate {
  items: EstimateItem[];
  skipped: SkippedItem[];
  totalBytes: number;
  freeBytesAvailable: number;
  sufficientSpace: boolean;
  qualityChoices: OfflineQualityChoice[];
  prompt: boolean;
  // The full manifest for each ready-to-submit item; reused by submit.
  manifests: Map<string, { manifest: OfflineDownloadManifest; libraryId: string }>;
}

const buildEstimate = async (
  deps: BadgerOfflineHandlerDeps,
  payload: OfflineEstimatePayload
): Promise<InternalEstimate> => {
  const items: EstimateItem[] = [];
  const skipped: SkippedItem[] = [];
  const manifests = new Map<
    string,
    { manifest: OfflineDownloadManifest; libraryId: string }
  >();
  let totalBytes = 0;
  // Files still to download, with the size of each of their qualities (OFFL-QUAL-01).
  const qualityFiles: OfflineQualityFile[] = [];

  if (!deps.libraryDb.isOpen()) {
    throw new Error("LIBRARY_DB_NOT_OPEN");
  }

  // Hydrate every requested media in one library-DB pass per media. The
  // `getMediaDetails` call is cheap enough at the scale the modal opens it
  // (one show or a season's worth, max ~40 episodes).
  const detailsByMediaId = new Map<string, Awaited<ReturnType<NonNullable<typeof deps.libraryDb.call>>>>();
  for (const mediaId of payload.mediaIds) {
    const details = await deps.libraryDb.call("getMediaDetails", [mediaId]);
    detailsByMediaId.set(mediaId, details);
  }

  // Existing local downloads for the entire payload set; lets us mark
  // `alreadyLocal: true` without a per-item DB round trip.
  const existingLocal = await deps.libraryDb.listLocalDownloads(payload.mediaIds);
  const existingByFileId = new Map(existingLocal.map((row) => [row.fileId, row]));

  // Narrow-scope filter: when set, only consider files whose id is in this
  // set. Empty array is treated as "no filter" so an inadvertent `fileIds: []`
  // doesn't silently produce zero items.
  const fileIdFilter =
    payload.fileIds && payload.fileIds.length > 0
      ? new Set(payload.fileIds)
      : null;

  for (const mediaId of payload.mediaIds) {
    const details = detailsByMediaId.get(mediaId) as
      | {
          id: string;
          title: string;
          year: string | null;
          type: "movie" | "tv";
          files: Array<{
            id: string;
            filename: string;
            season: number | null;
            episode: number | null;
          }>;
          formats: Array<{
            id: string;
            fileId: string;
            quality: string;
            initKey: string | null;
            initSize: number | null;
            chunks: Array<{ key: string; sizeBytes: number | null; startSeconds: number | null }>;
          }>;
          audioTracks: Array<{
            id: string;
            fileId: string | null;
            language: string;
            label: string;
            isDefault: boolean;
            initKey: string | null;
            initSize: number | null;
            chunks: Array<{ key: string; sizeBytes: number | null; startSeconds: number | null }>;
          }>;
          subtitleTracks: Array<{
            id: string;
            fileId: string | null;
            language: string;
            label: string;
            objectKey: string | null;
            format: string | null;
            isDefault: boolean;
          }>;
          episodes: Array<{
            id: string;
            seasonNumber: number;
            episodeNumber: number;
            name: string;
          }>;
        }
      | null
      | undefined;
    if (!details) {
      skipped.push({ mediaId, reason: "no-file" });
      continue;
    }
    if (details.files.length === 0) {
      skipped.push({ mediaId, reason: "no-file" });
      continue;
    }

    // Which files of this media to consider?
    //   - With a `fileIds` filter set: every file under this media whose id
    //     is in the filter. This is the "narrow scope" path used by the
    //     renderer for episode/season scopes.
    //   - Without a filter (legacy / movie / parent-scope): the first file
    //     only. Movies have exactly one file; for TV shows the renderer is
    //     expected to either supply fileIds or use the smart-fill /
    //     skipAlreadyLocal path, so falling back to files[0] preserves
    //     existing behaviour without surprises.
    const filesForMedia = fileIdFilter
      ? details.files.filter((f) => fileIdFilter.has(f.id))
      : [details.files[0]];

    if (filesForMedia.length === 0) {
      // The filter excluded every file of this media — nothing to do here.
      // Skip silently (no `skipped` entry) because the renderer intentionally
      // narrowed this media out; surfacing it as a skip would just create
      // misleading UI counters.
      continue;
    }

    for (const file of filesForMedia) {
      // Sum chunk sizes for video, all audio tracks bound to this file, and
      // all subtitle tracks bound to this file. NULL `sizeBytes` defaults to
      // 0 — the estimate is a hint, not a contract.
      let audioBytes = 0;
      const audioTracks = details.audioTracks.filter(
        (t) => t.fileId === file.id
      );
      for (const t of audioTracks) {
        audioBytes += Number(t.initSize ?? 0);
        for (const c of t.chunks) audioBytes += Number(c.sizeBytes ?? 0);
      }

      let subtitleBytes = 0;
      // Explicit element type so TS doesn't loop on `typeof subtitleTracks`
      // (the nested for-of plus the local `subtitleTracks` name colliding
      // with `details.subtitleTracks` confused the implicit-any pass when
      // referenced from `includedSubs`'s annotation).
      type SubtitleTrackRow = (typeof details.subtitleTracks)[number];
      const subtitleTracks: SubtitleTrackRow[] = details.subtitleTracks.filter(
        (t) => t.fileId === file.id
      );
      // Skip-list (MP4 only); SRT / VTT pass through.
      const skippedSubsForContainer: string[] = [];
      const includedSubs: SubtitleTrackRow[] = [];
      for (const s of subtitleTracks) {
        if (payload.container === "mp4" && !isMp4CompatibleSub(s.format)) {
          skippedSubsForContainer.push(s.language || s.label || s.id);
          continue;
        }
        if (!s.objectKey) {
          // No object key = can't fetch; skip silently and don't count bytes.
          skippedSubsForContainer.push(s.language || s.label || s.id);
          continue;
        }
        includedSubs.push(s);
        // We don't have sizeBytes for subtitle objects on the existing schema;
        // estimate via a conservative 10 KB per track. This is a hint only.
        subtitleBytes += 10 * 1024;
      }

      // Quality (OFFL-QUAL-01): every stored rendition of this file is a
      // choice; the picked quality, else the nearest lower, else the nearest
      // higher. No pick = the file's highest.
      const fileFormats = details.formats.filter(
        (f) => f.fileId === file.id && offlineQualityHeight(String(f.quality)) > 0
      );
      const videoBytesOf = (f: (typeof fileFormats)[number]): number => {
        let bytes = Number(f.initSize ?? 0);
        for (const c of f.chunks) bytes += Number(c.sizeBytes ?? 0);
        return bytes;
      };
      const availableQualities = fileFormats.map((f) => String(f.quality));
      const target =
        payload.quality ??
        availableQualities.reduce<string | null>(
          (best, q) =>
            best === null || offlineQualityHeight(q) > offlineQualityHeight(best) ? q : best,
          null
        );
      const selected = target ? resolveOfflineQuality(availableQualities, target) : null;
      const chosenFormat = selected
        ? fileFormats.find((f) => String(f.quality) === selected)
        : undefined;
      if (!selected || !chosenFormat) {
        skipped.push({ mediaId, reason: "no-quality-available" });
        continue;
      }
      const videoBytes = videoBytesOf(chosenFormat);
      const fileTotalBytes = videoBytes + audioBytes + subtitleBytes;
      const alreadyLocal = existingByFileId.has(file.id);
      if (!alreadyLocal) {
        qualityFiles.push({
          fileId: file.id,
          options: fileFormats.map((f) => ({
            quality: String(f.quality),
            bytes: videoBytesOf(f) + audioBytes + subtitleBytes,
          })),
        });
      }

      // Filename preview: movies → title (year); episodes → show - SxxEyy - title.
      let filenameInputs: OfflineDownloadManifest["filenameInputs"];
      if (details.type === "tv") {
        const episodeMatch = details.episodes.find(
          (e) =>
            file.season !== null &&
            file.episode !== null &&
            e.seasonNumber === file.season &&
            e.episodeNumber === file.episode
        );
        filenameInputs = {
          kind: "episode",
          showTitle: details.title,
          seasonNumber: file.season ?? 0,
          episodeNumber: file.episode ?? 0,
          episodeTitle: episodeMatch?.name ?? null,
        };
      } else {
        const yearNumber = details.year ? Number(details.year) : null;
        filenameInputs = {
          kind: "movie",
          title: details.title,
          year: yearNumber !== null && Number.isFinite(yearNumber) ? yearNumber : null,
        };
      }
      const expectedFilename = sanitizeOfflineFilename(
        buildOfflineFilename({
          ...filenameInputs,
          container: payload.container,
        })
      );

      items.push({
        mediaId,
        fileId: file.id,
        selectedQuality: selected,
        videoBytes,
        audioBytes,
        subtitleBytes,
        totalBytes: fileTotalBytes,
        alreadyLocal,
        expectedFilename,
        skippedSubsForContainer,
      });
      if (alreadyLocal) {
        // Don't add already-local bytes to the disk-space total — the file is
        // already on disk; downloading it again would replace, not add.
        // (Submit handler will treat it as a skip per skipAlreadyLocal.)
      } else {
        totalBytes += fileTotalBytes;
      }

      // Build the manifest for the submit handler. We do this here so submit
      // doesn't have to re-query getMediaDetails — saves a round trip.
      const manifest: OfflineDownloadManifest = {
        videoInitKey: chosenFormat.initKey,
        videoInitSize: chosenFormat.initSize,
        videoChunks: chosenFormat.chunks
          .map((c, i): ManifestVideoChunk => ({
            key: c.key,
            sizeBytes: Number(c.sizeBytes ?? 0),
            orderIndex: i,
          }))
          .filter((c) => c.key.length > 0),
        audioTracks: audioTracks.map((t): ManifestAudioTrack => ({
          trackId: t.id,
          language: String(t.language ?? "und"),
          label: String(t.label ?? ""),
          isDefault: Boolean(t.isDefault),
          initKey: t.initKey,
          initSize: t.initSize,
          chunks: t.chunks
            .map((c, i) => ({
              key: c.key,
              sizeBytes: Number(c.sizeBytes ?? 0),
              orderIndex: i,
            }))
            .filter((c) => c.key.length > 0),
        })),
        subtitles: includedSubs.map((s): ManifestSubtitleTrack => ({
          subtitleId: s.id,
          language: String(s.language ?? "und"),
          label: String(s.label ?? ""),
          format: s.format,
          objectKey: String(s.objectKey),
          sizeBytes: 10 * 1024,
          isDefault: Boolean(s.isDefault),
        })),
        filenameInputs,
        filenameHint: file.filename ?? null,
      };
      manifests.set(file.id, { manifest, libraryId: resolveLibraryIdSafe(deps) });
    }
  }

  // statfs the offline root for free bytes. The dir may not exist yet on
  // first run; fall back to its parent (the userData dir) so we still get
  // a meaningful number.
  const libraryId = resolveLibraryIdSafe(deps);
  const offlineDir = deps.resolveOfflineDir(libraryId);
  let freeBytesAvailable = 0;
  try {
    const probePath = await statfsTarget(offlineDir);
    const stat = statfsSync(probePath);
    freeBytesAvailable = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isFinite(freeBytesAvailable) || freeBytesAvailable < 0) {
      freeBytesAvailable = 0;
    }
  } catch (err) {
    console.warn(
      `[badger.offline] statfs failed for ${offlineDir}:`,
      err instanceof Error ? err.message : err
    );
    freeBytesAvailable = 0;
  }

  const sufficientSpace = freeBytesAvailable >= totalBytes + FREE_DISK_SAFETY_MARGIN_BYTES;
  const { choices: qualityChoices, prompt } = listOfflineQualityChoices(qualityFiles);
  return {
    items,
    skipped,
    totalBytes,
    freeBytesAvailable,
    sufficientSpace,
    qualityChoices,
    prompt,
    manifests,
  };
};

/**
 * `statfsSync` only works on a directory that exists. If `offlineDir` does
 * not exist yet, walk up to the first ancestor that does.
 */
const statfsTarget = async (start: string): Promise<string> => {
  let candidate = start;
  for (let i = 0; i < 8; i += 1) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      const parent = joinPath(candidate, "..");
      if (parent === candidate) return candidate;
      candidate = parent;
    }
  }
  return candidate;
};

export const createBadgerOfflineEstimateHandler = (
  deps: BadgerOfflineHandlerDeps
) => {
  return async (payload: OfflineEstimatePayload): Promise<OfflineEstimateResult> => {
    console.info("[badger.offline.estimate] entry", {
      mediaCount: payload.mediaIds.length,
      quality: payload.quality ?? null,
      container: payload.container,
    });
    const internal = await buildEstimate(deps, payload);
    console.info("[badger.offline.estimate] result", {
      items: internal.items.length,
      skipped: internal.skipped.length,
      totalBytes: internal.totalBytes,
      freeBytesAvailable: internal.freeBytesAvailable,
      sufficientSpace: internal.sufficientSpace,
      qualityChoices: internal.qualityChoices.map((c) => `${c.quality}=${c.totalBytes}`),
      prompt: internal.prompt,
    });
    return {
      items: internal.items.map((it) => ({
        mediaId: it.mediaId,
        fileId: it.fileId,
        selectedQuality: it.selectedQuality,
        videoBytes: it.videoBytes,
        audioBytes: it.audioBytes,
        subtitleBytes: it.subtitleBytes,
        totalBytes: it.totalBytes,
        alreadyLocal: it.alreadyLocal,
        expectedFilename: it.expectedFilename,
        skippedSubsForContainer: it.skippedSubsForContainer,
      })),
      skipped: internal.skipped,
      totalBytes: internal.totalBytes,
      freeBytesAvailable: internal.freeBytesAvailable,
      sufficientSpace: internal.sufficientSpace,
      qualityChoices: internal.qualityChoices,
      prompt: internal.prompt,
    };
  };
};

// ---------------------------------------------------------------------------
// Submit handler
// ---------------------------------------------------------------------------

const baseDownloadRecord = (now: string): Pick<
  IngestJobRecord,
  | "app"
  | "status"
  | "stageCode"
  | "stageLabel"
  | "progress"
  | "progressPct"
  | "outputs"
  | "errorCode"
  | "errorMessage"
  | "retryable"
  | "cancelRequested"
  | "dedupeKey"
  | "createdAt"
  | "updatedAt"
  | "startedAt"
  | "finishedAt"
  | "dismissedAt"
  | "uploadSpeedBytesPerSec"
> => ({
  app: "badger",
  status: "queued" satisfies IngestJobStatus,
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  dedupeKey: null,
  createdAt: now,
  updatedAt: now,
  startedAt: null,
  finishedAt: null,
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
});

export const createBadgerOfflineSubmitHandler = (
  deps: BadgerOfflineHandlerDeps
) => {
  return async (payload: OfflineSubmitPayload): Promise<OfflineSubmitResult> => {
    console.info("[badger.offline.submit] entry", {
      mediaCount: payload.mediaIds.length,
      quality: payload.quality ?? null,
      container: payload.container,
      skipAlreadyLocal: payload.skipAlreadyLocal,
    });
    const token = deps.resolveToken();
    if (!token) {
      console.warn("[badger.offline.submit] not_authenticated");
      return { errorCode: "not_authenticated" } as OfflineSubmitResult;
    }
    const libraryKey = deps.resolveLibraryKey();
    if (!libraryKey) {
      console.warn("[badger.offline.submit] library_db_not_open (no key)");
      return { errorCode: "library_db_not_open" } as OfflineSubmitResult;
    }
    if (!deps.libraryDb.isOpen()) {
      console.warn("[badger.offline.submit] library_db_not_open");
      return { errorCode: "library_db_not_open" } as OfflineSubmitResult;
    }

    const estimate = await buildEstimate(deps, {
      mediaIds: payload.mediaIds,
      ...(payload.quality ? { quality: payload.quality } : {}),
      container: payload.container,
      // Propagate the narrow-scope filter so submit's per-file selection
      // exactly matches the estimate the user saw in the modal.
      fileIds: payload.fileIds,
    });

    // Filter to candidates we can actually submit. `skipAlreadyLocal` is the
    // default renderer behaviour for partial-show downloads.
    const candidates = estimate.items.filter((it) =>
      payload.skipAlreadyLocal ? !it.alreadyLocal : true
    );
    const additionalSkips: SkippedItem[] = payload.skipAlreadyLocal
      ? estimate.items
          .filter((it) => it.alreadyLocal)
          .map((it) => ({ mediaId: it.mediaId, reason: "already-local" }))
      : [];

    // Defense-in-depth disk-space check. The modal showed a number; the user
    // may have filled the disk in the meantime.
    const requiredBytes = candidates.reduce(
      (sum, it) => sum + it.totalBytes,
      0
    );
    if (
      requiredBytes > 0 &&
      estimate.freeBytesAvailable < requiredBytes + FREE_DISK_SAFETY_MARGIN_BYTES
    ) {
      console.warn(
        "[badger.offline.submit] insufficient_disk_space",
        { requiredBytes, freeBytes: estimate.freeBytesAvailable }
      );
      return {
        errorCode: "insufficient_disk_space",
        requiredBytes,
        freeBytes: estimate.freeBytesAvailable,
      } as OfflineSubmitResult;
    }

    const submitted: Array<{
      mediaId: string;
      fileId: string;
      jobId: string;
      groupId: string;
    }> = [];
    const now = new Date().toISOString();
    for (const item of candidates) {
      const manifestEntry = estimate.manifests.get(item.fileId);
      if (!manifestEntry) {
        // Should never happen because buildEstimate populates the manifest
        // alongside the item. Treat as a hard skip rather than crash.
        additionalSkips.push({ mediaId: item.mediaId, reason: "no-file" });
        continue;
      }
      const { manifest, libraryId } = manifestEntry;
      // Stamp a friendly label + season/episode hints onto the job record so the
      // jobs sidebar shows "Show - S01E01 - Title" (or "Movie (Year)") instead
      // of the raw job UUID. Reuse the already-sanitized expectedFilename (it
      // matches the on-disk saved name); strip the container extension so the
      // label reads as a title, not a filename. Movies and null-season episodes
      // emit no hints (>= 1 guard) so no phantom S00E00 chip is shown.
      const containerExt = `.${payload.container}`;
      const friendlyLabel = item.expectedFilename.endsWith(containerExt)
        ? item.expectedFilename.slice(0, -containerExt.length)
        : item.expectedFilename;
      const stampHints =
        manifest.filenameInputs.kind === "episode" &&
        manifest.filenameInputs.seasonNumber >= 1 &&
        manifest.filenameInputs.episodeNumber >= 1
          ? {
              season: manifest.filenameInputs.seasonNumber,
              episode: manifest.filenameInputs.episodeNumber,
            }
          : undefined;
      const jobId = crypto.randomUUID();
      const job: IngestJobRecord = {
        ...baseDownloadRecord(now),
        jobId,
        kind: "download",
        lane: "upload",
        variant: null,
        priority: 70, // After ingest 144p (60) — offline downloads are user-paced
        parentJobIds: [],
        groupId: item.mediaId,
        mediaId: item.mediaId,
        payload: {
          fileId: item.fileId,
          mediaId: item.mediaId,
          quality: item.selectedQuality,
          formatId:
            // Look up the format id from the estimate item's chosen quality:
            // it's the manifest's videoInitKey-bearing format. We don't track
            // it on the EstimateItem so re-read the chosen quality via the
            // libraryDb call's already-cached details would be ideal — instead
            // we stash it via a lightweight `details` re-read. Cost is one
            // extra getMediaDetails call per submitted media. Acceptable for
            // v1 (the renderer rarely submits >40 items in one shot).
            await resolveFormatIdForSelected(
              deps,
              item.mediaId,
              item.fileId,
              item.selectedQuality
            ) ?? "",
          container: payload.container,
          expectedBytes: item.totalBytes,
          libraryId,
          manifest,
          // Friendly label + S/E hints for the jobs sidebar (see above). The
          // renderer also reconstructs these from `manifest.filenameInputs` for
          // jobs that completed before this stamp shipped.
          filename: friendlyLabel,
          ...(stampHints ? { hints: stampHints } : {}),
        },
      };
      // If formatId resolution failed, skip the item rather than submit a
      // job that will crash on missing formatId.
      if (!(job.payload as { formatId: string }).formatId) {
        additionalSkips.push({ mediaId: item.mediaId, reason: "no-quality-available" });
        continue;
      }
      try {
        await deps.engine.submit(job);
        submitted.push({
          mediaId: item.mediaId,
          fileId: item.fileId,
          jobId,
          groupId: item.mediaId,
        });
      } catch (err) {
        console.error(
          `[badger.offline.submit] engine.submit failed for ${item.mediaId}/${item.fileId}:`,
          err instanceof Error ? err.message : err
        );
        additionalSkips.push({ mediaId: item.mediaId, reason: "no-file" });
      }
    }

    console.info("[badger.offline.submit] result", {
      submitted: submitted.length,
      skipped: estimate.skipped.length + additionalSkips.length,
    });
    return {
      submitted,
      skipped: [...estimate.skipped, ...additionalSkips],
    };
  };
};

const resolveFormatIdForSelected = async (
  deps: BadgerOfflineHandlerDeps,
  mediaId: string,
  fileId: string,
  quality: string
): Promise<string | null> => {
  try {
    const details = (await deps.libraryDb.call("getMediaDetails", [mediaId])) as
      | {
          formats?: Array<{ id: string; fileId: string; quality: string }>;
        }
      | null;
    if (!details?.formats) return null;
    const match = details.formats.find(
      (f) => f.fileId === fileId && String(f.quality) === quality
    );
    return match?.id ?? null;
  } catch (err) {
    console.warn(
      `[badger.offline] resolveFormatIdForSelected(${mediaId}, ${fileId}, ${quality}) failed:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
};

// ---------------------------------------------------------------------------
// Delete handler
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: ReadonlySet<IngestJobStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

const isTerminal = (status: IngestJobStatus): boolean => TERMINAL_STATUSES.has(status);

const CANCEL_POLL_INTERVAL_MS = 100;
const CANCEL_POLL_TIMEOUT_MS = 5000;

/**
 * Cancel a job and wait for it (and its cascaded children) to reach a
 * terminal status. Bounded by `CANCEL_POLL_TIMEOUT_MS`. Returns the list of
 * cancelled job ids reported by `engine.cancel`.
 */
const cancelJobAndPoll = async (
  engine: EngineV2,
  jobId: string,
  reason: string
): Promise<string[]> => {
  console.info(`[badger.offline.delete] cancelling job ${jobId} reason=${reason}`);
  const { cancelledIds } = await engine.cancel(jobId, reason);
  const deadline = Date.now() + CANCEL_POLL_TIMEOUT_MS;
  const idsToWatch = cancelledIds.length > 0 ? cancelledIds : [jobId];
  while (Date.now() < deadline) {
    let allTerminal = true;
    for (const id of idsToWatch) {
      const found = await engine.get(id);
      if (!found) continue;
      if (!isTerminal(found.job.status)) {
        allTerminal = false;
        break;
      }
    }
    if (allTerminal) return cancelledIds;
    await new Promise((resolve) => setTimeout(resolve, CANCEL_POLL_INTERVAL_MS));
  }
  console.warn(
    `[badger.offline.delete] cancel poll timeout for job ${jobId} — ids ${JSON.stringify(idsToWatch)} may not all be terminal yet`
  );
  return cancelledIds;
};

export const createBadgerOfflineDeleteHandler = (
  deps: BadgerOfflineHandlerDeps
) => {
  return async (payload: OfflineDeletePayload): Promise<OfflineDeleteResult> => {
    console.info("[badger.offline.delete] entry", { scope: payload.scope });
    if (!deps.libraryDb.isOpen()) {
      // No DB → nothing to delete; respond with zeroes rather than error so
      // the renderer's UX path (toast, badge refresh) is identical.
      return { deleted: 0, freedBytes: 0, cancelledJobIds: [] };
    }

    // Hoist the scope fields outside the filter closures so TS's narrowing
    // survives the callback boundary. (Inside `filter((j) => ...)` the
    // narrow on `payload.scope.type` is lost — see TS handbook on
    // narrowing in callbacks.)
    const scopeType = payload.scope.type;
    const scopeMediaId =
      scopeType === "media" || scopeType === "season"
        ? payload.scope.mediaId
        : null;
    const scopeSeasonNumber =
      scopeType === "season" ? payload.scope.seasonNumber : null;
    const scopeFileId = scopeType === "file" ? payload.scope.fileId : null;

    // For season scope we need the set of fileIds that belong to (mediaId,
    // seasonNumber) — the library-DB localRows track only fileId/mediaId,
    // not (season, episode). Resolve via getMediaDetails so we can intersect
    // by season.
    let seasonFileIds: Set<string> | null = null;
    if (scopeType === "season" && scopeMediaId !== null) {
      try {
        const details = (await deps.libraryDb.call("getMediaDetails", [
          scopeMediaId,
        ])) as
          | {
              files?: Array<{
                id: string;
                season: number | null;
                episode: number | null;
              }>;
            }
          | null;
        const allFiles = details?.files ?? [];
        seasonFileIds = new Set(
          allFiles
            .filter((f) => f.season === scopeSeasonNumber)
            .map((f) => f.id)
        );
        console.info(
          "[badger.offline.delete] season scope file enumeration",
          {
            mediaId: scopeMediaId,
            seasonNumber: scopeSeasonNumber,
            seasonFileIdCount: seasonFileIds.size,
          }
        );
      } catch (err) {
        console.warn(
          `[badger.offline.delete] season scope getMediaDetails failed for ${scopeMediaId}:`,
          err instanceof Error ? err.message : err
        );
        seasonFileIds = new Set<string>();
      }
    }

    // Find candidate rows + non-terminal jobs.
    let rowsToDelete: Awaited<ReturnType<typeof deps.libraryDb.listLocalDownloads>>;
    if (scopeType === "season") {
      const seasonSet = seasonFileIds ?? new Set<string>();
      if (scopeMediaId !== null && seasonSet.size > 0) {
        const mediaRows = await deps.libraryDb.listLocalDownloads([
          scopeMediaId,
        ]);
        rowsToDelete = mediaRows.filter((r) => seasonSet.has(r.fileId));
      } else {
        rowsToDelete = [];
      }
    } else if (scopeMediaId !== null) {
      rowsToDelete = await deps.libraryDb.listLocalDownloads([scopeMediaId]);
    } else {
      const allRows = await deps.libraryDb.listLocalDownloads(undefined);
      rowsToDelete = allRows.filter((r) => r.fileId === scopeFileId);
    }
    console.info(
      "[badger.offline.delete] candidate rows",
      rowsToDelete.map((r) => ({ fileId: r.fileId, mediaId: r.mediaId, path: r.localPath }))
    );

    // Find non-terminal download jobs matching the scope and cancel them.
    const allJobs = (await deps.engine.list()).jobs;
    const matchingJobs = allJobs.filter((j) => {
      if (j.kind !== "download") return false;
      if (isTerminal(j.status) && j.status !== "succeeded") return false;
      if (scopeType === "season") {
        // Season scope: media must match AND the job's fileId must be in the
        // season's file set. Conservative — non-download jobs and jobs we
        // can't identify a fileId for are skipped.
        const seasonSet = seasonFileIds ?? new Set<string>();
        if (j.groupId !== scopeMediaId && j.mediaId !== scopeMediaId) return false;
        const pFileId = (j.payload as { fileId?: unknown }).fileId;
        return typeof pFileId === "string" && seasonSet.has(pFileId);
      }
      if (scopeMediaId !== null) {
        return j.groupId === scopeMediaId || j.mediaId === scopeMediaId;
      }
      const pFileId = (j.payload as { fileId?: unknown }).fileId;
      return typeof pFileId === "string" && pFileId === scopeFileId;
    });

    const cancelledJobIds: string[] = [];
    for (const job of matchingJobs) {
      if (isTerminal(job.status)) continue;
      try {
        const ids = await cancelJobAndPoll(deps.engine, job.jobId, "offline-delete");
        cancelledJobIds.push(...ids);
      } catch (err) {
        console.warn(
          `[badger.offline.delete] cancelJobAndPoll failed for ${job.jobId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Resume-aware cleanup: the step handler now PRESERVES staging dirs on
    // cancel/fail so retries can resume from partial. delete_local is the
    // path that explicitly removes them. Walk every matching job (in-flight
    // OR terminal) and nuke its `.tmp-<jobId>/` dir under the job's
    // libraryId-resolved offline root. Errors are best-effort logged.
    for (const job of matchingJobs) {
      const jobLibraryId =
        ((job.payload as { libraryId?: unknown }).libraryId as string | undefined) ||
        "default";
      try {
        const offlineRoot = deps.resolveOfflineDir(jobLibraryId);
        const stagingDir = joinPath(offlineRoot, `.tmp-${job.jobId}`);
        await fs.rm(stagingDir, { recursive: true, force: true });
        console.info(
          `[badger.offline.delete] removed staging dir ${stagingDir} for job ${job.jobId}`
        );
      } catch (err) {
        console.warn(
          `[badger.offline.delete] failed to remove staging dir for job ${job.jobId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Unlink files + collect freed bytes.
    let freedBytes = 0;
    let deleted = 0;
    for (const row of rowsToDelete) {
      try {
        await fs.rm(row.localPath, { force: true });
        freedBytes += Number(row.totalBytes ?? 0);
        deleted += 1;
      } catch (err) {
        console.warn(
          `[badger.offline.delete] fs.rm failed for ${row.localPath}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Drop the DB rows last so a crash mid-unlink doesn't lose the path
    // bookkeeping needed for a re-attempt.
    if (rowsToDelete.length > 0) {
      if (scopeType === "season") {
        // Batch-drop by the fileIds we just removed — the library DB
        // accepts a `files` scope with a fileIds array.
        const fileIds = rowsToDelete.map((r) => r.fileId);
        await deps.libraryDb.dropLocalDownloads({
          type: "files",
          fileIds,
        });
      } else if (scopeMediaId !== null) {
        await deps.libraryDb.dropLocalDownloads({
          type: "media",
          mediaId: scopeMediaId,
        });
      } else if (scopeFileId !== null) {
        await deps.libraryDb.dropLocalDownloads({
          type: "file",
          fileId: scopeFileId,
        });
      }
    }

    console.info("[badger.offline.delete] result", {
      deleted,
      freedBytes,
      cancelledJobIds: cancelledJobIds.length,
    });
    return { deleted, freedBytes, cancelledJobIds };
  };
};

// ---------------------------------------------------------------------------
// List handler
// ---------------------------------------------------------------------------

export const createBadgerOfflineListHandler = (
  deps: BadgerOfflineHandlerDeps
) => {
  return async (payload: OfflineListPayload): Promise<OfflineListResult> => {
    console.info("[badger.offline.list] entry", {
      mediaIdCount: payload.mediaIds?.length ?? null,
    });
    if (!deps.libraryDb.isOpen()) {
      return { entries: [] };
    }
    const rows = await deps.libraryDb.listLocalDownloads(payload.mediaIds);
    return {
      entries: rows.map((row) => ({
        mediaId: row.mediaId,
        fileId: row.fileId,
        quality: row.quality as OfflineListResult["entries"][number]["quality"],
        container: row.container as OfflineListResult["entries"][number]["container"],
        totalBytes: row.totalBytes,
        downloadedAt: row.downloadedAt,
        localPath: row.localPath,
      })),
    };
  };
};

// ---------------------------------------------------------------------------
// Reconcile handler
// ---------------------------------------------------------------------------

export const createBadgerOfflineReconcileHandler = (
  deps: BadgerOfflineHandlerDeps
) => {
  return async (
    payload: OfflineReconcilePayload
  ): Promise<OfflineReconcileResult> => {
    console.info("[badger.offline.reconcile] entry", {
      mediaIdCount: payload.mediaIds?.length ?? null,
    });
    if (!deps.libraryDb.isOpen()) {
      return { dropped: [] };
    }

    const rows = await deps.libraryDb.listLocalDownloads(payload.mediaIds);
    const dropped: Array<{
      mediaId: string;
      fileId: string;
      reason: "missing" | "size_mismatch";
    }> = [];
    const survivorFileIds: string[] = [];
    const survivorBucketByScope = new Map<string, string[]>();
    for (const row of rows) {
      let reason: "missing" | "size_mismatch" | null = null;
      try {
        const stat = await fs.stat(row.localPath);
        if (Number(stat.size) !== Number(row.totalBytes)) {
          reason = "size_mismatch";
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reason = "missing";
        } else {
          console.warn(
            `[badger.offline.reconcile] stat failed for ${row.localPath}:`,
            err instanceof Error ? err.message : err
          );
          // Treat unknown stat errors as missing — defensible because the
          // file is unreadable from the user's perspective.
          reason = "missing";
        }
      }
      if (reason) {
        dropped.push({ mediaId: row.mediaId, fileId: row.fileId, reason });
      } else {
        survivorFileIds.push(row.fileId);
      }
    }

    // Drop missing/mismatched rows in one batch per media (cheapest
    // path for the worst case "every row gone").
    if (dropped.length > 0) {
      const droppedFileIds = dropped.map((d) => d.fileId);
      await deps.libraryDb.dropLocalDownloads({
        type: "files",
        fileIds: droppedFileIds,
      });
    }

    // Stamp last_verified_at on the survivors so subsequent reconcile sweeps
    // can deprioritise the ones we just checked.
    if (survivorFileIds.length > 0) {
      const verifiedAt = new Date().toISOString();
      await deps.libraryDb.touchLocalDownloadsVerified(survivorFileIds, verifiedAt);
    }

    // Hush the unused-var lint — kept the bucket Map alive for a v2
    // enhancement (per-scope event emission). Production currently emits the
    // generic `library.updated` event via the snapshot publish path.
    void survivorBucketByScope;

    console.info("[badger.offline.reconcile] result", {
      dropped: dropped.length,
      surviving: survivorFileIds.length,
    });
    return { dropped };
  };
};

// ---------------------------------------------------------------------------
// Orphaned-staging-dir sweep (resume-feature support)
//
// Step handler now PRESERVES staging dirs on cancel/fail so retries can
// resume from partial. Orphans arise from:
//   - A runtime crash mid-download (process exits before retry can run).
//   - A job whose CAS-cancel path raced past the step's preserve-on-fail
//     branch and never produced a successor.
//
// On runtime startup we walk every `<offlineRoot>/<libraryId>/.tmp-*` dir,
// extract the jobId from the dir name, check the engine: if the jobId
// matches a non-terminal queued/running job we leave it alone (resume can
// still pick it up); otherwise we nuke the dir.
//
// Run at the same time as the startup reconcile; both are best-effort.
// ---------------------------------------------------------------------------

const STAGING_DIR_PREFIX = ".tmp-";

interface SweepOrphanedStagingDirsArgs {
  engine: EngineV2;
  /**
   * Resolve the per-library offline dir. Same surface as
   * `BadgerOfflineHandlerDeps.resolveOfflineDir`. We walk the parent of
   * `resolveOfflineDir("default")` to enumerate every library subdir.
   */
  resolveOfflineDir(libraryId: string): string;
}

interface SweepOrphanedStagingDirsResult {
  scanned: number;
  removed: number;
  preserved: number;
  errors: number;
}

/**
 * Walk every `<offlineRoot>/<libraryId>/.tmp-<jobId>/` directory and remove
 * those whose jobId is not associated with a non-terminal job in the engine.
 * Best-effort: stat failures and read failures log + skip, they do not throw.
 */
export const sweepOrphanedStagingDirs = async (
  args: SweepOrphanedStagingDirsArgs
): Promise<SweepOrphanedStagingDirsResult> => {
  const result: SweepOrphanedStagingDirsResult = {
    scanned: 0,
    removed: 0,
    preserved: 0,
    errors: 0,
  };

  // Snapshot non-terminal jobs once. The engine's `list()` returns ALL jobs
  // including terminal ones; we treat anything not in this set as an
  // orphan candidate.
  let nonTerminalJobIds = new Set<string>();
  try {
    const all = await args.engine.list();
    for (const j of all.jobs) {
      if (j.kind !== "download") continue;
      if (!isTerminal(j.status)) nonTerminalJobIds.add(j.jobId);
    }
  } catch (err) {
    console.warn(
      "[badger.offline.sweep] engine.list() failed — falling back to wipe-nothing:",
      err instanceof Error ? err.message : err
    );
    // If we can't tell which jobs are live, do NOT delete anything. Better
    // to leak a few staging dirs than nuke an in-flight download.
    nonTerminalJobIds = new Set<string>();
    return result;
  }

  // Discover library subdirs by reading the parent of resolveOfflineDir("default").
  const defaultLibraryDir = args.resolveOfflineDir("default");
  const offlineRootParent = joinPath(defaultLibraryDir, "..");
  let libraryNames: string[] = [];
  try {
    const entries = await fs.readdir(offlineRootParent, { withFileTypes: true });
    libraryNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(
        `[badger.offline.sweep] readdir(${offlineRootParent}) failed:`,
        err instanceof Error ? err.message : err
      );
      result.errors += 1;
    }
    return result;
  }

  for (const libraryName of libraryNames) {
    const libraryDir = joinPath(offlineRootParent, libraryName);
    let entries: { name: string; isDir: boolean }[] = [];
    try {
      const raw = await fs.readdir(libraryDir, { withFileTypes: true });
      entries = raw
        .filter((e) => e.name.startsWith(STAGING_DIR_PREFIX) && e.isDirectory())
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[badger.offline.sweep] readdir(${libraryDir}) failed:`,
        err instanceof Error ? err.message : err
      );
      continue;
    }
    for (const entry of entries) {
      result.scanned += 1;
      const jobId = entry.name.slice(STAGING_DIR_PREFIX.length);
      if (nonTerminalJobIds.has(jobId)) {
        result.preserved += 1;
        console.info(
          `[badger.offline.sweep] preserving staging dir ${libraryDir}/${entry.name} — job is non-terminal`
        );
        continue;
      }
      const dirPath = joinPath(libraryDir, entry.name);
      try {
        await fs.rm(dirPath, { recursive: true, force: true });
        result.removed += 1;
        console.info(`[badger.offline.sweep] removed orphan staging dir ${dirPath}`);
      } catch (err) {
        result.errors += 1;
        console.warn(
          `[badger.offline.sweep] failed to remove ${dirPath}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }
  return result;
};

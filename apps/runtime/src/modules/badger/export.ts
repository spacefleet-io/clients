/**
 * `badger.export.estimate` / `badger.export.submit`: plain video files the user keeps (OFFL-FILE-01 "Download
 * file", ACCT-EXPORT-01 "Download everything").
 *
 * Separate from offline playback (`offlineDownload.ts`): an export goes to a folder the user picked, always at the
 * highest stored quality (OFFL-QUAL-01: never asked), and is not tracked by the app — no `media_local_downloads`
 * row, never listed as offline content. One `kind: "export"` engine job per file; the `export_file` step
 * (`steps/exportFile.ts`) fetches, decrypts, muxes and places it.
 */

import { constants as fsConstants, promises as fs, statfsSync } from "node:fs";
import { dirname } from "node:path";
import crypto from "node:crypto";
import type {
  BadgerExportEstimatePayload,
  BadgerExportEstimateResult,
  BadgerExportSubmitPayload,
  BadgerExportSubmitResult,
  ExportContainer,
} from "@space/runtime-contracts/badger/export";
import { offlineQualityHeight } from "@space/shared/offlineQualityChoice";
import { buildOfflineFilename } from "@space/shared/offlineFilename";
import type { ExportLayout } from "@space/shared/exportLayout";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { EngineV2 } from "../../core/jobs/engineV2";
import type { BadgerLibraryDbService } from "../badgerLibraryDb";

// Same margin as offline saves (OFFL-SAFE-02): never fill the destination disk to the last byte.
const FREE_DISK_SAFETY_MARGIN_BYTES = 100 * 1024 * 1024;
// Subtitle objects carry no size in the library; a hint, like the offline estimate.
const SUBTITLE_ESTIMATE_BYTES = 10 * 1024;

export interface ExportPiece {
  key: string;
  sizeBytes: number;
  orderIndex: number;
}

export interface ExportManifest {
  videoInitKey: string | null;
  videoInitSize: number | null;
  videoChunks: ExportPiece[];
  audioTracks: Array<{
    trackId: string;
    language: string;
    label: string;
    isDefault: boolean;
    initKey: string | null;
    initSize: number | null;
    chunks: ExportPiece[];
  }>;
  subtitles: Array<{
    subtitleId: string;
    language: string;
    label: string;
    format: string | null;
    objectKey: string;
    sizeBytes: number;
    isDefault: boolean;
  }>;
  filenameInputs:
    | { kind: "movie"; title: string; year: number | null }
    | { kind: "episode"; showTitle: string; seasonNumber: number; episodeNumber: number; episodeTitle: string | null };
}

/** Persisted job payload of a `kind: "export"` job. Never holds the token or the library key (RT-SEC-05). */
export interface ExportJobPayload {
  fileId: string;
  mediaId: string;
  quality: string;
  container: ExportContainer;
  layout: ExportLayout;
  destDir: string;
  expectedBytes: number;
  manifest: ExportManifest;
  /** Subtitle languages MP4 cannot hold (ASS/PGS/unknown), left out of the file. */
  skippedSubsForContainer: string[];
  /** Jobs sidebar label, e.g. "Lattice (1999)" or "Show - S01E02 - Title". */
  filename: string;
  hints?: { season: number; episode: number };
}

export interface BadgerExportHandlerDeps {
  engine: Pick<EngineV2, "submit">;
  libraryDb: BadgerLibraryDbService;
  resolveToken(): string | null;
  resolveLibraryKey(): string | null;
  /** Test seam: free bytes on the disk holding `dir`. Default: `statfsSync` on its nearest existing ancestor. */
  freeBytesAt?(dir: string): number;
}

type SkippedItem = { mediaId: string; reason: "no-quality-available" | "no-file" };

type MediaDetails = {
  id: string;
  title: string;
  year: string | null;
  type: string;
  files: Array<{ id: string; season: number | null; episode: number | null }>;
  formats: Array<{
    fileId: string;
    quality: string;
    initKey: string | null;
    initSize: number | null;
    chunks: Array<{ key: string; sizeBytes: number | null }>;
  }>;
  audioTracks: Array<{
    id: string;
    fileId: string | null;
    language: string;
    label: string;
    isDefault: boolean;
    initKey: string | null;
    initSize: number | null;
    chunks: Array<{ key: string; sizeBytes: number | null }>;
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
  episodes: Array<{ seasonNumber: number; episodeNumber: number; name: string }>;
};

type ExportItem = { mediaId: string; payload: Omit<ExportJobPayload, "destDir" | "layout"> };

const isMp4CompatibleSub = (raw: string | null): boolean => {
  const fmt = (raw ?? "").toLowerCase();
  return fmt === "srt" || fmt === "vtt" || fmt === "webvtt";
};

const pieces = (chunks: Array<{ key: string; sizeBytes: number | null }>): ExportPiece[] =>
  chunks
    .map((c, orderIndex) => ({ key: c.key, sizeBytes: Number(c.sizeBytes ?? 0), orderIndex }))
    .filter((c) => c.key.length > 0);

/** One export per file of the scope, each at its highest stored quality. */
const collectItems = async (
  deps: BadgerExportHandlerDeps,
  scope: { all?: boolean; mediaIds?: string[]; fileIds?: string[] },
  container: ExportContainer,
): Promise<{ items: ExportItem[]; skipped: SkippedItem[] }> => {
  const items: ExportItem[] = [];
  const skipped: SkippedItem[] = [];
  const mediaIds = scope.all
    ? ((await deps.libraryDb.call("listMedia", [])) as Array<{ id: string }>).map((m) => String(m.id))
    : (scope.mediaIds ?? []);
  const fileFilter = scope.fileIds && scope.fileIds.length > 0 ? new Set(scope.fileIds) : null;

  for (const mediaId of mediaIds) {
    const details = (await deps.libraryDb.call("getMediaDetails", [mediaId])) as MediaDetails | null;
    if (!details || details.files.length === 0) {
      skipped.push({ mediaId, reason: "no-file" });
      continue;
    }
    for (const file of details.files) {
      if (fileFilter && !fileFilter.has(file.id)) continue;
      const best = details.formats
        .filter((f) => f.fileId === file.id && offlineQualityHeight(String(f.quality)) > 0)
        .reduce<MediaDetails["formats"][number] | null>(
          (top, f) =>
            top === null || offlineQualityHeight(String(f.quality)) > offlineQualityHeight(String(top.quality)) ? f : top,
          null,
        );
      if (!best) {
        skipped.push({ mediaId, reason: "no-quality-available" });
        continue;
      }
      const audio = details.audioTracks.filter((t) => t.fileId === file.id);
      const skippedSubsForContainer: string[] = [];
      const subs = details.subtitleTracks.filter((s) => {
        if (s.fileId !== file.id) return false;
        if (s.objectKey && (container === "mkv" || isMp4CompatibleSub(s.format))) return true;
        skippedSubsForContainer.push(s.language || s.label || s.id);
        return false;
      });

      const videoChunks = pieces(best.chunks);
      const audioTracks = audio.map((t) => ({
        trackId: t.id,
        language: String(t.language ?? "und"),
        label: String(t.label ?? ""),
        isDefault: Boolean(t.isDefault),
        initKey: t.initKey,
        initSize: t.initSize,
        chunks: pieces(t.chunks),
      }));
      const expectedBytes =
        Number(best.initSize ?? 0) +
        videoChunks.reduce((sum, c) => sum + c.sizeBytes, 0) +
        audioTracks.reduce(
          (sum, t) => sum + Number(t.initSize ?? 0) + t.chunks.reduce((s, c) => s + c.sizeBytes, 0),
          0,
        ) +
        subs.length * SUBTITLE_ESTIMATE_BYTES;

      let filenameInputs: ExportManifest["filenameInputs"];
      if (details.type === "tv") {
        const episode = details.episodes.find(
          (e) => e.seasonNumber === file.season && e.episodeNumber === file.episode,
        );
        filenameInputs = {
          kind: "episode",
          showTitle: details.title,
          seasonNumber: file.season ?? 0,
          episodeNumber: file.episode ?? 0,
          episodeTitle: episode?.name ?? null,
        };
      } else {
        const year = details.year ? Number(details.year) : null;
        filenameInputs = {
          kind: "movie",
          title: details.title,
          year: year !== null && Number.isFinite(year) ? year : null,
        };
      }
      const label = buildOfflineFilename({ ...filenameInputs, container }).slice(0, -(container.length + 1));
      items.push({
        mediaId,
        payload: {
          fileId: file.id,
          mediaId,
          quality: String(best.quality),
          container,
          expectedBytes,
          skippedSubsForContainer,
          filename: label,
          ...(filenameInputs.kind === "episode" && filenameInputs.seasonNumber >= 1 && filenameInputs.episodeNumber >= 1
            ? { hints: { season: filenameInputs.seasonNumber, episode: filenameInputs.episodeNumber } }
            : {}),
          manifest: {
            videoInitKey: best.initKey,
            videoInitSize: best.initSize,
            videoChunks,
            audioTracks,
            subtitles: subs.map((s) => ({
              subtitleId: s.id,
              language: String(s.language ?? "und"),
              label: String(s.label ?? ""),
              format: s.format,
              objectKey: String(s.objectKey),
              sizeBytes: SUBTITLE_ESTIMATE_BYTES,
              isDefault: Boolean(s.isDefault),
            })),
            filenameInputs,
          },
        },
      });
    }
  }
  return { items, skipped };
};

const defaultFreeBytesAt = (dir: string): number => {
  // `statfsSync` needs an existing path: walk up to the nearest one (the picked folder normally exists).
  let probe = dir;
  for (;;) {
    try {
      const stat = statfsSync(probe);
      const free = Number(stat.bavail) * Number(stat.bsize);
      return Number.isFinite(free) && free > 0 ? free : 0;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return 0;
      probe = parent;
    }
  }
};

const freeBytesOf = (deps: BadgerExportHandlerDeps, dir: string): number => {
  try {
    return (deps.freeBytesAt ?? defaultFreeBytesAt)(dir);
  } catch (err) {
    console.warn(`[badger.export] free-space probe failed for ${dir}:`, err instanceof Error ? err.message : err);
    return 0;
  }
};

export const createBadgerExportEstimateHandler =
  (deps: BadgerExportHandlerDeps) =>
  async (payload: BadgerExportEstimatePayload): Promise<BadgerExportEstimateResult> => {
    console.info("[badger.export.estimate] entry", {
      all: payload.all ?? false,
      mediaCount: payload.mediaIds?.length ?? 0,
      fileCount: payload.fileIds?.length ?? 0,
      container: payload.container,
    });
    if (!deps.libraryDb.isOpen()) throw new Error("LIBRARY_DB_NOT_OPEN");
    const { items, skipped } = await collectItems(deps, payload, payload.container);
    const totalBytes = items.reduce((sum, it) => sum + it.payload.expectedBytes, 0);
    const freeBytesAvailable = freeBytesOf(deps, payload.destDir);
    const result = {
      count: items.length,
      totalBytes,
      freeBytesAvailable,
      sufficientSpace: freeBytesAvailable >= totalBytes + FREE_DISK_SAFETY_MARGIN_BYTES,
      skipped,
    };
    console.info("[badger.export.estimate] result", result);
    return result;
  };

export const createBadgerExportSubmitHandler =
  (deps: BadgerExportHandlerDeps) =>
  async (payload: BadgerExportSubmitPayload): Promise<BadgerExportSubmitResult> => {
    console.info("[badger.export.submit] entry", {
      all: payload.all ?? false,
      mediaCount: payload.mediaIds?.length ?? 0,
      fileCount: payload.fileIds?.length ?? 0,
      container: payload.container,
      layout: payload.layout,
      destDir: payload.destDir,
    });
    if (!deps.resolveToken()) return { errorCode: "not_authenticated" };
    if (!deps.resolveLibraryKey() || !deps.libraryDb.isOpen()) return { errorCode: "library_db_not_open" };
    try {
      await fs.access(payload.destDir, fsConstants.W_OK);
    } catch (err) {
      console.warn(`[badger.export.submit] dest_not_writable ${payload.destDir}:`, err instanceof Error ? err.message : err);
      return { errorCode: "dest_not_writable" };
    }

    const { items, skipped } = await collectItems(deps, payload, payload.container);
    if (items.length === 0) return { errorCode: "nothing_to_export" };
    const requiredBytes = items.reduce((sum, it) => sum + it.payload.expectedBytes, 0);
    const freeBytes = freeBytesOf(deps, payload.destDir);
    if (freeBytes < requiredBytes + FREE_DISK_SAFETY_MARGIN_BYTES) {
      console.warn("[badger.export.submit] insufficient_disk_space", { requiredBytes, freeBytes });
      return { errorCode: "insufficient_disk_space", requiredBytes, freeBytes };
    }

    const now = new Date().toISOString();
    const submitted: Array<{ mediaId: string; fileId: string; jobId: string }> = [];
    for (const item of items) {
      const jobId = crypto.randomUUID();
      const jobPayload: ExportJobPayload = { ...item.payload, destDir: payload.destDir, layout: payload.layout };
      const job: IngestJobRecord = {
        jobId,
        app: "badger",
        kind: "export",
        lane: "upload",
        variant: null,
        // Same rank as offline saves: user-paced, after ingest's first rendition.
        priority: 70,
        parentJobIds: [],
        groupId: item.mediaId,
        mediaId: item.mediaId,
        status: "queued",
        stageCode: "queued",
        stageLabel: "Queued",
        progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
        progressPct: 0,
        payload: jobPayload as unknown as Record<string, unknown>,
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
      };
      await deps.engine.submit(job);
      submitted.push({ mediaId: item.mediaId, fileId: item.payload.fileId, jobId });
    }
    console.info("[badger.export.submit] result", { submitted: submitted.length, skipped: skipped.length, requiredBytes });
    return { submitted, skipped };
  };

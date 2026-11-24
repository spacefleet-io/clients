import { AsyncLocalStorage } from "node:async_hooks";
import { join as joinPath } from "node:path";
import { getDesktopPlatform } from "@space/desktop-platform";
import {
  configureMediaIngestRuntime,
  processMediaJob,
  producePreviewSheets,
  produceSkipSignature,
  produceMediaOutputs,
  uploadEncryptedFile,
  uploadProducedMedia,
  type ProducedMedia,
  type ProducedMediaOutputs,
  type UploadProducedMediaArgs,
  type UploadProducedMediaResult,
} from "@space/ingest-core/mediaProcessor";
import type { QualityPreset } from "@space/ingest-core/quality";
import type { MediaPreviewSheets, MediaSkipSignatureRef } from "@space/shared/previewSheets";
import { createRuntimeContentStorageBridge, createRuntimeMediaStorageTransport } from "../core/content/storageBridge";
import { decryptMediaObject, sealMediaObjectWithPadding } from "@space/media-crypto";

const currentLibraryKey = new AsyncLocalStorage<string | null>();

const storageBridge = createRuntimeContentStorageBridge("badger");
const mediaStorageTransport = createRuntimeMediaStorageTransport(storageBridge);

const parseLibraryKey = () => {
  const normalized = currentLibraryKey.getStore()?.trim().replace(/\s+/g, "") ?? "";
  if (!normalized) return null;
  const raw = Buffer.from(normalized, "base64");
  if (raw.length !== 32) return null;
  return raw;
};

const encryptMediaObject = (plaintext: Buffer) => {
  const libraryKey = parseLibraryKey();
  if (!libraryKey) throw new Error("media_key_missing");
  return sealMediaObjectWithPadding(plaintext, libraryKey);
};

// The object format (magic, salt / nonce / tag sizes, header, HKDF salts and
// info) lives in @space/media-crypto, next to its inverse
// `decryptMediaObject` (also used by the offline-download step).

configureMediaIngestRuntime({
  resolveJobDir: (userId: string, jobId: string) =>
    joinPath(process.env.SF_TRANSCODE_DIR?.trim() || joinPath(process.cwd(), ".runtime", "transcode"), userId, jobId),
  resolveFfmpegPath: () => {
    const raw = process.env.SF_FFMPEG_PATH?.trim();
    if (!raw || raw === "undefined" || raw === "null") return undefined;
    return raw;
  },
  resolveFfprobePath: () => {
    const raw = process.env.SF_FFPROBE_PATH?.trim();
    if (!raw || raw === "undefined" || raw === "null") return undefined;
    return raw;
  },
  encryptMediaObject,
  ...mediaStorageTransport,
  getGpuVendor: () => getDesktopPlatform().hardware.detectGpuVendor(),
});

export const processBadgerMediaJob = async (input: {
  token: string;
  userId: string;
  jobId: string;
  inputPath: string;
  placementId: string;
  libraryKeyBase64?: string | null;
  sourceQualityOverride?: string;
  includeSource?: boolean;
  includeFallback: boolean;
  /** Phase 3 — explicit transcode variants (replaces `includeFallback` when set). */
  targetVariants?: QualityPreset[];
  includeAudio?: boolean;
  includeSubtitles?: boolean;
  includeChapters?: boolean;
  audioTrackIndexes?: number[];
  subtitleTrackIndexes?: number[];
  audioTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  subtitleTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  signal?: AbortSignal;
  onProgress?: (stage: "transcoding" | "uploading", progress: number) => void;
  onEncoder?: (encoder: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu") => void;
  onLog?: (line: string) => void;
}): Promise<{ produced: ProducedMedia; encoder: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu" }> =>
  currentLibraryKey.run(input.libraryKeyBase64?.trim() || null, async () =>
    processMediaJob({
      token: input.token,
      userId: input.userId,
      jobId: input.jobId,
      inputPath: input.inputPath,
      placementId: input.placementId,
      sourceQualityOverride: input.sourceQualityOverride,
      includeSource: input.includeSource,
      includeFallback: input.includeFallback,
      targetVariants: input.targetVariants,
      includeAudio: input.includeAudio,
      includeSubtitles: input.includeSubtitles,
      includeChapters: input.includeChapters,
      audioTrackIndexes: input.audioTrackIndexes,
      subtitleTrackIndexes: input.subtitleTrackIndexes,
      audioTrackOverrides: input.audioTrackOverrides,
      subtitleTrackOverrides: input.subtitleTrackOverrides,
      signal: input.signal,
      onProgress: input.onProgress,
      onEncoder: input.onEncoder,
      onLog: input.onLog,
    })
  );

// ---------------------------------------------------------------------------
// Phase F split — encode-only + upload-only entrypoints used by the engineV2
// step handlers. Both wrap the underlying `produceMediaOutputs` /
// `uploadProducedMedia` helpers with the AsyncLocalStorage library-key
// plumbing so the encryption path resolves the right master key for the
// active user.
//
// The deps adapter (`apps/runtime/src/modules/badger/steps/deps-adapter.ts`)
// accepts BOTH as injected dependencies; production wires these two so the
// engineV2 lane model is honest end-to-end (encode runs in the source/format
// lane; upload runs in the upload lane and does the real chunk work).
// ---------------------------------------------------------------------------

export const produceBadgerMediaOutputs = async (input: {
  userId: string;
  jobId: string;
  inputPath: string;
  libraryKeyBase64?: string | null;
  sourceQualityOverride?: string;
  // Streaming-source retranscode (Phase 7): the source is piped to ffmpeg
  // stdin instead of read from inputPath. MUST be forwarded to
  // produceMediaOutputs — without it, produceMediaOutputs runs in non-stream
  // mode and ffprobes the `retranscode-stream:<id>` sentinel inputPath,
  // failing with "Protocol not found". Pairs with sourceQualityOverride
  // (probe is skipped in streaming mode).
  inputStream?: AsyncIterable<Uint8Array> | null;
  /** Fresh-iterable factory so a failed hardware streaming encode can be replayed on CPU. */
  reopenInputStream?: (() => AsyncIterable<Uint8Array>) | null;
  /** Duration hint used in streaming mode (probe is skipped, so no probed duration). */
  inputDurationSeconds?: number | null;
  includeSource?: boolean;
  includeFallback: boolean;
  /** Phase 3 — explicit transcode variants (replaces `includeFallback` when set). */
  targetVariants?: QualityPreset[];
  includeAudio?: boolean;
  includeSubtitles?: boolean;
  includeChapters?: boolean;
  audioTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  subtitleTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  signal?: AbortSignal;
  onProgress?: (stage: "transcoding" | "uploading", progress: number) => void;
  onLog?: (line: string) => void;
}): Promise<ProducedMediaOutputs> =>
  currentLibraryKey.run(input.libraryKeyBase64?.trim() || null, async () =>
    produceMediaOutputs({
      userId: input.userId,
      jobId: input.jobId,
      inputPath: input.inputPath,
      inputStream: input.inputStream,
      reopenInputStream: input.reopenInputStream,
      inputDurationSeconds: input.inputDurationSeconds,
      sourceQualityOverride: input.sourceQualityOverride,
      includeSource: input.includeSource,
      includeFallback: input.includeFallback,
      targetVariants: input.targetVariants,
      includeAudio: input.includeAudio,
      includeSubtitles: input.includeSubtitles,
      includeChapters: input.includeChapters,
      audioTrackOverrides: input.audioTrackOverrides,
      subtitleTrackOverrides: input.subtitleTrackOverrides,
      signal: input.signal,
      onProgress: input.onProgress,
      onLog: input.onLog,
    })
  );

export const uploadBadgerProducedMedia = async (
  input: UploadProducedMediaArgs & { libraryKeyBase64?: string | null }
): Promise<UploadProducedMediaResult> =>
  currentLibraryKey.run(input.libraryKeyBase64?.trim() || null, async () =>
    uploadProducedMedia({
      token: input.token,
      userId: input.userId,
      jobId: input.jobId,
      scope: input.scope,
      variant: input.variant,
      placementId: input.placementId,
      seedChunkKeys: input.seedChunkKeys,
      stateStore: input.stateStore,
      signal: input.signal,
      onProgress: input.onProgress,
      onLog: input.onLog,
    })
  );

/**
 * Seek-bar preview sheets (MPV-PREV-02) encrypted with the given library key. The preview run is queued after the
 * source commit, outside the import's key context, so it brings the key itself.
 */
export const produceBadgerPreviewSheets = (
  input: Parameters<typeof producePreviewSheets>[0] & { libraryKeyBase64: string }
): Promise<MediaPreviewSheets> => {
  const { libraryKeyBase64, ...args } = input;
  return currentLibraryKey.run(libraryKeyBase64.trim() || null, () => producePreviewSheets(args));
};

/** A skip signature alone (META-SKIP-04, catch-up of a video whose previews predate signatures), encrypted the same way. */
export const produceBadgerSkipSignature = (
  input: Parameters<typeof produceSkipSignature>[0] & { libraryKeyBase64: string }
): Promise<MediaSkipSignatureRef> => {
  const { libraryKeyBase64, ...args } = input;
  return currentLibraryKey.run(libraryKeyBase64.trim() || null, () => produceSkipSignature(args));
};

/**
 * Phase 7 — fetch + decrypt one encrypted DASH object from storage. Used by
 * the retranscode step to stage source-format chunks before feeding them
 * into the Phase 3 encoder pipeline. Production wires this into
 * `buildBadgerStepDeps`'s `downloadAndDecryptObject` slot.
 *
 * Fails loud on missing key, magic mismatch, or GCM auth failure (matches
 * the inverse `encryptMediaObject` thrown errors). The retranscode step
 * surfaces those error messages on the failed-job event.
 */
export const downloadAndDecryptBadgerObject = async (
  token: string,
  objectKey: string,
  libraryKeyBase64: string,
  /** Cuts the download: at once for the caller, and the tunnel session at its next chunk (MPV-PREV-07 yield). */
  signal?: AbortSignal
): Promise<Buffer> => {
  signal?.throwIfAborted();
  // Not live playback: zero bytes while the silo is saturated, resumed afterwards (STOR-BW-09).
  const download = storageBridge.downloadObject(token, objectKey, {
    purpose: "export",
    ...(signal
      ? {
          onChunk: () => {
            signal.throwIfAborted();
          },
        }
      : {}),
  });
  if (!signal) return decryptMediaObject(await download, libraryKeyBase64);
  // A saturated silo may send nothing for a while: the caller does not wait for a chunk to learn it was cut.
  download.catch(() => {});
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return decryptMediaObject(await Promise.race([download, aborted]), libraryKeyBase64);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
};

/**
 * One cheap authenticated call (POST /storage/head for one key): throws when the backend cannot be reached or
 * refuses the session. The preview catch-up pass (MPV-PREV-03) checks it before each video.
 */
export const probeBadgerBackend = async (token: string, objectKey: string): Promise<void> => {
  await storageBridge.headObjects(token, [objectKey], { signal: AbortSignal.timeout(15_000) });
};

/**
 * Encrypt one local file with the library key and upload it as a new storage
 * object, on the media's silo when `placementId` is known (#145). The OCR
 * worker stores each text twin of a picture subtitle this way (PLAY-TRACK-05).
 */
export const uploadEncryptedBadgerFile = async (input: {
  token: string;
  filePath: string;
  libraryKeyBase64: string;
  placementId?: string;
  signal?: AbortSignal;
}): Promise<{ key: string; sizeBytes: number }> =>
  currentLibraryKey.run(input.libraryKeyBase64.trim() || null, async () => {
    const uploaded = await uploadEncryptedFile(input.token, input.filePath, {
      placementId: input.placementId,
      signal: input.signal,
      counting: { role: "subtitle" },
    });
    return { key: uploaded.key, sizeBytes: uploaded.sizeBytes };
  });

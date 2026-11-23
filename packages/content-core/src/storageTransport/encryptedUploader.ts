import { totalmem } from "node:os";
import { AdaptivePool } from "./adaptivePool";
import { uploadPlaybackGate } from "./uploadPlaybackGate";
import {
  uploadEncryptedContentObject,
  type ContentUploadLedger,
  type ContentObjectUploadOptions,
  type ContentObjectUploadResult,
  type ContentObjectUploadRuntime,
} from "../upload";

export type EncryptedObjectUploadRuntime = ContentObjectUploadRuntime;

export type EncryptedObjectUploadResult = ContentObjectUploadResult;

export type EncryptedObjectUploadOptions = Omit<ContentObjectUploadOptions, "uploadLedger"> & {
  outputId?: string;
  sessionManager?: ContentUploadLedger;
};

/** Upload slots per GiB of host RAM. Each slot holds its plaintext segment and its sealed copy (~2 x 4 MiB) plus tunnel frames. */
const UPLOAD_SLOTS_PER_GIB = 2;

/**
 * In-flight object uploads for a host with `totalMemBytes` of RAM: 8 to start, ramping to 16 on 8 GiB and up
 * (unchanged there); smaller hosts cap the ramp at 2 slots per (rounded: an
 * "8 GB" machine reports ~7.8 GiB) GiB, never under 4 (#928: on a 4 GB Celeron the
 * pool ramped towards 16 objects in flight while the app and runtime already held ~1 GB).
 */
export const uploadPoolLimits = (totalMemBytes: number): { initialConcurrency: number; maxConcurrency: number } => {
  const gib = Number.isFinite(totalMemBytes) && totalMemBytes > 0 ? totalMemBytes / 1024 ** 3 : Number.POSITIVE_INFINITY;
  const maxConcurrency = Math.max(4, Math.min(16, Math.round(gib) * UPLOAD_SLOTS_PER_GIB));
  return { initialConcurrency: Math.min(8, maxConcurrency), maxConcurrency };
};

const globalUploadPool = new AdaptivePool({
  ...uploadPoolLimits(totalmem()),
  label: "ingest-upload",
  // "uploads while a video plays" (#25): full / throttle / pause, set by the desktop.
  gate: uploadPlaybackGate,
});

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new Error("CANCELLED");
  }
};

export const uploadEncryptedObjectFile = async (
  runtime: EncryptedObjectUploadRuntime,
  token: string,
  filePath: string,
  options: EncryptedObjectUploadOptions = {}
): Promise<EncryptedObjectUploadResult> =>
  globalUploadPool.run(
    async () => {
      throwIfAborted(options.signal);
      return uploadEncryptedContentObject(runtime, token, filePath, {
        outputId: options.outputId,
        uploadLedger: options.sessionManager,
        signal: options.signal,
        placementId: options.placementId,
        counting: options.counting,
      });
    },
    // A chunk waiting out a pause must still react to cancel / shutdown.
    { signal: options.signal },
  );

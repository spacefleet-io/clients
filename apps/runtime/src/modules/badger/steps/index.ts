/**
 * Re-exports + a `registerBadgerStepHandlers(engine)` helper that registers
 * every Phase D badger step handler against an EngineV2 instance.
 *
 * All handlers are currently stubbed (`NotImplementedError`). Wiring them
 * here ensures the engine boots end-to-end with the dependency graph live —
 * any submitted job will progress through the scheduler and the cancellation
 * cascade and only fail at step dispatch with a deterministic error code.
 */
import type { EngineV2 } from "../../../core/jobs/engineV2";
import { probeStepHandler } from "./probe";
import { identifyStepHandler } from "./identify";
import { extractStepHandler } from "./extract";
import { transcodeStepHandler } from "./transcode";
import { retranscodeStepHandler } from "./retranscode";
import { uploadStepHandler } from "./upload";
import { commitStepHandler } from "./commit";
import { offlineDownloadStepHandler } from "./offlineDownload";
import { exportFileStepHandler } from "./exportFile";
import { registerFormatCancelCleanup } from "./discardOnCancel";
import { registerIngestSuccessCleanup } from "./cleanupOnSuccess";
import { registerFailedJobDismissCleanup } from "../failedJobs";

export {
  probeStepHandler,
  identifyStepHandler,
  extractStepHandler,
  transcodeStepHandler,
  retranscodeStepHandler,
  uploadStepHandler,
  commitStepHandler,
  exportFileStepHandler,
  offlineDownloadStepHandler,
};
export { NotImplementedError } from "./notImplemented";

export const registerBadgerStepHandlers = (engine: EngineV2): void => {
  engine.registerHandler("probe", probeStepHandler);
  engine.registerHandler("identify", identifyStepHandler);
  engine.registerHandler("extract", extractStepHandler);
  engine.registerHandler("transcode", transcodeStepHandler);
  // Phase 7 — post-ingest re-transcode jobs (replan_qualities adds) use a
  // dedicated step that stages encrypted DASH chunks from storage instead
  // of consuming a local input file. The `retranscode → upload → commit`
  // chain is seeded by `seedStepsForJob` when payload.retranscode === true.
  engine.registerHandler("retranscode", retranscodeStepHandler);
  engine.registerHandler("upload", uploadStepHandler);
  engine.registerHandler("commit", commitStepHandler);
  // Phase 2 — offline downloads. `kind: "download"` jobs run a single
  // `offline_download` step that fetches chunks, decrypts, concatenates per
  // track, muxes into MKV/MP4, atomic-renames the muxed file under the
  // user's offline dir, and registers a `media_local_downloads` row.
  engine.registerHandler("offline_download", offlineDownloadStepHandler);
  // Exports (OFFL-FILE-01 / ACCT-EXPORT-01): `kind: "export"` jobs write a plain file to a folder the user picked.
  engine.registerHandler("export_file", exportFileStepHandler);
  // #25: a format job can now be cancelled (source failed/cancelled) after
  // its transcode finished but before its upload ran — drop those local
  // encode outputs. Running steps clean up in their own handlers.
  registerFormatCancelCleanup(engine);
  // A succeeded ingest job's transcode directory (a full copy of the encode,
  // about the media's size) has no further use: drop it.
  registerIngestSuccessCleanup(engine);
  // A failed import removed from the Jobs panel drops its kept processed copy (UX-JOBS-03).
  registerFailedJobDismissCleanup(engine);
};

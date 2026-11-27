/**
 * Module-scoped dependency registry for Phase D badger ingest step handlers.
 *
 * Mirrors the `configureMediaIngestRuntime` pattern used by the legacy
 * `processMediaJob` pipeline: the host (runtime bootstrap) wires concrete
 * implementations once at startup; tests inject mocks via the same setter to
 * stay deterministic without spinning up real ffmpeg/storage.
 *
 * The deps interface is intentionally narrow — every step handler reaches
 * through this seam so unit tests can mock the whole ffmpeg + upload + library
 * DB boundary in one place.
 */

import type { PreviewSheetsCatchUpOptions, PreviewSheetsJob, PreviewSheetsOutcome } from "./previewSheetsAfterCommit";
import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";
import type { JobState } from "@space/content-core";
import type {
  BadgerIngestSkipMarker,
  BadgerIngestShowSkipCache,
} from "@space/runtime-contracts/badger/ingest";

export interface ProbeStreamSummary {
  index: number;
  codecType: "video" | "audio" | "subtitle" | string;
  codecName: string | null;
  language: string | null;
  label: string | null;
  width?: number | null;
  height?: number | null;
}

export interface ProbeResult {
  durationSeconds: number | null;
  videoCodec: string | null;
  videoWidth: number | null;
  videoHeight: number | null;
  sourceQuality: string | null;
  audioStreamCount: number;
  subtitleStreamCount: number;
  streams: ProbeStreamSummary[];
  chapters: Array<{ title: string; startSeconds: number }>;
}

export interface IdentifyResult {
  mediaId: string | null;
  parsedTitle: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  preexistingHint: boolean;
}

export interface ExtractInput {
  userId: string;
  jobId: string;
  inputPath: string;
  /**
   * User overrides for `und`-language audio tracks. Forwarded to
   * `processMediaJob.audioTrackOverrides` so the encoded outputs ship with
   * the user-typed language/label baked in. `index` is the audio-only
   * stream index (0 = first audio stream). See Bug #4.
   */
  audioOverrides?: Array<{ index: number; language: string; label: string }>;
  /** Same as audioOverrides, applied to subtitle tracks. */
  subtitleOverrides?: Array<{ index: number; language: string; label: string }>;
  signal: AbortSignal;
  /**
   * Progress callback. `stage` mirrors the legacy `processMediaJob` stage
   * name ("transcoding" while ffmpeg is encoding, "uploading" while chunks
   * are streamed to the storage gateway). The extract step uses this to
   * emit a stageCode transition (`extracting` → `uploading`) mid-step so the
   * source-job's badge reflects the actual phase rather than sitting on
   * "extracting" for the entire monolithic call.
   */
  onProgress?: (stage: "transcoding" | "uploading", pct: number) => void;
  onLog?: (line: string) => void;
  /** Per-media silo placement (#145); the legacy monolithic path uploads too. */
  placementId: string;
}

export interface ExtractResult {
  jobDir: string;
  state: JobState;
  /** Convenience: number of segments produced across all source outputs. */
  segmentCount: number;
}

export interface TranscodeInput extends ExtractInput {
  variant: string;
}

export interface TranscodeResult extends ExtractResult {
  variant: string;
}

/**
 * Phase 7 — input shape for post-ingest re-transcode jobs.
 *
 * Unlike `TranscodeInput`, there is no `inputPath` on disk. The source media
 * is reconstructed from already-uploaded DASH segments in object storage:
 * the runtime downloads + decrypts the source format's chunks (in list
 * order: `media_format_chunks.order_index`, or the packed list once
 * converted, LIB-FMT-11), stages them to a temp dir, and
 * feeds the staged manifest to ffmpeg. This avoids the streaming-stdin
 * complexity called out in the plan's risk register (DASH segments are
 * fragmented mp4 — concatenating via stdin sometimes trips ffmpeg).
 */
export interface RetranscodeInput {
  userId: string;
  jobId: string;
  /** `media_items.id` the file belongs to. The replan handler stamps it on
   *  the job payload; the step reads it back and the deps adapter uses it
   *  to look up the file's full format list in library-db. */
  mediaId: string;
  /** The committed file row the source format belongs to. */
  fileId: string;
  /** Quality preset to produce (e.g. "720p"). Drives the encoder recipe. */
  targetVariant: string;
  /** `media_formats.id` of the source format the chunks come from. */
  sourceFormatId: string;
  /** Quality preset of the source format (e.g. "1080p"). Used by Phase 3
   *  encoder selection — must be strictly higher resolution than
   *  targetVariant (the runtime never up-scales). */
  sourceVariant: string;
  signal: AbortSignal;
  onProgress?: (stage: "transcoding" | "uploading", pct: number) => void;
  onLog?: (line: string) => void;
}

export interface RetranscodeResult {
  jobDir: string;
  state: JobState;
  /** Convenience: number of segments produced for the target variant. */
  segmentCount: number;
  variant: string;
}

export interface UploadInput {
  userId: string;
  jobId: string;
  token: string;
  /** "source" uploads everything in MediaJobStateStore; "format" uploads only the variant's outputs. */
  scope: "source" | "format";
  variant?: string;
  /** Per-media silo placement (#145) shared by every upload of this media. */
  placementId: string;
  signal: AbortSignal;
  onProgress?: (pct: number) => void;
  onLog?: (line: string) => void;
}

export interface UploadResult {
  produced: ProducedMedia;
  /**
   * Object-storage keys uploaded by this call.
   *
   * **Semantics differ by code path** (Phase F transition state):
   * - **Split path** (`uploadProducedMedia` via deps-adapter): contains only
   *   NEW keys uploaded by THIS call. Pre-existing uploaded keys (e.g. from
   *   a partial-resume) are NOT included.
   * - **Legacy path** (`processMediaJob` no-op pass-through, kept for
   *   unmigrated tests): contains ALL keys from the cached `ProducedMedia`,
   *   including any uploaded by a previous run.
   *
   * No internal consumer currently reads this field beyond stashing it in
   * `step.outputs.uploadResult.uploadedKeys`. Any future consumer using it
   * for retention / refcount / dedup logic must account for the divergence,
   * or this field should be reconciled to a single semantic.
   */
  uploadedKeys: string[];
}

export interface CommitInput {
  userId: string;
  jobId: string;
  mediaId: string;
  filename: string;
  scope: "source" | "format";
  variant?: string;
  /**
   * TV episode coordinates. Sourced from `payload.hints.{season,episode}`
   * (initial submit or attach_metadata) by the commit step handler, then
   * forwarded to `linkFileToMedia` / `addAudioTrackWithChunks` /
   * `addSubtitleTrackWithObject` so the rows are stamped with the right
   * `(season, episode)` and the audio track resolves to the right
   * `episodeId`. Without this, TV files always landed with
   * `season = null, episode = null`, `addAudioTrackWithChunks` resolved
   * `episodeId = null`, `getPlayableEpisodeKeySet` returned an empty set,
   * and `MediaDetailsDialog`'s play button stayed disabled forever after
   * ingest succeeded (root cause for the playback.e2e Play-button-stays-
   * disabled bug). Both optional/undefined for movies and for legacy hints
   * that lacked the fields.
   */
  season?: number | null;
  episode?: number | null;
  /**
   * Optional — when provided, the commit deps can use it directly. When
   * absent, the deps adapter is expected to recover the `ProducedMedia` shape
   * by reading `MediaJobStateStore` for `(userId, jobId)`. Either path is
   * acceptable; tests typically provide it inline, production reads from disk.
   */
  produced?: ProducedMedia;
  /**
   * For format-job commits only: the `media_files.id` produced by the parent
   * source-job's commit step. The format-row write requires a non-null
   * file_id (FK constraint). When scope === "format" and this is missing the
   * deps adapter must fail loud — silently substituting mediaId would corrupt
   * media_formats.file_id and break format playback (Bug #11).
   */
  sourceFileId?: string | null;
  /**
   * Source-job commit only: the probed quality of the source file (e.g.
   * "1080p"), already on the source-job payload from `ingestSubmit.ts`. The
   * deps adapter uses this to flip `is_source = 1` on the matching row in
   * `media_formats` so the post-ingest replan flow can refuse to delete the
   * source-of-record and pick it as the streaming basis for re-transcodes
   * (see plan virtual-puzzling-sketch.md, Phase 2). Format-job commits omit
   * it (they never write a source row). Null/absent on legacy source-job
   * payloads that pre-date Phase 2 — the row gets is_source = 0 in that case
   * and the Phase 1 schema backfill takes care of pre-existing libraries.
   */
  sourceQuality?: string | null;
  signal: AbortSignal;
}

export interface CommitResult {
  fileId: string | null;
  formatIds: string[];
  /**
   * For TV source-job commits: the resolved `media_episodes.id` of the
   * (season, episode) the file maps to. Used by the commit step to address
   * `replaceSkipMarkers` writes at the right episode row. Movie commits and
   * format-job commits leave this null/omitted.
   */
  episodeId?: string | null;
}

/** Who is waiting for the library DB, for the bounded readiness wait + its logs. */
export interface LibraryReadyWait {
  /** Step name for log correlation ("commit", ...). */
  stage: string;
  userId: string;
  jobId: string;
  signal: AbortSignal;
}

/** Input of {@link BadgerStepDeps.discardJobOutputs}. */
export type DiscardJobOutputsInput = {
  userId: string;
  jobId: string;
  reason: string;
  /** The job's media; required to prove no committed row serves its uploads. */
  mediaId?: string | null;
  /** True once the job's commit step ever started: its row may have landed. */
  commitStarted?: boolean;
};

/** Input of {@link BadgerStepDeps.removeJobDir}. */
export type RemoveJobDirInput = {
  userId: string;
  jobId: string;
  reason: string;
};

export interface BadgerStepDeps {
  probe(inputPath: string, signal: AbortSignal): Promise<ProbeResult>;
  identify(input: {
    filename: string;
    hint: { mediaId?: string | null; season?: number | null; episode?: number | null };
  }): Promise<IdentifyResult>;
  extractSource(input: ExtractInput): Promise<ExtractResult>;
  transcodeFormat(input: TranscodeInput): Promise<TranscodeResult>;
  /**
   * Phase 7 — post-ingest re-transcode. Stages encrypted DASH chunks from
   * storage, decrypts them, and runs the Phase 3 encoder pipeline against
   * the staged manifest to produce a new quality variant. Optional so
   * tests that don't exercise the post-ingest flow don't have to wire it;
   * the engine handler fails loud with `STEP_RETRANSCODE_DEP_MISSING`
   * when the dep is missing in production.
   */
  retranscodeFormat?(input: RetranscodeInput): Promise<RetranscodeResult>;
  uploadOutputs(input: UploadInput): Promise<UploadResult>;
  commit(input: CommitInput): Promise<CommitResult>;
  /** Best-effort: flips `mediaItems.hasFiles = true`. May be undefined while wiring is incomplete. */
  markMediaPlayable?(mediaId: string): Promise<void> | void;
  /**
   * Coalesce all library-DB writes inside `fn` into a single snapshot
   * publish (`reason = label`). Used by the commit step to merge its
   * 6-15 sequential writes (linkFileToMedia + addMediaFormat ×N + audio
   * tracks ×N + subtitle tracks ×N + markMediaPlayable) into one
   * `library.updated` event so the renderer sees the post-commit state
   * in a single update instead of a burst of intermediate snapshots
   * carrying `hasFiles=false`. Optional so test setups that don't need
   * batching can omit it; production wiring always provides it.
   *
   * `readyWait` (when given) makes the batch wait — bounded, abortable,
   * logged — for the library DB to be open before starting. A job resumed
   * right after a runtime respawn reaches commit before the desktop re-opens
   * the library; the batch itself refuses a closed DB (LIBRARY_DB_NOT_OPEN),
   * so the wait must sit in front of it (#25 P3).
   */
  runLibraryBatch?<T>(
    label: string,
    fn: () => Promise<T>,
    readyWait?: LibraryReadyWait
  ): Promise<T>;
  /**
   * Read the badger library DB's current `version`. Used by the commit
   * step to record the post-batch version on `commitResult` so engineV2
   * can attach `libraryVersionAtDone` to the succeeded event — that's
   * the cross-stream join key the renderer uses to gate the play button
   * on the matching `library.updated` snapshot landing. Optional so
   * unit tests with hand-rolled deps don't have to wire it; engineV2
   * omits the field from the succeeded event when it's missing.
   */
  getLibraryVersion?(): number;
  /**
   * Format-job commit dependency: resolve the parent source-job's committed
   * `media_files.id` so the format row's `file_id` FK is correct. Returns
   * null if the parent job hasn't committed yet (which should not happen
   * because format jobs depend on source-job success — but guard anyway).
   * Optional so unit tests for source-only flows don't need to wire it.
   */
  lookupParentSourceFileId?(parentSourceJobId: string): Promise<string | null>;
  /**
   * Per-media placement (#145): the `payload.placementId` persisted on a job,
   * or null when the job is unknown or predates placement ids. Used by format
   * jobs to reuse their parent source job's placement.
   */
  lookupJobPlacementId?(jobId: string): Promise<string | null>;
  /** Persist a freshly minted `payload.placementId` so retries reuse it. */
  persistJobPlacementId?(jobId: string, placementId: string): Promise<void>;
  /**
   * Remove a cancelled format job's local encode outputs (`<transcode
   * base>/<userId>/<jobId>`). Called once the job is terminal-cancelled and
   * no encoder is writing into the directory any more — a cancelled job never
   * resumes, and a retry gets a fresh jobId. Logs the removal with its reason.
   *
   * Before the directory goes, the objects its `job_state.json` records as
   * uploaded are released from storage — but only when that is provably safe:
   * `commitStarted` (the job's commit step ever ran, so its media_formats row
   * may have landed) or an unknown `mediaId` releases nothing, and so does a
   * library that already references any of those keys for `mediaId`.
   * Optional so unit-test deps need not wire it.
   */
  discardJobOutputs?(input: DiscardJobOutputsInput): Promise<void>;
  /**
   * At runtime start: re-queue the seek-bar preview runs (MPV-PREV-02) a stopped or crashed runtime left pending
   * (RT-LIFE-04), after releasing the sheets they had uploaded. Settles when they all ran. Optional so unit-test
   * deps need not wire it.
   */
  resumePreviewSheets?(): Promise<void>;
  /**
   * MPV-PREV-03: run the seek-bar preview sheets of a video already in the library, queued behind the imports'
   * runs (one decode per runtime). Settles with how the run ended. Optional so unit-test deps need not wire it.
   */
  runPreviewSheetsCatchUp?(job: PreviewSheetsJob, options: PreviewSheetsCatchUpOptions): Promise<PreviewSheetsOutcome>;
  /** MPV-PREV-03: formats whose import's preview run is queued or running; the catch-up pass leaves them to it. */
  queuedPreviewImportFormatIds?(): string[];
  /** On shutdown: abort the running preview decode and keep it pending for the next start. */
  stopPreviewSheets?(): void;
  /**
   * Remove a SUCCEEDED ingest job's local transcode directory (`<transcode
   * base>/<userId>/<jobId>`) and forget its in-memory `produced` cache
   * entries. Unlike {@link discardJobOutputs} it never releases uploaded
   * objects: the job committed, so storage keeps them. Logs the removal and
   * its size. Best-effort: a failed removal is logged, never thrown.
   * Optional so unit-test deps need not wire it.
   */
  removeJobDir?(input: RemoveJobDirInput): Promise<void>;
  /**
   * Persist the service-fetched per-episode markers for the just-committed
   * file's episode (or the show's media row for a movie — movies omit
   * markers entirely, so callers should not invoke this for them). Idempotent
   * delete-then-insert under the hood. Optional so unit tests for flows that
   * don't exercise skip-markers don't have to wire it.
   */
  replaceSkipMarkers?(
    mediaId: string,
    episodeId: string | null,
    markers: BadgerIngestSkipMarker[]
  ): Promise<void> | void;
  /**
   * Persist the full-show skip-marker cache to `media_skip_analysis` with
   * `kind = "external-skip-markers-show-v1"`. Idempotent overwrite — same
   * payload across multiple files of the same show just refreshes the
   * timestamp. Optional, paired with `replaceSkipMarkers`.
   */
  upsertShowSkipCache?(
    showMediaId: string,
    payload: BadgerIngestShowSkipCache
  ): Promise<void> | void;
  /**
   * List all episode rows for a show, keyed by `"<season>:<episode>"` →
   * `media_episodes.id`. Used by the commit step to write per-episode
   * markers for every episode of the show that already has a row locally
   * (not just the one whose file was just imported), so playback on any
   * already-imported episode is instant.
   */
  listExistingEpisodeIds?(
    showMediaId: string
  ): Promise<Map<string, string>> | Map<string, string>;
}

/**
 * Round 8 H2 (revised after walk-4): the factory + cached-deps storage lives
 * on `globalThis` so it survives `bun --hot` re-evaluation of THIS file.
 *
 * Why module-scoped `let` doesn't work: Bun 1.3.5's `--hot` re-evaluates a
 * file on save, which re-runs every top-level `let` initializer. Both
 * `configured` AND `depsFactory` would reset to null on a deps.ts edit,
 * and the recovery path (`setEngineV2ForBadgerIngest` re-firing) does not
 * re-run reliably — `apps/runtime/src/index.ts` is the only call site, and
 * its top-level `Bun.serve(...)` fails with EADDRINUSE on a hot re-eval,
 * preventing the boot path from completing.
 *
 * Bun 1.3.5's `--hot` also does NOT invoke `import.meta.hot.accept(deps[], cb)`
 * callbacks (the parser is Webpack/Vite-syntax-compatible but skips
 * callback execution), so the round-7 hook in index.ts was dead code.
 *
 * Storing the factory on a `globalThis`-keyed slot moves the storage out of
 * the module-evaluation lifecycle entirely. Hot re-eval of deps.ts re-imports
 * type definitions, but the factory + cache survive at the JS-realm level
 * across as many reloads as Bun does. Production: zero behavioural change
 * vs the module-scoped version on a clean boot. Tests: parity preserved via
 * `__resetBadgerStepDeps()` which clears the global slot.
 */
const GLOBAL_SLOT = Symbol.for("@space/runtime/badger-steps/deps-registry/v1");

interface GlobalRegistrySlot {
  configured: BadgerStepDeps | null;
  depsFactory: (() => BadgerStepDeps) | null;
}

const getGlobalSlot = (): GlobalRegistrySlot => {
  const g = globalThis as unknown as Record<symbol, GlobalRegistrySlot | undefined>;
  let slot = g[GLOBAL_SLOT];
  if (!slot) {
    slot = { configured: null, depsFactory: null };
    g[GLOBAL_SLOT] = slot;
  }
  return slot;
};

export const configureBadgerStepDeps = (deps: BadgerStepDeps): void => {
  getGlobalSlot().configured = deps;
};

/**
 * Round 8 H2: stash a factory that `getBadgerStepDeps()` can call when the
 * eager `configured` slot has been reset (e.g. an explicit reset, or a
 * future host that prefers lazy boot). The factory is also persisted on the
 * `globalThis` slot so HMR re-eval of this file does NOT wipe it.
 *
 * Idempotent — last factory wins, mirroring `configureBadgerStepDeps`.
 */
export const configureBadgerStepDepsFactory = (
  factory: () => BadgerStepDeps
): void => {
  getGlobalSlot().depsFactory = factory;
};

export const getBadgerStepDeps = (): BadgerStepDeps => {
  const slot = getGlobalSlot();
  if (slot.configured) return slot.configured;
  if (slot.depsFactory) {
    const fresh = slot.depsFactory();
    slot.configured = fresh;
    console.info(
      "[badger.steps] deps re-built via factory (HMR recovery)"
    );
    return fresh;
  }
  // Round 7 G2 defense in depth: this throw bubbles into a generic
  // engineV2 `handler-error` and the user has to read the step row's
  // error_message to know it was the deps gap. Logging the failure mode
  // (with a captured stack so we can see WHICH dispatch path tripped it)
  // BEFORE the throw means the runtime log keeps a separate audit line
  // independent of the step-failure rendering. See engineV2 catch-block
  // for the bubbling path.
  const stack = new Error().stack ?? "(no stack)";
  console.error(
    `[badger.steps] BADGER_STEP_DEPS_NOT_CONFIGURED — getBadgerStepDeps() called before configureBadgerStepDeps(). Likely cause: neither configureBadgerStepDeps() nor configureBadgerStepDepsFactory() ran before the first dispatch. Stack: ${stack}`
  );
  throw new Error(
    "BADGER_STEP_DEPS_NOT_CONFIGURED — call configureBadgerStepDeps() before submitting jobs"
  );
};

/** Test-only: clears the configured deps and factory. Production code should never call this. */
export const __resetBadgerStepDeps = (): void => {
  const slot = getGlobalSlot();
  slot.configured = null;
  slot.depsFactory = null;
};

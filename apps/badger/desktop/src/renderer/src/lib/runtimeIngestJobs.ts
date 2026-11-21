/**
 * Renderer-side hook for the v2 ingest queue. Reads from the shared
 * `runtimeJobsStore` (one EventSource connection per renderer, one `byId`
 * map shared across all consumers) and selects a filtered view.
 *
 * Plan reference: video-ingestion-is-buggy-effervescent-teapot.md (round 6,
 * Part A). Prior to round 6 each hook instance owned its own bootstrap +
 * subscription, which left the modal stale while open because three
 * surfaces fanned out into three independent state maps.
 *
 * - The shared store handles bootstrap snapshot, EventSource lifecycle,
 *   visibility reconcile, heartbeat reconcile, and engine-down probing.
 * - This hook is a thin `useSyncExternalStore` selector — `acquire()` on
 *   mount, `release()` on unmount, then the existing `useMemo` filtering.
 *
 * Tests live at `tests/runtime-ingest-jobs.test.tsx`.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { IngestJobRecordZ } from "@space/runtime-contracts/runtime/jobs";
import type { MediaRow } from "@space/shared/libraryTypes";
import type { LabJob } from "../../../shared/labQueueShared";
import type { LabJobGroup } from "@/components/labQueueGroups";
import {
  acquire as acquireStore,
  release as releaseStore,
  getSnapshot as getStoreSnapshot,
  subscribe as subscribeStore,
} from "./runtimeJobsStore";

// Renderer-local extension of the contract job record. The optional
// `libraryVersionAtDone` is sourced from the `runtime.jobs.succeeded` event's
// sibling field (NOT part of the contract IngestJobRecord) and persisted onto
// the per-job state so the play-button gate can require the renderer's
// last-seen library snapshot version to have caught up before enabling
// playback. Closes the cross-stream race between jobs SSE and library SSE.
//
// `libraryVersionDoneAt` is the renderer wall-clock time (epoch ms) the
// `runtime.jobs.succeeded` event landed. The play-button gate consults it
// alongside `libraryVersionAtDone` to time-out the gate after a stabilization
// window so a stalled library SSE (network blip, runtime hot-reload mid-ingest,
// edge-case dev-mode warmups) does not lock the user out indefinitely.
export type IngestJobRecord = IngestJobRecordZ & {
  libraryVersionAtDone?: number;
  libraryVersionDoneAt?: number;
};

export type SubmitSourcesInput = {
  userId: string;
  sources: Array<{
    filename: string;
    sizeMb?: number | null;
    sourceQuality?: string;
    desiredFormats?: string[];
    hints?: {
      mediaId?: string;
      pendingMediaPayload?: unknown;
      season?: number;
      episode?: number;
      matchedTitle?: string;
    };
  }>;
};

export type SubmittedJob = {
  groupId: string;
  sourceJobId: string;
  /** Per-media silo placement (#145); null for a deduped legacy source. */
  placementId: string | null;
  formatJobIds: Array<{ variant: string; jobId: string }>;
};

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------
//
// The legacy LabJob.status union is wider than IngestJobStatus and is what
// the existing GroupCard / LabStatusBadge consume. We map conservatively:
//   queued → "waiting"
//   running + kind="source" → "uploading" (source ingest = encrypt+chunk+push)
//   running + kind="format" → "transcoding"
//   succeeded → "done"
//   failed → "failed"
//   cancelled → "cancelled"
//   interrupted → "waiting" (will be re-evaluated by hydrateOnBoot)

const mapStatus = (
  s: IngestJobRecord["status"],
  kind?: IngestJobRecord["kind"],
): LabJob["status"] => {
  switch (s) {
    case "queued":
      return "waiting";
    case "running":
      return kind === "source" ? "uploading" : "transcoding";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "waiting";
    default:
      return "waiting";
  }
};

// Build a media-id-keyed lookup for the converter. Accepts either a Map or
// a MediaRow[] for ergonomics at call sites.
export const buildMediaByIdIndex = (
  media?: MediaRow[] | Map<string, MediaRow>
): Map<string, MediaRow> => {
  if (!media) return new Map();
  if (media instanceof Map) return media;
  const out = new Map<string, MediaRow>();
  for (const m of media) out.set(m.id, m);
  return out;
};

// Pull common payload-shape hints out of the unstructured payload record.
// payload may carry { filename, hints?: { season, episode, codec? } } as
// produced by submitSources. Older snapshots may not carry hints.
type IngestPayloadHints = {
  filename?: string;
  hints?: {
    season?: number | null;
    episode?: number | null;
    codec?: string;
  };
  // Offline-download jobs (kind === "download") don't carry `filename`/`hints`;
  // their friendly label lives in the manifest snapshot taken at submit time
  // (the same data `buildOfflineFilename` uses to name the saved file). This is
  // a renderer-local mirror of the unexported runtime
  // `OfflineDownloadManifest.filenameInputs` union — additive-only.
  manifest?: {
    filenameInputs?:
      | { kind: "movie"; title: string; year?: number | null }
      | {
          kind: "episode";
          showTitle: string;
          seasonNumber: number;
          episodeNumber: number;
          episodeTitle?: string | null;
        };
  };
};

// Build the no-extension friendly label for an offline-download job from its
// submit-time manifest snapshot. Mirrors `@space/shared/offlineFilename`'s
// format ("Show - S01E01 - Title" / "Title (Year)") so completed/legacy jobs —
// whose persisted payload predates the runtime `payload.filename` stamp — still
// render a human label instead of the raw job UUID. Self-contained: survives
// media-row deletion and matches the saved file's on-disk name.
const pad2 = (n: number) => String(Math.max(0, Math.trunc(n))).padStart(2, "0");
const offlineManifestLabel = (
  fi: NonNullable<IngestPayloadHints["manifest"]>["filenameInputs"]
): string | undefined => {
  if (!fi) return undefined;
  if (fi.kind === "episode") {
    const base = `${fi.showTitle.trim()} - S${pad2(fi.seasonNumber)}E${pad2(fi.episodeNumber)}`;
    return fi.episodeTitle && fi.episodeTitle.trim()
      ? `${base} - ${fi.episodeTitle.trim()}`
      : base;
  }
  return typeof fi.year === "number" && Number.isFinite(fi.year)
    ? `${fi.title.trim()} (${Math.trunc(fi.year)})`
    : fi.title.trim();
};

// Place in line (1-based) of every queued job, in the order the runtime's
// scheduler takes them: priority ascending, then oldest first, the jobId as
// tie-break (engineV2Runnable `compareEntries`). A queued job is either new or
// between two steps waiting for a lane slot (#2499, INGS-QUEUE-01); both read
// "Waiting · #N in line" in the UI, never as started.
export const computeQueuePositions = (
  jobs: Iterable<IngestJobRecord>
): Map<string, number> => {
  const queued: IngestJobRecord[] = [];
  for (const rec of jobs) if (rec.status === "queued") queued.push(rec);
  queued.sort(
    (a, b) =>
      (a.priority ?? 0) - (b.priority ?? 0) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0)
  );
  return new Map(queued.map((rec, index) => [rec.jobId, index + 1]));
};

// Adapter: IngestJobRecord → LabJob. With media supplied, populates
// matchedTo/posterPath/type so labJobPresentation produces meaningful
// labels ("Source 1080p" / "360p H.264") and TV episode chips render.
const toLabJob = (
  rec: IngestJobRecord,
  mediaById: Map<string, MediaRow>,
  queuePositions: Map<string, number>
): LabJob => {
  const payload = (rec.payload ?? {}) as IngestPayloadHints;
  // Offline-download metadata snapshot. Only consulted for download jobs —
  // source/format jobs never carry `manifest.filenameInputs`, so `fi` stays
  // undefined and every fallback below is inert (ingest labels unchanged).
  // Export jobs (plain-file "Download file", OFFL-FILE-01) carry the same manifest snapshot.
  const fi = rec.kind === "download" || rec.kind === "export" ? payload.manifest?.filenameInputs : undefined;
  const manifestLabel = offlineManifestLabel(fi);
  // Stamp wins for new jobs (payload.filename); manifest covers completed/legacy
  // jobs whose persisted payload predates the stamp; UUID is the last resort.
  const filename = payload.filename ?? manifestLabel ?? rec.mediaId ?? rec.jobId;
  const matched = mediaById.get(rec.mediaId);
  const matchedTo = matched
    ? {
        title: matched.title,
        year: matched.year,
        posterPath: matched.posterPath,
        type: matched.type,
      }
    : undefined;
  // Map runtime IngestJobKind → LabJob.jobType. The third arm ("download")
  // is the new offline-mode job kind (Phase 2 of the offline-mode plan).
  // Older event payloads with `rec.kind === "source"` fall through the
  // else branch unchanged. Any unknown kind also falls to "source" so the
  // sidebar doesn't crash on a contract drift.
  const jobType: LabJob["jobType"] =
    rec.kind === "format"
      ? "transcode"
      : rec.kind === "download"
        ? "download"
        : rec.kind === "export"
          ? "export"
          : "source";
  const codec = payload.hints?.codec ?? "h264";
  const selectedFormats =
    rec.kind === "format" && rec.variant
      ? [{ quality: rec.variant, codec }]
      : undefined;
  // For download episodes, prefer the manifest's show/movie title so the row
  // reads sensibly even before the media row syncs.
  const downloadTitle =
    fi?.kind === "episode" ? fi.showTitle : fi?.kind === "movie" ? fi.title : undefined;
  const detectedTitle = matched?.title ?? downloadTitle ?? filename;
  // Season/episode: prefer explicit hints (ingest + new download stamp), then
  // the download manifest snapshot (completed/legacy jobs). Guard >= 1 so movies
  // and null-season episodes never render a phantom S00E00 chip.
  const detectedSeason =
    typeof payload.hints?.season === "number"
      ? payload.hints.season
      : fi?.kind === "episode" && fi.seasonNumber >= 1
        ? fi.seasonNumber
        : undefined;
  const detectedEpisode =
    typeof payload.hints?.episode === "number"
      ? payload.hints.episode
      : fi?.kind === "episode" && fi.episodeNumber >= 1
        ? fi.episodeNumber
        : undefined;
  return {
    id: rec.jobId,
    filename,
    status: mapStatus(rec.status, rec.kind),
    progress: typeof rec.progressPct === "number" ? rec.progressPct : 0,
    error: rec.errorMessage ?? undefined,
    matchedMediaId: rec.mediaId ?? undefined,
    groupId: rec.groupId ?? rec.mediaId ?? rec.jobId,
    matchedTo,
    detectedTitle,
    detectedSeason,
    detectedEpisode,
    jobType,
    selectedFormats,
    uploadSpeedMbps:
      typeof rec.uploadSpeedBytesPerSec === "number" && rec.uploadSpeedBytesPerSec > 0
        ? rec.uploadSpeedBytesPerSec / 1024 / 1024
        : 0,
    sourceQuality: rec.variant ?? undefined,
    // `runtime.jobs.started` flips a job to running without a stage, so until
    // the step's first progress event the record still says "Queued" or
    // "Waiting" — which the running badge printed beside its % bar (#2499
    // hand try). No stage yet: the badge falls back to its status word.
    stageLabel:
      rec.status === "running" && (rec.stageCode === "queued" || rec.stageCode === "waiting")
        ? undefined
        : rec.stageLabel ?? undefined,
    queuePosition: queuePositions.get(rec.jobId),
    createdAt: rec.createdAt,
  } satisfies LabJob;
};

// Convert IngestJobRecord[] → LabJob[] (flat list, no grouping). Used by
// LabJobsProvider to feed downstream consumers (Library gallery overlay,
// ghost posters, Processes tab gate) with V2-derived data in legacy shape.
export const ingestJobsToLabJobs = (
  jobs: IngestJobRecord[],
  media?: MediaRow[] | Map<string, MediaRow>
): LabJob[] => {
  const idx = buildMediaByIdIndex(media);
  const queuePositions = computeQueuePositions(jobs);
  return jobs.map((rec) => toLabJob(rec, idx, queuePositions));
};

// A job is "terminal" when it can no longer change state without an explicit
// user retry/dismiss action. Used by the orphan-group filter below.
//
// `interrupted` is included alongside `succeeded | failed | cancelled` even
// though `mapStatus()` surfaces it as `"waiting"` in the active-jobs UI. The
// reason: an interrupted job is one the runtime gave up on mid-flight (process
// crash, kill -9, etc.). The hydrate-on-boot pass either re-promotes it to a
// runnable status or it stays `interrupted` indefinitely. From the perspective
// of the orphan sweep — "this group has no media row AND nothing in this group
// is making forward progress" — `interrupted` rows that survived hydrate are
// exactly the dead weight the user wants to clear. Bug #10 follow-up (Walk #3).
const TERMINAL_INGEST_STATUSES: ReadonlySet<IngestJobRecord["status"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

const isTerminalIngestStatus = (s: IngestJobRecord["status"]): boolean =>
  TERMINAL_INGEST_STATUSES.has(s);

// A group is a "stale orphan" when no media_items row matches its mediaId AND
// every job in the group is in a terminal state. These represent failed /
// cancelled jobs whose pending media row was already discarded — the user can
// neither open them (no media to navigate to) nor act on them as in-flight.
// Active orphans (queued/running jobs without a media row yet) are valid
// in-flight pre-commit state and must NOT be filtered.
export const isStaleOrphanGroup = (
  rawJobs: IngestJobRecord[],
  mediaById: Map<string, MediaRow>
): boolean => {
  if (rawJobs.length === 0) return false;
  const firstMediaId = rawJobs[0]!.mediaId;
  const hasMediaRow = !!mediaById.get(firstMediaId);
  if (hasMediaRow) return false;
  return rawJobs.every((rec) => isTerminalIngestStatus(rec.status));
};

// Pick the LabJob whose live stageLabel best represents the group's current
// activity. Active states (transcoding/uploading) win first, then any
// non-terminal job, then the first job. Returns null only for an empty list.
// Used by buildIngestJobGroups (group badge) and libraryGhosts (ghost poster
// pill) to surface the same micro-stage label per-job badges already show.
export const pickMostActiveJob = (jobs: LabJob[]): LabJob | null => {
  if (jobs.length === 0) return null;
  const active = jobs.find(
    (j) => j.status === "transcoding" || j.status === "uploading",
  );
  if (active) return active;
  const nonTerminal = jobs.find(
    (j) => j.status !== "done" && j.status !== "cancelled" && j.status !== "failed",
  );
  if (nonTerminal) return nonTerminal;
  return jobs[0] ?? null;
};

// Adapter: produce LabJobGroup[] directly from IngestJobRecord[]. With
// media supplied, group title/posterPath/type come from the matched
// MediaRow so the V2 sidebar renders the same as the V1 GroupCard.
//
// Stale orphan groups (no matching media_items row + all jobs terminal) are
// filtered out — they're un-openable and un-actionable cards from prior
// failed/cancelled non-dismissed jobs whose pending media row was discarded.
// The "Dismiss stale jobs" action in the sidebar surfaces them by groupId for
// bulk cleanup via cancelByGroup.
export const buildIngestJobGroups = (
  jobs: IngestJobRecord[],
  media?: MediaRow[] | Map<string, MediaRow>
): LabJobGroup[] => {
  const mediaById = buildMediaByIdIndex(media);
  const queuePositions = computeQueuePositions(jobs);
  const groups = new Map<string, { jobs: LabJob[]; rawJobs: IngestJobRecord[] }>();
  for (const rec of jobs) {
    const key = rec.groupId ?? rec.mediaId ?? rec.jobId;
    const entry = groups.get(key) ?? { jobs: [], rawJobs: [] };
    entry.jobs.push(toLabJob(rec, mediaById, queuePositions));
    entry.rawJobs.push(rec);
    groups.set(key, entry);
  }
  const built = Array.from(groups.entries())
    .filter(([, entry]) => !isStaleOrphanGroup(entry.rawJobs, mediaById))
    .map(([id, entry]) => {
    const labJobs = entry.jobs;
    const hasUploading = labJobs.some((j) => j.status === "uploading");
    const hasTranscoding = labJobs.some((j) => j.status === "transcoding");
    const hasFailed = labJobs.some((j) => j.status === "failed");
    // Fallback is the most active unfinished job, not the first one: a group
    // whose running jobs are momentarily back in line reads "Waiting · #N in
    // line", never its first episode's "Done" (#2499 hand try).
    const headerJob = pickMostActiveJob(labJobs);
    const status: LabJob["status"] = hasUploading
      ? "uploading"
      : hasTranscoding
      ? "transcoding"
      : hasFailed
      ? "failed"
      : headerJob?.status ?? "waiting";
    const stageLabel = headerJob?.stageLabel;
    // A waiting group's place in line is its earliest job's: the next to run.
    const positions = labJobs.flatMap((j) => (j.queuePosition === undefined ? [] : [j.queuePosition]));
    const queuePosition =
      status === "waiting" && positions.length > 0 ? Math.min(...positions) : undefined;
    const progress =
      labJobs.length === 0
        ? 0
        : Math.round(
            labJobs.reduce(
              (sum, j) => sum + (Number.isFinite(j.progress) ? j.progress : 0),
              0
            ) / labJobs.length
          );
    const uploadSpeeds = labJobs
      .map((j) => (Number.isFinite(j.uploadSpeedMbps) ? Number(j.uploadSpeedMbps) : 0))
      .filter((v) => v > 0);
    const uploadSpeedMbps =
      uploadSpeeds.length > 0
        ? uploadSpeeds.reduce((sum, v) => sum + v, 0) / uploadSpeeds.length
        : 0;
    const firstRaw = entry.rawJobs[0];
    const matched = firstRaw ? mediaById.get(firstRaw.mediaId) : undefined;
    const payload = (firstRaw?.payload ?? {}) as IngestPayloadHints;
    // Download group fallback: when the media row isn't synced yet, resolve the
    // show/movie title from the manifest snapshot instead of dropping to the
    // group's UUID id.
    const dlFi =
      firstRaw?.kind === "download" || firstRaw?.kind === "export" ? payload.manifest?.filenameInputs : undefined;
    const dlTitle =
      dlFi?.kind === "episode" ? dlFi.showTitle : dlFi?.kind === "movie" ? dlFi.title : undefined;
    const title =
      matched?.title ??
      labJobs[0]?.matchedTo?.title ??
      payload.filename ??
      dlTitle ??
      id;
    return {
      id,
      title,
      posterPath: matched?.posterPath ?? null,
      type: matched?.type,
      jobs: labJobs,
      progress,
      status,
      stageLabel,
      queuePosition,
      uploadSpeedMbps,
    };
  });
  // Most-recent first: rank groups by the newest createdAt across their
  // jobs so freshly-submitted work surfaces at the top. Groups with no
  // dated jobs sink to the bottom.
  return built
    .map((group) => ({ group, recency: groupRecency(group) }))
    .sort((a, b) => b.recency - a.recency)
    .map(({ group }) => group);
};

const groupRecency = (group: LabJobGroup): number => {
  let max = 0;
  for (const job of group.jobs) {
    const ts = job.createdAt ? Date.parse(job.createdAt) : NaN;
    if (Number.isFinite(ts) && ts > max) max = ts;
  }
  return max;
};

// Find the unique groupIds of all stale orphan groups (no media row + all
// terminal). Used by the sidebar "Dismiss stale jobs" overflow action to
// fan out cancelByGroup calls — cancelByGroup also dismisses terminal jobs,
// so a single sweep clears the orphan cards.
export const findStaleOrphanGroupIds = (
  jobs: IngestJobRecord[],
  media?: MediaRow[] | Map<string, MediaRow>
): string[] => {
  const mediaById = buildMediaByIdIndex(media);
  const byGroup = new Map<string, IngestJobRecord[]>();
  for (const rec of jobs) {
    const key = rec.groupId ?? rec.mediaId ?? rec.jobId;
    const list = byGroup.get(key) ?? [];
    list.push(rec);
    byGroup.set(key, list);
  }
  const out: string[] = [];
  for (const [groupId, recs] of byGroup) {
    if (isStaleOrphanGroup(recs, mediaById)) out.push(groupId);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Cross-stream play-button gate
// ---------------------------------------------------------------------------

/**
 * Stabilization window (ms) after `runtime.jobs.succeeded` lands during which
 * the play-button gate keeps holding the user back, waiting for the matching
 * `library.updated` event to advance the renderer's library version. Past
 * this window the gate falls open even if the version is still behind, so a
 * stalled library SSE (network blip, runtime hot-reload mid-ingest, dev-mode
 * warmup quirks) does not lock the user out indefinitely. ui-driver Run 7
 * measured 699ms end-to-end in production, so 2000ms gives 3× headroom.
 */
export const LIBRARY_VERSION_GATE_TIMEOUT_MS = 2000;

/**
 * Returns true when the most recent terminal job for a media item declared a
 * post-commit library version that the renderer's last-seen library snapshot
 * has NOT yet caught up to. Used by the play-button gate to keep playback
 * disabled across the residual race between the runtime jobs SSE and the
 * library SSE.
 *
 * Defaults to `false` (NOT pending — gate stays open) when:
 *   - the job has no `libraryVersionAtDone` (older runtime, or commit step
 *     that didn't write the library DB), or
 *   - `currentLibraryVersion` is undefined (no snapshot applied yet — fall
 *     back to existing `hasFiles` check), or
 *   - `currentLibraryVersion >= libraryVersionAtDone`, or
 *   - the stabilization window has elapsed since the job hit `succeeded`
 *     (`now - libraryVersionDoneAt > LIBRARY_VERSION_GATE_TIMEOUT_MS`).
 *
 * Defaults to `true` (gate must close) when the renderer's library version
 * is strictly behind the version stamped on the succeeded event AND we are
 * still inside the stabilization window.
 */
export const isLibraryVersionPending = (
  job:
    | Pick<IngestJobRecord, "libraryVersionAtDone" | "libraryVersionDoneAt">
    | null
    | undefined,
  currentLibraryVersion: number | undefined,
  now: number = Date.now(),
): boolean => {
  if (!job) return false;
  if (job.libraryVersionAtDone == null) return false;
  if (typeof currentLibraryVersion !== "number") return false;
  if (currentLibraryVersion >= job.libraryVersionAtDone) return false;
  // Timeout fallback: if we never observed when the job entered `succeeded`
  // (older event in the SSE replay log), treat the gate as open — the
  // surrounding `hasFiles` check is the safety net. If the timestamp IS
  // present and the window has elapsed, also fall through.
  if (typeof job.libraryVersionDoneAt !== "number") return false;
  if (now - job.libraryVersionDoneAt > LIBRARY_VERSION_GATE_TIMEOUT_MS) {
    return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Event reducer
// ---------------------------------------------------------------------------

export const applyIngestJobEvent = (
  byId: Map<string, IngestJobRecord>,
  event: import("@space/runtime-contracts/runtime/jobs").RuntimeJobsEvent
): Map<string, IngestJobRecord> => {
  const next = new Map(byId);
  switch (event.event) {
    case "runtime.jobs.created":
    case "runtime.jobs.failed":
    case "runtime.jobs.cancelled": {
      const rec = event.job as unknown as IngestJobRecord;
      next.set(rec.jobId, rec);
      return next;
    }
    case "runtime.jobs.succeeded": {
      // Persist the optional `libraryVersionAtDone` carried alongside the
      // job record so the play-button gate can compare against the
      // renderer's last-seen library snapshot version. Default to
      // `undefined` when absent (back-compat with pre-Phase-3 events
      // replayed from the SSE log).
      //
      // Stamp `libraryVersionDoneAt` (renderer wall-clock) only when the
      // version IS present — the gate uses it to time-out a stalled
      // library SSE catch-up. Older events with no version are not
      // gating anyway, so the timestamp is irrelevant for them.
      const rec: IngestJobRecord = {
        ...(event.job as unknown as IngestJobRecord),
        libraryVersionAtDone: event.libraryVersionAtDone,
        libraryVersionDoneAt:
          typeof event.libraryVersionAtDone === "number" ? Date.now() : undefined,
      };
      next.set(rec.jobId, rec);
      return next;
    }
    case "runtime.jobs.started": {
      const cur = next.get(event.jobId);
      if (!cur) return next;
      next.set(event.jobId, { ...cur, status: "running" });
      return next;
    }
    case "runtime.jobs.progress": {
      const cur = next.get(event.jobId);
      if (!cur) return next;
      // Progress events carry status so the per-job UI badge can recover when
      // the started event was missed (late mount, dropped event, replay from a
      // low Last-Event-ID). status is optional in the schema for back-compat
      // with payloads emitted before round 7, hence `?? cur.status`.
      next.set(event.jobId, {
        ...cur,
        progressPct: event.progressPct,
        uploadSpeedBytesPerSec: event.uploadSpeedBytesPerSec ?? cur.uploadSpeedBytesPerSec,
        status: event.status ?? cur.status,
        stageCode: event.stageCode ?? cur.stageCode,
        stageLabel: event.stageLabel ?? cur.stageLabel,
      });
      return next;
    }
    case "runtime.jobs.dismissed": {
      next.delete(event.jobId);
      return next;
    }
    default:
      return next;
  }
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export type RuntimeIngestError = {
  errorCode: string;
  message: string;
  status: number;
};

// Engine-down error codes from the runtime jobs v2 503 envelope (see
// runtime-eng: apps/runtime/src/core/jobs/engineV2BootStatus.ts), plus
// renderer-side codes for IPC/SSE unavailability. All map to the same
// "Ingest unavailable — restart the desktop / run dev:core:full" copy.
const ENGINE_DOWN_CODES = new Set([
  "engine_v2_disabled",
  "engine_v2_boot_failed",
  "engine_v2_not_ready",
  "not_enabled",
  "runtime_jobs_ipc_unavailable",
  "runtime_jobs_unreachable",
  "runtime_jobs_ws_closed",
]);

export const isEngineDownError = (err: RuntimeIngestError | null): boolean =>
  !!err && ENGINE_DOWN_CODES.has(err.errorCode);

export type UseRuntimeIngestJobsResult = {
  jobs: IngestJobRecord[];
  groups: LabJobGroup[];
  loading: boolean;
  error: Error | null;
  runtimeError: RuntimeIngestError | null;
};

export function useRuntimeIngestJobs(filter?: {
  mediaId?: string;
  media?: MediaRow[] | Map<string, MediaRow>;
}): UseRuntimeIngestJobsResult {
  // Refcounted lifecycle: every consumer acquires on mount and releases on
  // unmount. The store only opens one EventSource for the renderer regardless
  // of how many hook instances are active.
  useEffect(() => {
    acquireStore();
    return () => {
      releaseStore();
    };
  }, []);

  const snapshot = useSyncExternalStore(subscribeStore, getStoreSnapshot, getStoreSnapshot);

  const jobs = useMemo(() => {
    const all = Array.from(snapshot.byId.values());
    if (!filter?.mediaId) return all;
    // Match by EITHER mediaId or groupId. Pre-fix this was
    // `(j.groupId ?? j.mediaId) === filter.mediaId`, which always
    // picked groupId first — that broke replan jobs whose groupId is
    // structured (`replan:${mediaId}:${fileId}:${variant}`). They still
    // carry the bare mediaId on the job record itself, so the OR is
    // the correct match.
    return all.filter(
      (j) => j.mediaId === filter.mediaId || j.groupId === filter.mediaId,
    );
  }, [snapshot.byId, filter?.mediaId]);

  const groups = useMemo(
    () => buildIngestJobGroups(jobs, filter?.media),
    [jobs, filter?.media],
  );

  return {
    jobs,
    groups,
    loading: snapshot.loading,
    error: snapshot.error,
    runtimeError: snapshot.runtimeError,
  };
}

export type UseRuntimeIngestActionsResult = {
  cancelJob(jobId: string): Promise<void>;
  cancelByGroup(groupId: string, reason?: string): Promise<void>;
  dismissJob(jobId: string): Promise<void>;
  retryJob(jobId: string): Promise<void>;
  submitSources(input: SubmitSourcesInput): Promise<{ submitted: SubmittedJob[] }>;
};

export function useRuntimeIngestActions(): UseRuntimeIngestActionsResult {
  const cancelJob = useCallback(async (jobId: string) => {
    const api = (globalThis as { window?: Window }).window?.sf?.runtimeJobs;
    if (!api?.cancel) throw new Error("runtime_jobs_ipc_unavailable");
    await api.cancel({ jobId });
  }, []);
  const cancelByGroup = useCallback(async (groupId: string, reason?: string) => {
    const api = (globalThis as { window?: Window }).window?.sf?.runtimeJobs;
    if (!api?.cancelByGroup) throw new Error("runtime_jobs_ipc_unavailable");
    await api.cancelByGroup({ groupId, reason });
  }, []);
  const dismissJob = useCallback(async (jobId: string) => {
    const api = (globalThis as { window?: Window }).window?.sf?.runtimeJobs;
    if (!api?.dismiss) throw new Error("runtime_jobs_ipc_unavailable");
    await api.dismiss({ jobId });
  }, []);
  const retryJob = useCallback(async (jobId: string) => {
    const api = (globalThis as { window?: Window }).window?.sf?.runtimeJobs;
    if (!api?.retry) throw new Error("runtime_jobs_ipc_unavailable");
    await api.retry({ jobId });
  }, []);
  const submitSources = useCallback(async (input: SubmitSourcesInput) => {
    const api = (globalThis as { window?: Window }).window?.sf?.runtimeJobs;
    if (!api?.submitSources) throw new Error("runtime_jobs_ipc_unavailable");
    return api.submitSources(input) as Promise<{ submitted: SubmittedJob[] }>;
  }, []);
  return { cancelJob, cancelByGroup, dismissJob, retryJob, submitSources };
}

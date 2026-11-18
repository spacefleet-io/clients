import type { RuntimeJobRecord } from "./models";
import { buildBadgerRuntimeIngestJobId } from "./identity";

export type BadgerRuntimeSourceJob = Record<string, unknown> & {
  id: string;
  filename: string;
  status: string;
};

const toFiniteInteger = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
};

const resolveBadgerCollectionKey = (job: BadgerRuntimeSourceJob) => {
  const matchedMediaId = typeof job.matchedMediaId === "string" && job.matchedMediaId.trim().length > 0 ? job.matchedMediaId.trim() : null;
  const pendingKey = typeof job.pendingKey === "string" && job.pendingKey.trim().length > 0 ? job.pendingKey.trim() : null;
  const matchedTo =
    job.matchedTo && typeof job.matchedTo === "object" ? (job.matchedTo as Record<string, unknown>) : null;
  const type = typeof matchedTo?.type === "string" ? matchedTo.type : null;
  if (type !== "tv") return null;
  if (matchedMediaId) return `badger:tv:${matchedMediaId}`;
  if (pendingKey) return `badger:tv:pending:${pendingKey}`;
  return null;
};

const resolveBadgerMediaOrder = (job: BadgerRuntimeSourceJob) => {
  const season = toFiniteInteger(job.detectedSeason ?? job.manualSeason);
  const episode = toFiniteInteger(job.detectedEpisode ?? job.manualEpisode);
  if (season == null || episode == null) return null;
  return season * 10_000 + episode;
};

const resolveBadgerPhaseOrder = (job: BadgerRuntimeSourceJob) => (job.jobType === "transcode" ? 1 : 0);

const resolveBadgerVariantOrder = (job: BadgerRuntimeSourceJob) => {
  if (job.jobType !== "transcode") return 0;
  const selectedFormats = Array.isArray(job.selectedFormats) ? job.selectedFormats : [];
  const firstQuality =
    selectedFormats.length > 0 && selectedFormats[0] && typeof selectedFormats[0] === "object"
      ? (selectedFormats[0] as Record<string, unknown>).quality
      : null;
  const quality = typeof firstQuality === "string" ? firstQuality : "";
  switch (quality) {
    case "2160p":
      return 5;
    case "1080p":
      return 4;
    case "720p":
      return 3;
    case "480p":
      return 2;
    case "360p":
      return 1;
    default:
      return 9;
  }
};

const resolveBadgerRuntimeLane = (job: BadgerRuntimeSourceJob): RuntimeJobRecord["lane"] => {
  if (job.status === "uploading") return "network";
  if (job.status === "transcoding" || job.status === "ready") return "cpu";
  return "background";
};

const resolveBadgerResourceClaims = (lane: RuntimeJobRecord["lane"]) => {
  if (lane === "cpu") return ["cpuHeavy", "diskHeavy"] satisfies RuntimeJobRecord["resourceClaims"];
  if (lane === "network") return ["networkHeavy"] satisfies RuntimeJobRecord["resourceClaims"];
  return undefined;
};

type BadgerRuntimeProjection = Pick<
  RuntimeJobRecord,
  "status" | "stageCode" | "stageLabel" | "retryable" | "finishedAt"
>;

export const mapBadgerRuntimeJobStatus = (
  status: string,
  errorCode: string | undefined
): BadgerRuntimeProjection => {
  switch (status) {
    case "waiting":
      return { status: "queued", stageCode: status, stageLabel: "Queued", retryable: false, finishedAt: null };
    case "identifying":
      return { status: "running", stageCode: status, stageLabel: "Identifying", retryable: false, finishedAt: null };
    case "needs_match":
      return { status: "queued", stageCode: status, stageLabel: "Needs match", retryable: false, finishedAt: null };
    case "ready":
      return { status: "queued", stageCode: status, stageLabel: "Ready to start", retryable: false, finishedAt: null };
    case "transcoding":
      return { status: "running", stageCode: status, stageLabel: "Processing", retryable: false, finishedAt: null };
    case "uploading":
      return { status: "running", stageCode: status, stageLabel: "Uploading", retryable: false, finishedAt: null };
    case "done":
      return { status: "succeeded", stageCode: status, stageLabel: "Done", retryable: false, finishedAt: null };
    case "cancelled":
      return { status: "cancelled", stageCode: "cancelled", stageLabel: "Cancelled", retryable: false, finishedAt: null };
    case "failed":
      return {
        status: errorCode === "lab.errors.cancelled" ? "cancelled" : "failed",
        stageCode: errorCode === "lab.errors.cancelled" ? "cancelled" : status,
        stageLabel: errorCode === "lab.errors.cancelled" ? "Cancelled" : "Needs attention",
        retryable: errorCode !== "lab.errors.cancelled",
        finishedAt: null,
      };
    default:
      return { status: "queued", stageCode: status, stageLabel: "Queued", retryable: false, finishedAt: null };
  }
};

export const toBadgerRuntimeJobProgress = (value: unknown): RuntimeJobRecord["progress"] => {
  const completed = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  if (completed === null) {
    return { mode: "indeterminate", completed: null, total: null, unit: null };
  }
  return { mode: "fraction", completed, total: 100, unit: "percent" };
};

export const buildBadgerRuntimeJobRecord = (input: {
  job: BadgerRuntimeSourceJob;
  userId: string | null;
  existing: RuntimeJobRecord | null;
  nowIso?: string;
}): RuntimeJobRecord => {
  const { job, userId, existing } = input;
  const mapped = mapBadgerRuntimeJobStatus(job.status, typeof job.error === "string" ? job.error : undefined);
  const jobId = buildBadgerRuntimeIngestJobId(userId, job.id);
  const fallbackNow = input.nowIso ?? new Date().toISOString();
  const updatedAt =
    typeof job.completedAt === "string"
      ? job.completedAt
      : typeof job.createdAt === "string"
        ? job.createdAt
        : existing?.updatedAt ?? fallbackNow;
  const createdAt = typeof job.createdAt === "string" ? job.createdAt : existing?.createdAt ?? updatedAt;
  const lane = resolveBadgerRuntimeLane(job);
  const resourceClaims = resolveBadgerResourceClaims(lane);
  const persistedSubmittedOrder =
    existing?.scheduling?.submittedOrder ?? toFiniteInteger(job.queueSequence) ?? null;
  return {
    jobId,
    app: "badger",
    kind: "badger.ingest.media_file",
    lane,
    status: mapped.status,
    stageCode: mapped.stageCode,
    stageLabel: mapped.stageLabel,
    progress: toBadgerRuntimeJobProgress(job.progress),
    payload: {
      userId,
      ...job,
    },
    outputs: {
      fileId: job.fileId ?? null,
    },
    errorCode: typeof job.error === "string" ? job.error : null,
    errorMessage: typeof job.error === "string" ? job.error : null,
    retryable: mapped.retryable,
    resourceClaims,
    scheduling: {
      submittedOrder: persistedSubmittedOrder,
      collectionKey: resolveBadgerCollectionKey(job) ?? existing?.scheduling?.collectionKey ?? null,
      mediaOrder: resolveBadgerMediaOrder(job) ?? existing?.scheduling?.mediaOrder ?? null,
      phaseOrder: resolveBadgerPhaseOrder(job),
      variantOrder: resolveBadgerVariantOrder(job),
    },
    attemptCount: existing?.attemptCount ?? 0,
    maxAttempts: existing?.maxAttempts,
    nextAttemptAt: existing?.nextAttemptAt ?? null,
    lastAttemptAt: existing?.lastAttemptAt ?? null,
    cancelRequested: false,
    priority: existing?.priority ?? 0,
    dedupeKey: typeof job.fileId === "string" ? `badger:${job.fileId}` : existing?.dedupeKey ?? null,
    createdAt,
    updatedAt,
    startedAt: existing?.startedAt ?? (mapped.status === "running" ? createdAt : null),
    finishedAt: mapped.status === "succeeded" || mapped.status === "cancelled" ? updatedAt : null,
  };
};

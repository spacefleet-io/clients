/**
 * Will this import fit in the account's storage? (spec INGS-QUOTA-01, INGS-QUOTA-02)
 *
 * Pure: the import dialog collects what it is about to add, this module answers how much
 * space it needs, how much is left, whether it fits, how full the account would be
 * afterwards, and which plan to offer. Nothing here talks to the server.
 *
 * Auto-scale (ACCT-SCALE-01) would exempt an account from the gate; it does not exist yet,
 * so every account is checked.
 */
import type { AccountStorageSummary } from "@space/shared/api";
import type { IngestJobRecord } from "@/lib/runtimeIngestJobs";
import { estimateFromFile, estimateFromSourceFormat } from "../../../shared/labQueueShared";
import {
  isPlanId,
  nextPlanUp,
  planLimitBytes,
  planMonthlyPrice,
  smallestPlanFitting,
  type BillingPeriod,
  type PlanChoice,
} from "@space/shared/storagePlans";

const MIB = 1024 * 1024;

/** INGS-QUOTA-02: the offer shows once the account would be MORE than 90% full. */
export const QUOTA_HIGH_USAGE_RATIO = 0.9;

export type ImportQuotaSource = {
  /** File size in bytes, as the scan reported it. */
  sizeBytes: number | null;
  /** "1080p", "2160p" … ; null when unknown. */
  quality: string | null;
  durationSeconds: number | null;
};

export type ImportQuotaItemInput = {
  /** Originals this item uploads (several when one movie comes in several versions). */
  sources: ImportQuotaSource[];
  /**
   * The copies this computer makes of every original it uploads: the 360p backup copy when
   * this computer makes it (INGS-FALLBK-01) and the Settings ladder (STOR-QUOTA-04).
   */
  outputs: ReadonlyArray<{ quality: string; codec: string }>;
  mediaType: "movie" | "tv";
};

/**
 * Estimated size of one copy made from `source`. Same chain as AddQualityModal and
 * `estimateLabJobOutputTotal`: the pixel-ratio estimate when the source's quality and
 * duration are known, the file-size ratio otherwise.
 */
const estimateCopyMb = (
  source: Pick<ImportQuotaSource, "quality" | "durationSeconds"> & { sizeMb: number | null },
  copy: { quality: string; codec: string },
  mediaType: "movie" | "tv",
): number =>
  estimateFromSourceFormat({
    sourceSizeMb: source.sizeMb,
    sourceQuality: source.quality,
    targetQuality: copy.quality,
    targetCodec: copy.codec,
    durationSeconds: source.durationSeconds,
    mediaType,
  }) ?? estimateFromFile(source.sizeMb ?? undefined, copy.quality, copy.codec, mediaType);

/**
 * Bytes one item (one movie or one episode) adds: each original plus the copies made from
 * it. Mirrors the submit: every original goes to the runtime with the whole ladder
 * (fileIngestionV2Translate), and the runtime makes every copy in it, even one at or above
 * the original's quality (a 240p original still gets its 360p copy). The pixel-ratio
 * estimate has no answer for those, so they take the file-size ratio.
 */
export const estimateImportItemBytes = ({ sources, outputs, mediaType }: ImportQuotaItemInput): number =>
  Math.round(
    sources.reduce((sum, source) => {
      const sizeMb = source.sizeBytes ? source.sizeBytes / MIB : null;
      const copies = outputs.reduce(
        (copySum, copy) => copySum + estimateCopyMb({ ...source, sizeMb }, copy, mediaType) * MIB,
        0,
      );
      return sum + Math.max(0, source.sizeBytes ?? 0) + copies;
    }, 0),
  );

const UNFINISHED_STATUSES: ReadonlySet<IngestJobRecord["status"]> = new Set(["queued", "running", "interrupted"]);

const readPayloadNumber = (payload: Record<string, unknown>, key: string): number | null => {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/**
 * A source's `payload.sizeMb` is rounded to whole megabytes, so 0 is a known file under half
 * a megabyte, not an unknown size: it must not fall through to the per-quality default
 * (hundreds of MB) that `estimateFromFile` uses when the size is missing.
 */
const readPayloadSizeMb = (payload: Record<string, unknown>): number | null => {
  const sizeMb = readPayloadNumber(payload, "sizeMb");
  return sizeMb === null || sizeMb < 0 ? null : Math.max(sizeMb, 0.5);
};

/**
 * Bytes earlier imports on this computer still have to upload. The server only reserves
 * space for the piece being uploaded right now (5-minute leases), so queued work is
 * invisible to `GET /account/storage` and is counted here instead.
 *
 * Approximation: a source job counts its whole file (`payload.sizeMb`) while queued, and
 * the share its progress has not reached yet while running (byte progress when the job
 * reports it); a format job counts the estimated size of its copy, made from its parent
 * source. The piece under an active lease is then counted twice (here and in
 * `reservedBytes`), which errs on the side of stopping an import that might not fit.
 */
export const estimatePendingLocalBytes = (jobs: Iterable<IngestJobRecord>): number => {
  const byId = new Map<string, IngestJobRecord>();
  for (const job of jobs) byId.set(job.jobId, job);
  let total = 0;
  for (const job of byId.values()) {
    if (!UNFINISHED_STATUSES.has(job.status)) continue;
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    if (job.kind === "source") {
      const sizeMb = readPayloadSizeMb(payload);
      if (sizeMb === null) continue;
      const progress = job.progress;
      const done =
        job.status === "running" && progress?.mode === "fraction" && progress.total && progress.completed !== null
          ? Math.min(1, Math.max(0, progress.completed / progress.total))
          : 0;
      total += sizeMb * MIB * (1 - done);
      continue;
    }
    if (job.kind === "format" && job.variant) {
      const parentId = typeof payload.parentSourceJobId === "string" ? payload.parentSourceJobId : job.parentJobIds?.[0];
      const parent = parentId ? byId.get(parentId) : undefined;
      const parentPayload = (parent?.payload ?? {}) as Record<string, unknown>;
      const sizeMb = readPayloadSizeMb(parentPayload);
      const sourceQuality = typeof parentPayload.sourceQuality === "string" ? parentPayload.sourceQuality : null;
      const mediaType = typeof (parentPayload.hints as { season?: unknown } | undefined)?.season === "number" ? "tv" : "movie";
      total +=
        estimateCopyMb({ sizeMb, quality: sourceQuality, durationSeconds: null }, { quality: job.variant, codec: "h264" }, mediaType) *
        MIB;
    }
  }
  return Math.round(total);
};

export type PlanOffer = PlanChoice & {
  limitBytes: number;
  /** Per month in `billingPeriod` (annual = yearly price / 12), in EUR. */
  monthlyPrice: number;
  billingPeriod: BillingPeriod;
};

export type ImportQuotaInput = {
  /** Bytes each item would add, in the order the user sees them. */
  items: Array<{ id: string; bytes: number }>;
  storage: Pick<AccountStorageSummary, "plan" | "storageAddonCount" | "limitBytes" | "usedBytes" | "reservedBytes">;
  /** `estimatePendingLocalBytes` of this computer's unfinished jobs. */
  pendingLocalBytes: number;
  billingPeriod: BillingPeriod;
};

export type ImportQuotaVerdict = "fits" | "high-usage" | "does-not-fit";

export type ImportQuotaResult = {
  verdict: ImportQuotaVerdict;
  neededBytes: number;
  /** limit − stored − being uploaded − still to upload from this computer; never below 0. `Infinity` when unlimited. */
  spaceLeftBytes: number;
  /** Space left once this import is stored (negative when it does not fit). */
  spaceLeftAfterBytes: number;
  /** How full the account would be after this import (1 = full). */
  usageRatioAfter: number;
  /** INGS-QUOTA-01: the smallest plan holding the library plus this import. */
  smallestFittingPlan: PlanOffer | null;
  /** INGS-QUOTA-02: the next plan up from the current one. */
  nextPlan: PlanOffer | null;
};

const toOffer = (choice: PlanChoice | null, billingPeriod: BillingPeriod): PlanOffer | null =>
  choice
    ? {
        ...choice,
        limitBytes: planLimitBytes(choice),
        monthlyPrice: planMonthlyPrice(choice, billingPeriod),
        billingPeriod,
      }
    : null;

/** The storage warning to show: never one for an unlimited (admin) account (ACCT-PLAN-14). */
export const storageWarningLevel = (
  storage: Pick<AccountStorageSummary, "limitBytes" | "warningLevel">,
): AccountStorageSummary["warningLevel"] => (storage.limitBytes === null ? "ok" : storage.warningLevel);

export const evaluateImportQuota = ({ items, storage, pendingLocalBytes, billingPeriod }: ImportQuotaInput): ImportQuotaResult => {
  // ACCT-PLAN-14: an admin account (no limit) fits any import and is never offered a plan.
  if (storage.limitBytes === null) {
    return {
      verdict: "fits",
      neededBytes: items.reduce((sum, item) => sum + Math.max(0, item.bytes), 0),
      spaceLeftBytes: Number.POSITIVE_INFINITY,
      spaceLeftAfterBytes: Number.POSITIVE_INFINITY,
      usageRatioAfter: 0,
      smallestFittingPlan: null,
      nextPlan: null,
    };
  }
  const limitBytes = storage.limitBytes;
  const neededBytes = items.reduce((sum, item) => sum + Math.max(0, item.bytes), 0);
  const committedBytes = storage.usedBytes + storage.reservedBytes + Math.max(0, pendingLocalBytes);
  const spaceLeftBytes = Math.max(0, limitBytes - committedBytes);
  const spaceLeftAfterBytes = limitBytes - committedBytes - neededBytes;
  const usageRatioAfter = limitBytes > 0 ? (committedBytes + neededBytes) / limitBytes : 1;
  const fits = neededBytes <= limitBytes - committedBytes;
  const verdict: ImportQuotaVerdict = !fits
    ? "does-not-fit"
    : usageRatioAfter > QUOTA_HIGH_USAGE_RATIO
      ? "high-usage"
      : "fits";
  const current: PlanChoice = {
    plan: isPlanId(storage.plan) ? storage.plan : "free",
    addonCount: storage.plan === "tier3" ? Math.max(0, storage.storageAddonCount ?? 0) : 0,
  };
  return {
    verdict,
    neededBytes,
    spaceLeftBytes,
    spaceLeftAfterBytes,
    usageRatioAfter,
    smallestFittingPlan: toOffer(smallestPlanFitting(committedBytes + neededBytes, current), billingPeriod),
    nextPlan: toOffer(nextPlanUp(current), billingPeriod),
  };
};

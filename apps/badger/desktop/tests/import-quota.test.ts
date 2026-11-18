/**
 * The import's storage check (spec INGS-QUOTA-01, INGS-QUOTA-02): how much an import
 * adds, how much space is really left (stored + being uploaded + still queued on this
 * computer), whether it fits, whether it fills the account past 90%, and which plan to
 * offer — the smallest one that holds it, Scale add-ons included, or the next one up.
 */
import { describe, expect, it } from "vitest";
import {
  QUOTA_HIGH_USAGE_RATIO,
  estimateImportItemBytes,
  estimatePendingLocalBytes,
  evaluateImportQuota,
  type ImportQuotaInput,
  type ImportQuotaResult,
  storageWarningLevel,
} from "../src/renderer/src/lib/importQuota";
import type { IngestJobRecord } from "../src/renderer/src/lib/runtimeIngestJobs";
import { planMonthlyPrice, smallestPlanFitting } from "@space/shared/storagePlans";
import { estimateFromFile, estimateFromSourceFormat } from "../src/shared/labQueueShared";

const P = "[import-quota]";
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const storage = (plan: string, limitGb: number, usedGb: number, extra: Partial<ImportQuotaInput["storage"]> = {}) => ({
  plan,
  storageAddonCount: 0,
  limitBytes: limitGb * GIB,
  usedBytes: usedGb * GIB,
  reservedBytes: 0,
  ...extra,
});

const evaluate = (label: string, input: ImportQuotaInput): ImportQuotaResult => {
  const result = evaluateImportQuota(input);
  console.info(
    `${P}:${label} input=${JSON.stringify({ ...input, items: input.items.map((i) => `${i.id}=${i.bytes}`) })} → ${JSON.stringify(result)}`,
  );
  return result;
};

const dump = (label: string, value: unknown) => console.error(`=== ${P}:${label} ===\n${JSON.stringify(value, null, 2)}`);

describe("evaluateImportQuota", () => {
  it("@req INGS-QUOTA-01 an import exactly the size of the space left fits; one byte more does not", () => {
    const exact = evaluate("exact", {
      items: [{ id: "movie", bytes: 50 * GIB }],
      storage: storage("tier1", 100, 50),
      pendingLocalBytes: 0,
      billingPeriod: "annual",
    });
    const over = evaluate("over", {
      items: [{ id: "movie", bytes: 50 * GIB + 1 }],
      storage: storage("tier1", 100, 50),
      pendingLocalBytes: 0,
      billingPeriod: "annual",
    });
    if (exact.verdict === "does-not-fit" || over.verdict !== "does-not-fit") dump("exact-vs-over", { exact, over });
    // Exactly full fits, but leaves the account 100% full: the INGS-QUOTA-02 offer, not a refusal.
    expect(exact.verdict).toBe("high-usage");
    expect(exact.spaceLeftAfterBytes).toBe(0);
    expect(over.verdict).toBe("does-not-fit");
    expect(over.neededBytes).toBe(50 * GIB + 1);
    expect(over.spaceLeftBytes).toBe(50 * GIB);
    expect(over.smallestFittingPlan).toMatchObject({ plan: "tier2", addonCount: 0, limitBytes: 400 * GIB });
  });

  // @req ACCT-PLAN-14
  it("[ACCT-PLAN-14-IMPORT-01] an unlimited (admin) account fits any import, is never offered a plan, and never warned", () => {
    const huge = evaluate("unlimited-huge", {
      items: [{ id: "archive", bytes: 50_000 * GIB }, { id: "movie", bytes: 80 * GIB }],
      storage: storage("free", 0, 9_000, { limitBytes: null, reservedBytes: 3 * GIB }),
      pendingLocalBytes: 700 * GIB,
      billingPeriod: "annual",
    });
    // The same import on a limited account is still refused with an offer (non-admin path unchanged).
    const limited = evaluate("limited-huge", {
      items: [{ id: "archive", bytes: 50_000 * GIB }, { id: "movie", bytes: 80 * GIB }],
      storage: storage("tier1", 100, 90, { reservedBytes: 3 * GIB }),
      pendingLocalBytes: 700 * GIB,
      billingPeriod: "annual",
    });
    const warnings = {
      unlimitedBlocked: storageWarningLevel({ limitBytes: null, warningLevel: "blocked" }),
      limitedBlocked: storageWarningLevel({ limitBytes: 100 * GIB, warningLevel: "blocked" }),
      limitedWarning: storageWarningLevel({ limitBytes: 100 * GIB, warningLevel: "warning" }),
    };
    console.info(`${P}:unlimited warnings=${JSON.stringify(warnings)}`);
    if (huge.verdict !== "fits" || limited.verdict !== "does-not-fit") dump("unlimited-vs-limited", { huge, limited, warnings });
    expect(huge.verdict).toBe("fits");
    expect(huge.neededBytes).toBe(50_080 * GIB);
    expect(huge.spaceLeftBytes).toBe(Number.POSITIVE_INFINITY);
    expect(huge.spaceLeftAfterBytes).toBe(Number.POSITIVE_INFINITY);
    expect(huge.usageRatioAfter).toBe(0);
    expect(huge.smallestFittingPlan).toBeNull();
    expect(huge.nextPlan).toBeNull();
    expect(limited.verdict).toBe("does-not-fit");
    expect(limited.spaceLeftBytes).toBe(0);
    expect(limited.nextPlan).not.toBeNull();
    expect(warnings).toEqual({ unlimitedBlocked: "ok", limitedBlocked: "blocked", limitedWarning: "warning" });
  });

  it("@req INGS-QUOTA-02 exactly 90% full after the import is fine; just over 90% raises the offer", () => {
    const atNinety = evaluate("at-90", {
      items: [{ id: "a", bytes: 25 * GIB }, { id: "b", bytes: 25 * GIB }],
      storage: storage("tier1", 100, 40),
      pendingLocalBytes: 0,
      billingPeriod: "annual",
    });
    const overNinety = evaluate("over-90", {
      items: [{ id: "a", bytes: 25 * GIB }, { id: "b", bytes: 25 * GIB + 1 }],
      storage: storage("tier1", 100, 40),
      pendingLocalBytes: 0,
      billingPeriod: "annual",
    });
    if (atNinety.verdict !== "fits" || overNinety.verdict !== "high-usage") dump("ninety", { atNinety, overNinety });
    expect(atNinety.usageRatioAfter).toBe(QUOTA_HIGH_USAGE_RATIO);
    expect(atNinety.verdict).toBe("fits");
    expect(overNinety.verdict).toBe("high-usage");
    expect(overNinety.nextPlan).toMatchObject({ plan: "tier2", addonCount: 0, monthlyPrice: 4.99, billingPeriod: "annual" });
  });

  it("@req INGS-QUOTA-01 counts bytes being uploaded and still queued on this computer as used", () => {
    const input: ImportQuotaInput = {
      items: [{ id: "movie", bytes: 40 * GIB }],
      storage: storage("tier1", 100, 40, { reservedBytes: 10 * GIB }),
      pendingLocalBytes: 0,
      billingPeriod: "monthly",
    };
    const idle = evaluate("no-pending", input);
    const busy = evaluate("pending", { ...input, pendingLocalBytes: 20 * GIB });
    if (idle.verdict === "does-not-fit" || busy.verdict !== "does-not-fit") dump("pending", { idle, busy });
    expect(idle.verdict).not.toBe("does-not-fit");
    expect(idle.spaceLeftBytes).toBe(50 * GIB);
    expect(busy.verdict).toBe("does-not-fit");
    expect(busy.spaceLeftBytes).toBe(30 * GIB);
    // The plan offered holds everything already committed plus this import: 40+10+20+40 = 110 GB.
    expect(busy.smallestFittingPlan).toMatchObject({ plan: "tier2", monthlyPrice: 5.99, billingPeriod: "monthly" });
  });

  it("@req INGS-QUOTA-01 never reports negative space left when the account is already over", () => {
    const result = evaluate("over-limit", {
      items: [{ id: "movie", bytes: GIB }],
      storage: storage("free", 20, 25),
      pendingLocalBytes: 0,
      billingPeriod: "annual",
    });
    expect(result.verdict).toBe("does-not-fit");
    expect(result.spaceLeftBytes).toBe(0);
    expect(result.smallestFittingPlan).toMatchObject({ plan: "tier1" });
  });

  it("@req INGS-QUOTA-01 the smallest fitting plan can be Scale with add-on blocks, priced for the billing period", () => {
    const input: ImportQuotaInput = {
      items: [{ id: "show", bytes: 2000 * GIB }],
      storage: storage("tier2", 400, 390),
      pendingLocalBytes: 0,
      billingPeriod: "annual",
    };
    const annual = evaluate("scale-annual", input);
    const monthly = evaluate("scale-monthly", { ...input, billingPeriod: "monthly" });
    if (annual.smallestFittingPlan?.addonCount !== 3) dump("scale-addons", { annual, monthly });
    // 390 + 2000 = 2390 GB → Scale 1000 GB + 3 × 500 GB = 2500 GB.
    expect(annual.smallestFittingPlan).toMatchObject({ plan: "tier3", addonCount: 3, limitBytes: 2500 * GIB });
    expect(annual.smallestFittingPlan?.monthlyPrice).toBeCloseTo((131.88 + 3 * 64.9) / 12, 2);
    expect(monthly.smallestFittingPlan?.monthlyPrice).toBeCloseTo(13.99 + 3 * 6.49, 2);
  });

  it("@req INGS-QUOTA-01 offers a bigger Scale when already on Scale with add-ons", () => {
    const result = evaluate("scale-to-scale", {
      items: [{ id: "show", bytes: 600 * GIB }],
      storage: storage("tier3", 1500, 1400, { storageAddonCount: 1 }),
      pendingLocalBytes: 0,
      billingPeriod: "annual",
    });
    expect(result.smallestFittingPlan).toMatchObject({ plan: "tier3", addonCount: 2 });
  });

  it("@req INGS-QUOTA-01 a huge import is offered Scale with as many blocks as it needs (no storage ceiling)", () => {
    const result = evaluate("huge", {
      items: [{ id: "archive", bytes: 10_001 * GIB }],
      storage: storage("tier1", 100, 0),
      pendingLocalBytes: 0,
      billingPeriod: "annual",
    });
    expect(result.verdict).toBe("does-not-fit");
    // 10 001 GB → Scale 1000 GB + 19 × 500 GB = 10 500 GB (the old cap stopped at 18 blocks).
    expect(result.smallestFittingPlan).toMatchObject({ plan: "tier3", addonCount: 19, limitBytes: 10_500 * GIB });
    expect(smallestPlanFitting(50_000 * GIB, { plan: "free", addonCount: 0 })).toMatchObject({ plan: "tier3", addonCount: 98 });
  });

  it("@req INGS-QUOTA-02 on Scale with blocks the next plan up is one more block", () => {
    const result = evaluate("largest", {
      items: [{ id: "movie", bytes: 500 * GIB }],
      storage: storage("tier3", 10_000, 8_600, { storageAddonCount: 18 }),
      pendingLocalBytes: 0,
      billingPeriod: "annual",
    });
    expect(result.verdict).toBe("high-usage");
    expect(result.nextPlan).toMatchObject({ plan: "tier3", addonCount: 19 });
  });

  it("@req INGS-QUOTA-02 plan prices follow Settings → Account and the catalog the API charges (yearly price / 12)", () => {
    const prices = {
      starterAnnual: planMonthlyPrice({ plan: "tier1", addonCount: 0 }, "annual"),
      starterMonthly: planMonthlyPrice({ plan: "tier1", addonCount: 0 }, "monthly"),
      scaleAnnual: planMonthlyPrice({ plan: "tier3", addonCount: 0 }, "annual"),
    };
    console.info(`${P}:prices ${JSON.stringify(prices)}`);
    expect(prices).toEqual({ starterAnnual: 2.49, starterMonthly: 2.99, scaleAnnual: 10.99 });
  });
});

describe("estimateImportItemBytes", () => {
  it("@req INGS-QUOTA-01 counts the original plus every copy of the ladder", () => {
    const source = { sizeBytes: 1000 * MIB, quality: "1080p", durationSeconds: 3600 };
    const bytes = estimateImportItemBytes({
      sources: [source],
      outputs: [
        { quality: "360p", codec: "h264" },
        { quality: "2160p", codec: "h264" },
      ],
      mediaType: "movie",
    });
    const copy360Mb = estimateFromSourceFormat({
      sourceSizeMb: 1000,
      sourceQuality: "1080p",
      targetQuality: "360p",
      targetCodec: "h264",
      durationSeconds: 3600,
      mediaType: "movie",
    });
    // Above the original's quality the pixel-ratio estimate has no answer: file-size ratio.
    const copy2160Mb = estimateFromFile(1000, "2160p", "h264", "movie");
    console.info(`${P}:item bytes=${bytes} copy360Mb=${copy360Mb} copy2160Mb=${copy2160Mb}`);
    expect(copy360Mb).toBeGreaterThan(0);
    expect(copy2160Mb).toBeGreaterThan(0);
    expect(bytes).toBe(Math.round(1000 * MIB + (copy360Mb ?? 0) * MIB + copy2160Mb * MIB));
  });

  // Found in the hand try of 2026-10-28: a 320x240 clip still got its 360p copy made and
  // uploaded, but the estimate counted the original alone.
  it("@req INGS-QUOTA-01 a 240p original still counts its 360p backup copy", () => {
    const sizeBytes = 9_933;
    const bytes = estimateImportItemBytes({
      sources: [{ sizeBytes, quality: "240p", durationSeconds: 20 }],
      outputs: [{ quality: "360p", codec: "h264" }],
      mediaType: "movie",
    });
    const copyMb = estimateFromFile(sizeBytes / MIB, "360p", "h264", "movie");
    console.info(`${P}:240p item bytes=${bytes} original=${sizeBytes} copyMb=${copyMb}`);
    expect(copyMb).toBeGreaterThan(0);
    expect(bytes).toBe(Math.round(sizeBytes + copyMb * MIB));
  });

  it("@req INGS-QUOTA-01 counts every original of a movie in several versions, and its copies", () => {
    const one = estimateImportItemBytes({
      sources: [{ sizeBytes: 4000 * MIB, quality: "2160p", durationSeconds: 3600 }],
      outputs: [{ quality: "360p", codec: "h264" }],
      mediaType: "movie",
    });
    const two = estimateImportItemBytes({
      sources: [
        { sizeBytes: 4000 * MIB, quality: "2160p", durationSeconds: 3600 },
        { sizeBytes: 1500 * MIB, quality: "1080p", durationSeconds: 3600 },
      ],
      outputs: [{ quality: "360p", codec: "h264" }],
      mediaType: "movie",
    });
    console.info(`${P}:versions one=${one} two=${two}`);
    expect(two).toBeGreaterThan(one + 1500 * MIB);
  });

  it("@req INGS-QUOTA-01 without outputs an item is just its originals", () => {
    expect(
      estimateImportItemBytes({
        sources: [{ sizeBytes: 123_456_789, quality: null, durationSeconds: null }],
        outputs: [],
        mediaType: "tv",
      }),
    ).toBe(123_456_789);
  });
});

const job = (overrides: Partial<IngestJobRecord> & Pick<IngestJobRecord, "jobId" | "kind" | "status">): IngestJobRecord => ({
  app: "badger",
  lane: overrides.kind === "format" ? "format" : "source",
  stageCode: "queued",
  stageLabel: "",
  progress: { mode: "none", completed: null, total: null, unit: null },
  payload: {},
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  groupId: "group-1",
  mediaId: "media-1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  progressPct: 0,
  ...overrides,
});

describe("estimatePendingLocalBytes", () => {
  it("@req INGS-QUOTA-01 counts queued sources whole, running ones by what is left, and ignores finished jobs", () => {
    const jobs = [
      job({ jobId: "queued", kind: "source", status: "queued", payload: { sizeMb: 1000 } }),
      job({
        jobId: "running",
        kind: "source",
        status: "running",
        payload: { sizeMb: 2000 },
        progress: { mode: "fraction", completed: 500, total: 2000, unit: "bytes" },
      }),
      job({ jobId: "done", kind: "source", status: "succeeded", payload: { sizeMb: 9000 } }),
      job({ jobId: "failed", kind: "source", status: "failed", payload: { sizeMb: 9000 } }),
      job({ jobId: "cancelled", kind: "source", status: "cancelled", payload: { sizeMb: 9000 } }),
    ];
    const pending = estimatePendingLocalBytes(jobs);
    console.info(`${P}:pending sources=${pending}`);
    expect(pending).toBe(Math.round(1000 * MIB + 1500 * MIB));
  });

  it("@req INGS-QUOTA-01 counts a queued copy from its source's size", () => {
    const source = job({
      jobId: "src",
      kind: "source",
      status: "succeeded",
      payload: { sizeMb: 1000, sourceQuality: "1080p" },
    });
    const copy = job({ jobId: "fmt", kind: "format", status: "queued", variant: "360p", parentJobIds: ["src"] });
    const pending = estimatePendingLocalBytes([source, copy]);
    console.info(`${P}:pending copy=${pending}`);
    expect(pending).toBeGreaterThan(0);
    expect(pending).toBeLessThan(1000 * MIB);
  });

  // Found in the hand try of 2026-10-28: a 9.7 KB clip went to the runtime with sizeMb 0
  // (rounded), and its queued 360p copy was counted at the 520 MB "size unknown" default,
  // which left the next import "0 B" of space.
  it("@req INGS-QUOTA-01 a source under half a megabyte (sizeMb 0) is small, not of unknown size", () => {
    const source = job({
      jobId: "tiny",
      kind: "source",
      status: "running",
      payload: { sizeMb: 0, sourceQuality: "240p" },
      progress: { mode: "fraction", completed: 10, total: 100, unit: "percent" },
    });
    const copy = job({
      jobId: "tiny-360",
      kind: "format",
      status: "queued",
      variant: "360p",
      payload: { parentSourceJobId: "tiny" },
    });
    const pending = estimatePendingLocalBytes([source, copy]);
    const sourceLeft = 0.5 * MIB * 0.9;
    const copyMb = estimateFromFile(0.5, "360p", "h264", "movie");
    const unknownSizeMb = estimateFromFile(undefined, "360p", "h264", "movie");
    console.info(`${P}:pending tiny=${pending} sourceLeft=${sourceLeft} copyMb=${copyMb} unknownSizeMb=${unknownSizeMb}`);
    expect(pending).toBe(Math.round(sourceLeft + copyMb * MIB));
    expect(pending).toBeLessThan(unknownSizeMb * MIB);
  });

  it("@req INGS-QUOTA-01 is zero with nothing left to upload", () => {
    expect(estimatePendingLocalBytes([])).toBe(0);
  });
});

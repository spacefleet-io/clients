// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildMediaDetailsJobSummary,
  isMediaDetailsLocalJobActive,
  isMediaDetailsSharedJobActive,
} from "../src/renderer/src/lib/mediaDetailsJobs";

// Dump-on-failure: surface the computed summary shape so a mismatch on any of
// the derived counts / progress values is diagnosable offline without rerun.
// Wrapped in try/catch so a dump failure can never mask the real assertion.
const dumpMediaDetailsJobsSnapshot = (label: string, summary: unknown) => {
  try {
    console.error(`=== [media-details-jobs:${label}] snapshot ===`);
    console.error(`summary:\n${JSON.stringify(summary, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("mediaDetailsJobs", () => {
  it("classifies local and shared processing jobs with terminal-state awareness", () => {
    console.info(`[media-details-jobs:classify] checking active/terminal classification`);
    const classification = {
      localWaiting: isMediaDetailsLocalJobActive({ status: "waiting" }),
      localDone: isMediaDetailsLocalJobActive({ status: "done" }),
      sharedProcessing: isMediaDetailsSharedJobActive({ status: "processing" }),
      sharedCancelled: isMediaDetailsSharedJobActive({ status: "cancelled" }),
    };
    console.info(`[media-details-jobs:classify] result=${JSON.stringify(classification)}`);
    if (
      classification.localWaiting !== true ||
      classification.localDone !== false ||
      classification.sharedProcessing !== true ||
      classification.sharedCancelled !== false
    ) {
      dumpMediaDetailsJobsSnapshot("classify", classification);
    }
    expect(isMediaDetailsLocalJobActive({ status: "waiting" })).toBe(true);
    expect(isMediaDetailsLocalJobActive({ status: "done" })).toBe(false);
    expect(isMediaDetailsSharedJobActive({ status: "processing" })).toBe(true);
    expect(isMediaDetailsSharedJobActive({ status: "cancelled" })).toBe(false);
  });

  it("builds a media-scoped processing summary and blended progress", () => {
    console.info(`[media-details-jobs:summary] building summary for media-1`);
    const summary = buildMediaDetailsJobSummary("media-1", {
      activeJobs: [
        { matchedMediaId: "media-1", status: "transcoding", progress: 40 },
        { matchedMediaId: "media-2", status: "transcoding", progress: 90 },
      ],
      jobs: [
        { matchedMediaId: "media-1", status: "waiting", progress: null },
        { matchedMediaId: "media-1", status: "done", progress: 100 },
        { matchedMediaId: "media-2", status: "transcoding", progress: 90 },
      ],
      ingestJobs: [
        { mediaId: "media-1", status: "processing", progressPct: 80 },
        { mediaId: "media-1", status: "completed", progressPct: 100 },
        { mediaId: "media-2", status: "processing", progressPct: 50 },
      ],
    });

    console.info(
      `[media-details-jobs:summary] activeForMedia=${summary.activeJobsForMedia.length} jobsForMedia=${summary.jobsForMedia.length} sharedIngestForMedia=${summary.sharedIngestJobsForMedia.length} hasProcessing=${summary.hasProcessingJobsForMedia} progress=${String(summary.processingProgress)}`,
    );
    if (
      summary.activeJobsForMedia.length !== 1 ||
      summary.jobsForMedia.length !== 2 ||
      summary.sharedIngestJobsForMedia.length !== 2 ||
      summary.hasProcessingJobsForMedia !== true ||
      summary.processingProgress !== 60
    ) {
      dumpMediaDetailsJobsSnapshot("summary", summary);
    }
    expect(summary.activeJobsForMedia).toHaveLength(1);
    expect(summary.jobsForMedia).toHaveLength(2);
    expect(summary.sharedIngestJobsForMedia).toHaveLength(2);
    expect(summary.hasProcessingJobsForMedia).toBe(true);
    expect(summary.processingProgress).toBe(60);
  });

  it("returns empty processing state when no media is selected", () => {
    console.info(`[media-details-jobs:empty] building summary with null mediaId`);
    const summary = buildMediaDetailsJobSummary(null, {
      activeJobs: [{ matchedMediaId: "media-1", status: "transcoding", progress: 50 }],
      jobs: [{ matchedMediaId: "media-1", status: "waiting", progress: null }],
      ingestJobs: [{ mediaId: "media-1", status: "processing", progressPct: 30 }],
    });

    console.info(
      `[media-details-jobs:empty] activeForMedia=${summary.activeJobsForMedia.length} jobsForMedia=${summary.jobsForMedia.length} sharedIngestForMedia=${summary.sharedIngestJobsForMedia.length} hasProcessing=${summary.hasProcessingJobsForMedia} progress=${String(summary.processingProgress)}`,
    );
    if (
      summary.activeJobsForMedia.length !== 0 ||
      summary.jobsForMedia.length !== 0 ||
      summary.sharedIngestJobsForMedia.length !== 0 ||
      summary.hasProcessingJobsForMedia !== false ||
      summary.processingProgress !== null
    ) {
      dumpMediaDetailsJobsSnapshot("empty", summary);
    }
    expect(summary.activeJobsForMedia).toEqual([]);
    expect(summary.jobsForMedia).toEqual([]);
    expect(summary.sharedIngestJobsForMedia).toEqual([]);
    expect(summary.hasProcessingJobsForMedia).toBe(false);
    expect(summary.processingProgress).toBeNull();
  });
});

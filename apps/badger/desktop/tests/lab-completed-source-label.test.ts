// B2: completed source jobs show the generic label "Job" because
// buildCompletedLabJobPresentation only uses produced.videoFormats /
// selectedFormats — both empty for a source-ingest row. The active-state
// presenter already special-cases jobType === "source" with
// t("lab.queue.sourceIngest"); mirror that here so completed source rows
// show "Source ingest" (or "Source · …" if produced formats exist) instead
// of falling back to "Job".

import { describe, expect, it } from "vitest";

const mockT = ((key: string, fallback?: string) => {
  const dict: Record<string, string> = {
    "lab.queue.sourceIngest": "Source ingest",
    "lab.queue.transcode": "Transcode",
    "lab.queue.job": "Job",
    "lab.queue.tracks": "Tracks",
    "lab.source": "Source",
  };
  return dict[key] ?? fallback ?? key;
}) as any;

const sourceJob = (overrides: Record<string, unknown> = {}) => ({
  id: "j-src",
  filename: "movie.mkv",
  status: "done",
  progress: 100,
  jobType: "source",
  createdAt: "2026-04-01T00:00:00Z",
  completedAt: "2026-04-01T00:05:00Z",
  ...overrides,
});

// On assertion failure, dump the input job + computed presentation so a label
// regression (e.g. silent fallback to "Job") is diagnosable from CI logs.
const dumpLabLabelSnapshot = (
  label: string,
  job: unknown,
  presentation: unknown,
) => {
  try {
    console.error(`=== [lab-completed-source-label:${label}] snapshot ===`);
    console.error(`input job: ${JSON.stringify(job, null, 2)}`);
    console.error(`presentation: ${JSON.stringify(presentation, null, 2)}`);
    console.error(`=== [lab-completed-source-label:${label}] end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("[@bugfix][@regression-proof] B2 buildCompletedLabJobPresentation source label", () => {
  it("source job with no produced formats → 'Source ingest'", async () => {
    console.info("[lab-completed-source-label:source-no-formats] building presentation for source job with no produced formats");
    const { buildCompletedLabJobPresentation } = await import(
      "../src/renderer/src/components/labJobPresentation"
    );
    const job = sourceJob();
    const presentation = buildCompletedLabJobPresentation(job as any, false, mockT);
    const { outputSummary } = presentation;
    console.info(`[lab-completed-source-label:source-no-formats] outputSummary=${JSON.stringify(outputSummary)} (expected "Source ingest")`);
    if (outputSummary !== "Source ingest") {
      dumpLabLabelSnapshot("source-no-formats", job, presentation);
    }
    expect(outputSummary).toBe("Source ingest");
  });

  it("source job with produced video formats → 'Source · 1080p, 720p'", async () => {
    console.info("[lab-completed-source-label:source-with-formats] building presentation for source job with produced 1080p/720p");
    const { buildCompletedLabJobPresentation } = await import(
      "../src/renderer/src/components/labJobPresentation"
    );
    const job = sourceJob({
      produced: {
        videoFormats: [
          { quality: "1080p", codec: "h264" },
          { quality: "720p", codec: "h264" },
        ],
      },
    });
    const presentation = buildCompletedLabJobPresentation(job as any, false, mockT);
    const { outputSummary } = presentation;
    console.info(`[lab-completed-source-label:source-with-formats] outputSummary=${JSON.stringify(outputSummary)} (expected "Source · 1080p, 720p")`);
    if (outputSummary !== "Source · 1080p, 720p") {
      dumpLabLabelSnapshot("source-with-formats", job, presentation);
    }
    expect(outputSummary).toBe("Source · 1080p, 720p");
  });

  it("transcode job (no source) keeps existing comma-joined behavior", async () => {
    console.info("[lab-completed-source-label:transcode] building presentation for transcode job with selected 360p");
    const { buildCompletedLabJobPresentation } = await import(
      "../src/renderer/src/components/labJobPresentation"
    );
    const job = {
      ...sourceJob(),
      jobType: "transcode",
      selectedFormats: [{ quality: "360p", codec: "h264" }],
    };
    const presentation = buildCompletedLabJobPresentation(job as any, false, mockT);
    const { outputSummary } = presentation;
    console.info(`[lab-completed-source-label:transcode] outputSummary=${JSON.stringify(outputSummary)} (expected "360p")`);
    if (outputSummary !== "360p") {
      dumpLabLabelSnapshot("transcode", job, presentation);
    }
    expect(outputSummary).toBe("360p");
  });

  it("source job never falls back to bare 'Job' label", async () => {
    console.info("[lab-completed-source-label:no-bare-job] asserting source job never produces empty or bare 'Job' label");
    const { buildCompletedLabJobPresentation } = await import(
      "../src/renderer/src/components/labJobPresentation"
    );
    const job = sourceJob();
    const presentation = buildCompletedLabJobPresentation(job as any, false, mockT);
    const { outputSummary } = presentation;
    console.info(`[lab-completed-source-label:no-bare-job] outputSummary=${JSON.stringify(outputSummary)} (must not be "" or "Job")`);
    if (outputSummary === "" || outputSummary === "Job") {
      dumpLabLabelSnapshot("no-bare-job", job, presentation);
    }
    expect(outputSummary).not.toBe("");
    expect(outputSummary).not.toBe("Job");
  });
});

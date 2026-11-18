import { describe, expect, it } from "vitest";

import {
  buildActiveLabJobPresentation,
  buildCompletedLabJobPresentation,
} from "../src/renderer/src/components/labJobPresentation";

const t = (key: string) =>
  ({
    "lab.source": "Source",
    "lab.queue.sourceIngest": "Source ingest",
    "lab.queue.transcode": "Transcode",
    "lab.queue.tracks": "Tracks",
    "lab.queue.job": "Job",
    "lab.queue.help.sourceIngest": "Source help",
    "lab.queue.help.transcode": "Transcode help",
    "lab.queue.help.tracks": "Tracks help",
    "lab.queue.help.job": "Job help",
    "lab.queue.splitSource": "Split source",
    "lab.audio": "Audio",
    "lab.subtitles": "Subtitles",
    "lab.queue.chapters": "Chapters",
    "lab.queue.uploadSpeed": "{{speed}} Mbps",
  })[key] ?? key;

// Dump-on-failure helper: print the raw job input + the computed presentation
// so an assertion failure shows exactly which field diverged without a re-run.
// Body wrapped in try/catch so a dump error cannot mask the real assertion.
const dumpLabJobSnapshot = (label: string, job: unknown, presentation: unknown) => {
  try {
    console.error(`=== [lab-job-presentation:${label}] snapshot ===`);
    console.error(`job input:\n${JSON.stringify(job, null, 2)}`);
    console.error(`computed presentation:\n${JSON.stringify(presentation, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("lab job presentation helpers", () => {
  it("builds source-ingest presentation with episode label and chips", () => {
    console.info("[lab-job-presentation:source-ingest] building active presentation for source job-1 (tv S01E02)");
    const job = {
      id: "job-1",
      filename: "Show - S01E02.mkv",
      status: "ready",
      progress: 0,
      createdAt: "2026-03-25T10:00:00.000Z",
      jobType: "source",
      matchedTo: { type: "tv" },
      detectedSeason: 1,
      detectedEpisode: 2,
      includeSource: true,
      includeAudio: true,
      includeChapters: true,
    } as any;
    const presentation = buildActiveLabJobPresentation(job, false, t as any);
    try {
      expect(presentation).toMatchObject({
        episodeLabel: "S01E02",
        outputLabel: "Source ingest",
        outputHelp: "Source help",
        trackChips: ["Split source", "Audio", "Chapters"],
        canStart: true,
        uploadSpeedLabel: null,
      });
    } catch (err) {
      dumpLabJobSnapshot("source-ingest", job, presentation);
      throw err;
    }
  });

  // @bugfix offline-download-job-uuid-label-2026-06-04
  // @regression-proof Download jobs carry the episode in the manifest but their
  // matchedTo may be the show row OR absent (media not synced). Pre-fix the
  // episodeLabel gate required matchedTo?.type === "tv", so offline-download TV
  // rows showed NO S01E01 — the user couldn't tell which episode was saving.
  it("[@bugfix][@regression-proof] download episode shows S01E01 chip even without a matched tv MediaRow", () => {
    console.info("[lab-job-presentation:download-episode] download job, matchedTo undefined, detected S01E01");
    const job = {
      id: "dl-1",
      filename: "Brooklyn Nine-Nine - S01E01 - Pilot",
      status: "uploading",
      progress: 30,
      createdAt: "2026-06-04T10:00:00.000Z",
      jobType: "download",
      matchedTo: undefined, // media row not synced — pre-fix this killed the chip
      detectedSeason: 1,
      detectedEpisode: 1,
    } as any;
    const presentation = buildActiveLabJobPresentation(job, false, t as any);
    try {
      expect(presentation.episodeLabel).toBe("S01E01");
    } catch (err) {
      dumpLabJobSnapshot("download-episode", job, presentation);
      throw err;
    }
  });

  it("download movie shows no episode chip", () => {
    console.info("[lab-job-presentation:download-movie] download movie job → episodeLabel null");
    const job = {
      id: "dl-2",
      filename: "Orchard (2017)",
      status: "uploading",
      progress: 30,
      createdAt: "2026-06-04T10:00:00.000Z",
      jobType: "download",
      matchedTo: undefined,
    } as any;
    const presentation = buildActiveLabJobPresentation(job, false, t as any);
    try {
      expect(presentation.episodeLabel).toBeNull();
    } catch (err) {
      dumpLabJobSnapshot("download-movie", job, presentation);
      throw err;
    }
  });

  it("builds transcode presentation with selected output label and upload speed", () => {
    console.info("[lab-job-presentation:transcode] building active presentation for transcode job-2 (360p, 4.2 Mbps)");
    const job = {
      id: "job-2",
      filename: "Movie.mkv",
      status: "uploading",
      progress: 50,
      createdAt: "2026-03-25T10:00:00.000Z",
      jobType: "transcode",
      selectedFormats: [{ quality: "360p", codec: "h264" }],
      uploadSpeedMbps: 4.2,
    } as any;
    const presentation = buildActiveLabJobPresentation(
      job,
      false,
      ((key: string, options?: Record<string, unknown>) =>
        key === "lab.queue.uploadSpeed" ? `${options?.speed} Mbps` : t(key)) as any
    );
    try {
      expect(presentation).toMatchObject({
        outputLabel: "Transcode · 360p",
        outputHelp: "Transcode help",
        canStart: false,
        uploadSpeedLabel: "4.2 Mbps",
      });
    } catch (err) {
      dumpLabJobSnapshot("transcode", job, presentation);
      throw err;
    }
  });

  // @bugfix @regression-proof
  // V2 ingest sidebar must surface the current micro-stage label on the
  // source row so users see "Source ingest · Extracting / Uploading /
  // Committing" instead of a long apparent stall between steps. Reported
  // 2026-05-01: "Source ingest → 100% → nothing for a long time → media
  // playable" while transcoding ran in parallel.
  describe("stageLabel surfacing (@bugfix @regression-proof)", () => {
    const baseJob = {
      id: "job-stage",
      filename: "Movie.mkv",
      progress: 50,
      createdAt: "2026-05-01T10:00:00.000Z",
    } as const;

    it("appends stageLabel to source ingest output (Extracting)", () => {
      const job = {
        ...baseJob,
        status: "transcoding",
        jobType: "source",
        stageLabel: "Extracting",
      } as any;
      console.info(`[lab-job-presentation:stage-extracting] status=${job.status} stageLabel=${job.stageLabel}`);
      const result = buildActiveLabJobPresentation(job, false, t as any);
      if (result.outputLabel !== "Source ingest · Extracting") dumpLabJobSnapshot("stage-extracting", job, result);
      expect(result.outputLabel).toBe("Source ingest · Extracting");
    });

    it("appends stageLabel to source ingest output (Uploading)", () => {
      const job = {
        ...baseJob,
        status: "transcoding",
        jobType: "source",
        stageLabel: "Uploading",
      } as any;
      console.info(`[lab-job-presentation:stage-uploading] status=${job.status} stageLabel=${job.stageLabel}`);
      const result = buildActiveLabJobPresentation(job, false, t as any);
      if (result.outputLabel !== "Source ingest · Uploading") dumpLabJobSnapshot("stage-uploading", job, result);
      expect(result.outputLabel).toBe("Source ingest · Uploading");
    });

    it("does NOT append stageLabel when job is terminal (done)", () => {
      const job = {
        ...baseJob,
        status: "done",
        jobType: "source",
        stageLabel: "Uploaded",
      } as any;
      console.info(`[lab-job-presentation:stage-terminal-done] status=${job.status} stageLabel=${job.stageLabel}`);
      const result = buildActiveLabJobPresentation(job, false, t as any);
      if (result.outputLabel !== "Source ingest") dumpLabJobSnapshot("stage-terminal-done", job, result);
      expect(result.outputLabel).toBe("Source ingest");
    });

    it("does NOT append stageLabel when job is failed", () => {
      const job = {
        ...baseJob,
        status: "failed",
        jobType: "source",
        stageLabel: "Uploading",
      } as any;
      console.info(`[lab-job-presentation:stage-failed] status=${job.status} stageLabel=${job.stageLabel}`);
      const result = buildActiveLabJobPresentation(job, false, t as any);
      if (result.outputLabel !== "Source ingest") dumpLabJobSnapshot("stage-failed", job, result);
      expect(result.outputLabel).toBe("Source ingest");
    });

    it("does NOT append stageLabel when job is cancelled", () => {
      const job = {
        ...baseJob,
        status: "cancelled",
        jobType: "source",
        stageLabel: "Uploading",
      } as any;
      console.info(`[lab-job-presentation:stage-cancelled] status=${job.status} stageLabel=${job.stageLabel}`);
      const result = buildActiveLabJobPresentation(job, false, t as any);
      if (result.outputLabel !== "Source ingest") dumpLabJobSnapshot("stage-cancelled", job, result);
      expect(result.outputLabel).toBe("Source ingest");
    });

    it("appends stageLabel to transcode output (Encoding 360p)", () => {
      const job = {
        ...baseJob,
        status: "transcoding",
        jobType: "transcode",
        selectedFormats: [{ quality: "360p", codec: "h264" }],
        stageLabel: "Encoding 360p",
      } as any;
      console.info(`[lab-job-presentation:stage-transcode] status=${job.status} stageLabel=${job.stageLabel}`);
      const result = buildActiveLabJobPresentation(job, false, t as any);
      if (result.outputLabel !== "Transcode · 360p · Encoding 360p") dumpLabJobSnapshot("stage-transcode", job, result);
      expect(result.outputLabel).toBe("Transcode · 360p · Encoding 360p");
    });

    it("preserves existing label when stageLabel is missing (V1 path)", () => {
      const job = {
        ...baseJob,
        status: "ready",
        jobType: "source",
      } as any;
      console.info(`[lab-job-presentation:stage-missing-v1] status=${job.status} stageLabel=${job.stageLabel ?? "(none)"}`);
      const result = buildActiveLabJobPresentation(job, false, t as any);
      if (result.outputLabel !== "Source ingest") dumpLabJobSnapshot("stage-missing-v1", job, result);
      expect(result.outputLabel).toBe("Source ingest");
    });
  });

  it("builds completed job summaries and completion metadata", () => {
    console.info("[lab-job-presentation:completed] building completed presentation for done job-3 (1080p, 90s span)");
    const completedJob = {
      id: "job-3",
      filename: "Movie.mkv",
      status: "done",
      progress: 100,
      createdAt: "2026-03-25T10:00:00.000Z",
      completedAt: "2026-03-25T10:01:30.000Z",
      selectedFormats: [{ quality: "1080p", codec: "h264" }],
    } as any;
    const completedT = ((key: string, options?: Record<string, unknown>) =>
      key === "lab.completedMeta"
        ? `${options?.time} / ${options?.duration}`
        : t(key)) as any;
    const presentation = buildCompletedLabJobPresentation(completedJob, false, completedT);
    try {
      expect(presentation).toMatchObject({
        outputSummary: "1080p",
        completedMeta: {
          duration: "1m 30s",
        },
      });
      expect(presentation.completedMeta?.label).toContain("1m 30s");
    } catch (err) {
      dumpLabJobSnapshot("completed", completedJob, presentation);
      throw err;
    }
  });
});

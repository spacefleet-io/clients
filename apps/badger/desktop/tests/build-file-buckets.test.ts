// buildFileBuckets groups a TV show's ingest jobs into per-episode buckets
// keyed by `job.filename`. Filename — not season/episode — is the key because
// only the `jobType === "source"` job carries season/episode metadata while
// every job (source + transcode) for one episode shares the same filename.
// A bucket's title prefers the source job's zero-padded `S01E01` code and
// falls back to a cleaned basename of the filename.

import { describe, expect, it } from "vitest";
import { buildFileBuckets } from "../src/renderer/src/components/labQueueGroups";
import type { LabJob } from "../src/renderer/src/lib/labJobs";

const baseJob = (overrides: Partial<LabJob> = {}): LabJob =>
  ({
    id: "job-1",
    filename: "Brooklyn Nine-Nine - S01E01 - Pilot [1080p].mkv",
    status: "waiting",
    progress: 0,
    jobType: "source",
    createdAt: "2026-04-01T00:00:00Z",
    ...overrides,
  }) as LabJob;

describe("buildFileBuckets", () => {
  it("produces one bucket per distinct filename", () => {
    const buckets = buildFileBuckets([
      baseJob({ id: "ep1-src", filename: "Show - S01E01 - Pilot.mkv" }),
      baseJob({ id: "ep2-src", filename: "Show - S01E02 - The Tagger.mkv" }),
      baseJob({ id: "ep3-src", filename: "Show - S01E03 - The Slump.mkv" }),
    ]);
    expect(buckets).toHaveLength(3);
    expect(buckets.map((b) => b.id).sort()).toEqual([
      "Show - S01E01 - Pilot.mkv",
      "Show - S01E02 - The Tagger.mkv",
      "Show - S01E03 - The Slump.mkv",
    ]);
  });

  it("keeps source + transcode jobs of one episode in the same bucket", () => {
    // The transcode job carries NO season/episode — only the same filename.
    const filename = "Show - S01E01 - Pilot.mkv";
    const buckets = buildFileBuckets([
      baseJob({
        id: "src",
        filename,
        jobType: "source",
        detectedSeason: 1,
        detectedEpisode: 1,
      }),
      baseJob({ id: "tx-1080", filename, jobType: "transcode" }),
      baseJob({ id: "tx-360", filename, jobType: "transcode" }),
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.jobs.map((j) => j.id).sort()).toEqual([
      "src",
      "tx-1080",
      "tx-360",
    ]);
  });

  it("titles a bucket from the source job's detected season/episode (zero-padded)", () => {
    const buckets = buildFileBuckets([
      baseJob({
        id: "src",
        filename: "raw-file.mkv",
        jobType: "source",
        detectedSeason: 1,
        detectedEpisode: 1,
      }),
      // Order-independent: the transcode job is listed before the source job.
      baseJob({ id: "tx", filename: "raw-file.mkv", jobType: "transcode" }),
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.title).toBe("S01E01");
  });

  it("titles a bucket from manualSeason/manualEpisode when detected info is absent", () => {
    const buckets = buildFileBuckets([
      baseJob({
        id: "src",
        filename: "raw-file.mkv",
        jobType: "source",
        manualSeason: 2,
        manualEpisode: 7,
      }),
    ]);
    expect(buckets[0]!.title).toBe("S02E07");
  });

  it("zero-pads double-digit seasons and episodes consistently", () => {
    const buckets = buildFileBuckets([
      baseJob({
        id: "src",
        filename: "raw-file.mkv",
        jobType: "source",
        detectedSeason: 12,
        detectedEpisode: 24,
      }),
    ]);
    expect(buckets[0]!.title).toBe("S12E24");
  });

  it("falls back to a cleaned basename when the source job has no episode info", () => {
    const buckets = buildFileBuckets([
      baseJob({
        id: "src",
        filename: "/media/incoming/Some Movie [1080p].mkv",
        jobType: "source",
      }),
    ]);
    // Directory stripped, extension stripped.
    expect(buckets[0]!.title).toBe("Some Movie [1080p]");
  });

  it("falls back to the basename when a bucket has no source job at all", () => {
    // Transcode-only bucket — no source job means no season/episode to read.
    const buckets = buildFileBuckets([
      baseJob({
        id: "tx",
        filename: "Show - S03E04 - Title.mkv",
        jobType: "transcode",
      }),
    ]);
    expect(buckets[0]!.title).toBe("Show - S03E04 - Title");
  });

  it("strips Windows-style directory separators in the basename fallback", () => {
    const buckets = buildFileBuckets([
      baseJob({
        id: "src",
        filename: "C:\\Downloads\\Some File 720p.mkv",
        jobType: "source",
      }),
    ]);
    expect(buckets[0]!.title).toBe("Some File 720p");
  });

  it("sorts buckets by title", () => {
    const buckets = buildFileBuckets([
      baseJob({
        id: "e3",
        filename: "c.mkv",
        jobType: "source",
        detectedSeason: 1,
        detectedEpisode: 3,
      }),
      baseJob({
        id: "e1",
        filename: "a.mkv",
        jobType: "source",
        detectedSeason: 1,
        detectedEpisode: 1,
      }),
      baseJob({
        id: "e2",
        filename: "b.mkv",
        jobType: "source",
        detectedSeason: 1,
        detectedEpisode: 2,
      }),
    ]);
    expect(buckets.map((b) => b.title)).toEqual(["S01E01", "S01E02", "S01E03"]);
  });

  it("returns an empty array for no jobs", () => {
    expect(buildFileBuckets([])).toEqual([]);
  });
});

// B5: buildIngestJobGroups returns groups sorted most-recent-first by the
// newest createdAt across each group's jobs. Sorting at this layer (not at
// the sidebar component) means MediaDetailsProcessingPanel and any future
// consumer of the helper get the same ordering for free.

import { describe, expect, it } from "vitest";

// Dump-on-failure helper: surfaces the actual vs expected group ordering plus
// each group's id and ranking createdAt so a sort regression is diagnosable
// offline. Body wrapped in try/catch so a dump failure can't mask the assert.
const dumpGroupsSnapshot = (
  label: string,
  ctx: { expected?: unknown[]; actual?: unknown[]; groups?: Array<{ id: string }> },
) => {
  try {
    console.error(`=== [build-ingest-job-groups-sort:${label}] ordering snapshot ===`);
    console.error(`expected order=${JSON.stringify(ctx.expected)}`);
    console.error(`actual   order=${JSON.stringify(ctx.actual)}`);
    console.error(`groups:\n${JSON.stringify(ctx.groups, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const baseRecord = (overrides: Record<string, unknown> = {}) => ({
  jobId: "job-1",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "queued",
  stageCode: "init",
  stageLabel: "Init",
  progress: { mode: "none", completed: null, total: null, unit: null },
  payload: { filename: "movie.mkv" },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: true,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: "2026-04-01T00:00:00Z",
  updatedAt: "2026-04-01T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  groupId: "group-x",
  mediaId: "media-x",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  progressPct: 0,
  ...overrides,
});

describe("[@bugfix][@regression-proof] B5 buildIngestJobGroups orders groups newest-first", () => {
  it("simple three-group case: newest createdAt wins, oldest sinks", async () => {
    console.info("[build-ingest-job-groups-sort:setup] three groups oldest/newest/middle");
    const { buildIngestJobGroups } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const groups = buildIngestJobGroups([
      baseRecord({ jobId: "j-old", groupId: "oldest", mediaId: "oldest", createdAt: "2026-04-01T00:00:00Z" }) as any,
      baseRecord({ jobId: "j-new", groupId: "newest", mediaId: "newest", createdAt: "2026-04-03T00:00:00Z" }) as any,
      baseRecord({ jobId: "j-mid", groupId: "middle", mediaId: "middle", createdAt: "2026-04-02T00:00:00Z" }) as any,
    ]);
    const actual = groups.map((g) => g.id);
    const expected = ["newest", "middle", "oldest"];
    console.info(`[build-ingest-job-groups-sort:assert] actual order=${JSON.stringify(actual)}`);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      dumpGroupsSnapshot("three-group", { expected, actual, groups });
    }
    expect(actual).toEqual(expected);
  });

  it("group with mixed-age jobs ranks by the most-recent job's createdAt", async () => {
    console.info("[build-ingest-job-groups-sort:setup] mixed-age jobs across group-a/group-b");
    const { buildIngestJobGroups } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const groups = buildIngestJobGroups([
      baseRecord({ jobId: "a-old", groupId: "group-a", mediaId: "group-a", createdAt: "2026-04-01T00:00:00Z" }) as any,
      baseRecord({ jobId: "a-new", groupId: "group-a", mediaId: "group-a", createdAt: "2026-04-05T00:00:00Z" }) as any,
      baseRecord({ jobId: "b-only", groupId: "group-b", mediaId: "group-b", createdAt: "2026-04-03T00:00:00Z" }) as any,
    ]);
    // group-a wins on max(createdAt) = 2026-04-05 vs group-b's 2026-04-03.
    const actual = groups.map((g) => g.id);
    const expected = ["group-a", "group-b"];
    console.info(`[build-ingest-job-groups-sort:assert] actual order=${JSON.stringify(actual)}`);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      dumpGroupsSnapshot("mixed-age", { expected, actual, groups });
    }
    expect(actual).toEqual(expected);
  });

  it("five fixture groups produce strict newest-first ordering", async () => {
    console.info("[build-ingest-job-groups-sort:setup] five groups g1..g5 (shuffled input)");
    const { buildIngestJobGroups } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const records = [
      ["g3", "2026-04-03T00:00:00Z"],
      ["g1", "2026-04-01T00:00:00Z"],
      ["g5", "2026-04-05T00:00:00Z"],
      ["g2", "2026-04-02T00:00:00Z"],
      ["g4", "2026-04-04T00:00:00Z"],
    ].map(([id, createdAt]) =>
      baseRecord({ jobId: `j-${id}`, groupId: id, mediaId: id, createdAt }) as any,
    );
    const groups = buildIngestJobGroups(records);
    const actual = groups.map((g) => g.id);
    const expected = ["g5", "g4", "g3", "g2", "g1"];
    console.info(`[build-ingest-job-groups-sort:assert] actual order=${JSON.stringify(actual)}`);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      dumpGroupsSnapshot("five-group", { expected, actual, groups });
    }
    expect(actual).toEqual(expected);
  });
});

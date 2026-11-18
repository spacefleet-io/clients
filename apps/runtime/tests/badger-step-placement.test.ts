/**
 * #145 one media = one placementId = one silo. Pins `resolveJobPlacementId`:
 * which placement a badger step uploads under, including the fallbacks for
 * jobs queued before placement ids existed.
 */
import { describe, expect, it, vi } from "vitest";
import type { IngestJobRecord } from "../src/core/jobs/engineV2";
import { readJobPlacementId, resolveJobPlacementId } from "../src/modules/badger/steps/placement";

const SUITE = "badger-step-placement";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type PlacementJob = Pick<IngestJobRecord, "jobId" | "kind" | "payload" | "parentJobIds">;

const job = (over: Partial<PlacementJob>): PlacementJob => ({
  jobId: "job-source-0001",
  kind: "source",
  payload: {},
  parentJobIds: [],
  ...over,
});

const makeDeps = (parentPlacement: string | null = null) => {
  const lookupJobPlacementId = vi.fn(async (_jobId: string): Promise<string | null> => parentPlacement);
  const persistJobPlacementId = vi.fn(async (_jobId: string, _placementId: string): Promise<void> => {});
  return { lookupJobPlacementId, persistJobPlacementId };
};

describe(`[${SUITE}] resolveJobPlacementId`, () => {
  it("payload.placementId wins over every fallback", async () => {
    const deps = makeDeps("placement-parent");
    const id = await resolveJobPlacementId(
      job({ kind: "format", payload: { placementId: "placement-own", parentSourceJobId: "job-source-0001" } }),
      deps
    );
    console.info(`[${SUITE}:payload-wins] id=${id}`);
    expect(id).toBe("placement-own");
    expect(deps.lookupJobPlacementId).not.toHaveBeenCalled();
    expect(deps.persistJobPlacementId).not.toHaveBeenCalled();
  });

  it("source with a valid job id → the job id, nothing persisted", async () => {
    const deps = makeDeps();
    const id = await resolveJobPlacementId(job({ jobId: "job-source-0001" }), deps);
    console.info(`[${SUITE}:source-jobid] id=${id}`);
    expect(id).toBe("job-source-0001");
    expect(deps.persistJobPlacementId).not.toHaveBeenCalled();
  });

  it("source with an invalid job id → mints a UUID and persists it on the job", async () => {
    const deps = makeDeps();
    const id = await resolveJobPlacementId(job({ jobId: "src" }), deps);
    console.info(`[${SUITE}:source-mint] id=${id} persist=${JSON.stringify(deps.persistJobPlacementId.mock.calls)}`);
    expect(id).toMatch(UUID_RE);
    expect(deps.persistJobPlacementId).toHaveBeenCalledExactlyOnceWith("src", id);
  });

  it("minting without persistJobPlacementId wired fails loud", async () => {
    await expect(resolveJobPlacementId(job({ jobId: "src" }), {})).rejects.toThrow(
      "STEP_PLACEMENT_PERSIST_NOT_WIRED"
    );
  });

  it("format job reuses the parent source's persisted placementId", async () => {
    const deps = makeDeps("placement-of-parent");
    const id = await resolveJobPlacementId(
      job({ jobId: "job-format-0001", kind: "format", payload: { parentSourceJobId: "src" } }),
      deps
    );
    console.info(`[${SUITE}:format-parent] id=${id}`);
    expect(id).toBe("placement-of-parent");
    expect(deps.lookupJobPlacementId).toHaveBeenCalledExactlyOnceWith("src");
    expect(deps.persistJobPlacementId).not.toHaveBeenCalled();
  });

  it("format job: parent without a persisted id → the parent's (valid) job id, via parentJobIds", async () => {
    const deps = makeDeps(null);
    const id = await resolveJobPlacementId(
      job({ jobId: "job-format-0001", kind: "format", parentJobIds: ["job-source-0001"] }),
      deps
    );
    console.info(`[${SUITE}:format-parent-jobid] id=${id}`);
    expect(id).toBe("job-source-0001");
    expect(deps.lookupJobPlacementId).toHaveBeenCalledExactlyOnceWith("job-source-0001");
  });

  it("format job: parent unknown and its id invalid → STEP_PLACEMENT_PARENT_UNKNOWN", async () => {
    await expect(
      resolveJobPlacementId(job({ jobId: "job-format-0001", kind: "format", parentJobIds: ["src"] }), makeDeps(null))
    ).rejects.toThrow("STEP_PLACEMENT_PARENT_UNKNOWN:src");
  });

  it("format job without any parent → STEP_PLACEMENT_MISSING_PARENT_SOURCE_JOB_ID", async () => {
    await expect(
      resolveJobPlacementId(job({ jobId: "job-format-0001", kind: "format" }), makeDeps())
    ).rejects.toThrow("STEP_PLACEMENT_MISSING_PARENT_SOURCE_JOB_ID");
  });

  it("retranscode format job without an id mints and persists (no parent lookup)", async () => {
    const deps = makeDeps("placement-of-parent");
    const id = await resolveJobPlacementId(
      job({ jobId: "job-retranscode-1", kind: "format", payload: { retranscode: true } }),
      deps
    );
    console.info(`[${SUITE}:retranscode-mint] id=${id}`);
    expect(id).toMatch(UUID_RE);
    expect(deps.lookupJobPlacementId).not.toHaveBeenCalled();
    expect(deps.persistJobPlacementId).toHaveBeenCalledExactlyOnceWith("job-retranscode-1", id);
  });
});

describe(`[${SUITE}] readJobPlacementId`, () => {
  it("ignores an invalid payload id and never falls back to a format job's own id", () => {
    expect(readJobPlacementId(job({ payload: { placementId: "bad id!" } }))).toBe("job-source-0001");
    expect(readJobPlacementId(job({ kind: "format", jobId: "job-format-0001" }))).toBeNull();
  });
});

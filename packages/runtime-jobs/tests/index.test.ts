import { describe, expect, it } from "vitest";
import {
  backoffMsForRuntimeJobAttempt,
  buildBadgerRuntimeJobRecord,
  buildDefaultRuntimeJobSchedulingPolicy,
  buildRuntimeJobEventPayload,
  buildBadgerRuntimeIngestJobId,
  canScheduleRuntimeJobRetry,
  DEFAULT_RUNTIME_JOB_SCHEDULING_POLICY,
  filterRuntimeJobs,
  getRuntimeJobAttemptCount,
  inferRuntimeJobResourceClaims,
  isRuntimeJobReadyToRunAt,
  isTerminalRuntimeJobStatus,
  parseRuntimeJobId,
  selectRunnableRuntimeJobs,
  type RuntimeJobRecord,
  type RuntimeJobSchedulingCandidate,
} from "../src/index";

const SUITE = "runtime-jobs-index";

const summarizeJobs = (jobs: ReadonlyArray<Pick<RuntimeJobRecord, "jobId" | "app" | "kind" | "lane" | "status" | "priority"> & Partial<RuntimeJobRecord>>) =>
  jobs.map((j) => ({
    jobId: j.jobId,
    app: j.app,
    kind: j.kind,
    lane: j.lane,
    status: j.status,
    priority: j.priority,
    attemptCount: j.attemptCount ?? null,
    maxAttempts: j.maxAttempts ?? null,
    cancelRequested: j.cancelRequested ?? null,
    nextAttemptAt: j.nextAttemptAt ?? null,
  }));

const dumpJobsSnapshot = (
  label: string,
  ctx: {
    registry?: ReadonlyArray<RuntimeJobRecord> | ReadonlyArray<RuntimeJobSchedulingCandidate>;
    scheduled?: ReadonlyArray<string>;
    completed?: ReadonlyArray<string>;
    input?: unknown;
    expected?: unknown;
    observed?: unknown;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.registry) {
      console.error(`job registry (${ctx.registry.length}):\n${JSON.stringify(summarizeJobs(ctx.registry as ReadonlyArray<RuntimeJobRecord>), null, 2)}`);
    }
    if (ctx.scheduled !== undefined) {
      console.error(`scheduled jobIds: ${JSON.stringify(ctx.scheduled)}`);
    }
    if (ctx.completed !== undefined) {
      console.error(`completed jobIds: ${JSON.stringify(ctx.completed)}`);
    }
    if (ctx.input !== undefined) {
      console.error(`input:\n${JSON.stringify(ctx.input, null, 2)}`);
    }
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, null, 2)}`);
    }
    if (ctx.observed !== undefined) {
      console.error(`observed:\n${JSON.stringify(ctx.observed, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const job = (overrides: Partial<RuntimeJobRecord>): RuntimeJobRecord => ({
  jobId: overrides.jobId ?? "job-1",
  app: overrides.app ?? "parrot",
  kind: overrides.kind ?? "parrot.sync.upload",
  lane: overrides.lane ?? "io",
  status: overrides.status ?? "running",
  stageCode: overrides.stageCode ?? "uploading",
  stageLabel: overrides.stageLabel ?? "Uploading",
  progress: overrides.progress ?? { mode: "indeterminate", completed: null, total: null, unit: null },
  payload: overrides.payload ?? {},
  outputs: overrides.outputs ?? {},
  errorCode: overrides.errorCode ?? null,
  errorMessage: overrides.errorMessage ?? null,
  retryable: overrides.retryable ?? true,
  resourceClaims: overrides.resourceClaims,
  scheduling: overrides.scheduling,
  attemptCount: overrides.attemptCount ?? 0,
  maxAttempts: overrides.maxAttempts,
  nextAttemptAt: overrides.nextAttemptAt ?? null,
  lastAttemptAt: overrides.lastAttemptAt ?? null,
  cancelRequested: overrides.cancelRequested ?? false,
  priority: overrides.priority ?? 0,
  dedupeKey: overrides.dedupeKey ?? null,
  createdAt: overrides.createdAt ?? "2026-03-18T10:00:00.000Z",
  updatedAt: overrides.updatedAt ?? "2026-03-18T10:00:00.000Z",
  startedAt: overrides.startedAt ?? "2026-03-18T10:00:01.000Z",
  finishedAt: overrides.finishedAt ?? null,
});

describe("runtime-jobs filters", () => {
  it("hides completed jobs by default", () => {
    console.info(`[${SUITE}:filter-hide-completed] registry=[running:a, succeeded:b]`);
    const items = [job({ jobId: "a", status: "running" }), job({ jobId: "b", status: "succeeded" })];
    const observed = filterRuntimeJobs(items).map((entry) => entry.jobId);
    try {
      expect(observed).toEqual(["a"]);
      console.info(`[${SUITE}:filter-hide-completed] OK observed=${JSON.stringify(observed)}`);
    } catch (err) {
      dumpJobsSnapshot("filter-hide-completed-failure", { registry: items, expected: ["a"], observed });
      throw err;
    }
  });

  it("filters by app, kind, status and limit deterministically @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:filter-by-criteria] filter app=parrot status=[failed,running] kind=[parrot.preview.generate,parrot.sync.upload] limit=1`);
    const items = [
      job({ jobId: "a", app: "parrot", kind: "parrot.sync.upload", status: "running", updatedAt: "2026-03-18T10:00:05.000Z" }),
      job({ jobId: "b", app: "badger", kind: "badger.ingest.media_file", status: "failed", updatedAt: "2026-03-18T10:00:06.000Z" }),
      job({ jobId: "c", app: "parrot", kind: "parrot.preview.generate", status: "failed", updatedAt: "2026-03-18T10:00:07.000Z" }),
    ];
    const observed = filterRuntimeJobs(items, { app: "parrot", status: ["failed", "running"], kind: ["parrot.preview.generate", "parrot.sync.upload"], limit: 1 }).map((entry) => entry.jobId);
    try {
      expect(observed).toEqual(["c"]);
      console.info(`[${SUITE}:filter-by-criteria] OK observed=${JSON.stringify(observed)}`);
    } catch (err) {
      dumpJobsSnapshot("filter-by-criteria-failure", { registry: items, expected: ["c"], observed });
      throw err;
    }
  });

  it("builds shared event payloads from canonical job records @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:build-event-payload] building event from evt-1 with quota_exceeded`);
    const sourceJob = job({
      jobId: "evt-1",
      payload: { path: "/Family/photo.jpg" },
      outputs: { objectKey: "obj-1" },
      errorCode: "quota_exceeded",
    });
    const observed = buildRuntimeJobEventPayload(sourceJob);
    const expected = {
      jobId: "evt-1",
      app: "parrot",
      kind: "parrot.sync.upload",
      status: "running",
      stageCode: "uploading",
      stageLabel: "Uploading",
      progress: { mode: "indeterminate", completed: null, total: null, unit: null },
      payload: { path: "/Family/photo.jpg" },
      outputs: { objectKey: "obj-1" },
      updatedAt: "2026-03-18T10:00:00.000Z",
      startedAt: "2026-03-18T10:00:01.000Z",
      finishedAt: null,
      errorCode: "quota_exceeded",
      errorMessage: null,
      retryable: true,
    };
    try {
      expect(observed).toEqual(expected);
      console.info(`[${SUITE}:build-event-payload] OK payload matches`);
    } catch (err) {
      dumpJobsSnapshot("build-event-payload-failure", { registry: [sourceJob], expected, observed });
      throw err;
    }
  });

  it("recognizes terminal statuses deterministically @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:terminal-statuses] checking succeeded/failed/cancelled/running`);
    const probes = [
      ["succeeded", true],
      ["failed", true],
      ["cancelled", true],
      ["running", false],
    ] as const;
    for (const [status, expected] of probes) {
      const observed = isTerminalRuntimeJobStatus(status);
      try {
        expect(observed).toBe(expected);
        console.info(`[${SUITE}:terminal-statuses] OK ${status}=${observed}`);
      } catch (err) {
        dumpJobsSnapshot("terminal-statuses-failure", {
          input: { status },
          expected,
          observed,
        });
        throw err;
      }
    }
  });

  it("computes retry/backoff eligibility deterministically @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:retry-backoff] probing backoff, attempts, retry-eligibility, ready-to-run-at`);
    try {
      expect(backoffMsForRuntimeJobAttempt(0)).toBe(1_000);
      expect(backoffMsForRuntimeJobAttempt(1)).toBe(2_000);
      expect(backoffMsForRuntimeJobAttempt(20)).toBe(60_000);
      expect(getRuntimeJobAttemptCount({ attemptCount: 2.8 } as RuntimeJobRecord)).toBe(2);
      expect(canScheduleRuntimeJobRetry({ retryable: true, attemptCount: 0, maxAttempts: 2 } as RuntimeJobRecord)).toBe(true);
      expect(canScheduleRuntimeJobRetry({ retryable: true, attemptCount: 2, maxAttempts: 2 } as RuntimeJobRecord)).toBe(false);
      expect(
        isRuntimeJobReadyToRunAt(
          { status: "queued", cancelRequested: false, nextAttemptAt: "2026-03-23T12:00:05.000Z" } as RuntimeJobRecord,
          "2026-03-23T12:00:04.000Z"
        )
      ).toBe(false);
      expect(
        isRuntimeJobReadyToRunAt(
          { status: "queued", cancelRequested: false, nextAttemptAt: "2026-03-23T12:00:05.000Z" } as RuntimeJobRecord,
          "2026-03-23T12:00:05.000Z"
        )
      ).toBe(true);
      console.info(`[${SUITE}:retry-backoff] OK all probes match`);
    } catch (err) {
      dumpJobsSnapshot("retry-backoff-failure", {
        extra: {
          backoff0: backoffMsForRuntimeJobAttempt(0),
          backoff1: backoffMsForRuntimeJobAttempt(1),
          backoff20: backoffMsForRuntimeJobAttempt(20),
          attemptCountFloor: getRuntimeJobAttemptCount({ attemptCount: 2.8 } as RuntimeJobRecord),
          canRetryFresh: canScheduleRuntimeJobRetry({ retryable: true, attemptCount: 0, maxAttempts: 2 } as RuntimeJobRecord),
          canRetryAtCap: canScheduleRuntimeJobRetry({ retryable: true, attemptCount: 2, maxAttempts: 2 } as RuntimeJobRecord),
          readyBeforeWindow: isRuntimeJobReadyToRunAt(
            { status: "queued", cancelRequested: false, nextAttemptAt: "2026-03-23T12:00:05.000Z" } as RuntimeJobRecord,
            "2026-03-23T12:00:04.000Z",
          ),
          readyAtWindow: isRuntimeJobReadyToRunAt(
            { status: "queued", cancelRequested: false, nextAttemptAt: "2026-03-23T12:00:05.000Z" } as RuntimeJobRecord,
            "2026-03-23T12:00:05.000Z",
          ),
        },
      });
      throw err;
    }
  });

  it("parses and builds canonical runtime job ids deterministically @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:job-id-parse-build] roundtripping badger ids and rejecting "invalid"`);
    try {
      expect(buildBadgerRuntimeIngestJobId("user-a", "job-9")).toBe("badger:ingest:user-a:job-9");
      expect(buildBadgerRuntimeIngestJobId(null, "job-9")).toBe("badger:ingest:active:job-9");
      expect(parseRuntimeJobId("badger:ingest:user-a:job-9")).toEqual({
        app: "badger",
        kind: "ingest",
        rawId: "job-9",
        ownerId: "user-a",
        jobId: "badger:ingest:user-a:job-9",
      });
      expect(parseRuntimeJobId("invalid")).toBeNull();
      expect(parseRuntimeJobId("parrot:task:task-9")).toBeNull();
      console.info(`[${SUITE}:job-id-parse-build] OK all ids parsed and built correctly`);
    } catch (err) {
      dumpJobsSnapshot("job-id-parse-build-failure", {
        extra: {
          builtBadgerWithOwner: buildBadgerRuntimeIngestJobId("user-a", "job-9"),
          builtBadgerActive: buildBadgerRuntimeIngestJobId(null, "job-9"),
          parsedBadger: parseRuntimeJobId("badger:ingest:user-a:job-9"),
          parsedInvalid: parseRuntimeJobId("invalid"),
        },
      });
      throw err;
    }
  });

  it("projects badger source jobs into canonical runtime jobs deterministically @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:badger-projection] projecting transcoding job and failed/cancelled job`);
    const inputA = {
      job: {
        id: "job-12",
        filename: "/tmp/lodgers.mkv",
        status: "transcoding",
        progress: 45,
        fileId: "file-12",
        queueSequence: 4,
        matchedMediaId: "media-lodgers",
        matchedTo: { type: "tv" },
        detectedSeason: 1,
        detectedEpisode: 3,
      },
      userId: "user-a",
      existing: null,
      nowIso: "2026-03-23T12:00:00.000Z",
    };
    const inputB = {
      job: {
        id: "job-13",
        filename: "/tmp/lodgers-2.mkv",
        status: "failed",
        error: "lab.errors.cancelled",
      },
      userId: null,
      existing: null,
      nowIso: "2026-03-23T12:00:00.000Z",
    };
    let observedA: unknown;
    let observedB: unknown;
    try {
      observedA = buildBadgerRuntimeJobRecord(inputA as Parameters<typeof buildBadgerRuntimeJobRecord>[0]);
      expect(observedA).toEqual(
        expect.objectContaining({
          jobId: "badger:ingest:user-a:job-12",
          app: "badger",
          kind: "badger.ingest.media_file",
          lane: "cpu",
          status: "running",
          stageCode: "transcoding",
          stageLabel: "Processing",
          progress: { mode: "fraction", completed: 45, total: 100, unit: "percent" },
          dedupeKey: "badger:file-12",
          resourceClaims: ["cpuHeavy", "diskHeavy"],
          scheduling: {
            submittedOrder: 4,
            collectionKey: "badger:tv:media-lodgers",
            mediaOrder: 10003,
            phaseOrder: 0,
            variantOrder: 0,
          },
          startedAt: "2026-03-23T12:00:00.000Z",
        }),
      );
      observedB = buildBadgerRuntimeJobRecord(inputB as Parameters<typeof buildBadgerRuntimeJobRecord>[0]);
      expect(observedB).toEqual(
        expect.objectContaining({
          jobId: "badger:ingest:active:job-13",
          lane: "background",
          status: "cancelled",
          stageCode: "cancelled",
          stageLabel: "Cancelled",
          retryable: false,
          startedAt: null,
        }),
      );
      console.info(`[${SUITE}:badger-projection] OK both projections matched`);
    } catch (err) {
      dumpJobsSnapshot("badger-projection-failure", {
        input: { inputA, inputB },
        observed: { observedA, observedB },
      });
      throw err;
    }
  });

  it("prefers core episodes in canonical TV order before derived transcodes within one show @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:tv-core-before-derived] selecting from e4-core, e3-derived, e2-core`);
    const jobs = [
      job({
        jobId: "show-e4-core",
        app: "badger",
        kind: "badger.ingest.media_file",
        lane: "cpu",
        status: "queued",
        stageCode: "ready",
        stageLabel: "Ready to start",
        scheduling: {
          submittedOrder: 1,
          collectionKey: "badger:tv:lodgers",
          mediaOrder: 10004,
          phaseOrder: 0,
          variantOrder: 0,
        },
      }),
      job({
        jobId: "show-e3-derived",
        app: "badger",
        kind: "badger.ingest.media_file",
        lane: "cpu",
        status: "queued",
        stageCode: "ready",
        stageLabel: "Ready to start",
        scheduling: {
          submittedOrder: 2,
          collectionKey: "badger:tv:lodgers",
          mediaOrder: 10003,
          phaseOrder: 1,
          variantOrder: 1,
        },
      }),
      job({
        jobId: "show-e2-core",
        app: "badger",
        kind: "badger.ingest.media_file",
        lane: "cpu",
        status: "queued",
        stageCode: "ready",
        stageLabel: "Ready to start",
        scheduling: {
          submittedOrder: 3,
          collectionKey: "badger:tv:lodgers",
          mediaOrder: 10002,
          phaseOrder: 0,
          variantOrder: 0,
        },
      }),
    ];
    const selected = selectRunnableRuntimeJobs({
      jobs,
      policy: {
        ...DEFAULT_RUNTIME_JOB_SCHEDULING_POLICY,
        maxConcurrentJobs: 3,
        laneConcurrency: {
          ...DEFAULT_RUNTIME_JOB_SCHEDULING_POLICY.laneConcurrency,
          cpu: 3,
        },
        resourceLimits: {
          ...DEFAULT_RUNTIME_JOB_SCHEDULING_POLICY.resourceLimits,
          cpuHeavy: 3,
        },
      },
    });

    const observed = selected.map((entry) => entry.jobId);
    const expected = ["show-e2-core", "show-e4-core", "show-e3-derived"];
    try {
      expect(observed).toEqual(expected);
      console.info(`[${SUITE}:tv-core-before-derived] OK scheduled=${JSON.stringify(observed)}`);
    } catch (err) {
      dumpJobsSnapshot("tv-core-before-derived-failure", {
        registry: jobs,
        scheduled: observed,
        expected,
        observed,
      });
      throw err;
    }
  });

  it("derives safer low-capacity runtime scheduler budgets for weaker machines @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:low-capacity-policy] deriving policy for logicalCpuCount=2 totalMemoryGiB=4`);
    const observed = buildDefaultRuntimeJobSchedulingPolicy({
      logicalCpuCount: 2,
      totalMemoryGiB: 4,
    });
    const expected = {
      maxConcurrentJobs: 2,
      laneConcurrency: {
        interactive: 1,
        cpu: 1,
        io: 1,
        network: 1,
        background: 1,
      },
      resourceLimits: {
        cpuHeavy: 1,
        diskHeavy: 1,
        networkHeavy: 1,
        memoryHeavy: 1,
      },
    };
    try {
      expect(observed).toMatchObject(expected);
      console.info(`[${SUITE}:low-capacity-policy] OK budget matches`);
    } catch (err) {
      dumpJobsSnapshot("low-capacity-policy-failure", {
        input: { logicalCpuCount: 2, totalMemoryGiB: 4 },
        expected,
        observed,
      });
      throw err;
    }
  });

  it("raises the host cpu budget only on stronger machines so advanced transcode parallelism stays bounded @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:cpu-budget-scaling] checking cpu lane budget for 6c/12GiB and 12c/24GiB`);
    const policy6 = buildDefaultRuntimeJobSchedulingPolicy({ logicalCpuCount: 6, totalMemoryGiB: 12 });
    const policy12 = buildDefaultRuntimeJobSchedulingPolicy({ logicalCpuCount: 12, totalMemoryGiB: 24 });
    try {
      expect(policy6.laneConcurrency.cpu).toBe(2);
      expect(policy12.laneConcurrency.cpu).toBe(3);
      console.info(`[${SUITE}:cpu-budget-scaling] OK cpu(6c)=${policy6.laneConcurrency.cpu} cpu(12c)=${policy12.laneConcurrency.cpu}`);
    } catch (err) {
      dumpJobsSnapshot("cpu-budget-scaling-failure", {
        input: { runs: [{ cpu: 6, mem: 12 }, { cpu: 12, mem: 24 }] },
        observed: { cpu6: policy6.laneConcurrency.cpu, cpu12: policy12.laneConcurrency.cpu },
        expected: { cpu6: 2, cpu12: 3 },
      });
      throw err;
    }
  });

  it("keeps running work in place while still allowing other lanes to proceed @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:running-work-preserved] mix of running cpu, queued cpu, queued network`);
    const jobs = [
      job({
        jobId: "show-e3-core-running",
        app: "badger",
        kind: "badger.ingest.media_file",
        lane: "cpu",
        status: "running",
        stageCode: "transcoding",
        stageLabel: "Processing",
        scheduling: {
          submittedOrder: 2,
          collectionKey: "badger:tv:lodgers",
          mediaOrder: 10003,
          phaseOrder: 0,
          variantOrder: 0,
        },
      }),
      job({
        jobId: "show-e2-core-queued",
        app: "badger",
        kind: "badger.ingest.media_file",
        lane: "cpu",
        status: "queued",
        stageCode: "ready",
        stageLabel: "Ready to start",
        scheduling: {
          submittedOrder: 4,
          collectionKey: "badger:tv:lodgers",
          mediaOrder: 10002,
          phaseOrder: 0,
          variantOrder: 0,
        },
      }),
      job({
        jobId: "show-e1-upload",
        app: "badger",
        kind: "badger.ingest.media_file",
        lane: "network",
        status: "queued",
        stageCode: "uploading",
        stageLabel: "Uploading",
        scheduling: {
          submittedOrder: 1,
          collectionKey: "badger:tv:lodgers",
          mediaOrder: 10001,
          phaseOrder: 0,
          variantOrder: 0,
        },
      }),
    ];
    const selected = selectRunnableRuntimeJobs({ jobs });
    const observed = selected.map((entry) => entry.jobId);
    const expected = ["show-e1-upload"];
    try {
      expect(observed).toEqual(expected);
      console.info(`[${SUITE}:running-work-preserved] OK scheduled=${JSON.stringify(observed)}`);
    } catch (err) {
      dumpJobsSnapshot("running-work-preserved-failure", {
        registry: jobs,
        scheduled: observed,
        expected,
        observed,
      });
      throw err;
    }
  });
});

describe("runtime-jobs scheduler", () => {
  it("infers default resource claims from lane deterministically @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:lane-claims] inferring default resource claims for cpu/io/network/background`);
    const claimsCpu = inferRuntimeJobResourceClaims(job({ lane: "cpu" }));
    const claimsIo = inferRuntimeJobResourceClaims(job({ lane: "io" }));
    const claimsNet = inferRuntimeJobResourceClaims(job({ lane: "network" }));
    const claimsBg = inferRuntimeJobResourceClaims(job({ lane: "background" }));
    try {
      expect(claimsCpu).toEqual(["cpuHeavy"]);
      expect(claimsIo).toEqual(["diskHeavy"]);
      expect(claimsNet).toEqual(["networkHeavy"]);
      expect(claimsBg).toEqual([]);
      console.info(`[${SUITE}:lane-claims] OK cpu=${JSON.stringify(claimsCpu)} io=${JSON.stringify(claimsIo)} net=${JSON.stringify(claimsNet)} bg=${JSON.stringify(claimsBg)}`);
    } catch (err) {
      dumpJobsSnapshot("lane-claims-failure", {
        observed: { cpu: claimsCpu, io: claimsIo, network: claimsNet, background: claimsBg },
        expected: { cpu: ["cpuHeavy"], io: ["diskHeavy"], network: ["networkHeavy"], background: [] },
      });
      throw err;
    }
  });

  it("selects runnable jobs within lane and resource budgets deterministically @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:lane-and-resource-budgets] 7 candidates, policy.maxConcurrentJobs=5`);
    const items: RuntimeJobSchedulingCandidate[] = [
      job({ jobId: "active-cpu", status: "running", lane: "cpu" }),
      job({ jobId: "queued-cpu", status: "queued", lane: "cpu", priority: 10 }),
      job({ jobId: "queued-io-high", status: "queued", lane: "io", priority: 10, createdAt: "2026-03-18T10:00:01.000Z" }),
      job({ jobId: "queued-io-low", status: "queued", lane: "io", priority: 1, createdAt: "2026-03-18T10:00:02.000Z" }),
      {
        ...job({ jobId: "queued-network-memory-a", status: "queued", lane: "network", priority: 5 }),
        resourceClaims: ["networkHeavy", "memoryHeavy"],
      },
      {
        ...job({ jobId: "queued-network-memory-b", status: "queued", lane: "network", priority: 4 }),
        resourceClaims: ["networkHeavy", "memoryHeavy"],
      },
      job({ jobId: "queued-background", status: "queued", lane: "background", priority: 100 }),
    ];

    const observed = selectRunnableRuntimeJobs({
      jobs: items,
      policy: {
        ...DEFAULT_RUNTIME_JOB_SCHEDULING_POLICY,
        maxConcurrentJobs: 5,
      },
    }).map((entry) => entry.jobId);
    const expected = ["queued-io-high", "queued-io-low", "queued-network-memory-a", "queued-background"];
    try {
      expect(observed).toEqual(expected);
      console.info(`[${SUITE}:lane-and-resource-budgets] OK scheduled=${JSON.stringify(observed)}`);
    } catch (err) {
      dumpJobsSnapshot("lane-and-resource-budgets-failure", {
        registry: items,
        scheduled: observed,
        expected,
        observed,
      });
      throw err;
    }
  });

  it("skips delayed queued jobs until their retry window is due @bugfix @regression-proof", () => {
    console.info(`[${SUITE}:delayed-retry-window] nowIso=12:00:05Z; "delayed" has window=12:00:10Z`);
    const items: RuntimeJobSchedulingCandidate[] = [
      job({ jobId: "delayed", status: "queued", lane: "cpu", nextAttemptAt: "2026-03-23T12:00:10.000Z" }),
      job({ jobId: "ready-now", status: "queued", lane: "cpu" }),
    ];

    const observed = selectRunnableRuntimeJobs({
      jobs: items,
      policy: DEFAULT_RUNTIME_JOB_SCHEDULING_POLICY,
      nowIso: "2026-03-23T12:00:05.000Z",
    }).map((entry) => entry.jobId);
    const expected = ["ready-now"];
    try {
      expect(observed).toEqual(expected);
      console.info(`[${SUITE}:delayed-retry-window] OK scheduled=${JSON.stringify(observed)}`);
    } catch (err) {
      dumpJobsSnapshot("delayed-retry-window-failure", {
        registry: items,
        scheduled: observed,
        expected,
        observed,
        extra: { nowIso: "2026-03-23T12:00:05.000Z" },
      });
      throw err;
    }
  });

  it("exhausted retry job stays failed and is never selected by the scheduler", () => {
    console.info(`[${SUITE}:exhausted-retry-not-scheduled] checking failed-at-cap job is not selected`);
    const exhausted: RuntimeJobSchedulingCandidate = job({
      jobId: "exhausted",
      status: "failed",
      lane: "cpu",
      retryable: true,
      attemptCount: 3,
      maxAttempts: 3,
    });
    const ready: RuntimeJobSchedulingCandidate = job({
      jobId: "ready",
      status: "queued",
      lane: "cpu",
    });

    const canRetry = canScheduleRuntimeJobRetry(exhausted);
    const selected = selectRunnableRuntimeJobs({
      jobs: [exhausted, ready],
      policy: DEFAULT_RUNTIME_JOB_SCHEDULING_POLICY,
    });
    const observed = selected.map((e) => e.jobId);
    const expected = ["ready"];
    try {
      expect(canRetry).toBe(false);
      expect(observed).toEqual(expected);
      console.info(`[${SUITE}:exhausted-retry-not-scheduled] OK canRetry=${canRetry} scheduled=${JSON.stringify(observed)}`);
    } catch (err) {
      dumpJobsSnapshot("exhausted-retry-not-scheduled-failure", {
        registry: [exhausted, ready],
        scheduled: observed,
        expected,
        observed,
        extra: { canRetry },
      });
      throw err;
    }
  });
});

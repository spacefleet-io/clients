/**
 * Benchmark for #671 R6: what a big queue costs the runtime event loop in
 * engineV2's scheduler (`tick()`).
 *
 *   bun apps/runtime/scripts/bench-engine-tick.ts [pairs=300] [completions=40]
 *   BENCH_ENGINE_MODULE=/path/to/old/engineV2.ts bun apps/runtime/scripts/bench-engine-tick.ts
 *
 * Scenario (the audit's jobs-1 shape): `pairs` source jobs, each with a format
 * child that waits on it, so 2 x `pairs` jobs sit in the queue. Lane caps are
 * source=1, format=1, so one source job holds the source lane and every other
 * job waits. Reports, per phase:
 *   - submit: wall time of `submit()` (which runs a tick) for the first and the
 *     last 10 pairs, and the total;
 *   - step end: after the running source step finishes, the time the event loop
 *     is blocked until the engine settles (the next job started), median and
 *     max over `completions` consecutive step ends.
 * Handlers do nothing but await a release, so the numbers are the scheduler's.
 */
import type { IngestJobRecord } from "@space/runtime-jobs";
import type * as EngineModule from "@space/runtime-jobs-engine/engineV2";

const engineModule = process.env.BENCH_ENGINE_MODULE ?? "@space/runtime-jobs-engine/engineV2";
const { createEngineV2 } = (await import(engineModule)) as typeof EngineModule;

const pairs = Number(process.argv[2] ?? 300);
const completions = Number(process.argv[3] ?? 40);
const ts = "2026-01-01T00:00:00.000Z";

const makeJob = (overrides: Partial<IngestJobRecord>): IngestJobRecord => ({
  jobId: "job",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "queued",
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: { userId: "u1" },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: ts,
  updatedAt: ts,
  startedAt: null,
  finishedAt: null,
  groupId: "g",
  mediaId: "m",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  ...overrides,
});

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n: number) => Math.round(n * 100) / 100;

const engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
await engine.start();
engine.setLaneCaps({ source: 1, format: 1, upload: 1 });

// Each handler waits for an explicit release so the test controls step ends.
const waiting: Array<() => void> = [];
const started: string[] = [];
engine.subscribe((e) => {
  if (e.event === "runtime.jobs.started") started.push(e.jobId);
});
for (const kind of ["probe", "identify", "extract", "transcode", "upload", "commit"]) {
  engine.registerHandler(
    kind,
    ({ signal }) =>
      new Promise<void>((resolve, reject) => {
        waiting.push(resolve);
        // stop() aborts in-flight steps and waits for them; without this the bench would hang at exit.
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      })
  );
}

const submitMs: number[] = [];
for (let i = 0; i < pairs; i += 1) {
  const t0 = performance.now();
  await engine.submit(makeJob({ jobId: `src${i}`, mediaId: `m${i}`, groupId: `g${i}`, createdAt: new Date(Date.parse(ts) + i * 2).toISOString() }));
  await engine.submit(
    makeJob({
      jobId: `fmt${i}`,
      kind: "format",
      lane: "format",
      variant: "720p",
      mediaId: `m${i}`,
      groupId: `g${i}`,
      parentJobIds: [`src${i}`],
      createdAt: new Date(Date.parse(ts) + i * 2 + 1).toISOString(),
    })
  );
  submitMs.push(performance.now() - t0);
}

// Block time of one step end: release the running handler, then see how long
// until the loop is free again (a setImmediate scheduled right after).
const stepEndBlockMs: number[] = [];
for (let i = 0; i < completions; i += 1) {
  const release = waiting.shift();
  if (!release) break;
  const t0 = performance.now();
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  // Drain the microtask chain the completion kicks off (finally -> tick).
  await new Promise<void>((resolve) => setImmediate(resolve));
  stepEndBlockMs.push(performance.now() - t0);
}

const sorted = [...stepEndBlockMs].sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      engineModule,
      pairs,
      queuedJobs: pairs * 2,
      submitPair: {
        firstTenAvgMs: round(avg(submitMs.slice(0, 10))),
        lastTenAvgMs: round(avg(submitMs.slice(-10))),
        totalMs: round(submitMs.reduce((a, b) => a + b, 0)),
      },
      stepEnd: {
        samples: stepEndBlockMs.length,
        p50Ms: round(percentile(sorted, 0.5)),
        p95Ms: round(percentile(sorted, 0.95)),
        maxMs: round(sorted[sorted.length - 1] ?? 0),
      },
      startedJobs: started.length,
    },
    null,
    2
  )
);
await engine.stop();
process.exit(0);

/**
 * E2E helper: V2 runtimeJobs polling listener.
 *
 * The only live job-observation surface in the renderer is
 * `window.sf.runtimeJobs` (`list()` snapshot + `getStreamUrl()` EventSource).
 * The V1 `window.sf.labQueue` bridge and its `sf-lab-queue-update` IPC
 * channel are gone; suites that still listened on them observed nothing and
 * passed vacuously (issue #25). This helper is the single e2e plumbing for
 * job lifecycle.
 *
 * The helper polls `runtimeJobs.list({ includeDismissed: true })` every
 * `intervalMs` (default 500ms) and appends a `{ jobs, ts }` sample to
 * `window.__e2eRuntimeJobUpdates`. Each job is a `RuntimeJobSnapshot`: the
 * raw V2 status in `rawStatus` plus `status`, a lifecycle label the suites
 * assert on, mapped like `runtimeIngestJobs.ts:mapStatus`:
 *   queued     → "waiting"
 *   running + kind="source" → "uploading"
 *   running + kind="format" → "transcoding"
 *   succeeded  → "done"
 *   failed     → "failed"
 *   cancelled  → "cancelled"
 *   interrupted → "waiting"
 *
 * Fail-loud contract: wiring THROWS when `window.sf.runtimeJobs.list` is
 * missing, and every poll error / runtime error envelope is recorded in
 * `window.__e2eRuntimeJobsErrors` so a silent observer is visible in dumps.
 * Suites that assert on job state MUST also assert that they saw at least
 * one job (see `readAllSeenRuntimeJobs`), so an empty stream fails instead
 * of passing.
 *
 * Jobs already in the runtime store when the listener is wired are excluded
 * by default (`includePreexisting: false`), so earlier suites' jobs in the
 * shared harness runtime can never satisfy this suite's assertions.
 */

import type { Page } from "playwright";

export type WireRuntimeJobsListenerOptions = {
  /** Polling interval in ms. Default 500. */
  intervalMs?: number;
  /** Cap on stored updates (FIFO drop). Default 5000. */
  maxUpdates?: number;
  /**
   * Keep jobs that already existed when the listener was wired. Default
   * false: the runtime job store outlives a test file (the harness is a
   * worker singleton and list() is not user-scoped), so without a baseline a
   * suite would read earlier suites' jobs as its own and could pass on them.
   * Set true only when re-wiring to follow a job this suite already started
   * (after an idle window, a relaunch, ...).
   */
  includePreexisting?: boolean;
};

export type RuntimeJobStatus = "waiting" | "uploading" | "transcoding" | "done" | "failed" | "cancelled";

export type RuntimeJobSnapshot = {
  jobId: string;
  /** Same as jobId; kept so readers can use either key. */
  id: string;
  status: RuntimeJobStatus;
  rawStatus: string;
  progressPct: number;
  progress: number;
  error: string | null;
  mediaId: string | null;
  groupId: string | null;
  kind: string;
  stageCode: string | null;
  stageLabel: string | null;
};

export type RuntimeJobUpdate = { jobs: RuntimeJobSnapshot[]; ts: number };

/**
 * Install a polling-based V2 runtimeJobs listener inside the renderer page.
 *
 * Side effects in the page:
 *   - `window.__e2eRuntimeJobUpdates` is set to a fresh empty array.
 *   - `window.__e2eRuntimeJobsErrors` is set to a fresh empty array.
 *   - `window.__e2eRuntimeJobsStop` is set to a teardown function.
 *
 * Idempotent: calling twice stops the existing poll, resets state, and starts
 * a new one. Throws when the V2 surface is missing.
 */
export const wireRuntimeJobsListener = async (
  page: Page,
  options: WireRuntimeJobsListenerOptions = {},
): Promise<void> => {
  const intervalMs = options.intervalMs ?? 500;
  const maxUpdates = options.maxUpdates ?? 5000;
  const includePreexisting = options.includePreexisting ?? false;

  const wired = await page.evaluate(
    async ({ intervalMs: pollMs, maxUpdates: cap, includePreexisting: keepOld }) => {
      type Status = "waiting" | "uploading" | "transcoding" | "done" | "failed" | "cancelled";

      type V2Record = {
        jobId: string;
        kind?: string;
        status?: string;
        progressPct?: number;
        progress?: { mode?: string; completed?: number | null; total?: number | null };
        errorMessage?: string | null;
        errorCode?: string | null;
        mediaId?: string | null;
        groupId?: string | null;
        stageCode?: string;
        stageLabel?: string;
      };

      type Snapshot = {
        jobId: string;
        id: string;
        status: Status;
        rawStatus: string;
        progressPct: number;
        progress: number;
        error: string | null;
        mediaId: string | null;
        groupId: string | null;
        kind: string;
        stageCode: string | null;
        stageLabel: string | null;
      };

      const mapStatus = (s: string | undefined, kind: string | undefined): Status => {
        switch (s) {
          case "queued":
            return "waiting";
          case "running":
            return kind === "source" ? "uploading" : "transcoding";
          case "succeeded":
            return "done";
          case "failed":
            return "failed";
          case "cancelled":
            return "cancelled";
          case "interrupted":
            return "waiting";
          default:
            return "waiting";
        }
      };

      const target = window as typeof window & {
        __e2eRuntimeJobUpdates?: Array<{ jobs: Snapshot[]; ts: number }>;
        __e2eRuntimeJobsErrors?: string[];
        __e2eRuntimeJobsBaseline?: string[];
        __e2eRuntimeJobsStop?: (() => void) | null;
        __e2eRuntimeJobsPollHandle?: number | null;
      };

      // Stop any existing poll.
      if (typeof target.__e2eRuntimeJobsStop === "function") {
        try {
          target.__e2eRuntimeJobsStop();
        } catch {
          /* ignore */
        }
      }
      clearInterval(target.__e2eRuntimeJobsPollHandle ?? undefined);
      target.__e2eRuntimeJobUpdates = [];
      target.__e2eRuntimeJobsErrors = [];
      target.__e2eRuntimeJobsBaseline = [];
      target.__e2eRuntimeJobsPollHandle = null;

      const sf = (window as unknown as {
        sf?: {
          runtimeJobs?: {
            list?: (filter?: { mediaId?: string; includeDismissed?: boolean }) => Promise<unknown>;
          };
        };
      }).sf;

      const list = sf?.runtimeJobs?.list;
      if (typeof list !== "function") {
        target.__e2eRuntimeJobsStop = null;
        return "missing-surface";
      }

      const recordError = (msg: string) => {
        const errors = target.__e2eRuntimeJobsErrors ?? [];
        errors.push(`${new Date().toISOString()} ${msg}`);
        if (errors.length > 50) errors.splice(0, errors.length - 50);
        target.__e2eRuntimeJobsErrors = errors;
      };

      // Baseline: ids already in the store before this suite acts. Retried
      // because the runtime may still be warming up when a suite wires.
      const baseline = new Set<string>();
      if (!keepOld) {
        let baselineRead = false;
        for (let attempt = 0; attempt < 30 && !baselineRead; attempt += 1) {
          try {
            const raw = await list({ includeDismissed: true });
            const jobsField = raw && typeof raw === "object" ? (raw as { jobs?: unknown }).jobs : undefined;
            if (Array.isArray(jobsField)) {
              for (const r of jobsField as V2Record[]) baseline.add(r.jobId);
              baselineRead = true;
            } else {
              recordError(`baseline attempt ${attempt} unexpected list() shape ${JSON.stringify(raw).slice(0, 300)}`);
            }
          } catch (err) {
            recordError(`baseline attempt ${attempt} threw ${err instanceof Error ? err.message : String(err)}`);
          }
          if (!baselineRead) {
            const { promise, resolve } = Promise.withResolvers<void>();
            setTimeout(resolve, 500);
            await promise;
          }
        }
        if (!baselineRead) return "baseline-failed";
        target.__e2eRuntimeJobsBaseline = Array.from(baseline);
      }

      let inFlight = false;
      const poll = async () => {
        if (inFlight) return;
        inFlight = true;
        try {
          const raw = await list({ includeDismissed: true });
          // Error envelope from main: { __runtimeJobsError: true, ... }
          if (
            !!raw &&
            typeof raw === "object" &&
            (raw as { __runtimeJobsError?: unknown }).__runtimeJobsError === true
          ) {
            recordError(`error-envelope ${JSON.stringify(raw).slice(0, 500)}`);
            return;
          }
          // The runtime returns `{ jobs: V2Record[], maxEventId }`.
          const jobsField = raw && typeof raw === "object" ? (raw as { jobs?: unknown }).jobs : undefined;
          if (!Array.isArray(jobsField)) {
            recordError(`unexpected list() shape ${JSON.stringify(raw).slice(0, 500)}`);
            return;
          }
          const fresh = (jobsField as V2Record[]).filter((r) => !baseline.has(r.jobId));
          const jobs: Snapshot[] = fresh.map((r) => {
            const kind = typeof r.kind === "string" ? r.kind : "";
            const rawStatus = typeof r.status === "string" ? r.status : "";
            let pct = 0;
            if (typeof r.progressPct === "number") {
              pct = r.progressPct;
            } else if (
              r.progress &&
              typeof r.progress.completed === "number" &&
              typeof r.progress.total === "number" &&
              r.progress.total > 0
            ) {
              pct = (r.progress.completed / r.progress.total) * 100;
            }
            return {
              jobId: r.jobId,
              id: r.jobId,
              status: mapStatus(rawStatus, kind),
              rawStatus,
              progressPct: pct,
              progress: pct,
              error: r.errorMessage ?? r.errorCode ?? null,
              mediaId: r.mediaId ?? null,
              groupId: r.groupId ?? null,
              kind,
              stageCode: r.stageCode ?? null,
              stageLabel: r.stageLabel ?? null,
            };
          });
          const updates = target.__e2eRuntimeJobUpdates ?? [];
          updates.push({ jobs, ts: Date.now() });
          if (updates.length > cap) updates.splice(0, updates.length - cap);
          target.__e2eRuntimeJobUpdates = updates;
        } catch (err) {
          recordError(`poll threw ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          inFlight = false;
        }
      };

      // Kick off an immediate poll so the first sample lands quickly.
      void poll();
      const handle = window.setInterval(() => {
        void poll();
      }, pollMs);
      target.__e2eRuntimeJobsPollHandle = handle;
      target.__e2eRuntimeJobsStop = () => {
        if (target.__e2eRuntimeJobsPollHandle != null) {
          clearInterval(target.__e2eRuntimeJobsPollHandle);
          target.__e2eRuntimeJobsPollHandle = null;
        }
      };
      return `wired baselineExcluded=${baseline.size}`;
    },
    { intervalMs, maxUpdates, includePreexisting },
  );
  if (wired === "missing-surface") {
    throw new Error("wireRuntimeJobsListener: window.sf.runtimeJobs.list is not exposed — cannot observe jobs");
  }
  if (wired === "baseline-failed") {
    const errors = await readRuntimeJobsErrors(page);
    throw new Error(
      `wireRuntimeJobsListener: could not read the pre-existing job baseline after 30 attempts: ${errors.slice(-3).join(" | ")}`,
    );
  }
  console.info(
    `[runtimeJobsListener] ${wired} intervalMs=${intervalMs} maxUpdates=${maxUpdates} includePreexisting=${includePreexisting}`,
  );
};

/** Every sample collected since the listener was (re)wired. Empty when unwired. */
export const readRuntimeJobUpdates = async (page: Page): Promise<RuntimeJobUpdate[]> =>
  page.evaluate(
    () =>
      (window as typeof window & { __e2eRuntimeJobUpdates?: RuntimeJobUpdate[] }).__e2eRuntimeJobUpdates ?? [],
  );

/** Jobs from the most recent sample (empty before the first poll lands). */
export const readLatestRuntimeJobs = async (page: Page): Promise<RuntimeJobSnapshot[]> =>
  page.evaluate(() => {
    const updates =
      (window as typeof window & { __e2eRuntimeJobUpdates?: RuntimeJobUpdate[] }).__e2eRuntimeJobUpdates ?? [];
    return updates[updates.length - 1]?.jobs ?? [];
  });

/**
 * Last-known snapshot of every distinct job seen across all samples, in
 * first-seen order. Use this for "saw at least one job" / "no job failed"
 * verdicts so a job that left the list still counts.
 */
export const readAllSeenRuntimeJobs = async (page: Page): Promise<RuntimeJobSnapshot[]> =>
  page.evaluate(() => {
    const updates =
      (window as typeof window & { __e2eRuntimeJobUpdates?: RuntimeJobUpdate[] }).__e2eRuntimeJobUpdates ?? [];
    const byId = new Map<string, RuntimeJobSnapshot>();
    for (const update of updates) {
      for (const job of update.jobs) byId.set(job.jobId, job);
    }
    return Array.from(byId.values());
  });

/** Poll errors / error envelopes recorded by the listener (diagnostics). */
export const readRuntimeJobsErrors = async (page: Page): Promise<string[]> =>
  page.evaluate(
    () => (window as typeof window & { __e2eRuntimeJobsErrors?: string[] }).__e2eRuntimeJobsErrors ?? [],
  );

/** Stop polling. Safe when the listener was never wired or the page is gone. */
export const stopRuntimeJobsListener = async (page: Page): Promise<void> => {
  await page
    .evaluate(() => {
      const target = window as typeof window & { __e2eRuntimeJobsStop?: (() => void) | null };
      target.__e2eRuntimeJobsStop?.();
    })
    .catch(() => undefined);
};

/** One-line `jobId:kind:status` summary for phase logs and failure dumps. */
export const describeRuntimeJobs = (jobs: RuntimeJobSnapshot[]): string =>
  jobs.length === 0
    ? "(no jobs)"
    : jobs
        .map((j) => `${j.jobId}:${j.kind || "?"}:${j.rawStatus}${j.error ? `(${j.error.slice(0, 120)})` : ""}`)
        .join(", ");

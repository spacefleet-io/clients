/**
 * UX-JOBS-03: the one action each failed import offers, asked from the runtime (it knows what is still on this
 * computer: the processed copy, the original file), and running that action.
 *
 * Asked when the panel opens, whenever the set of failed jobs changes, and when the window comes back to the front
 * (the user may have freed disk space or moved the file back meanwhile). A refused retry carries the action that fits
 * now; it replaces the job's entry until the next ask, so "the file you picked is not the same video" stays visible.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FailedJobAvailability, RuntimeJobsRetryResult } from "@space/runtime-contracts/runtime/jobs";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "failed-job-actions" });

export type FailedJobActionsState = {
  byJobId: ReadonlyMap<string, FailedJobAvailability>;
  /** Bytes the kept processed copies of failed imports take on this computer. */
  keptBytesTotal: number;
  /** The job whose action is running, so its button shows busy. */
  busyJobId: string | null;
  /** Runs `upload_again`, `process_again` or `find_file` for the job; other actions have no runtime call. */
  run: (jobId: string) => Promise<void>;
};

export function useFailedJobActions(failedJobIds: readonly string[]): FailedJobActionsState {
  const [byJobId, setByJobId] = useState<ReadonlyMap<string, FailedJobAvailability>>(new Map());
  const [keptBytesTotal, setKeptBytesTotal] = useState(0);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [askCount, setAskCount] = useState(0);
  const idsKey = useMemo(() => [...failedJobIds].sort().join(","), [failedJobIds]);

  useEffect(() => {
    const onFocus = () => setAskCount((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    const api = window.sf?.runtimeJobs;
    const jobIds = idsKey ? idsKey.split(",") : [];
    if (jobIds.length === 0) {
      setByJobId(new Map());
      setKeptBytesTotal(0);
      return;
    }
    if (!api?.availability) {
      log.warn({ count: jobIds.length }, "failed-job-actions.availability-ipc-missing");
      return;
    }
    let cancelled = false;
    api
      .availability({ jobIds })
      .then((result) => {
        if (cancelled) return;
        log.info(
          {
            asked: jobIds.length,
            answered: result.jobs.map((j) => `${j.jobId}:${j.action}:${j.reason}`),
            keptBytesTotal: result.keptBytesTotal,
          },
          "failed-job-actions.availability",
        );
        setByJobId(new Map(result.jobs.map((j) => [j.jobId, j])));
        setKeptBytesTotal(result.keptBytesTotal);
      })
      .catch((err: unknown) => {
        log.warn({ err: err instanceof Error ? err.message : String(err), asked: jobIds.length }, "failed-job-actions.availability-failed");
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey, askCount]);

  const run = useCallback(
    async (jobId: string) => {
      const api = window.sf?.runtimeJobs;
      const entry = byJobId.get(jobId);
      if (!api || !entry) return;
      setBusyJobId(jobId);
      try {
        // `upgrade_plan` / `free_space` run their next action once the plan or the disk has room.
        const action = entry.action === "upgrade_plan" || entry.action === "free_space" ? entry.nextAction : entry.action;
        let result: RuntimeJobsRetryResult | { cancelled: true };
        if (action === "find_file") {
          if (!api.findFile) throw new Error("runtime_jobs_ipc_unavailable");
          result = await api.findFile({ jobId });
        } else if (action === "upload_again" || action === "process_again") {
          if (!api.retry) throw new Error("runtime_jobs_ipc_unavailable");
          result = await api.retry({ jobId, mode: action === "upload_again" ? "upload" : "process" });
        } else {
          log.info({ jobId, action: entry.action, nextAction: entry.nextAction }, "failed-job-actions.nothing-to-run");
          return;
        }
        log.info({ jobId, action: entry.action, reason: entry.reason, result }, "failed-job-actions.run");
        if ("cancelled" in result || result.retried) return;
        if (!result.action || !result.reason) return;
        const refused = { action: result.action, reason: result.reason };
        setByJobId((prev) => new Map(prev).set(jobId, { ...entry, ...refused }));
      } catch (err) {
        log.warn({ jobId, action: entry.action, err: err instanceof Error ? err.message : String(err) }, "failed-job-actions.run-failed");
      } finally {
        setBusyJobId(null);
      }
    },
    [byJobId],
  );

  return { byJobId, keptBytesTotal, busyJobId, run };
}

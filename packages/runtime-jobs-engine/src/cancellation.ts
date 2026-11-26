/**
 * Pure orchestration of the downstream-only cancel cascade described in plan §4.
 *
 * Strictly downstream BFS: cancelling `format.360p` cancels nothing else;
 * cancelling `source` cascades to every job that lists `source.jobId` in its
 * `parentJobIds`. Sibling formats are independent (both depend on source,
 * neither on each other) so cancelling one does not touch the other.
 *
 * All I/O lives behind the `CancelDeps` seam — this module is unit-testable
 * with stubs and never imports a SQLite driver, runtime store, or contract.
 */

import {
  isTerminalIngestJobStatus,
  type IngestJobRecord,
  type IngestJobStatus,
} from "@space/runtime-jobs";

export type CancelDeps = {
  /** Load a single job; null if it does not exist. */
  loadJob(jobId: string): IngestJobRecord | null;
  /** Find all jobs that have `jobId` in their `parentJobIds` array. */
  findChildren(jobId: string): IngestJobRecord[];
  /**
   * Compare-and-swap the status. Returns true when the write happened
   * (job was in `fromStatuses`); false otherwise (terminal, or another writer
   * beat us to the punch). This is the race-resolution seam from plan §4.
   */
  setStatusCAS(
    jobId: string,
    fromStatuses: IngestJobStatus[],
    toStatus: IngestJobStatus,
    reason?: string
  ): boolean;
  /** Signal the in-flight runner's AbortController, if registered. */
  abortRunner(jobId: string): void;
};

export type CancelCascadeResult = {
  /** Job ids that were transitioned to `cancelled` by this call. */
  cancelledIds: string[];
  /** Job ids encountered that were already terminal and so skipped. */
  alreadyTerminal: string[];
};

const NON_TERMINAL_STATUSES: IngestJobStatus[] = [
  "queued",
  "running",
  "interrupted",
];

/**
 * BFS from `rootJobId` along `parentJobIds` edges (child = job that depends
 * on this job). For each reached node:
 *  - if terminal → record and skip (no children traversal).
 *  - else CAS to cancelled, abort runner if registered.
 *  - if CAS succeeded → enqueue children.
 *  - if CAS failed (a concurrent writer beat us) → do NOT propagate cascade
 *    past that node; another path is responsible for that subtree.
 */
export function cancelJobCascade(
  rootJobId: string,
  reason: string,
  deps: CancelDeps
): CancelCascadeResult {
  const cancelledIds: string[] = [];
  const alreadyTerminal: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [rootJobId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const job = deps.loadJob(id);
    if (!job) continue;

    if (isTerminalIngestJobStatus(job.status)) {
      alreadyTerminal.push(id);
      continue;
    }

    const wrote = deps.setStatusCAS(id, NON_TERMINAL_STATUSES, "cancelled", reason);
    if (!wrote) {
      // Another writer reached terminal first (success or independent cancel).
      // Do not cascade through this node — its successors are owned by whoever
      // produced the terminal write.
      continue;
    }
    deps.abortRunner(id);
    cancelledIds.push(id);

    for (const child of deps.findChildren(id)) {
      if (!visited.has(child.jobId)) queue.push(child.jobId);
    }
  }

  return { cancelledIds, alreadyTerminal };
}

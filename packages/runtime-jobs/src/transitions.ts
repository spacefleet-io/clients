import type {
  IngestJobRecord,
  IngestJobStatus,
  IngestJobStepRecord,
  RuntimeJobStatus,
} from "./models";

export const isTerminalRuntimeJobStatus = (status: RuntimeJobStatus) =>
  status === "succeeded" || status === "failed" || status === "cancelled";

// ---------------------------------------------------------------------------
// Ingest aggregation — pure, side-effect-free reducers.
//
// The same algorithm is applied at two levels:
//   - aggregateJobStatusFromSteps: roll N steps up to one job's status.
//   - aggregateGroupStatusFromJobs: roll N jobs up to one group's status.
//
// Precedence (top wins):
//   1. any element running          → running
//   2. all succeeded                → succeeded
//   3. any failed (no running)      → failed
//   4. all cancelled, or any cancelled with no running and no failed
//                                   → cancelled
//   5. any interrupted (no running) → interrupted
//   6. otherwise                    → queued
// ---------------------------------------------------------------------------

const aggregate = (statuses: readonly IngestJobStatus[]): IngestJobStatus => {
  if (statuses.length === 0) return "queued";

  let anyRunning = false;
  let anyFailed = false;
  let anyCancelled = false;
  let anyInterrupted = false;
  let allSucceeded = true;
  let allCancelled = true;

  for (const status of statuses) {
    if (status !== "succeeded") allSucceeded = false;
    if (status !== "cancelled") allCancelled = false;
    if (status === "running") anyRunning = true;
    else if (status === "failed") anyFailed = true;
    else if (status === "cancelled") anyCancelled = true;
    else if (status === "interrupted") anyInterrupted = true;
  }

  if (anyRunning) return "running";
  if (allSucceeded) return "succeeded";
  if (anyFailed) return "failed";
  if (allCancelled) return "cancelled";
  if (anyCancelled) return "cancelled";
  if (anyInterrupted) return "interrupted";
  return "queued";
};

export const aggregateJobStatusFromSteps = (
  steps: readonly IngestJobStepRecord[],
): IngestJobStatus => aggregate(steps.map((step) => step.status));

export const aggregateGroupStatusFromJobs = (
  jobs: readonly IngestJobRecord[],
): IngestJobStatus => aggregate(jobs.map((job) => job.status));

// ---------------------------------------------------------------------------
// Cancel-vs-success terminal CAS resolver (plan section 4).
//
// Both the runner ("succeeded"/"failed") and the cancel handler ("cancelled")
// race to write a terminal status. This pure function decides which terminal
// wins given the current observed state. Callers wrap it in their store's
// CAS update.
//
// Rules:
//   - If currentStatus is already terminal, it sticks (idempotent).
//   - If outputs are durable (uploaded, committable), success wins even when
//     a cancel is pending — losing durable work is worse than honoring cancel.
//   - Otherwise: if a cancel was requested, cancel wins; else the runner's
//     requested terminal applies.
// ---------------------------------------------------------------------------

export const resolveTerminalCAS = (
  currentStatus: IngestJobStatus,
  requestedStatus: IngestJobStatus,
  cancelRequested: boolean,
  outputsDurable: boolean,
): IngestJobStatus => {
  // Idempotent: already-terminal records do not transition again.
  if (
    currentStatus === "succeeded" ||
    currentStatus === "failed" ||
    currentStatus === "cancelled"
  ) {
    return currentStatus;
  }

  // Durable outputs trump a pending cancel: never throw away committed work.
  if (requestedStatus === "succeeded" && outputsDurable) {
    return "succeeded";
  }

  // Cancel wins over a pending non-durable runner completion.
  if (cancelRequested && requestedStatus !== "cancelled") {
    return "cancelled";
  }

  return requestedStatus;
};

import { isRuntimeJobReadyToRunAt } from "./retry";
import { isTerminalRuntimeJobStatus } from "./transitions";
import type {
  RuntimeJobHostCapacity,
  RuntimeJobLane,
  RuntimeJobResourceClaim,
  RuntimeJobSchedulingMetadata,
  RuntimeJobSchedulerPolicy,
  RuntimeJobSchedulingCandidate,
} from "./models";

export const DEFAULT_RUNTIME_JOB_SCHEDULING_POLICY: RuntimeJobSchedulerPolicy = {
  maxConcurrentJobs: 4,
  laneConcurrency: {
    interactive: 2,
    background: 1,
    cpu: 1,
    io: 2,
    network: 2,
  },
  resourceLimits: {
    cpuHeavy: 1,
    diskHeavy: 2,
    networkHeavy: 2,
    memoryHeavy: 1,
  },
  lanePriority: ["interactive", "cpu", "io", "network", "background"],
};

const clonePolicy = (policy: RuntimeJobSchedulerPolicy): RuntimeJobSchedulerPolicy => ({
  ...policy,
  laneConcurrency: { ...policy.laneConcurrency },
  resourceLimits: { ...policy.resourceLimits },
  lanePriority: [...policy.lanePriority],
});

const coercePositiveInteger = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return Math.trunc(value);
};

const coercePositiveNumber = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return value;
};

export const buildDefaultRuntimeJobSchedulingPolicy = (
  hostCapacity: RuntimeJobHostCapacity = {}
): RuntimeJobSchedulerPolicy => {
  const policy = clonePolicy(DEFAULT_RUNTIME_JOB_SCHEDULING_POLICY);
  const logicalCpuCount = coercePositiveInteger(hostCapacity.logicalCpuCount);
  const totalMemoryGiB = coercePositiveNumber(hostCapacity.totalMemoryGiB);

  const lowCapacity =
    (logicalCpuCount != null && logicalCpuCount <= 2) ||
    (totalMemoryGiB != null && totalMemoryGiB < 6);
  const mediumCapacity =
    !lowCapacity &&
    ((logicalCpuCount != null && logicalCpuCount <= 4) ||
      (totalMemoryGiB != null && totalMemoryGiB < 8));

  if (lowCapacity) {
    policy.maxConcurrentJobs = 2;
    policy.laneConcurrency.interactive = 1;
    policy.laneConcurrency.cpu = 1;
    policy.laneConcurrency.io = 1;
    policy.laneConcurrency.network = 1;
    policy.resourceLimits.cpuHeavy = 1;
    policy.resourceLimits.diskHeavy = 1;
    policy.resourceLimits.networkHeavy = 1;
    policy.resourceLimits.memoryHeavy = 1;
    return policy;
  }

  if (mediumCapacity) {
    policy.maxConcurrentJobs = 3;
    policy.laneConcurrency.interactive = 1;
    policy.laneConcurrency.cpu = 1;
    policy.laneConcurrency.io = 1;
    policy.laneConcurrency.network = 1;
    policy.resourceLimits.cpuHeavy = 1;
    policy.resourceLimits.diskHeavy = 1;
    policy.resourceLimits.networkHeavy = 1;
    policy.resourceLimits.memoryHeavy = 1;
    return policy;
  }

  if ((logicalCpuCount != null && logicalCpuCount > 8) && (totalMemoryGiB == null || totalMemoryGiB >= 16)) {
    policy.laneConcurrency.cpu = 3;
    policy.resourceLimits.cpuHeavy = 3;
    return policy;
  }

  if ((logicalCpuCount != null && logicalCpuCount > 4) && (totalMemoryGiB == null || totalMemoryGiB >= 8)) {
    policy.laneConcurrency.cpu = 2;
    policy.resourceLimits.cpuHeavy = 2;
    return policy;
  }

  return policy;
};

const DEFAULT_RESOURCE_CLAIMS_BY_LANE: Record<RuntimeJobLane, RuntimeJobResourceClaim[]> = {
  interactive: [],
  background: [],
  cpu: ["cpuHeavy"],
  io: ["diskHeavy"],
  network: ["networkHeavy"],
};

const compareNullableNumbers = (left: number | null | undefined, right: number | null | undefined) => {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return left - right;
};

const compareSchedulingMetadata = (
  left: RuntimeJobSchedulingMetadata | undefined,
  right: RuntimeJobSchedulingMetadata | undefined
) => {
  const leftCollection = left?.collectionKey?.trim() || null;
  const rightCollection = right?.collectionKey?.trim() || null;
  if (leftCollection && rightCollection && leftCollection === rightCollection) {
    const phaseDelta = compareNullableNumbers(left?.phaseOrder, right?.phaseOrder);
    if (phaseDelta !== 0) return phaseDelta;
    const mediaDelta = compareNullableNumbers(left?.mediaOrder, right?.mediaOrder);
    if (mediaDelta !== 0) return mediaDelta;
    const submittedDelta = compareNullableNumbers(left?.submittedOrder, right?.submittedOrder);
    if (submittedDelta !== 0) return submittedDelta;
    const variantDelta = compareNullableNumbers(left?.variantOrder, right?.variantOrder);
    if (variantDelta !== 0) return variantDelta;
    return 0;
  }

  const submittedDelta = compareNullableNumbers(left?.submittedOrder, right?.submittedOrder);
  if (submittedDelta !== 0) return submittedDelta;
  const variantDelta = compareNullableNumbers(left?.variantOrder, right?.variantOrder);
  if (variantDelta !== 0) return variantDelta;
  return 0;
};

const sortJobsForScheduling = (policy: RuntimeJobSchedulerPolicy, jobs: RuntimeJobSchedulingCandidate[]) =>
  [...jobs].sort((left, right) => {
    const laneDelta = policy.lanePriority.indexOf(left.lane) - policy.lanePriority.indexOf(right.lane);
    if (laneDelta !== 0) return laneDelta;
    const schedulingDelta = compareSchedulingMetadata(left.scheduling, right.scheduling);
    if (schedulingDelta !== 0) return schedulingDelta;
    if (left.priority !== right.priority) return right.priority - left.priority;
    const createdDelta = left.createdAt.localeCompare(right.createdAt);
    if (createdDelta !== 0) return createdDelta;
    return left.jobId.localeCompare(right.jobId);
  });

export const inferRuntimeJobResourceClaims = (
  job: Pick<RuntimeJobSchedulingCandidate, "lane" | "resourceClaims">
): RuntimeJobResourceClaim[] => {
  if (Array.isArray(job.resourceClaims) && job.resourceClaims.length > 0) {
    return [...new Set(job.resourceClaims)];
  }
  return DEFAULT_RESOURCE_CLAIMS_BY_LANE[job.lane];
};

export const selectRunnableRuntimeJobs = ({
  jobs,
  policy = DEFAULT_RUNTIME_JOB_SCHEDULING_POLICY,
  nowIso = new Date().toISOString(),
}: {
  jobs: RuntimeJobSchedulingCandidate[];
  policy?: RuntimeJobSchedulerPolicy;
  nowIso?: string;
}): RuntimeJobSchedulingCandidate[] => {
  const activeJobs = jobs.filter((job) => job.status === "running");
  const queuedJobs = sortJobsForScheduling(
    policy,
    jobs.filter((job) => isRuntimeJobReadyToRunAt(job, nowIso) && !isTerminalRuntimeJobStatus(job.status))
  );

  const laneUsage = new Map<RuntimeJobLane, number>();
  const claimUsage = new Map<RuntimeJobResourceClaim, number>();
  for (const job of activeJobs) {
    laneUsage.set(job.lane, (laneUsage.get(job.lane) ?? 0) + 1);
    for (const claim of inferRuntimeJobResourceClaims(job)) {
      claimUsage.set(claim, (claimUsage.get(claim) ?? 0) + 1);
    }
  }

  const selected: RuntimeJobSchedulingCandidate[] = [];
  let activeCount = activeJobs.length;
  for (const job of queuedJobs) {
    if (activeCount >= policy.maxConcurrentJobs) break;
    if ((laneUsage.get(job.lane) ?? 0) >= policy.laneConcurrency[job.lane]) continue;
    const claims = inferRuntimeJobResourceClaims(job);
    const overLimit = claims.some((claim) => (claimUsage.get(claim) ?? 0) >= policy.resourceLimits[claim]);
    if (overLimit) continue;

    selected.push(job);
    activeCount += 1;
    laneUsage.set(job.lane, (laneUsage.get(job.lane) ?? 0) + 1);
    for (const claim of claims) {
      claimUsage.set(claim, (claimUsage.get(claim) ?? 0) + 1);
    }
  }

  return selected;
};

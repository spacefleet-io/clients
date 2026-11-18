import {
  buildDefaultRuntimeJobSchedulingPolicy,
  type RuntimeJobHostCapacity,
  selectRunnableRuntimeJobs,
  type RuntimeJobSchedulerPolicy,
  type RuntimeJobSchedulingCandidate,
} from "@space/runtime-jobs";
import { getEffectiveCpuCount } from "@space/ffmpeg/hostCpu";
import { totalmem } from "node:os";

export const getDefaultRuntimeSchedulerPolicy = (
  hostCapacity: RuntimeJobHostCapacity = {}
): RuntimeJobSchedulerPolicy => ({
  ...buildDefaultRuntimeJobSchedulingPolicy(hostCapacity),
});

export const getHostRuntimeSchedulerPolicy = (): RuntimeJobSchedulerPolicy =>
  getDefaultRuntimeSchedulerPolicy({
    logicalCpuCount: getEffectiveCpuCount().count,
    totalMemoryGiB: totalmem() / 1024 / 1024 / 1024,
  });

export const listNextRunnableRuntimeJobs = ({
  jobs,
  policy = getDefaultRuntimeSchedulerPolicy(),
  nowIso,
}: {
  jobs: RuntimeJobSchedulingCandidate[];
  policy?: RuntimeJobSchedulerPolicy;
  nowIso?: string;
}) => selectRunnableRuntimeJobs({ jobs, policy, nowIso });

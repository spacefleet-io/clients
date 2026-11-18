import { buildRuntimeJobEventPayload, type RuntimeJobRecord } from "@space/runtime-jobs";
import type { AppId } from "../../types";

export type RuntimeJobsEventPublisher = (args: {
  app: AppId;
  channel: string;
  event: string;
  payload: Record<string, unknown>;
}) => void;

export const publishRuntimeJobsUpdate = (
  publish: RuntimeJobsEventPublisher,
  args: {
    app: AppId;
    requestId?: string;
    sourceChannel: string;
    sourceEvent: string;
    jobs: RuntimeJobRecord[];
  }
) => {
  if (args.jobs.length === 0) return;
  const payload = {
    ...(args.requestId ? { requestId: args.requestId } : {}),
    sourceChannel: args.sourceChannel,
    sourceEvent: args.sourceEvent,
    jobs: args.jobs.map((job) => buildRuntimeJobEventPayload(job)),
  };
  publish({ app: args.app, channel: "runtime.jobs", event: "runtime.jobs.updated", payload });
};

export const publishAndDriveRuntimeJobsUpdate = (
  publish: RuntimeJobsEventPublisher,
  kick: () => void | Promise<unknown>,
  args: {
    app: AppId;
    requestId?: string;
    sourceChannel: string;
    sourceEvent: string;
    jobs: RuntimeJobRecord[];
  }
) => {
  if (args.jobs.length === 0) return false;
  publishRuntimeJobsUpdate(publish, args);
  void kick();
  return true;
};

export const publishRuntimeJobLifecycle = (
  publish: RuntimeJobsEventPublisher,
  args: {
    app: AppId;
    sourceChannel: string;
    sourceEvent: string;
    job: RuntimeJobRecord;
  }
) => {
  const payload = {
    sourceChannel: args.sourceChannel,
    sourceEvent: args.sourceEvent,
    jobs: [buildRuntimeJobEventPayload(args.job)],
  };
  const runtimeEvent =
    args.job.status === "succeeded"
      ? "runtime.jobs.completed"
      : args.job.status === "failed"
        ? "runtime.jobs.failed"
        : args.job.status === "cancelled"
          ? "runtime.jobs.cancelled"
        : args.job.progress.mode === "fraction"
            ? "runtime.jobs.progress"
            : "runtime.jobs.updated";
  publish({ app: args.app, channel: "runtime.jobs", event: runtimeEvent, payload });
};

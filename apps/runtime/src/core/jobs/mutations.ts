import type { ParsedRuntimeJobId, RuntimeJobRecord } from "@space/runtime-jobs";
import type { AppId, RuntimeCommandRequest } from "../../types";

export type RuntimeJobMutationAction = "cancel" | "retry";

export type PlannedRuntimeJobMutation = Pick<
  RuntimeCommandRequest,
  "requestId" | "module" | "command" | "payload"
>;

export const buildRuntimeJobMutationRequestId = (action: RuntimeJobMutationAction, rawId: string) =>
  `runtime-jobs-${action}-${rawId}`;

const resolveBadgerRuntimeJobMutationUserId = (
  parsed: Extract<ParsedRuntimeJobId, { app: "badger" }>,
  current: RuntimeJobRecord | null
) => {
  if (typeof current?.payload.userId === "string") return current.payload.userId;
  if (parsed.ownerId && parsed.ownerId !== "active") return parsed.ownerId;
  return undefined;
};

export const buildBadgerRuntimeJobMutation = (
  action: RuntimeJobMutationAction,
  parsed: Extract<ParsedRuntimeJobId, { app: "badger" }>,
  current: RuntimeJobRecord | null
): PlannedRuntimeJobMutation => {
  const userId = resolveBadgerRuntimeJobMutationUserId(parsed, current);
  const mutationType = action === "cancel" ? "cancel_job" : "start_job";
  return {
    requestId: buildRuntimeJobMutationRequestId(action, parsed.rawId),
    module: "badger" satisfies AppId,
    command: "badger.ingest.apply",
    payload: {
      ...(userId ? { userId } : {}),
      actions: [{ type: mutationType, jobId: parsed.rawId }],
    },
  };
};

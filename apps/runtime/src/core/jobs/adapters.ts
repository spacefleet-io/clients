import type { RuntimeJobRecord } from "@space/runtime-jobs";
import { buildRuntimeJobEventPayload } from "@space/runtime-jobs";
import type { AppId, RuntimeCommandRequest, RuntimeCommandResponse } from "../../types";
import {
  readResponseResult,
} from "./normalizers";
import { syncBadgerRuntimeJobsFromCommandResult, syncBadgerRuntimeJobsFromEventPayload } from "./syncers";

export const syncRuntimeJobsFromModuleCommand = (
  request: RuntimeCommandRequest,
  response: RuntimeCommandResponse
): RuntimeJobRecord[] => {
  if (!response.ok) return [];
  const result = readResponseResult(response);
  if (!result) return [];

  if (request.module === "badger") return syncBadgerRuntimeJobsFromCommandResult(request.command, result);

  return [];
};

export const syncRuntimeJobsFromModuleEvent = (
  module: AppId,
  channel: string,
  event: string,
  payload: Record<string, unknown>
): RuntimeJobRecord[] => {
  if (module === "badger") return syncBadgerRuntimeJobsFromEventPayload(channel, event, payload);

  return [];
};

export const buildJobsMirrorPayload = (jobs: RuntimeJobRecord[]) =>
  jobs.length > 0
    ? {
        jobs: jobs.map((job) => buildRuntimeJobEventPayload(job)),
      }
    : null;

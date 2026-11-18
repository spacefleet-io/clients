import type { RuntimeCommandResponse } from "../../types";

export type BadgerJobLike = Record<string, unknown> & {
  id: string;
  filename: string;
  status: string;
};

export const readResponseResult = (response: RuntimeCommandResponse) =>
  response.ok ? (response.result as Record<string, unknown>) : null;

export const normalizeBadgerJobLike = (item: unknown): BadgerJobLike | null => {
  if (!item || typeof item !== "object") return null;
  const job = item as Record<string, unknown>;
  if (typeof job.id !== "string" || typeof job.filename !== "string" || typeof job.status !== "string") {
    return null;
  }
  return job as BadgerJobLike;
};

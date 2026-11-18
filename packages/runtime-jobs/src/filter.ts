import type { RuntimeJobFilter, RuntimeJobRecord } from "./models";
import { isTerminalRuntimeJobStatus } from "./transitions";

export const filterRuntimeJobs = (items: RuntimeJobRecord[], filter: RuntimeJobFilter = {}) => {
  let next = items;
  if (filter.app) next = next.filter((item) => item.app === filter.app);
  if (filter.status && filter.status.length > 0) {
    next = next.filter((item) => filter.status!.includes(item.status));
  } else if (filter.includeCompleted !== true) {
    next = next.filter((item) => !isTerminalRuntimeJobStatus(item.status));
  }
  if (filter.kind && filter.kind.length > 0) next = next.filter((item) => filter.kind!.includes(item.kind));
  next = [...next].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
  if (filter.limit && Number.isFinite(filter.limit) && filter.limit > 0) return next.slice(0, Math.floor(filter.limit));
  return next;
};

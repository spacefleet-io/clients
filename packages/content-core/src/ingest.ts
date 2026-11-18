import { resolveChunkingMode, type ResolveChunkingModeArgs } from "./chunking";
import type { ContentChunkingMode, ContentIngestPlan } from "./models";

export type PlannedContentIngest = {
  sourceId: string;
  ownerApp: ContentIngestPlan["ownerApp"];
  objectNamespace: string;
  chunkingMode: ContentChunkingMode;
  derivePreviews: boolean;
};

export const planContentIngest = (
  plan: ContentIngestPlan,
  options: Omit<ResolveChunkingModeArgs, "source" | "preferredMode"> = {}
): PlannedContentIngest => ({
  sourceId: plan.source.sourceId,
  ownerApp: plan.ownerApp,
  objectNamespace: plan.objectNamespace,
  chunkingMode: resolveChunkingMode({
    source: plan.source,
    preferredMode: plan.preferredChunkingMode,
    ...options,
  }),
  derivePreviews: plan.derivePreviews,
});

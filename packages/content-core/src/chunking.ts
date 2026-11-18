import type { ContentChunkingMode, ContentChunkingPreference, LocalContentSource } from "./models";

export const DEFAULT_PACKED_SMALL_FILE_THRESHOLD_BYTES = 32 * 1024 * 1024;

export type ResolveChunkingModeArgs = {
  source: Pick<LocalContentSource, "sizeBytes">;
  preferredMode?: ContentChunkingPreference;
  packedSmallFileThresholdBytes?: number;
};

export const resolveChunkingMode = ({
  source,
  preferredMode = "auto",
  packedSmallFileThresholdBytes = DEFAULT_PACKED_SMALL_FILE_THRESHOLD_BYTES,
}: ResolveChunkingModeArgs): ContentChunkingMode => {
  if (preferredMode === "chunked" || preferredMode === "packed_small_file") {
    return preferredMode;
  }
  return source.sizeBytes <= packedSmallFileThresholdBytes ? "packed_small_file" : "chunked";
};

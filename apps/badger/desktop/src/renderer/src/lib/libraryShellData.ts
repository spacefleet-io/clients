type DatasetStatus = { core: boolean; metadata: boolean; playback: boolean };

type LibraryFormatTooNewDetail = {
  surface: "storage" | "op-stream" | "schema";
  observed: number;
  supported: number;
  group?: string;
};

export const buildLibraryShellValue = (input: {
  loading: boolean;
  coreReady: boolean;
  metadataReady: boolean;
  playbackReady: boolean;
  error: string | null;
  formatTooNew: LibraryFormatTooNewDetail | null;
  writeBlockedReason: string | null;
  mediaCount: number;
}) => ({
  loading: input.loading || !input.coreReady,
  error: input.error,
  formatTooNew: input.formatTooNew,
  writeBlockedReason: input.writeBlockedReason,
  datasetStatus: {
    core: input.coreReady,
    metadata: input.metadataReady,
    playback: input.playbackReady,
  } satisfies DatasetStatus,
  mediaCount: input.mediaCount,
});

export type LibrarySyncInput = {
  loading: boolean;
  hasError: boolean;
  datasetStatus: { core: boolean; metadata: boolean; playback: boolean };
  requirePlayback?: boolean;
};

export const shouldShowLibrarySyncBanner = (input: LibrarySyncInput) => {
  if (input.hasError) return false;
  if (input.loading) return true;
  return (
    input.datasetStatus.core === false ||
    (input.requirePlayback === true && input.datasetStatus.playback === false)
  );
};

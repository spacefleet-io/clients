import type { IngestJob, MediaDetails, MediaRow, PlaylistRow } from "@/lib/libraryDb";

export type LibraryDatasetStatus = {
  core: boolean;
  metadata: boolean;
  playback: boolean;
};

export const EMPTY_LIBRARY_DATASET_STATUS: LibraryDatasetStatus = {
  core: false,
  metadata: false,
  playback: false,
};

type ResetLibraryStateOptions = {
  closeDb?: () => void;
  clearDatasetSubscription?: () => void;
  syncMediaKey: (key: string | null) => void;
  updateMedia: (next: MediaRow[]) => void;
  updatePlaylists: (next: PlaylistRow[]) => void;
  setPlaylistItemsMap: (next: Record<string, string[]>) => void;
  setMediaDetailsMap: (next: Record<string, MediaDetails>) => void;
  setIngestJobs: (next: IngestJob[]) => void;
  setSettingsMap: (next: Record<string, { value: string; updatedAt: string }>) => void;
  setDatasetStatus: (next: LibraryDatasetStatus) => void;
  setError?: (next: string | null) => void;
  error?: string | null;
  setLoading?: (next: boolean) => void;
  loading?: boolean;
};

export const resetLibraryState = ({
  closeDb,
  clearDatasetSubscription,
  syncMediaKey,
  updateMedia,
  updatePlaylists,
  setPlaylistItemsMap,
  setMediaDetailsMap,
  setIngestJobs,
  setSettingsMap,
  setDatasetStatus,
  setError,
  error,
  setLoading,
  loading,
}: ResetLibraryStateOptions) => {
  closeDb?.();
  clearDatasetSubscription?.();
  syncMediaKey(null);
  updateMedia([]);
  updatePlaylists([]);
  setPlaylistItemsMap({});
  setMediaDetailsMap({});
  setIngestJobs([]);
  setSettingsMap({});
  setDatasetStatus(EMPTY_LIBRARY_DATASET_STATUS);
  if (setError) {
    setError(error ?? null);
  }
  if (setLoading !== undefined && loading !== undefined) {
    setLoading(loading);
  }
};

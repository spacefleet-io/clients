import { describe, expect, it, vi } from "vitest";

import { EMPTY_LIBRARY_DATASET_STATUS, resetLibraryState } from "../src/renderer/src/lib/libraryStateReset";

// Dump-on-failure helper: dumps which mocks were called and with what args so
// a missed/extra reset callback is diagnosable offline. try/catch-guarded.
const dumpResetSnapshot = (
  label: string,
  ctx: Record<string, ReturnType<typeof vi.fn>>,
) => {
  try {
    console.error(`=== [library-state-reset:${label}] reset-callback snapshot ===`);
    for (const [name, spy] of Object.entries(ctx)) {
      console.error(`${name}: calls=${spy.mock.calls.length} args=${JSON.stringify(spy.mock.calls)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("library state reset", () => {
  it("clears loaded library state and applies optional error/loading overrides", () => {
    const closeDb = vi.fn();
    const clearDatasetSubscription = vi.fn();
    const syncMediaKey = vi.fn();
    const updateMedia = vi.fn();
    const updatePlaylists = vi.fn();
    const setPlaylistItemsMap = vi.fn();
    const setMediaDetailsMap = vi.fn();
    const setIngestJobs = vi.fn();
    const setSettingsMap = vi.fn();
    const setDatasetStatus = vi.fn();
    const setError = vi.fn();
    const setLoading = vi.fn();

    console.info("[library-state-reset:setup] resetLibraryState with full callback set + error/loading overrides");
    resetLibraryState({
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
      error: "Missing encryption key. Please set it again.",
      setLoading,
      loading: false,
    });

    console.info(
      `[library-state-reset:assert] closeDb=${closeDb.mock.calls.length} setError=${setError.mock.calls.length} setLoading=${setLoading.mock.calls.length}`,
    );
    if (
      closeDb.mock.calls.length !== 1 ||
      clearDatasetSubscription.mock.calls.length !== 1 ||
      setError.mock.calls.length !== 1 ||
      setLoading.mock.calls.length !== 1
    ) {
      dumpResetSnapshot("full-reset-mismatch", {
        closeDb, clearDatasetSubscription, syncMediaKey, updateMedia, updatePlaylists,
        setPlaylistItemsMap, setMediaDetailsMap, setIngestJobs,
        setSettingsMap, setDatasetStatus, setError, setLoading,
      });
    }

    expect(closeDb).toHaveBeenCalledOnce();
    expect(clearDatasetSubscription).toHaveBeenCalledOnce();
    expect(syncMediaKey).toHaveBeenCalledWith(null);
    expect(updateMedia).toHaveBeenCalledWith([]);
    expect(updatePlaylists).toHaveBeenCalledWith([]);
    expect(setPlaylistItemsMap).toHaveBeenCalledWith({});
    expect(setMediaDetailsMap).toHaveBeenCalledWith({});
    expect(setIngestJobs).toHaveBeenCalledWith([]);
    expect(setSettingsMap).toHaveBeenCalledWith({});
    expect(setDatasetStatus).toHaveBeenCalledWith(EMPTY_LIBRARY_DATASET_STATUS);
    expect(setError).toHaveBeenCalledWith("Missing encryption key. Please set it again.");
    expect(setLoading).toHaveBeenCalledWith(false);
  });

  it("does not require db/error/loading callbacks for local cache resets", () => {
    const syncMediaKey = vi.fn();
    const updateMedia = vi.fn();
    const updatePlaylists = vi.fn();
    const setPlaylistItemsMap = vi.fn();
    const setMediaDetailsMap = vi.fn();
    const setIngestJobs = vi.fn();
    const setSettingsMap = vi.fn();
    const setDatasetStatus = vi.fn();

    console.info("[library-state-reset:setup] resetLibraryState with local-cache-only callback set");
    resetLibraryState({
      syncMediaKey,
      updateMedia,
      updatePlaylists,
      setPlaylistItemsMap,
      setMediaDetailsMap,
      setIngestJobs,
      setSettingsMap,
      setDatasetStatus,
    });

    console.info(
      `[library-state-reset:assert] syncMediaKey=${syncMediaKey.mock.calls.length} setDatasetStatus=${setDatasetStatus.mock.calls.length}`,
    );
    if (syncMediaKey.mock.calls.length === 0 || setDatasetStatus.mock.calls.length === 0) {
      dumpResetSnapshot("local-cache-reset-mismatch", {
        syncMediaKey, updateMedia, updatePlaylists, setPlaylistItemsMap, setMediaDetailsMap,
        setIngestJobs, setSettingsMap, setDatasetStatus,
      });
    }
    expect(syncMediaKey).toHaveBeenCalledWith(null);
    expect(setDatasetStatus).toHaveBeenCalledWith(EMPTY_LIBRARY_DATASET_STATUS);
  });
});

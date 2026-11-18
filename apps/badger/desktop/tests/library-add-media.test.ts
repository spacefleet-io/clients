import { describe, expect, it, vi } from "vitest";
import { addMediaFromCatalogWithSnapshotRefresh } from "../src/renderer/src/lib/libraryContext";

// Dump-on-failure: surface the returned id plus the captured mock call counts &
// args so a regression in the "return id even if refresh fails" contract is
// diagnosable without rerun. Wrapped in try/catch so a dump failure can never
// mask the real assertion.
const dumpAddMediaSnapshot = (
  label: string,
  ctx: {
    mediaId: unknown;
    addMediaFromCatalog: ReturnType<typeof vi.fn>;
    requestSnapshotRefresh: ReturnType<typeof vi.fn>;
    consoleError: ReturnType<typeof vi.spyOn>;
  },
) => {
  try {
    console.error(`=== [library-add-media:${label}] snapshot ===`);
    console.error(`returned mediaId=${JSON.stringify(ctx.mediaId)}`);
    console.error(
      `addMediaFromCatalog: calls=${ctx.addMediaFromCatalog.mock.calls.length} args=${JSON.stringify(ctx.addMediaFromCatalog.mock.calls, null, 2)}`,
    );
    console.error(
      `requestSnapshotRefresh: calls=${ctx.requestSnapshotRefresh.mock.calls.length} args=${JSON.stringify(ctx.requestSnapshotRefresh.mock.calls, null, 2)}`,
    );
    console.error(
      `console.error: calls=${ctx.consoleError.mock.calls.length} args=${JSON.stringify(ctx.consoleError.mock.calls, null, 2)}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("addMediaFromCatalogWithSnapshotRefresh", () => {
  it("[@bugfix][@regression-proof] returns the created media id even when snapshot refresh fails after the write", async () => {
    console.info(`[library-add-media:setup] addMediaFromCatalog resolves; requestSnapshotRefresh throws SNAPSHOT_REFRESH_FAILED`);
    const addMediaFromCatalog = vi.fn(async () => "lodgers-media");
    const requestSnapshotRefresh = vi.fn(async () => {
      throw new Error("SNAPSHOT_REFRESH_FAILED");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const mediaId = await addMediaFromCatalogWithSnapshotRefresh({
      db: { addMediaFromCatalog } as any,
      item: {
        id: 901668,
        type: "tv",
        title: "Lodgers",
        originalTitle: "Lodgers",
        originalLanguage: "en",
        overview: null,
        year: "1994",
        rating: 8.4,
        posterPath: null,
        backdropPath: null,
        genres: [],
        cast: [],
        trailers: [],
        seasons: [],
        episodes: [],
        totalEpisodes: 0,
      } as any,
      requestSnapshotRefresh,
    });

    console.info(
      `[library-add-media:assert] returned mediaId=${JSON.stringify(mediaId)} addMediaCalls=${addMediaFromCatalog.mock.calls.length} refreshCalls=${requestSnapshotRefresh.mock.calls.length} consoleErrorCalls=${consoleError.mock.calls.length}`,
    );
    try {
      expect(mediaId).toBe("lodgers-media");
      expect(addMediaFromCatalog).toHaveBeenCalledTimes(1);
      expect(requestSnapshotRefresh).toHaveBeenCalledTimes(1);
      // rendererLogger.error emits `[<service>]`, `<message>`, <payload>` — the
      // payload includes the structured fields plus `level`/`service`/`scope`.
      expect(consoleError).toHaveBeenCalledWith(
        "[badger-desktop-renderer]",
        "addMediaFromCatalog snapshot refresh failed",
        expect.objectContaining({
          mediaType: "tv",
          catalogId: 901668,
          message: "SNAPSHOT_REFRESH_FAILED",
          level: "error",
          scope: "library",
          service: "badger-desktop-renderer",
        })
      );
    } catch (err) {
      // Restore real console.error only on failure so the dump can print — NOT
      // before asserting, since mockRestore() clears the spy's recorded calls
      // that toHaveBeenCalledWith above depends on.
      consoleError.mockRestore();
      dumpAddMediaSnapshot("assert", { mediaId, addMediaFromCatalog, requestSnapshotRefresh, consoleError });
      throw err;
    }
  });
});

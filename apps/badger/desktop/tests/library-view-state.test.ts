import { describe, expect, it } from "vitest";

import {
  buildActiveJobsByMediaId,
  mergeLibraryGridItems,
} from "../src/renderer/src/pages/libraryViewState";

describe("library view state helpers", () => {
  it("aggregates active lab jobs per media id", () => {
    const grouped = buildActiveJobsByMediaId([
      {
        matchedMediaId: "media-1",
        progress: 20,
        status: "uploading",
        uploadSpeedMbps: 4,
        includeFallback: false,
        includeSource: true,
        includeAudio: true,
        includeSubtitles: true,
        includeChapters: true,
      },
      {
        matchedMediaId: "media-1",
        progress: 80,
        status: "transcoding",
        uploadSpeedMbps: 0,
        includeFallback: true,
        includeSource: false,
        includeAudio: false,
        includeSubtitles: false,
        includeChapters: false,
      },
    ] as any);

    expect(grouped.get("media-1")).toMatchObject({
      total: 2,
      progressSum: 100,
      hasBlocking: true,
      hasFallbackOnly: true,
      hasUploading: true,
      uploadSpeedSum: 4,
      uploadSpeedCount: 1,
    });
  });

  it("[@bugfix][@regression-proof] excludes cancelled jobs from active media processing state", () => {
    const grouped = buildActiveJobsByMediaId([
      {
        matchedMediaId: "media-1",
        progress: 20,
        status: "cancelled",
        includeFallback: false,
        includeSource: true,
        includeAudio: true,
        includeSubtitles: true,
        includeChapters: true,
      },
    ] as any);

    expect(grouped.has("media-1")).toBe(false);
  });

  it("[@bugfix][@regression-proof] prefers the real media row when queued ghost items share the same library identity", () => {
    const merged = mergeLibraryGridItems(
      [
        {
          id: "ghost-episode-1",
          title: "Lodgers",
          year: "1994",
          type: "tv" as const,
          progress: 0,
          statusLabel: "Queued",
          __ghost: true as const,
        },
        {
          id: "ghost-episode-2",
          title: "Lodgers",
          year: "1994",
          type: "tv" as const,
          progress: 0,
          statusLabel: "Queued",
          __ghost: true as const,
        },
      ],
      [
        {
          id: "media-lodgers",
          title: "Lodgers",
          year: "1994",
          type: "tv",
          addedAt: "2026-03-25T18:54:36.640Z",
        },
      ] as any
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "media-lodgers", title: "Lodgers" });
  });
});

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildFileIngestionVideoDecisionItems,
  countFileIngestionAutoIgnoredVideoOverlaps,
} from "../src/renderer/src/components/fileIngestionDecisions";

// On assertion failure, dump the computed decision items / overlap count so the
// mismatch is diagnosable offline. Wrapped in try/catch so a dump failure can't
// mask the original assertion.
const dumpFileIngestionSnapshot = (
  label: string,
  ctx: Record<string, unknown>,
): void => {
  try {
    console.error(`=== [file-ingestion-decisions:${label}] snapshot ===`);
    console.error(`state:\n${JSON.stringify(ctx, null, 2)}`);
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("fileIngestionDecisions", () => {
  it("builds decision items for grouped tv episodes with canonical slot labels", () => {
    const groups = [
      {
        id: "tv:60059",
        match: { id: 60059, type: "tv" as const, title: "Better Call Saul" },
        candidates: [{ parsed: { season: 1, episode: 1 }, size: 600 * 1024 * 1024 }],
        episodeGroups: [
          {
            id: "tv:60059:s1e1",
            season: 1,
            episode: 1,
            candidates: [{ parsed: { season: 1, episode: 1 }, size: 600 * 1024 * 1024 }],
            videoVariants: [
              { candidate: { parsed: { season: 1, episode: 1 }, size: 600 * 1024 * 1024 }, quality: "1080p", codec: "h264", hasChapters: false },
              { candidate: { parsed: { season: 1, episode: 1 }, size: 350 * 1024 * 1024 }, quality: "360p", codec: "h264", hasChapters: false },
            ],
          },
        ],
      },
    ];

    console.info(
      "[file-ingestion-decisions:tv-slot-labels] building decision items for grouped tv episodes (existing=1080p)",
    );
    const items = buildFileIngestionVideoDecisionItems({
      groups,
      hasExistingFiles: () => true,
      getExistingQualities: () => new Set(["1080p"]),
      selectVariants: (variants) => variants,
      movieLabel: "Movie",
    });
    console.info(
      `[file-ingestion-decisions:tv-slot-labels] produced ${items.length} item(s): ${JSON.stringify(items.map((i) => ({ id: (i as Record<string, unknown>).id, quality: (i as Record<string, unknown>).quality })))}`,
    );

    try {
      expect(items).toEqual([
        expect.objectContaining({
          id: "tv:60059:s1e1:360p",
          title: "Better Call Saul",
          slotLabel: "S1E01",
          quality: "360p",
          existingQualities: ["1080p"],
        }),
      ]);
    } catch (err) {
      dumpFileIngestionSnapshot("tv-slot-labels-fail", { items });
      throw err;
    }
  });

  it("does not create decision items for new episodes of an existing show", () => {
    const groups = [
      {
        id: "tv:60059",
        match: { id: 60059, type: "tv" as const, title: "Better Call Saul" },
        candidates: [{ parsed: { season: 1, episode: 3 }, size: 600 * 1024 * 1024 }],
        episodeGroups: [
          {
            id: "tv:60059:s1e3",
            season: 1,
            episode: 3,
            candidates: [{ parsed: { season: 1, episode: 3 }, size: 600 * 1024 * 1024 }],
            videoVariants: [
              { candidate: { parsed: { season: 1, episode: 3 }, size: 600 * 1024 * 1024 }, quality: "1080p", codec: "h264", hasChapters: false },
            ],
          },
        ],
      },
    ];

    const items = buildFileIngestionVideoDecisionItems({
      groups,
      hasExistingFiles: () => true,
      getExistingQualities: () => new Set<string>(),
      selectVariants: (variants) => variants,
      movieLabel: "Movie",
    });

    expect(items).toEqual([]);
  });

  it("creates decision items for existing episodes with different quality", () => {
    const groups = [
      {
        id: "tv:60059",
        match: { id: 60059, type: "tv" as const, title: "Better Call Saul" },
        candidates: [{ parsed: { season: 1, episode: 1 }, size: 350 * 1024 * 1024 }],
        episodeGroups: [
          {
            id: "tv:60059:s1e1",
            season: 1,
            episode: 1,
            candidates: [{ parsed: { season: 1, episode: 1 }, size: 350 * 1024 * 1024 }],
            videoVariants: [
              { candidate: { parsed: { season: 1, episode: 1 }, size: 350 * 1024 * 1024 }, quality: "720p", codec: "h264", hasChapters: false },
            ],
          },
        ],
      },
    ];

    const items = buildFileIngestionVideoDecisionItems({
      groups,
      hasExistingFiles: () => true,
      getExistingQualities: () => new Set(["1080p"]),
      selectVariants: (variants) => variants,
      movieLabel: "Movie",
    });

    expect(items).toEqual([
      expect.objectContaining({
        title: "Better Call Saul",
        slotLabel: "S1E01",
        quality: "720p",
        existingQualities: ["1080p"],
      }),
    ]);
  });

  it("counts auto-ignored overlaps only for already-existing qualities", () => {
    const groups = [
      {
        id: "movie:78",
        match: { id: 78, type: "movie" as const, title: "Blade Runner" },
        candidates: [{ parsed: {}, size: 700 * 1024 * 1024 }],
        videoVariants: [
          { candidate: { parsed: {}, size: 700 * 1024 * 1024 }, quality: "1080p", codec: "h264", hasChapters: false },
          { candidate: { parsed: {}, size: 300 * 1024 * 1024 }, quality: "360p", codec: "h264", hasChapters: false },
        ],
      },
    ];

    console.info(
      "[file-ingestion-decisions:overlap-count] counting auto-ignored overlaps (existing=360p)",
    );
    const count = countFileIngestionAutoIgnoredVideoOverlaps({
      groups,
      hasExistingFiles: () => true,
      getExistingQualities: () => new Set(["360p"]),
      selectVariants: (variants) => variants,
    });
    console.info(`[file-ingestion-decisions:overlap-count] count=${count}`);

    try {
      expect(count).toBe(1);
    } catch (err) {
      dumpFileIngestionSnapshot("overlap-count-fail", { count, expected: 1, groups });
      throw err;
    }
  });

  it("counts zero overlaps for new episodes of an existing show", () => {
    const groups = [
      {
        id: "tv:60059",
        match: { id: 60059, type: "tv" as const, title: "Better Call Saul" },
        candidates: [{ parsed: { season: 1, episode: 3 }, size: 600 * 1024 * 1024 }],
        episodeGroups: [
          {
            id: "tv:60059:s1e3",
            season: 1,
            episode: 3,
            candidates: [{ parsed: { season: 1, episode: 3 }, size: 600 * 1024 * 1024 }],
            videoVariants: [
              { candidate: { parsed: { season: 1, episode: 3 }, size: 600 * 1024 * 1024 }, quality: "1080p", codec: "h264", hasChapters: false },
            ],
          },
        ],
      },
    ];

    const count = countFileIngestionAutoIgnoredVideoOverlaps({
      groups,
      hasExistingFiles: () => true,
      getExistingQualities: () => new Set<string>(),
      selectVariants: (variants) => variants,
    });

    expect(count).toBe(0);
  });
});

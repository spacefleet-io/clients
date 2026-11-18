import { describe, expect, it } from "vitest";

import {
  buildManualMatches,
  estimateLabJobOutputTotal,
  resolveLabJobEpisodeSelectionState,
} from "../src/renderer/src/components/labJobCardState";

// Dump arbitrary computed lab-job state on assertion failure. try/catch so a
// dump failure can't mask the real expect().
const dumpLabJobCardStateSnapshot = (label: string, payload: Record<string, unknown>) => {
  try {
    console.error(`=== [lab-job-card-state:${label}] snapshot ===`);
    for (const [k, v] of Object.entries(payload)) {
      console.error(`${k}:\n${JSON.stringify(v, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("lab job card state helpers", () => {
  it("limits manual matches to the first five case-insensitive results", () => {
    console.info("[lab-job-card-state:manual-matches] querying 'better call' against 6 items");
    const items = Array.from({ length: 6 }, (_, index) => ({
      id: `tv-${index}`,
      title: `Better Call Saul ${index}`,
      originalTitle: null,
    }));
    const matches = buildManualMatches("better call", [] as any, items as any);
    console.info(
      `[lab-job-card-state:manual-matches] matches.length=${matches.length} ids=${JSON.stringify(matches.map((m: any) => m?.id))}`,
    );
    if (matches.length !== 5 || matches[0]?.id !== "tv-0" || matches[4]?.id !== "tv-4") {
      dumpLabJobCardStateSnapshot("manual-matches", { items, matches });
    }
    expect(matches).toHaveLength(5);
    expect(matches[0]?.id).toBe("tv-0");
    expect(matches[4]?.id).toBe("tv-4");
  });

  it("resolves episode selection state from pending tv details when the media is not linked yet", () => {
    console.info("[lab-job-card-state:episode-selection] resolving from pendingDetails (unlinked tv)");
    const state = resolveLabJobEpisodeSelectionState({
      job: {
        matchedTo: { type: "tv" },
        videoMeta: { width: 1920, height: 1080, durationSec: 300, codec: "h264" },
        pendingDetails: {
          seasons: [{ id: "season-1", seasonNumber: 1, name: "Season 1" }],
          episodes: [{ id: "episode-1", seasonNumber: 1, episodeNumber: 1, name: "Uno" }],
        },
      } as any,
      media: [],
      getMediaDetails: () => null,
    });

    const expectedDetails = {
      seasons: [{ id: "season-1", seasonNumber: 1, name: "Season 1" }],
      episodes: [{ id: "episode-1", seasonNumber: 1, episodeNumber: 1, name: "Uno" }],
    };
    console.info(
      `[lab-job-card-state:episode-selection] needsEpisodeSelection=${state.needsEpisodeSelection}`,
    );
    if (
      JSON.stringify(state.detailsForEpisodes) !== JSON.stringify(expectedDetails) ||
      state.needsEpisodeSelection !== true
    ) {
      dumpLabJobCardStateSnapshot("episode-selection", { state });
    }
    expect(state.detailsForEpisodes).toEqual(expectedDetails);
    expect(state.needsEpisodeSelection).toBe(true);
  });

  it("estimates total output size from selected formats", () => {
    console.info("[lab-job-card-state:output-total] estimating for 2-format vs 1-format movie");
    const total = estimateLabJobOutputTotal(
      {
        sizeMb: 1000,
        selectedFormats: [
          { quality: "360p", codec: "h264" },
          { quality: "720p", codec: "h264" },
        ],
      } as any,
      "movie"
    );
    const single = estimateLabJobOutputTotal(
      { sizeMb: 1000, selectedFormats: [{ quality: "360p", codec: "h264" }] } as any,
      "movie"
    );
    console.info(`[lab-job-card-state:output-total] total(2fmt)=${total} total(1fmt)=${single}`);
    if (!(total > 0) || !(total > single)) {
      dumpLabJobCardStateSnapshot("output-total", { total, single });
    }
    expect(total).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(single);
  });
});

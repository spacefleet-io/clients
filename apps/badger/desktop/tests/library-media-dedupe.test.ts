import { describe, expect, it } from "vitest";

import { dedupeMediaByIdentity } from "../src/renderer/src/lib/libraryMediaDedupe";

// On assertion failure, dump the input rows + deduped output so a merge/identity
// regression is diagnosable from CI logs.
const dumpDedupeSnapshot = (label: string, input: unknown, output: unknown) => {
  try {
    console.error(`=== [library-media-dedupe:${label}] snapshot ===`);
    console.error(`input rows: ${JSON.stringify(input, null, 2)}`);
    console.error(`deduped output: ${JSON.stringify(output, null, 2)}`);
    console.error(`=== [library-media-dedupe:${label}] end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("library media dedupe", () => {
  it("keeps the best duplicate row while merging aggregate tv progress and episode counts", () => {
    console.info("[library-media-dedupe:tv-merge] deduping 2 tv rows with shared catalogId=100 (Better Call Saul)");
    const input = [
      {
        id: "a",
        type: "tv",
        catalogId: 100,
        title: "Better Call Saul",
        originalTitle: "Better Call Saul",
        year: 2015,
        hasFiles: false,
        progressPct: 20,
        addedAt: "2026-03-25T10:00:00.000Z",
        updatedAt: "2026-03-25T10:00:00.000Z",
        lastWatchedAt: "2026-03-25T10:05:00.000Z",
        totalEpisodes: 10,
        episodeCount: 1,
      },
      {
        id: "b",
        type: "tv",
        catalogId: 100,
        title: "Better Call Saul",
        originalTitle: "Better Call Saul",
        year: 2015,
        hasFiles: true,
        progressPct: 60,
        addedAt: "2026-03-25T09:00:00.000Z",
        updatedAt: "2026-03-25T11:00:00.000Z",
        lastWatchedAt: "2026-03-25T11:05:00.000Z",
        totalEpisodes: 13,
        episodeCount: 3,
      },
    ];
    const rows = dedupeMediaByIdentity(input as any);
    console.info(`[library-media-dedupe:tv-merge] deduped ${input.length} rows -> ${rows.length}; winner id=${rows[0]?.id} progressPct=${rows[0]?.progressPct}`);

    try {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "b",
        hasFiles: true,
        progressPct: 40,
        addedAt: "2026-03-25T09:00:00.000Z",
        updatedAt: "2026-03-25T11:00:00.000Z",
        lastWatchedAt: "2026-03-25T11:05:00.000Z",
        totalEpisodes: 13,
        episodeCount: 3,
      });
    } catch (err) {
      dumpDedupeSnapshot("tv-merge", input, rows);
      throw err;
    }
  });

  it("falls back to normalized local identity when catalog ids are missing", () => {
    console.info("[library-media-dedupe:local-identity] deduping 2 movie rows with null catalogId via normalized title (Arrival / ' arrival ')");
    const input = [
      {
        id: "a",
        type: "movie",
        catalogId: null,
        title: "Arrival",
        originalTitle: "Arrival",
        year: 2016,
        hasFiles: false,
        progressPct: 0,
        addedAt: "2026-03-25T08:00:00.000Z",
        updatedAt: "2026-03-25T08:00:00.000Z",
      },
      {
        id: "b",
        type: "movie",
        catalogId: null,
        title: " arrival ",
        originalTitle: "ARRIVAL",
        year: 2016,
        hasFiles: true,
        progressPct: 0,
        addedAt: "2026-03-25T07:00:00.000Z",
        updatedAt: "2026-03-25T09:00:00.000Z",
      },
    ];
    const rows = dedupeMediaByIdentity(input as any);
    console.info(`[library-media-dedupe:local-identity] deduped ${input.length} rows -> ${rows.length}; winner id=${rows[0]?.id} hasFiles=${rows[0]?.hasFiles}`);

    try {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "b",
        hasFiles: true,
        addedAt: "2026-03-25T07:00:00.000Z",
        updatedAt: "2026-03-25T09:00:00.000Z",
      });
    } catch (err) {
      dumpDedupeSnapshot("local-identity", input, rows);
      throw err;
    }
  });
});

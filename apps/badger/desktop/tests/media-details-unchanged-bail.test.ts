/**
 * @test-id MEDIA-DETAILS-UNCHANGED-BAIL-001
 * @bugfix
 * @regression-proof
 * @level unit
 * @why Issue #25 P1 residual (ultimate seed 1791529129542, case c017): every
 *      library snapshot arrives over IPC as a fresh structured clone, so
 *      `getMediaDetails` returns a new object on every push even when nothing
 *      changed. MediaDetailsDialog's cache effect then reassigned
 *      `selectedDetails` each time ("selectedDetails: reassigned", 174 per run
 *      before #147, still 29 after) and re-rendered the 3.5k-line dialog at
 *      1 Hz while visible. Fix: the dialog keeps the current details when the
 *      cached ones are structurally equal (`plainDataEqual`).
 * @covers apps/badger/desktop/src/renderer/src/lib/plainDataEqual.ts
 * @covers apps/badger/desktop/src/renderer/src/components/MediaDetailsDialog.tsx
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MediaDetails } from "@space/shared";
import { plainDataEqual } from "../src/renderer/src/lib/plainDataEqual";

const LOG = "[media-details-unchanged-bail]";

// Fixture: carries the nested shapes a snapshot holds (arrays of objects,
// nulls, booleans, numbers); MediaRow fields the comparison never singles out
// are omitted.
const details = (id: string, progressPct = 0): MediaDetails =>
  ({
    id,
    title: `Title ${id}`,
    progressPct,
    lastWatchedAt: null,
    updatedAt: "2026-10-09T07:09:42.991Z",
    cast: [{ id: `${id}-c1`, personId: "p1", tmdbId: null, name: "Actor", role: null, profilePath: null }],
    playlistIds: ["p1"],
    seasons: [],
    episodes: [],
    trailers: [],
    files: [{ id: `${id}-f1`, filename: "a.mkv", season: null, episode: null, desiredFormats: [{ quality: "1080p", codec: "h264", bitrateKbps: null }] }],
    formats: [],
    audioTracks: [{ id: `${id}-a1`, chunks: [{ key: "k", sizeBytes: null, startSeconds: 0 }] }],
    subtitleTracks: [],
    subtitles: [],
    chapters: [],
    skipMarkers: [],
    hasLocalFiles: true,
  }) as unknown as MediaDetails; // fixture: partial MediaRow, unread fields omitted

// The dialog's functional update, as wired in MediaDetailsDialog (pinned below).
const nextSelected = (prev: MediaDetails | null, cached: MediaDetails) =>
  prev && plainDataEqual(prev, cached) ? prev : cached;

describe("[@bugfix][@regression-proof] MediaDetailsDialog keeps selectedDetails when a snapshot carries unchanged details", () => {
  it("60 IPC-cloned no-op pushes cause 0 reassignments; a real change causes exactly 1", () => {
    let selected: MediaDetails | null = details("m1", 40);
    let reassigned = 0;
    for (let push = 0; push < 60; push++) {
      const next = nextSelected(selected, structuredClone(details("m1", 40)));
      if (next !== selected) reassigned += 1;
      selected = next;
    }
    const noOp = reassigned;
    const changed = nextSelected(selected, structuredClone(details("m1", 41)));
    if (changed !== selected) reassigned += 1;
    console.info(`${LOG} pushes=60 noOpReassigned=${noOp} afterChange=${reassigned} progress=${changed.progressPct}`);
    expect({ noOp, afterChange: reassigned, progress: changed.progressPct }).toEqual({ noOp: 0, afterChange: 1, progress: 41 });
  });

  it("plainDataEqual compares IPC-cloned plain data structurally", () => {
    const a = details("m1");
    const nested = structuredClone(a);
    nested.audioTracks[0].chunks[0].sizeBytes = 7;
    const cases = {
      clone: plainDataEqual(a, structuredClone(a)),
      keyOrder: plainDataEqual(a, Object.fromEntries(Object.entries(structuredClone(a)).reverse())),
      progress: plainDataEqual(a, details("m1", 5)),
      nestedChunk: plainDataEqual(a, nested),
      nullVsArray: plainDataEqual(a, { ...a, cast: null }),
      arrayVsObject: plainDataEqual({ list: [] }, { list: {} }),
      extraKey: plainDataEqual(a, { ...a, extra: 1 }),
      missingVsUndefined: plainDataEqual({ x: undefined }, { y: undefined }),
      nan: plainDataEqual({ n: Number.NaN }, { n: Number.NaN }),
    };
    console.info(`${LOG} equal-cases ${JSON.stringify(cases)}`);
    expect(cases).toEqual({
      clone: true,
      keyOrder: true,
      progress: false,
      nestedChunk: false,
      nullVsArray: false,
      arrayVsObject: false,
      extraKey: false,
      missingVsUndefined: false,
      nan: true,
    });
  });

  it("MediaDetailsDialog bails out of the cache refresh when the details are unchanged", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/renderer/src/components/MediaDetailsDialog.tsx", import.meta.url)),
      "utf8",
    );
    const idx = src.indexOf("const cached = getMediaDetails(selectedId);");
    const region = src.slice(idx, idx + 400);
    const checks = {
      found: idx > -1,
      importsHelper: src.includes('import { plainDataEqual } from "@/lib/plainDataEqual";'),
      guarded: /setSelectedDetails\(\(prev\) =>\s*\(?prev && plainDataEqual\(prev, cached\) \? prev : cached\)?\)/.test(region),
    };
    console.info(`${LOG} dialog-wiring checks=${JSON.stringify(checks)}`);
    if (!checks.guarded) console.error(`${LOG} dialog region:\n${region}`);
    expect(checks).toEqual({ found: true, importsHelper: true, guarded: true });
  });
});

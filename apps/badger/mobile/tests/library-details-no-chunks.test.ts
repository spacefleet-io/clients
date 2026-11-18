/**
 * @test-id MOBILE-LIBRARY-DETAILS-NO-CHUNKS-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why exists: opening the details sheet loaded every HLS segment row of every format and audio track (thousands of rows per
 * title) through `getMediaDetails`, although the screen never reads them. `library.details.timing` showed the
 * `playbackPayload` query alone at 658-1124 ms on a normal phone (budget for the whole open: 1000 ms). The details screen must
 * ask for `{ chunks: false }`; the player loads them separately, for the played file only (see `library-playback-chunks-scoped.test.ts`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mediaDetailsQueries } from "@space/library-db-definition/mediaDetails";

const src = (rel: string): string => readFileSync(resolve(__dirname, "../src", rel), "utf8");

describe("details screen skips per-segment rows", () => {
  it("@regression-proof the details screens (phone and TV) request details without chunks", () => {
    // Both details screens load through useMediaDetailsState; every details read there must skip the chunk rows.
    for (const screen of ["screens/MediaDetailsScreen.tsx", "tv/screens/TvMediaDetailsScreen.tsx"]) {
      expect(src(screen), `${screen} loads through useMediaDetailsState`).toContain("useMediaDetailsState(");
    }
    const hook = src("lib/useMediaDetailsState.ts");
    const calls = hook.match(/getMediaDetails\([^)]*\)/g) ?? [];
    console.info("[library-details-no-chunks] details calls:", JSON.stringify(calls));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/getMediaDetails\(mediaId,\s*\{\s*chunks:\s*false\s*\}\)/);
  });

  it("the player loads details without chunks, then the chunks of the played file only", () => {
    const player = src("screens/player/usePlayerSession.ts");
    expect(player).toMatch(/getMediaDetails\(mediaId,\s*\{\s*chunks:\s*false\s*\}\)/);
    expect(player).toMatch(/getPlaybackChunks\(\s*formatsWithoutChunks\.map/);
    expect(src("lib/libraryDb.ts")).toMatch(/getPlaybackChunks = async \(formatIds: string\[\], audioTrackIds: string\[\]\)/);
  });

  it("libraryDb gates both chunk queries on the option", () => {
    expect(src("lib/libraryDb.ts")).toContain("options.chunks !== false");
    const without = mediaDetailsQueries("m1", { chunks: false }).map((query) => query.name);
    const withChunks = mediaDetailsQueries("m1").map((query) => query.name);
    console.info("[details-no-chunks] queries", JSON.stringify({ without, withChunks }));
    expect(without).not.toContain("formatChunks");
    expect(without).not.toContain("audioChunks");
    expect(withChunks).toEqual(expect.arrayContaining(["formatChunks", "audioChunks"]));
  });
});

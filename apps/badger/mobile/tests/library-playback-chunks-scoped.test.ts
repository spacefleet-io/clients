/**
 * @test-id MOBILE-LIBRARY-PLAYBACK-CHUNKS-SCOPED-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why exists: the player called `getMediaDetails(mediaId)`, which loads the segment rows of EVERY format and audio track of
 * the whole title (all episodes of a show), then filtered to the played file in JS. On the throttled phone the
 * `playbackPayload` read took 2.1 s for a 3-episode series, which is most of the 4.1 s next-episode time-to-first-frame
 * (budget 3000 ms). The chunk query must be keyed by the played file's format / track ids, never by media id.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = (rel: string): string => readFileSync(resolve(__dirname, "../src", rel), "utf8");

describe("player chunk loading is scoped to the played file", () => {
  const db = src("lib/libraryDb.ts");
  const body = db.slice(db.indexOf("getPlaybackChunks = async"), db.indexOf("getPlayableTrackIds = async"));

  it("@regression-proof getPlaybackChunks selects by format_id / track_id lists, not media_id", () => {
    console.info("[library-playback-chunks-scoped] query scope:", /WHERE \$\{idColumn\} IN/.exec(body)?.[0]);
    expect(body).toMatch(/WHERE \$\{idColumn\} IN \(\$\{ids\.map/);
    expect(body).toContain('packed("media_format_chunks", "format_id", formatIds)');
    expect(body).toContain('packed("media_audio_chunks", "track_id", audioTrackIds)');
    expect(body).not.toContain("media_id");
  });

  it("segment rows are packed natively (group_concat), not returned as one JS row per segment", () => {
    expect(body).toContain("group_concat(");
    expect(body).toMatch(/GROUP BY \$\{idColumn\}, order_index \/ \$\{PACK_PAGE\}/);
  });

  it("the player never asks for the whole title's chunks", () => {
    const player = src("screens/player/usePlayerSession.ts");
    expect(player).not.toMatch(/getMediaDetails\(mediaId\)/);
    expect(player).toContain("chunks: false");
  });
});

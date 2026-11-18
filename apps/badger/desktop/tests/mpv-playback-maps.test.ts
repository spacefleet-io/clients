import { describe, expect, it } from "vitest";
import { buildChunkMapFromFormat, buildHlsTrackFromChunkMap, orderPlaybackFormats } from "../src/renderer/src/lib/mpvPlaybackMaps";

// Dump the input + computed playback-map state on assertion failure.
// try/catch so a dump failure can't mask the real expect().
const dumpMpvPlaybackMapsSnapshot = (label: string, payload: Record<string, unknown>) => {
  try {
    console.error(`=== [mpv-playback-maps:${label}] snapshot ===`);
    for (const [k, v] of Object.entries(payload)) {
      console.error(`${k}:\n${JSON.stringify(v, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("mpvPlaybackMaps", () => {
  it("@bugfix @regression-proof orders playback qualities using the shared quality ladder", () => {
    console.info("[mpv-playback-maps:order] sorting [360p,1080p,720p] via orderPlaybackFormats");
    const sorted = ["360p", "1080p", "720p"].sort(orderPlaybackFormats);
    console.info(`[mpv-playback-maps:order] sorted=${JSON.stringify(sorted)}`);
    if (JSON.stringify(sorted) !== JSON.stringify(["1080p", "720p", "360p"])) {
      dumpMpvPlaybackMapsSnapshot("order", { sorted });
    }
    expect(sorted).toEqual(["1080p", "720p", "360p"]);
  });

  it("@bugfix @regression-proof builds chunk maps from playback formats without leaking null sizes", () => {
    console.info("[mpv-playback-maps:chunk-map] building chunk map with null init/total/chunk sizes");
    const chunkMap = buildChunkMapFromFormat({
      initKey: "init",
      initSize: null,
      durationSeconds: 20,
      totalSize: null,
      chunks: [
        { key: "c1", sizeBytes: null, startSeconds: 0 },
        { key: "c2", sizeBytes: 50, startSeconds: 10 },
      ],
    });
    const expected = {
      init: { key: "init", size: 0 },
      durationSeconds: 20,
      totalSize: null,
      chunks: [
        { key: "c1", size: 0, startSeconds: 0 },
        { key: "c2", size: 50, startSeconds: 10 },
      ],
    };
    if (JSON.stringify(chunkMap) !== JSON.stringify(expected)) {
      dumpMpvPlaybackMapsSnapshot("chunk-map", { chunkMap, expected });
    }
    expect(chunkMap).toEqual(expected);
  });

  it("@bugfix @regression-proof computes hls segment durations from chunk start times and total duration", () => {
    console.info("[mpv-playback-maps:hls-track] building HLS track from 3-chunk map, dur=25");
    const track = buildHlsTrackFromChunkMap(
      {
        init: { key: "init", size: 10 },
        durationSeconds: 25,
        totalSize: 100,
        chunks: [
          { key: "c1", size: 10, startSeconds: 0 },
          { key: "c2", size: 10, startSeconds: 8 },
          { key: "c3", size: 10, startSeconds: 17 },
        ],
      },
      "avc1"
    );

    const expected = {
      initKey: "init",
      codecString: "avc1",
      segments: [
        { key: "c1", durationSeconds: 8, startSeconds: 0 },
        { key: "c2", durationSeconds: 9, startSeconds: 8 },
        { key: "c3", durationSeconds: 8, startSeconds: 17 },
      ],
    };
    console.info(
      `[mpv-playback-maps:hls-track] segments=${JSON.stringify((track as any)?.segments)}`,
    );
    if (JSON.stringify(track) !== JSON.stringify(expected)) {
      dumpMpvPlaybackMapsSnapshot("hls-track", { track, expected });
    }
    expect(track).toEqual(expected);
  });
});

// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMpvPlaybackState, isPlaybackReloadReady } from "../src/renderer/src/lib/mpvPlaybackState";
import { hasPlayableAudioTrack } from "../src/renderer/src/lib/mpvPlaybackSelection";

// On assertion failure, dump the computed playback state so a fallback/effective
// format or signature regression is diagnosable from CI logs.
const dumpMpvStateSnapshot = (label: string, state: unknown) => {
  try {
    console.error(`=== [mpv-playback-state:${label}] snapshot ===`);
    console.error(`computed state: ${JSON.stringify(state, null, 2)}`);
    console.error(`=== [mpv-playback-state:${label}] end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("mpvPlaybackState", () => {
  it("derives fallback/effective format state and signatures deterministically", () => {
    console.info("[mpv-playback-state:format-derive] building state with 1080p+360p formats, playbackQuality=360p, qualityMode=auto");
    const state = buildMpvPlaybackState({
      formats: [
        {
          id: "fmt-1080",
          quality: "1080p",
          codec: "h264",
          codecString: "avc1",
          initKey: "init-1080",
          initSize: 12,
          durationSeconds: 120,
          totalSize: 1200,
          chunks: [
            { key: "v1", sizeBytes: 100, startSeconds: 0 },
            { key: "v2", sizeBytes: 110, startSeconds: 60 },
          ],
        },
        {
          id: "fmt-360",
          quality: "360p",
          codec: "h264",
          codecString: "avc1",
          initKey: "init-360",
          initSize: 8,
          durationSeconds: 120,
          totalSize: 600,
          chunks: [{ key: "v360-1", sizeBytes: 90, startSeconds: 0 }],
        },
      ],
      playbackQuality: "360p",
      selectedFormatId: "fmt-1080",
      qualityMode: "auto",
      audioOptions: [],
      selectedAudioId: null,
    });

    console.info(
      `[mpv-playback-state:format-derive] fallbackFormatId=${state.fallbackFormatId} selectedFormat=${state.selectedFormat?.id} autoFormat=${state.autoFormat?.id} effectiveFormat=${state.effectiveFormat?.id} effectiveFormatSignature=${state.effectiveFormatSignature}`,
    );
    try {
      expect(state.fallbackFormatId).toBe("fmt-360");
      expect(state.selectedFormat?.id).toBe("fmt-1080");
      expect(state.autoFormat?.id).toBe("fmt-360");
      expect(state.effectiveFormat?.id).toBe("fmt-360");
      expect(state.effectiveFormatMap?.init?.key).toBe("init-360");
      expect(state.effectiveFormatSignature).toContain("fmt-360");
    } catch (err) {
      dumpMpvStateSnapshot("format-derive", state);
      throw err;
    }
  });

  it("falls back to the first playable audio option when the selected one is not streamable", () => {
    console.info("[mpv-playback-state:audio-fallback] building state with broken selected audio (audio-bad, no chunks) + playable audio-good");
    const state = buildMpvPlaybackState({
      formats: [],
      playbackQuality: "1080p",
      selectedFormatId: null,
      qualityMode: "fixed",
      audioOptions: [
        {
          id: "audio-bad",
          language: "en",
          label: "Broken",
          initKey: null,
          chunks: [],
          codecString: "aac",
        },
        {
          id: "audio-good",
          language: "fr",
          label: "French",
          initKey: "audio-init",
          initSize: 5,
          durationSeconds: 120,
          totalSize: 200,
          chunks: [{ key: "a1", sizeBytes: 50, startSeconds: 0 }],
          codecString: "aac",
        },
      ],
      selectedAudioId: "audio-bad",
    });

    console.info(
      `[mpv-playback-state:audio-fallback] selectedAudio=${state.selectedAudio?.id} playableAudioOptions=${JSON.stringify(state.playableAudioOptions.map((option) => option.id))} audioMap.init.key=${state.audioMap?.init?.key} audioMapSignature=${state.audioMapSignature} initSignature=${state.initSignature}`,
    );
    try {
      expect(state.selectedAudio?.id).toBe("audio-bad");
      expect(state.playableAudioOptions.map((option) => option.id)).toEqual(["audio-good"]);
      expect(state.audioMap?.init?.key).toBe("audio-init");
      expect(state.audioMapSignature).toContain("audio-bad");
      expect(state.initSignature).toContain("audio-init");
    } catch (err) {
      dumpMpvStateSnapshot("audio-fallback", state);
      throw err;
    }
  });

  // @bugfix @regression-proof F3 (ultimate stress, issue #25): silent media
  // (zero audio tracks) must be reload-ready — the quality/audio reload effect
  // used to bail on `!audioMapRef.current`, so a quality switch on a silent
  // clip silently did nothing.
  it("@bugfix @regression-proof silent media (no audio tracks) is reload-ready once the video map exists", () => {
    console.info("[mpv-playback-state:silent-media] building state with one video format and zero audio options");
    const state = buildMpvPlaybackState({
      formats: [
        {
          id: "fmt-1080",
          quality: "1080p",
          codec: "h264",
          codecString: "avc1",
          initKey: "init-1080",
          initSize: 12,
          durationSeconds: 120,
          totalSize: 1200,
          chunks: [{ key: "v1", sizeBytes: 100, startSeconds: 0 }],
        },
      ],
      playbackQuality: "1080p",
      selectedFormatId: null,
      qualityMode: "auto",
      audioOptions: [],
      selectedAudioId: null,
    });
    // Silent media: the library has zero audio tracks.
    const hasPlayableAudio = hasPlayableAudioTrack([], null);
    const ready = isPlaybackReloadReady({
      effectiveFormatMap: state.effectiveFormatMap,
      audioMap: state.audioMap,
      hasPlayableAudio,
    });
    console.info(
      `[mpv-playback-state:silent-media] audioMap=${state.audioMap} hasPlayableAudio=${hasPlayableAudio} reloadReady=${ready}`,
    );
    try {
      expect(state.audioMap).toBeNull();
      expect(hasPlayableAudio).toBe(false);
      expect(ready).toBe(true);
      // Media with a streamable audio track (even before the engine resolved
      // its audio options) must still wait for the audio map.
      expect(
        hasPlayableAudioTrack(
          [{ id: "a1", initKey: "ai", chunks: [{ key: "c1" }], episodeId: null }] as never,
          null,
        ),
      ).toBe(true);
      // A track without chunks is not playable audio.
      expect(
        hasPlayableAudioTrack([{ id: "a2", initKey: "ai", chunks: [], episodeId: null }] as never, null),
      ).toBe(false);
      // Media WITH audio but no resolved audio map yet must still wait.
      expect(
        isPlaybackReloadReady({ effectiveFormatMap: state.effectiveFormatMap, audioMap: null, hasPlayableAudio: true }),
      ).toBe(false);
      // No video map: never ready.
      expect(isPlaybackReloadReady({ effectiveFormatMap: null, audioMap: null, hasPlayableAudio: false })).toBe(false);
    } catch (err) {
      dumpMpvStateSnapshot("silent-media", { state, ready });
      throw err;
    }
  });

  it("@bugfix @regression-proof the engine reload effect no longer hard-requires an audio map", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/renderer/src/lib/useMpvPlaybackEngine.ts"),
      "utf8",
    );
    try {
      expect(source).not.toMatch(/!audioMapRef\.current\s*\|\|/);
      expect(source).toContain("isPlaybackReloadReady(");
    } catch (err) {
      dumpMpvStateSnapshot("engine-source", { sourceLen: source.length });
      throw err;
    }
  });
});

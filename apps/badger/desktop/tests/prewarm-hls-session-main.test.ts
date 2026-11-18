import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * @bugfix @regression-proof
 *
 * Regression test for commit 0c601c79 — PlaybackServer.prewarmHlsSession
 * fetches the 4 expected keys (video init + video segment at
 * startSeconds, audio init + audio segment at startSeconds) so mpv's
 * first reads are microsecond cache hits rather than cold storage tunnel
 * fetches. Without prewarm, mpv's HLS demuxer treats slow first reads
 * as stream errors and seeks back to the playlist start — the audible
 * 3–10 s segment loop the user reported on Resume from a non-zero
 * position.
 *
 * This test exercises PlaybackServer.prewarmHlsSession directly:
 *  - Creates an HLS session with two video variants + one audio variant.
 *  - Mocks `downloadStorageObjectViaTunnelToSink` so we can assert
 *    exactly which keys are warmed.
 *  - Verifies the return shape includes `warmedKeys` (success) and
 *    `missedKeys` (per-object fetch failures don't fail the whole
 *    prewarm — the user-visible launch path stays bounded even when
 *    one of the 4 fetches fails).
 *  - Verifies `elapsedMs` is reported.
 *  - Verifies the segment is picked AT the startSeconds offset (not
 *    always segment 0).
 */

const downloadToSinkMock = vi.hoisted(() => vi.fn());

vi.mock("../src/main/api", () => ({
  downloadStorageObjectViaTunnelToSink: (...args: unknown[]) => downloadToSinkMock(...args),
}));

import { setActivePlaybackProfileId } from "../src/main/activePlaybackProfile";
import { PlaybackServer } from "../src/main/playbackServer";

// ---------------------------------------------------------------------------
// Diagnostic-logging helpers (per the tests-log-generously convention).
// Suite id: prewarm-hls. Phase markers: `[prewarm-hls:<phase>]`.
// dumpPrewarmHlsSnapshot prints the mock fetch call list, the prewarm result,
// and the start-error state so a failed assertion is debuggable.
// ---------------------------------------------------------------------------

const dumpPrewarmHlsSnapshot = (
  label: string,
  ctx: {
    startError?: unknown;
    result?: { warmedKeys: string[]; missedKeys: string[]; elapsedMs: number } | null;
    extra?: Record<string, unknown>;
  } = {},
) => {
  try {
     
    console.log(
      `[prewarm-hls:dump] ${label}`,
      JSON.stringify(
        {
          startErrorMessage:
            ctx.startError instanceof Error ? ctx.startError.message : ctx.startError,
          startErrorCode:
            ctx.startError && typeof ctx.startError === "object"
              ? (ctx.startError as { code?: string }).code
              : undefined,
          downloadToSinkCalls: downloadToSinkMock.mock.calls.length,
          downloadToSinkKeys: downloadToSinkMock.mock.calls.map((c) => c[1]),
          prewarmResult: ctx.result,
          ...(ctx.extra ?? {}),
        },
        null,
        2,
      ),
    );
  } catch (dumpError) {
     
    console.log(`[prewarm-hls:dump-error] ${label}`, dumpError);
  }
};

describe("@bugfix @regression-proof PlaybackServer.prewarmHlsSession", () => {
  let server: PlaybackServer;
  let startError: unknown = null;

  beforeEach(async () => {
     
    console.log("[prewarm-hls:beforeEach] resetting download mock + starting PlaybackServer");
    // STOR-BW-11: every playback names the picked profile; without one each object fetch is refused (a miss).
    setActivePlaybackProfileId("00000000-0000-4000-8000-000000000001");
    downloadToSinkMock.mockReset();
    startError = null;
    server = new PlaybackServer();
    try {
      await server.start();
    } catch (error) {
      startError = error;
    }
    server.setToken("test-token");
     
    console.log(
      `[prewarm-hls:beforeEach:ready] startError=${startError ? String((startError as Error).message ?? startError) : "<none>"}`,
    );
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  /**
   * Build a typical 3-segment HLS session: each track has segments
   * starting at 0, 10, and 20 seconds with 10-second durations.
   */
  const makeSession = () => {
    const video1 = {
      id: "video-1080p",
      quality: "1080p",
      bitrateKbps: 5000,
      width: 1920,
      height: 1080,
      track: {
        initKey: "v1-init",
        codecString: "avc1.640028",
        segments: [
          { key: "v1-seg-0", durationSeconds: 10, startSeconds: 0 },
          { key: "v1-seg-1", durationSeconds: 10, startSeconds: 10 },
          { key: "v1-seg-2", durationSeconds: 10, startSeconds: 20 },
        ],
      },
    };
    const video2 = {
      id: "video-720p",
      quality: "720p",
      bitrateKbps: 2500,
      width: 1280,
      height: 720,
      track: {
        initKey: "v2-init",
        codecString: "avc1.4d401f",
        segments: [
          { key: "v2-seg-0", durationSeconds: 10, startSeconds: 0 },
          { key: "v2-seg-1", durationSeconds: 10, startSeconds: 10 },
          { key: "v2-seg-2", durationSeconds: 10, startSeconds: 20 },
        ],
      },
    };
    const audio1 = {
      id: "audio-en",
      language: "en",
      label: "English",
      isDefault: true,
      track: {
        initKey: "a1-init",
        codecString: "mp4a.40.2",
        segments: [
          { key: "a1-seg-0", durationSeconds: 10, startSeconds: 0 },
          { key: "a1-seg-1", durationSeconds: 10, startSeconds: 10 },
          { key: "a1-seg-2", durationSeconds: 10, startSeconds: 20 },
        ],
      },
    };
    return server.createHlsSession({
      id: "test-session",
      videos: [video1, video2],
      audio: [audio1],
    });
  };

  it("@bugfix @regression-proof warms 4 keys (video init + video segment + audio init + audio segment) at startSeconds", async () => {
    let result: { warmedKeys: string[]; missedKeys: string[]; elapsedMs: number } | null = null;
    try {
       
      console.log("[prewarm-hls:warm-4-keys] starting test");
      if (startError) {
        expect((startError as { code?: string }).code).toBe("EPERM");
        return;
      }
      // Pretend every fetch returns 4 bytes.
      downloadToSinkMock.mockImplementation(
        async (
          _token: string,
          _key: string,
          sink: (chunk: Uint8Array) => void | Promise<void>,
        ) => {
          await sink(new Uint8Array([1, 2, 3, 4]));
        },
      );
      const session = makeSession();
       
      console.log("[prewarm-hls:warm-4-keys] calling prewarmHlsSession startSeconds=15");
      result = await (server as unknown as {
        prewarmHlsSession: (id: string, opts: { videoId?: string | null; audioId?: string | null; startSeconds?: number | null }) => Promise<{
          warmedKeys: string[];
          missedKeys: string[];
          elapsedMs: number;
        }>;
      }).prewarmHlsSession(session.id, {
        videoId: "video-1080p",
        audioId: "audio-en",
        // 15s into the timeline — segment 1 covers [10, 20).
        startSeconds: 15,
      });
       
      console.log(
        `[prewarm-hls:warm-4-keys:asserting] warmedKeys=${JSON.stringify(result.warmedKeys)} missedKeys=${JSON.stringify(result.missedKeys)}`,
      );
      // The 4 expected keys.
      expect(result.warmedKeys).toEqual(
        expect.arrayContaining(["v1-init", "v1-seg-1", "a1-init", "a1-seg-1"]),
      );
      expect(result.warmedKeys).toHaveLength(4);
      expect(result.missedKeys).toHaveLength(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    } catch (assertionError) {
      dumpPrewarmHlsSnapshot("warm-4-keys:fail", { startError, result });
      throw assertionError;
    }
  });

  it("@bugfix @regression-proof picks segment 0 when startSeconds is null / 0", async () => {
    let result: { warmedKeys: string[]; missedKeys: string[]; elapsedMs: number } | null = null;
    try {
       
      console.log("[prewarm-hls:start-null] startSeconds=null → segment 0 expected");
      if (startError) {
        expect((startError as { code?: string }).code).toBe("EPERM");
        return;
      }
      downloadToSinkMock.mockImplementation(
        async (
          _token: string,
          _key: string,
          sink: (chunk: Uint8Array) => void | Promise<void>,
        ) => {
          await sink(new Uint8Array([7]));
        },
      );
      const session = makeSession();
      result = await (server as unknown as {
        prewarmHlsSession: (id: string, opts: { videoId?: string | null; audioId?: string | null; startSeconds?: number | null }) => Promise<{
          warmedKeys: string[];
          missedKeys: string[];
          elapsedMs: number;
        }>;
      }).prewarmHlsSession(session.id, {
        videoId: "video-1080p",
        audioId: "audio-en",
        startSeconds: null,
      });
       
      console.log(
        `[prewarm-hls:start-null:asserting] warmedKeys=${JSON.stringify(result.warmedKeys)}`,
      );
      // Segment 0 (covers [0, 10)) — keys v1-seg-0 + a1-seg-0.
      expect(result.warmedKeys).toEqual(
        expect.arrayContaining(["v1-init", "v1-seg-0", "a1-init", "a1-seg-0"]),
      );
    } catch (assertionError) {
      dumpPrewarmHlsSnapshot("start-null:fail", { startError, result });
      throw assertionError;
    }
  });

  it("@bugfix @regression-proof tolerates per-object fetch failures via missedKeys (launch path stays bounded)", async () => {
    let result: { warmedKeys: string[]; missedKeys: string[]; elapsedMs: number } | null = null;
    try {
       
      console.log("[prewarm-hls:per-object-failure] segments throw, init succeeds");
      if (startError) {
        expect((startError as { code?: string }).code).toBe("EPERM");
        return;
      }
      // Half the keys fail — the prewarm MUST still resolve. The caller
      // tracks missedKeys but does not raise: mpv will then pay the
      // cold-fetch cost on those specific keys, and the launch UI stays
      // bounded by the renderer-side budget cap.
      downloadToSinkMock.mockImplementation(
        async (
          _token: string,
          key: string,
          sink: (chunk: Uint8Array) => void | Promise<void>,
        ) => {
          if (key.includes("init")) {
            // init succeeds
            await sink(new Uint8Array([0]));
          } else {
            throw new Error("tunnel_dead_for_segment");
          }
        },
      );
      const session = makeSession();
      result = await (server as unknown as {
        prewarmHlsSession: (id: string, opts: { videoId?: string | null; audioId?: string | null; startSeconds?: number | null }) => Promise<{
          warmedKeys: string[];
          missedKeys: string[];
          elapsedMs: number;
        }>;
      }).prewarmHlsSession(session.id, {
        videoId: "video-1080p",
        audioId: "audio-en",
        startSeconds: 0,
      });
       
      console.log(
        `[prewarm-hls:per-object-failure:asserting] warmedKeys=${JSON.stringify(result.warmedKeys)} missedKeys=${JSON.stringify(result.missedKeys)}`,
      );
      expect(result.warmedKeys).toEqual(
        expect.arrayContaining(["v1-init", "a1-init"]),
      );
      expect(result.missedKeys).toEqual(
        expect.arrayContaining(["v1-seg-0", "a1-seg-0"]),
      );
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    } catch (assertionError) {
      dumpPrewarmHlsSnapshot("per-object-failure:fail", { startError, result });
      throw assertionError;
    }
  });

  it("@bugfix @regression-proof returns empty result when the session id is unknown", async () => {
    let result: { warmedKeys: string[]; missedKeys: string[]; elapsedMs: number } | null = null;
    try {
       
      console.log("[prewarm-hls:unknown-session] requesting an unknown session id");
      if (startError) {
        expect((startError as { code?: string }).code).toBe("EPERM");
        return;
      }
      result = await (server as unknown as {
        prewarmHlsSession: (id: string, opts: { videoId?: string | null; audioId?: string | null; startSeconds?: number | null }) => Promise<{
          warmedKeys: string[];
          missedKeys: string[];
          elapsedMs: number;
        }>;
      }).prewarmHlsSession("unknown-session", { startSeconds: 0 });
      expect(result.warmedKeys).toEqual([]);
      expect(result.missedKeys).toEqual([]);
      expect(result.elapsedMs).toBe(0);
      expect(downloadToSinkMock).not.toHaveBeenCalled();
    } catch (assertionError) {
      dumpPrewarmHlsSnapshot("unknown-session:fail", { startError, result });
      throw assertionError;
    }
  });

  it("@bugfix @regression-proof respects an explicit videoId/audioId selection (not always default)", async () => {
    let result: { warmedKeys: string[]; missedKeys: string[]; elapsedMs: number } | null = null;
    try {
       
      console.log("[prewarm-hls:explicit-selection] picking 720p variant, startSeconds=15");
      if (startError) {
        expect((startError as { code?: string }).code).toBe("EPERM");
        return;
      }
      downloadToSinkMock.mockImplementation(
        async (
          _token: string,
          _key: string,
          sink: (chunk: Uint8Array) => void | Promise<void>,
        ) => {
          await sink(new Uint8Array([3]));
        },
      );
      const session = makeSession();
      // Pick the 720p variant — its keys are v2-*.
      result = await (server as unknown as {
        prewarmHlsSession: (id: string, opts: { videoId?: string | null; audioId?: string | null; startSeconds?: number | null }) => Promise<{
          warmedKeys: string[];
          missedKeys: string[];
          elapsedMs: number;
        }>;
      }).prewarmHlsSession(session.id, {
        videoId: "video-720p",
        audioId: "audio-en",
        startSeconds: 15,
      });
       
      console.log(
        `[prewarm-hls:explicit-selection:asserting] warmedKeys=${JSON.stringify(result.warmedKeys)}`,
      );
      expect(result.warmedKeys).toEqual(
        expect.arrayContaining(["v2-init", "v2-seg-1", "a1-init", "a1-seg-1"]),
      );
      // 1080p keys must NOT appear.
      for (const key of result.warmedKeys) {
        expect(key.startsWith("v1-")).toBe(false);
      }
    } catch (assertionError) {
      dumpPrewarmHlsSnapshot("explicit-selection:fail", { startError, result });
      throw assertionError;
    }
  });
});

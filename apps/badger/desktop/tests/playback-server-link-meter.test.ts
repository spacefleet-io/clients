import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloadToSinkMock = vi.hoisted(() => vi.fn());

vi.mock("../src/main/api", () => ({
  downloadStorageObjectViaTunnelToSink: (...args: unknown[]) => downloadToSinkMock(...args),
}));

import { PlaybackServer } from "../src/main/playbackServer";
import { setActivePlaybackProfileId } from "../src/main/activePlaybackProfile";

/**
 * Issue #25: Auto quality reads the link estimate measured in MAIN over the
 * upstream tunnel fetches of HLS video media segments. This suite pins the
 * PlaybackServer wiring: which fetches are metered (on-demand + prefetch),
 * the reset on a new HLS session, and the runtime-settable test throttle that
 * caps the effective estimate.
 */

const SUITE = "playback-server-link-meter";
// Every mocked tunnel download takes exactly 1 s of (fake) wall time and
// delivers 250 kB → 2 Mbps when metered.
const DOWNLOAD_MS = 1_000;
const BYTES_PER_OBJECT = 250_000;
const SAMPLE_BPS = (BYTES_PER_OBJECT * 8 * 1000) / DOWNLOAD_MS;

const errorCode = (error: unknown): unknown =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

const segments = (prefix: string) =>
  Array.from({ length: 4 }, (_, index) => ({ key: `${prefix}-${index}`, durationSeconds: 6, startSeconds: index * 6 }));

describe("PlaybackServer upstream link meter", () => {
  let server: PlaybackServer;
  let startError: unknown = null;
  const started: string[] = [];
  const savedEnv = {
    prefetch: process.env.SF_PLAYBACK_HLS_OBJECT_PREFETCH_COUNT,
    throttle: process.env.SF_PLAYBACK_THROTTLE_KBPS,
  };

  const dump = (label: string, extra: Record<string, unknown> = {}) => {
    try {
      console.error(`=== [${SUITE}:${label}] snapshot ===`);
      console.error(`started downloads: ${JSON.stringify(started)}`);
      console.error(`link estimate: ${JSON.stringify(server.getLinkEstimate())}`);
      console.error(`now: ${Date.now()}`);
      console.error(`extra: ${JSON.stringify(extra, null, 2)}`);
      console.error(`=== [${SUITE}:${label}] end snapshot ===`);
    } catch (err) {
      console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  };

  const createSession = (id: string, prefetchCount: number) => {
    process.env.SF_PLAYBACK_HLS_OBJECT_PREFETCH_COUNT = String(prefetchCount);
    console.info(`[${SUITE}:create-session] id=${id} prefetchCount=${prefetchCount}`);
    return server.createHlsSession({
      id,
      videos: [
        {
          id: "v0",
          quality: "1080p",
          bitrateKbps: 4000,
          width: 1920,
          height: 1080,
          track: { initKey: `${id}-init-v`, codecString: null, segments: segments(`${id}-seg-v`) },
        },
      ],
      audio: [
        {
          id: "a0",
          language: "en",
          label: "English",
          isDefault: true,
          track: { initKey: `${id}-init-a`, codecString: null, segments: segments(`${id}-seg-a`) },
        },
      ],
    });
  };

  const getObject = async (key: string) => {
    const res = await fetch(`${server.getBaseUrl()}/playback/object/${key}`);
    const body = await res.arrayBuffer();
    console.info(`[${SUITE}:get-object] key=${key} status=${res.status} bytes=${body.byteLength} estimate=${JSON.stringify(server.getLinkEstimate())}`);
    return { status: res.status, bytes: body.byteLength };
  };

  beforeEach(async () => {

    // STOR-BW-11: every playback names the picked profile.

    setActivePlaybackProfileId("00000000-0000-4000-8000-000000000001");
    downloadToSinkMock.mockReset();
    started.length = 0;
    startError = null;
    delete process.env.SF_PLAYBACK_THROTTLE_KBPS;
    // Fake Date only: the meter's clock. HTTP and vi.waitFor keep real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(1_000_000));
    downloadToSinkMock.mockImplementation(
      async (_token: string, key: string, sink: (chunk: Uint8Array) => void | Promise<void>) => {
        started.push(key);
        vi.setSystemTime(new Date(Date.now() + DOWNLOAD_MS));
        await sink(new Uint8Array(BYTES_PER_OBJECT).fill(7));
      },
    );
    server = new PlaybackServer({});
    try {
      await server.start();
      server.setToken("test-token");
    } catch (error) {
      startError = error;
      console.info(`[${SUITE}:setup] start failed code=${errorCode(error)} (EPERM-tolerant sandbox path)`);
    }
  });

  afterEach(async () => {
    await server.stop();
    vi.useRealTimers();
    if (savedEnv.prefetch === undefined) delete process.env.SF_PLAYBACK_HLS_OBJECT_PREFETCH_COUNT;
    else process.env.SF_PLAYBACK_HLS_OBJECT_PREFETCH_COUNT = savedEnv.prefetch;
    if (savedEnv.throttle === undefined) delete process.env.SF_PLAYBACK_THROTTLE_KBPS;
    else process.env.SF_PLAYBACK_THROTTLE_KBPS = savedEnv.throttle;
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-SERVER-001
   * @level integration
   * @why Init segments and audio are not the link the video rungs compete for; only video media segments may feed the estimate.
   */
  it("meters on-demand tunnel fetches of video media segments only", async () => {
    if (startError) {
      expect(errorCode(startError)).toBe("EPERM");
      return;
    }
    createSession("s1", 0);
    await getObject("s1-init-v");
    await getObject("s1-init-a");
    await getObject("s1-seg-a-0");
    const afterNonVideo = server.getLinkEstimate();
    console.info(`[${SUITE}:video-only] after init+audio estimate=${JSON.stringify(afterNonVideo)}`);
    try {
      expect(afterNonVideo).toEqual({ bps: 0, sampleCount: 0, updatedAtMs: null, throttleKbps: 0 });
      await getObject("s1-seg-v-0");
      expect(server.getLinkEstimate()).toEqual({
        bps: SAMPLE_BPS,
        sampleCount: 1,
        updatedAtMs: Date.now(),
        throttleKbps: 0,
      });
      expect(started).toEqual(["s1-init-v", "s1-init-a", "s1-seg-a-0", "s1-seg-v-0"]);
    } catch (err) {
      dump("video-only-failed", { afterNonVideo });
      throw err;
    }
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-SERVER-002
   * @level integration
   * @why Prefetch does most upstream fetching during steady playback; it must feed the meter too.
   */
  it("meters prefetched video segments", async () => {
    if (startError) {
      expect(errorCode(startError)).toBe("EPERM");
      return;
    }
    createSession("s2", 1);
    await getObject("s2-seg-v-0");
    try {
      await vi.waitFor(() => {
        expect(started).toEqual(["s2-seg-v-0", "s2-seg-v-1"]);
        expect(server.getLinkEstimate().sampleCount).toBe(2);
      });
      expect(server.getLinkEstimate().bps).toBe(SAMPLE_BPS);
    } catch (err) {
      dump("prefetch-failed");
      throw err;
    }
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-SERVER-003
   * @level integration
   */
  it("resets the estimate when a new HLS session is created", async () => {
    if (startError) {
      expect(errorCode(startError)).toBe("EPERM");
      return;
    }
    createSession("s3", 0);
    await getObject("s3-seg-v-0");
    const before = server.getLinkEstimate();
    createSession("s4", 0);
    const after = server.getLinkEstimate();
    console.info(`[${SUITE}:reset] before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    try {
      expect(before.sampleCount).toBe(1);
      expect(after).toEqual({ bps: 0, sampleCount: 0, updatedAtMs: null, throttleKbps: 0 });
    } catch (err) {
      dump("reset-failed", { before, after });
      throw err;
    }
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-SERVER-004
   * @level integration
   * @why The e2e drops and restores the "network" at runtime; the effective estimate follows the throttle.
   */
  it("setThrottleKbps changes the throttle at runtime and caps the effective estimate", async () => {
    if (startError) {
      expect(errorCode(startError)).toBe("EPERM");
      return;
    }
    createSession("s5", 0);
    await getObject("s5-seg-v-0");
    const steps: Array<{ kbps: number; estimate: unknown; get: number }> = [];
    const apply = (kbps: number) => {
      server.setThrottleKbps(kbps);
      const estimate = server.getLinkEstimate();
      steps.push({ kbps, estimate, get: server.getThrottleKbps() });
      console.info(`[${SUITE}:throttle] set=${kbps} get=${server.getThrottleKbps()} estimate=${JSON.stringify(estimate)}`);
      return estimate;
    };
    try {
      expect(apply(1_000)).toMatchObject({ bps: 1_000_000, sampleCount: 1, throttleKbps: 1_000 });
      expect(apply(5_000)).toMatchObject({ bps: SAMPLE_BPS, throttleKbps: 5_000 });
      expect(apply(0)).toMatchObject({ bps: SAMPLE_BPS, throttleKbps: 0 });
      expect(steps.map((step) => step.get)).toEqual([1_000, 5_000, 0]);
      expect(() => server.setThrottleKbps(-1)).toThrow(RangeError);
      expect(server.getThrottleKbps()).toBe(0);
    } catch (err) {
      dump("throttle-failed", { steps });
      throw err;
    }
  });
});

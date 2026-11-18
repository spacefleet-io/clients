/**
 * @req STOR-BW-01
 *
 * Gateway high-traffic period, desktop playback side: the HLS object look-ahead
 * shrinks to the gateway's `playbackBufferSeconds` and is restored when traffic
 * is normal again; fetches carry the bitrate and the start/seek burst hints.
 * (mpv's `--cache-secs` cap lives in packages/mpv/tests/stream-cache-traffic-cap.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImmediate as nextMacrotask } from "node:timers/promises";

const downloadToSinkMock = vi.hoisted(() => vi.fn());

vi.mock("../src/main/forceGc", () => ({ runFullGc: () => ({ ms: 1 }) }));
vi.mock("../src/main/api", () => ({
  downloadStorageObjectViaTunnelToSink: (...args: unknown[]) => downloadToSinkMock(...args),
}));

import { setActivePlaybackProfileId } from "../src/main/activePlaybackProfile";
import { PlaybackServer } from "../src/main/playbackServer";
import { createBurstTracker, limitPrefetchKeys } from "../src/main/playbackTraffic";

const NORMAL = { state: "normal", playbackBufferSeconds: null } as const;
const high = (playbackBufferSeconds: number | null) => ({ state: "high", playbackBufferSeconds }) as const;

describe("limitPrefetchKeys", () => {
  const durations = new Map(["a", "b", "c", "d"].map((key) => [key, 12]));
  const durationOf = (key: string) => durations.get(key) ?? null;

  it("keeps the whole look-ahead window when traffic is normal", () => {
    expect(limitPrefetchKeys(["a", "b", "c", "d"], NORMAL, durationOf)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps objects while their cumulative duration stays within the gateway's buffer, at least one", () => {
    expect(limitPrefetchKeys(["a", "b", "c", "d"], high(30), durationOf)).toEqual(["a", "b"]);
    expect(limitPrefetchKeys(["a", "b", "c", "d"], high(36), durationOf)).toEqual(["a", "b", "c"]);
    expect(limitPrefetchKeys(["a", "b", "c", "d"], high(5), durationOf)).toEqual(["a"]);
  });

  it("falls back to two objects when the buffer or a duration is unknown", () => {
    expect(limitPrefetchKeys(["a", "b", "c", "d"], high(null), durationOf)).toEqual(["a", "b"]);
    expect(limitPrefetchKeys(["a", "b", "c", "d"], high(60), () => null)).toEqual(["a", "b"]);
  });

  it("never lengthens a window that is already short", () => {
    expect(limitPrefetchKeys(["a"], high(300), durationOf)).toEqual(["a"]);
    expect(limitPrefetchKeys([], high(30), durationOf)).toEqual([]);
  });
});

describe("createBurstTracker", () => {
  const seg = (startSeconds: number) => ({ kind: "video" as const, isInit: false, startSeconds, durationSeconds: 12 });

  it("marks the first foreground request of a playback as `start`, then plays on without a burst", () => {
    const tracker = createBurstTracker();
    expect(tracker.note(seg(0))).toBe("start");
    expect(tracker.note(seg(12))).toBeUndefined();
    expect(tracker.note(seg(24))).toBeUndefined();
  });

  it("marks a jump outside the expected window as `seek`, forward or backward", () => {
    const tracker = createBurstTracker();
    tracker.note(seg(0));
    tracker.note(seg(12));
    expect(tracker.note(seg(600))).toBe("seek");
    expect(tracker.note(seg(612))).toBeUndefined();
    expect(tracker.note(seg(48))).toBe("seek");
  });

  it("does not call a re-read of the same position (variant switch) a seek, and restarts after reset", () => {
    const tracker = createBurstTracker();
    tracker.note(seg(0));
    tracker.note(seg(12));
    expect(tracker.note(seg(12))).toBeUndefined();
    tracker.reset();
    expect(tracker.note(seg(300))).toBe("start");
  });

  it("ignores audio and init objects for seek detection", () => {
    const tracker = createBurstTracker();
    tracker.note(seg(0));
    expect(tracker.note({ kind: "audio", isInit: false, startSeconds: 900, durationSeconds: 12 })).toBeUndefined();
    expect(tracker.note({ kind: "video", isInit: true, startSeconds: null, durationSeconds: null })).toBeUndefined();
    expect(tracker.note(seg(12))).toBeUndefined();
  });
});

describe("PlaybackServer under gateway traffic state", () => {
  const KEYS = Array.from({ length: 12 }, (_, index) => `seg-${index}`);
  let traffic: { state: "normal" | "high"; playbackBufferSeconds: number | null };
  let server: PlaybackServer;
  let startError: unknown = null;

  beforeEach(async () => {
    // STOR-BW-11: every playback names the picked profile; without one each object fetch is refused (500).
    setActivePlaybackProfileId("00000000-0000-4000-8000-000000000001");
    downloadToSinkMock.mockReset();
    downloadToSinkMock.mockImplementation(
      async (_token: string, key: string, sink: (chunk: Uint8Array) => void | Promise<void>) => {
        await sink(new TextEncoder().encode(`payload:${key}`));
      },
    );
    traffic = { state: "normal", playbackBufferSeconds: null };
    startError = null;
    server = new PlaybackServer({ getTraffic: () => ({ ...traffic, observedAt: 0 }) });
    try {
      await server.start();
      server.setToken("test-token");
      server.createHlsSession({
        id: "traffic-session",
        videos: [
          {
            id: "v0",
            quality: "1080p",
            bitrateKbps: 4000,
            width: 1920,
            height: 1080,
            track: {
              initKey: "init-0",
              codecString: null,
              segments: KEYS.map((key, index) => ({ key, durationSeconds: 12, startSeconds: index * 12 })),
            },
          },
        ],
        audio: [],
      });
    } catch (error) {
      startError = error;
    }
  });

  afterEach(async () => {
    await server.stop();
  });

  // The mocked tunnel resolves without I/O: a few macrotask turns drain every queued prefetch.
  const settle = async () => {
    for (let i = 0; i < 40; i += 1) await nextMacrotask();
  };

  const getObject = async (key: string) => {
    const res = await fetch(`${server.getBaseUrl()}/playback/object/${key}`);
    await res.text();
    return res.status;
  };

  const fetchedKeys = () => downloadToSinkMock.mock.calls.map((call) => call[1] as string);

  it("prefetches the full window when traffic is normal", async () => {
    if (startError) return;
    expect(await getObject("seg-0")).toBe(200);
    await settle();
    expect(fetchedKeys().sort()).toEqual(["seg-0", "seg-1", "seg-2", "seg-3", "seg-4"]);
  });

  it("caps the look-ahead to the gateway's playbackBufferSeconds while high, and restores it when normal", async () => {
    if (startError) return;
    traffic = { state: "high", playbackBufferSeconds: 30 };
    expect(await getObject("seg-0")).toBe(200);
    await settle();
    // 30 s of look-ahead = two 12 s objects after the requested one.
    expect(fetchedKeys().sort()).toEqual(["seg-0", "seg-1", "seg-2"]);

    traffic = { state: "normal", playbackBufferSeconds: null };
    expect(await getObject("seg-6")).toBe(200);
    await settle();
    expect(fetchedKeys()).toEqual(expect.arrayContaining(["seg-7", "seg-8", "seg-9", "seg-10"]));
  });

  it("sends the bitrate and start/seek burst hints with foreground playback fetches", async () => {
    if (startError) return;
    traffic = { state: "high", playbackBufferSeconds: 12 };
    await getObject("seg-0");
    await settle();
    await getObject("seg-9");
    await settle();
    const hintsOf = (key: string) => {
      const call = downloadToSinkMock.mock.calls.find((c) => c[1] === key);
      return (call?.[3] as { hints?: { playbackBps?: number; burst?: string } } | undefined)?.hints;
    };
    expect(hintsOf("seg-0")).toMatchObject({ playbackBps: 4_000_000, burst: "start" });
    expect(hintsOf("seg-9")).toMatchObject({ playbackBps: 4_000_000, burst: "seek" });
    // Look-ahead (background) fetches never claim a burst.
    expect(hintsOf("seg-1")?.burst).toBeUndefined();
  });
});

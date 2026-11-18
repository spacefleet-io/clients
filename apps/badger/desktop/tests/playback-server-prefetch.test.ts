import { setImmediate as nextMacrotask } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloadToSinkMock = vi.hoisted(() => vi.fn());

vi.mock("../src/main/api", () => ({
  downloadStorageObjectViaTunnelToSink: (...args: unknown[]) => downloadToSinkMock(...args),
}));

import { PlaybackServer } from "../src/main/playbackServer";
import { setActivePlaybackProfileId } from "../src/main/activePlaybackProfile";

const TAG = "[playback-server-prefetch]";
const SEGMENT_KEYS = Array.from({ length: 12 }, (_, index) => `seg-${index}`);

/**
 * Every tunnel download parks until the test releases it, so the test decides
 * exactly how many are in flight and in which order they were started.
 */
type GatedDownloads = {
  started: string[];
  active: Set<string>;
  maxActive: () => number;
  release: (key: string) => void;
  releaseAll: () => void;
};

const installGatedDownloads = (): GatedDownloads => {
  const started: string[] = [];
  const active = new Set<string>();
  const gates = new Map<string, () => void>();
  let maxActive = 0;
  let open = false;
  downloadToSinkMock.mockImplementation(
    async (_token: string, key: string, sink: (chunk: Uint8Array) => void | Promise<void>) => {
      started.push(key);
      active.add(key);
      maxActive = Math.max(maxActive, active.size);
      if (!open) {
        const gate = Promise.withResolvers<void>();
        gates.set(key, gate.resolve);
        await gate.promise;
      }
      active.delete(key);
      await sink(new TextEncoder().encode(`payload:${key}`));
    }
  );
  return {
    started,
    active,
    maxActive: () => maxActive,
    release: (key: string) => {
      const gate = gates.get(key);
      if (!gate) throw new Error(`no parked download for ${key}`);
      gate();
    },
    // Lets every parked and future download finish so the test can drain to a quiet state.
    releaseAll: () => {
      open = true;
      gates.forEach((gate) => gate());
    },
  };
};

const snapshot = (label: string, gated: GatedDownloads) =>
  console.info(
    `${TAG} ${label} started=${JSON.stringify(gated.started)} active=${JSON.stringify([...gated.active])} maxActive=${gated.maxActive()}`
  );

describe("playbackServer HLS object prefetch", () => {
  let server: PlaybackServer;
  let startError: unknown = null;

  beforeEach(async () => {

    // STOR-BW-11: every playback names the picked profile.

    setActivePlaybackProfileId("00000000-0000-4000-8000-000000000001");
    downloadToSinkMock.mockReset();
    startError = null;
    server = new PlaybackServer({});
    try {
      await server.start();
      server.setToken("test-token");
      server.createHlsSession({
        id: "prefetch-session",
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
              segments: SEGMENT_KEYS.map((key, index) => ({
                key,
                durationSeconds: 12,
                startSeconds: index * 12,
              })),
            },
          },
        ],
        audio: [],
      });
    } catch (error) {
      startError = error;
      console.info(`${TAG} setup failed code=${(error as { code?: string }).code} (EPERM-tolerant sandbox path)`);
    }
  });

  afterEach(async () => {
    await server.stop();
  });

  const getObject = async (key: string) => {
    const res = await fetch(`${server.getBaseUrl()}/playback/object/${key}`);
    const body = await res.text();
    return { status: res.status, body };
  };

  /**
   * @test-id DESKTOP-PLAYBACK-PREFETCH-CAP-001
   * @level integration
   * @bugfix
   * @why Issue #25: every /playback/object request fanned out 4 concurrent prefetches, each costing a tunnel session + SHA-256 + AES-GCM in worker threads on a 4-core no-GPU box.
   * @regression-proof Prefetch never runs more than 2 object downloads at once and starts the rest in order as slots free up.
   */
  it("@bugfix @regression-proof caps in-flight prefetches at 2 and drains the queue in order", async () => {
    if (startError) {
      expect((startError as { code?: string }).code).toBe("EPERM");
      return;
    }
    const gated = installGatedDownloads();
    const foreground = getObject("seg-0");
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-0"]));
    gated.release("seg-0");
    expect((await foreground).body).toBe("payload:seg-0");

    // Pre-fix all four prefetches start at once, so this exact-3 wait times out.
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2"]));
    snapshot("after-foreground", gated);
    try {
      expect(gated.active.size).toBe(2);

      gated.release("seg-1");
      await vi.waitFor(() => expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2", "seg-3"]));
      gated.release("seg-2");
      await vi.waitFor(() => expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2", "seg-3", "seg-4"]));
      gated.release("seg-3");
      gated.release("seg-4");
      await vi.waitFor(() => expect(gated.active.size).toBe(0));
      snapshot("drained", gated);
      expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2", "seg-3", "seg-4"]);
      // seg-0 (foreground) finished before prefetch began, so the peak is the prefetch cap.
      expect(gated.maxActive()).toBe(2);
    } catch (err) {
      snapshot("FAILED", gated);
      throw err;
    }
  });

  /**
   * @test-id DESKTOP-PLAYBACK-PREFETCH-CAP-002
   * @level integration
   * @bugfix
   * @why A saturated prefetch pool must never delay the object mpv is actually waiting for, and a key mpv asks for must not be fetched twice.
   * @regression-proof With 2 prefetches parked, a foreground request for an unrelated key starts immediately, and a foreground request for a queued/in-flight prefetch key does not add a download.
   */
  it("@bugfix @regression-proof never starves the foreground fetch and never downloads a key twice", async () => {
    if (startError) {
      expect((startError as { code?: string }).code).toBe("EPERM");
      return;
    }
    const gated = installGatedDownloads();
    const first = getObject("seg-0");
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-0"]));
    gated.release("seg-0");
    await first;
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2"]));

    // Foreground for a key outside the prefetch window while the pool is full.
    const unrelated = getObject("seg-11");
    await vi.waitFor(() => expect(gated.started).toContain("seg-11"));
    snapshot("foreground-while-saturated", gated);
    expect(gated.active.has("seg-11")).toBe(true);

    // Foreground for a key still queued behind the cap (seg-4): fetched once, by the foreground.
    const queued = getObject("seg-4");
    await vi.waitFor(() => expect(gated.started).toContain("seg-4"));
    // And for one already in flight as a prefetch (seg-1): joins the pending fetch.
    const inFlight = getObject("seg-1");

    gated.releaseAll();
    const bodies = await Promise.all([unrelated, queued, inFlight]);
    // seg-5 sits in both the seg-1 window (seg-2..5) and the seg-4 window (seg-5..8), so wait
    // until it started and the pool idled before checking that no key was downloaded twice.
    await vi.waitFor(() => {
      expect(gated.started).toContain("seg-5");
      expect(gated.active.size).toBe(0);
    });
    snapshot("end", gated);
    try {
      expect(bodies.map((entry) => entry.body)).toEqual(["payload:seg-11", "payload:seg-4", "payload:seg-1"]);
      const counts = new Map<string, number>();
      gated.started.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1));
      expect([...counts.entries()].filter(([, count]) => count > 1)).toEqual([]);
    } catch (err) {
      snapshot("FAILED", gated);
      throw err;
    }
  });

  /**
   * @test-id DESKTOP-PLAYBACK-PREFETCH-CAP-003
   * @level integration
   * @bugfix
   * @why After a seek, keys queued for the old position must not take the 2 prefetch slots ahead of the new window.
   * @regression-proof Seek to seg-7 while seg-3/seg-4 wait in the queue: the next prefetch slots go to seg-8/seg-9 and the stale keys never download.
   */
  it("@bugfix @regression-proof puts the post-seek window ahead of stale queued keys", async () => {
    if (startError) {
      expect((startError as { code?: string }).code).toBe("EPERM");
      return;
    }
    const gated = installGatedDownloads();
    const first = getObject("seg-0");
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-0"]));
    gated.release("seg-0");
    await first;
    // seg-1/seg-2 in flight, seg-3/seg-4 queued behind the cap.
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2"]));

    const seek = getObject("seg-7");
    await vi.waitFor(() => expect(gated.started).toContain("seg-7"));
    gated.release("seg-7");
    await seek;
    gated.release("seg-1");
    gated.release("seg-2");
    try {
      await vi.waitFor(() => expect(gated.started).toContain("seg-9"));
      snapshot("after-seek", gated);
      expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2", "seg-7", "seg-8", "seg-9"]);
      gated.releaseAll();
      await vi.waitFor(() => {
        expect(gated.started).toContain("seg-11");
        expect(gated.active.size).toBe(0);
      });
      await nextMacrotask();
      snapshot("after-seek-drained", gated);
      expect(gated.started).not.toContain("seg-3");
      expect(gated.started).not.toContain("seg-4");
    } catch (err) {
      snapshot("FAILED", gated);
      throw err;
    }
  });

  /**
   * @test-id DESKTOP-PLAYBACK-PREFETCH-CAP-004
   * @level integration
   * @bugfix
   * @why Pruning a released HLS session must not leave its queued prefetch keys downloading.
   * @regression-proof Queued seg-3/seg-4 are dropped when the session is pruned, so freed slots start nothing.
   */
  it("@bugfix @regression-proof drops a pruned session's queued prefetch keys", async () => {
    if (startError) {
      expect((startError as { code?: string }).code).toBe("EPERM");
      return;
    }
    const gated = installGatedDownloads();
    const first = getObject("seg-0");
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-0"]));
    gated.release("seg-0");
    await first;
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2"]));

    server.releaseHlsSession("prefetch-session");
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow + 6 * 60 * 1000);
    try {
      const playlist = await fetch(`${server.getBaseUrl()}/playback/hls/prefetch-session/master.m3u8`);
      console.info(`${TAG} pruned-session playlist status=${playlist.status}`);
      expect(playlist.status).toBe(404);
    } finally {
      nowSpy.mockRestore();
    }
    gated.releaseAll();
    await vi.waitFor(() => expect(gated.active.size).toBe(0));
    await nextMacrotask();
    snapshot("after-prune", gated);
    expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2"]);
  });

  /**
   * @test-id DESKTOP-PLAYBACK-PREFETCH-CAP-005
   * @level integration
   * @bugfix
   * @why stop() must not leave queued prefetch keys that keep starting downloads on a stopped server.
   * @regression-proof Queued seg-3/seg-4 are discarded by stop(); freed slots start nothing.
   */
  it("@bugfix @regression-proof stop() discards queued prefetch keys", async () => {
    if (startError) {
      expect((startError as { code?: string }).code).toBe("EPERM");
      return;
    }
    const gated = installGatedDownloads();
    const first = getObject("seg-0");
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-0"]));
    gated.release("seg-0");
    await first;
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2"]));

    await server.stop();
    gated.releaseAll();
    await vi.waitFor(() => expect(gated.active.size).toBe(0));
    await nextMacrotask();
    snapshot("after-stop", gated);
    expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2"]);
  });
});

import { setImmediate as nextMacrotask } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloadToSinkMock = vi.hoisted(() => vi.fn());
const runFullGcMock = vi.hoisted(() => vi.fn());

vi.mock("../src/main/forceGc", () => ({
  runFullGc: (...args: unknown[]) => runFullGcMock(...args),
}));

vi.mock("../src/main/api", () => ({
  downloadStorageObjectViaTunnelToSink: (...args: unknown[]) => downloadToSinkMock(...args),
}));

import { PlaybackServer } from "../src/main/playbackServer";
import { setActivePlaybackProfileId } from "../src/main/activePlaybackProfile";

const TAG = "[playback-server-cache-release]";
const SEGMENT_KEYS = Array.from({ length: 12 }, (_, index) => `seg-${index}`);
const CAP_ENV = "SF_PLAYBACK_OBJECT_CACHE_MAX_BYTES";

/** Tunnel downloads park until the test releases them, so the test owns the "in flight at close" window. */
const installGatedDownloads = () => {
  const started: string[] = [];
  const active = new Set<string>();
  const gates = new Map<string, () => void>();
  let open = false;
  downloadToSinkMock.mockImplementation(
    async (_token: string, key: string, sink: (chunk: Uint8Array) => void | Promise<void>) => {
      started.push(key);
      active.add(key);
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
    release: (key: string) => {
      const gate = gates.get(key);
      if (!gate) throw new Error(`no parked download for ${key}`);
      gate();
    },
    releaseAll: () => {
      open = true;
      gates.forEach((gate) => gate());
    },
  };
};

describe("playbackServer chunk cache lifetime", () => {
  let server: PlaybackServer;
  let startError: unknown = null;
  let savedCapEnv: string | undefined;

  beforeEach(async () => {

    // STOR-BW-11: every playback names the picked profile.

    setActivePlaybackProfileId("00000000-0000-4000-8000-000000000001");
    downloadToSinkMock.mockReset();
    runFullGcMock.mockReset();
    runFullGcMock.mockReturnValue({ ms: 1 });
    savedCapEnv = process.env[CAP_ENV];
    delete process.env[CAP_ENV];
    startError = null;
    server = new PlaybackServer({});
    try {
      await server.start();
      server.setToken("test-token");
      server.createHlsSession({
        id: "cache-release-session",
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
    if (savedCapEnv === undefined) delete process.env[CAP_ENV];
    else process.env[CAP_ENV] = savedCapEnv;
  });

  const getObject = async (key: string) => {
    const res = await fetch(`${server.getBaseUrl()}/playback/object/${key}`);
    return { status: res.status, body: await res.text() };
  };

  const stats = (label: string) => {
    const snapshot = server.getObjectPayloadCacheStats();
    console.info(`${TAG} ${label} ${JSON.stringify(snapshot)}`);
    return snapshot;
  };

  /**
   * @test-id DESKTOP-PLAYBACK-CACHE-CAP-001
   * @level unit
   * @bugfix
   * @why Issue #25: the 256 MB video chunk cache cost ~290 MB RSS on low-end PCs; Chris capped it at 96 MB (2026-10-13).
   * @regression-proof The default cap is 96 MB and SF_PLAYBACK_OBJECT_CACHE_MAX_BYTES still overrides it.
   */
  it("@bugfix @regression-proof defaults the cache cap to 96 MB and keeps the env override @req MPV-CACHE-01", () => {
    expect(server.getObjectPayloadCacheStats().maxBytes).toBe(96 * 1024 * 1024);
    process.env[CAP_ENV] = "4096";
    expect(server.getObjectPayloadCacheStats().maxBytes).toBe(4096);
    process.env[CAP_ENV] = "not-a-number";
    expect(server.getObjectPayloadCacheStats().maxBytes).toBe(96 * 1024 * 1024);
  });

  /**
   * @test-id DESKTOP-PLAYBACK-CACHE-CLOSE-001
   * @level integration
   * @bugfix
   * @why The cache filled during a session and was never emptied when mpv closed, so its ~290 MB stayed resident in main.
   * @regression-proof After clearObjectPayloadCache the cache holds 0 bytes / 0 entries and the prefetch queue is empty.
   */
  it("@bugfix @regression-proof empties buffers, byte counter and prefetch queue on close @req MPV-CACHE-02", async () => {
    if (startError) {
      expect((startError as { code?: string }).code).toBe("EPERM");
      return;
    }
    const gated = installGatedDownloads();
    gated.releaseAll();
    expect((await getObject("seg-0")).body).toBe("payload:seg-0");
    await vi.waitFor(() => expect(stats("warm").bytes).toBeGreaterThan("payload:seg-0".length));
    expect(stats("warm-entries").entries).toBeGreaterThan(1);

    server.clearObjectPayloadCache("test-close");
    const after = stats("after-close");
    expect(after.bytes).toBe(0);
    expect(after.entries).toBe(0);
    expect(after.queuedPrefetchKeys).toBe(0);
    // Off-heap Buffers only return to the OS once V8 collects them: close must ask for one full GC.
    expect(runFullGcMock).toHaveBeenCalledTimes(1);
    // A second close signal for the same playback (mpv exit, then the renderer's stop) finds nothing to free.
    server.clearObjectPayloadCache("test-close-again");
    expect(runFullGcMock).toHaveBeenCalledTimes(1);

    // The next playback starts from a cold cache and fills it again.
    expect((await getObject("seg-8")).body).toBe("payload:seg-8");
    expect(stats("refill").bytes).toBeGreaterThan(0);
  });

  /**
   * @test-id DESKTOP-PLAYBACK-CACHE-CLOSE-002
   * @level integration
   * @bugfix
   * @why A fetch in flight when mpv closes used to store its payload (and its foreground request used to schedule a new prefetch window) after the clear, refilling the cache of a playback that no longer exists.
   * @regression-proof A late foreground fetch, in-flight prefetches and queued prefetch keys leave the cache at 0 bytes and start no further download after close.
   */
  it("@bugfix @regression-proof late in-flight fetches do not repopulate the cache after close", async () => {
    if (startError) {
      expect((startError as { code?: string }).code).toBe("EPERM");
      return;
    }
    const gated = installGatedDownloads();
    const first = getObject("seg-0");
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-0"]));
    gated.release("seg-0");
    await first;
    // seg-1/seg-2 in flight as prefetches, seg-3/seg-4 queued behind the cap.
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2"]));
    // A foreground request for another key is parked mid-download too.
    const late = getObject("seg-9");
    await vi.waitFor(() => expect(gated.started).toContain("seg-9"));
    stats("before-close");

    server.clearObjectPayloadCache("test-close");
    expect(stats("right-after-close").bytes).toBe(0);

    gated.releaseAll();
    // The waiting request still gets its bytes: mpv may be mid-read of a dying stream.
    expect((await late).body).toBe("payload:seg-9");
    await vi.waitFor(() => expect(gated.active.size).toBe(0));
    await nextMacrotask();
    await nextMacrotask();
    const settled = stats("settled");
    console.info(`${TAG} started=${JSON.stringify(gated.started)}`);
    expect(settled.bytes).toBe(0);
    expect(settled.entries).toBe(0);
    expect(settled.queuedPrefetchKeys).toBe(0);
    // No prefetch window was scheduled by the late foreground response, queued seg-3/4 never ran.
    expect(gated.started).toEqual(["seg-0", "seg-1", "seg-2", "seg-9"]);
  });

  /**
   * @test-id DESKTOP-PLAYBACK-CACHE-CLOSE-003
   * @level integration
   * @bugfix
   * @why Review of #241: a download left pending by the closed playback is joined by the next playback, but neither the creator (stale epoch) nor the joiner stored the bytes, so the chunk the new mpv asks for next went back to the storage tunnel cold.
   * @regression-proof A request that joins a pre-close pending fetch after the clear caches the payload for the new playback.
   */
  it("@bugfix @regression-proof a new playback joining a pre-close pending fetch caches the payload", async () => {
    if (startError) {
      expect((startError as { code?: string }).code).toBe("EPERM");
      return;
    }
    const gated = installGatedDownloads();
    const payloadLookups = vi.spyOn(server as unknown as { getObjectPayload: (key: string) => Promise<Buffer> }, "getObjectPayload");
    const seg9Lookups = () => payloadLookups.mock.calls.filter(([key]) => key === "seg-9").length;
    const oldPlayback = getObject("seg-9");
    await vi.waitFor(() => expect(gated.started).toEqual(["seg-9"]));

    server.clearObjectPayloadCache("test-close");
    stats("closed-with-seg-9-pending");
    const newPlayback = getObject("seg-9");
    // Wait until the new playback's request has reached the cache (a loopback HTTP round trip: a fixed
    // number of macrotasks is not enough on every host), then the join must not start a second download.
    await vi.waitFor(() => expect(seg9Lookups()).toBe(2));
    await nextMacrotask();
    expect(gated.started.filter((key) => key === "seg-9")).toHaveLength(1);

    gated.releaseAll();
    expect((await oldPlayback).body).toBe("payload:seg-9");
    expect((await newPlayback).body).toBe("payload:seg-9");
    await vi.waitFor(() => expect(gated.active.size).toBe(0));
    const settled = stats("settled");
    expect(settled.bytes).toBeGreaterThanOrEqual("payload:seg-9".length);

    // Served from the cache: no further seg-9 download.
    expect((await getObject("seg-9")).body).toBe("payload:seg-9");
    console.info(`${TAG} started=${JSON.stringify(gated.started)}`);
    expect(gated.started.filter((key) => key === "seg-9")).toHaveLength(1);
  });
});

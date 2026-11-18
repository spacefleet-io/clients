/**
 * @req STOR-BW-07
 * @req STOR-BW-08
 *
 * A new free playback refused by a saturated silo (503 `free_playback_refused`) and a viewer stopped by it
 * (`playback_stopped`) are final for the desktop playback server: no retry storm against a silo that said no, and the
 * main process is told, with the silo's report, so the renderer can open its dialog. Any other failure keeps the usual
 * retries and raises no hook. The report of the silo serving each request reaches the main process through the
 * download hints.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageTunnelError, type StorageTraffic } from "@space/shared/storageTunnel";

const downloadToSinkMock = vi.hoisted(() => vi.fn());

vi.mock("../src/main/forceGc", () => ({ runFullGc: () => ({ ms: 1 }) }));
vi.mock("../src/main/api", () => ({
  downloadStorageObjectViaTunnelToSink: (...args: unknown[]) => downloadToSinkMock(...args),
}));

import { PlaybackServer } from "../src/main/playbackServer";
import { setActivePlaybackProfileId } from "../src/main/activePlaybackProfile";

type Fetcher = { fetchObjectViaTunnel: (key: string) => Promise<Buffer> };

const traffic = (patch: Partial<StorageTraffic> = {}): StorageTraffic => ({
  state: "high",
  playbackBufferSeconds: 30,
  saturated: true,
  qualityCap: "480p",
  playbackStopped: false,
  ...patch,
});

const fetchSegment = (server: PlaybackServer) => (server as unknown as Fetcher).fetchObjectViaTunnel("seg-0");

describe("playback server, saturated silo (STOR-BW-07, STOR-BW-08)", () => {
  beforeEach(() => {
    // STOR-BW-11: every playback names the picked profile.
    setActivePlaybackProfileId("00000000-0000-4000-8000-000000000001");
    downloadToSinkMock.mockReset();
    vi.stubEnv("SF_PLAYBACK_OBJECT_FETCH_RETRY_DELAY_MS", "0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("raises the refusal hook once, with the silo's report, and does not retry a refused playback", async () => {
    const onPlaybackRefused = vi.fn();
    const onPlaybackStopped = vi.fn();
    const server = new PlaybackServer({ onPlaybackRefused, onPlaybackStopped });
    server.setToken("test-token");
    const report = traffic();
    downloadToSinkMock.mockRejectedValue(new StorageTunnelError(503, { error: "free_playback_refused", traffic: report }));
    await expect(fetchSegment(server)).rejects.toMatchObject({ code: "free_playback_refused" });
    expect(downloadToSinkMock).toHaveBeenCalledTimes(1);
    expect(onPlaybackRefused).toHaveBeenCalledTimes(1);
    expect(onPlaybackRefused).toHaveBeenCalledWith(report);
    expect(onPlaybackStopped).not.toHaveBeenCalled();
  });

  it("raises the stop hook once, with the silo's report, and does not retry a stopped viewer", async () => {
    const onPlaybackRefused = vi.fn();
    const onPlaybackStopped = vi.fn();
    const server = new PlaybackServer({ onPlaybackRefused, onPlaybackStopped });
    server.setToken("test-token");
    const report = traffic({ playbackStopped: true });
    downloadToSinkMock.mockRejectedValue(new StorageTunnelError(503, { error: "playback_stopped", traffic: report }));
    await expect(fetchSegment(server)).rejects.toMatchObject({ code: "playback_stopped" });
    expect(downloadToSinkMock).toHaveBeenCalledTimes(1);
    expect(onPlaybackStopped).toHaveBeenCalledTimes(1);
    expect(onPlaybackStopped).toHaveBeenCalledWith(report);
    expect(onPlaybackRefused).not.toHaveBeenCalled();
  });

  it("raises neither hook for other gateway failures", async () => {
    const onPlaybackRefused = vi.fn();
    const onPlaybackStopped = vi.fn();
    const server = new PlaybackServer({ onPlaybackRefused, onPlaybackStopped });
    server.setToken("test-token");
    downloadToSinkMock.mockRejectedValue(new StorageTunnelError(503, { error: "gateway_busy" }));
    await expect(fetchSegment(server)).rejects.toBeDefined();
    expect(onPlaybackRefused).not.toHaveBeenCalled();
    expect(onPlaybackStopped).not.toHaveBeenCalled();
  });

  it("hands the silo's reports to the main process through the download hints", async () => {
    const onPlaybackTraffic = vi.fn();
    const server = new PlaybackServer({ onPlaybackTraffic });
    server.setToken("test-token");
    downloadToSinkMock.mockImplementation(
      async (_token: string, _key: string, sink: (chunk: Uint8Array) => void | Promise<void>) => {
        await sink(new TextEncoder().encode("payload"));
      },
    );
    await fetchSegment(server);
    const options = downloadToSinkMock.mock.calls[0]?.[3] as { hints?: { onTraffic?: unknown } } | undefined;
    expect(options?.hints?.onTraffic).toBe(onPlaybackTraffic);
  });
});

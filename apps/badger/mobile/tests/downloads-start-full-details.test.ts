import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaDetails, MediaFormat } from "@space/shared/libraryTypes";

const nativeEnqueue = vi.fn();
const nativeGetStatus = vi.fn();

vi.mock("react-native", () => ({
  PermissionsAndroid: { request: vi.fn() },
  Platform: { OS: "android", Version: 30 },
  NativeModules: {},
  DeviceEventEmitter: { addListener: vi.fn() },
}));
vi.mock("@space/mobile-shell/logger", () => ({
  scopeLogger: () => ({ info: console.info, warn: console.warn, error: console.error, debug: vi.fn() }),
}));
vi.mock("../src/lib/playbackGateway", () => ({ resolveGatewayCandidates: vi.fn(async () => ["http://127.0.0.1:3003"]) }));
vi.mock("../src/lib/downloads/downloadsStore", () => ({ getDownloadsState: () => ({ items: [], networkAllowed: true, wifiOnly: false }) }));
vi.mock("@space/mobile-media-proxy/downloads", () => ({
  nativeEnqueue: (...args: unknown[]) => nativeEnqueue(...args),
  nativeGetStatus: (...args: unknown[]) => nativeGetStatus(...args),
  nativeRemove: vi.fn(),
  nativeRetry: vi.fn(),
}));

import { startDownload } from "../src/lib/downloads/downloadActions";

const format = (withChunks: boolean): MediaFormat =>
  ({
    id: "fmt-420",
    fileId: "f12",
    mediaId: "m1",
    quality: "420p",
    codec: "h264",
    bitrateKbps: 1000,
    sizeMb: 10,
    initKey: "media/p1/fmt-420/init.mp4",
    initSize: 1000,
    durationSeconds: 600,
    totalSize: null,
    chunks: withChunks ? [{ key: "media/p1/fmt-420/c0.m4s", sizeBytes: 1_000_000, startSeconds: 0 }] : [],
  }) as unknown as MediaFormat;

const details = (withChunks: boolean): MediaDetails =>
  ({
    id: "m1",
    title: "Show",
    seasons: [],
    episodes: [{ id: "e12", seasonNumber: 1, episodeNumber: 2, name: "Two" }],
    files: [{ id: "f12", filename: "s1e2", season: 1, episode: 2, desiredFormats: [] }],
    formats: [format(withChunks)],
    audioTracks: [],
    subtitleTracks: [],
    subtitles: [],
    chapters: [],
    skipMarkers: [],
  }) as unknown as MediaDetails;

describe("startDownload with chunk-less details @bugfix @regression-proof", () => {
  beforeEach(() => {
    nativeEnqueue.mockResolvedValue(true);
    nativeGetStatus.mockResolvedValue({ freeBytes: 50_000_000_000, networkType: "wifi" });
  });

  // MediaDetailsScreen loads details with `{ chunks: false }` (perf), so the planner saw no chunks and every download
  // ended with "No downloadable quality is available for this title yet." (phone, 2026-10-15).
  it("loads the full details (with chunks) before planning, so the download is enqueued", async () => {
    const loadFullDetails = vi.fn(async () => details(true));
    const result = await startDownload({
      details: details(false),
      scopes: [{ kind: "episode", seasonNumber: 1, episodeNumber: 2 }],
      token: "t",
      loadFullDetails,
      chooseQuality: vi.fn(async () => null),
    });
    console.info("startDownload result", result, "enqueue calls", nativeEnqueue.mock.calls.length);
    expect(loadFullDetails).toHaveBeenCalledWith("m1");
    expect(result.kind).toBe("enqueued");
    expect(nativeEnqueue).toHaveBeenCalledTimes(1);
  });

  it("reports an error instead of a misleading 'nothing to download' when the full details cannot be loaded", async () => {
    const result = await startDownload({
      details: details(false),
      scopes: [{ kind: "episode", seasonNumber: 1, episodeNumber: 2 }],
      token: "t",
      loadFullDetails: async () => null,
      chooseQuality: vi.fn(async () => null),
    });
    console.info("startDownload result", result);
    expect(result.kind).toBe("error");
    expect(nativeEnqueue).not.toHaveBeenCalled();
  });
});

// @req OFFL-QUAL-01[badger-mobile]
describe("OFFL-QUAL-01 startDownload asks the quality when there is more than one", () => {
  const twoQualities = (): MediaDetails => {
    const d = details(true);
    const hi = {
      ...format(true),
      id: "fmt-1080",
      quality: "1080p",
      initKey: "media/p1/fmt-1080/init.mp4",
      chunks: [{ key: "media/p1/fmt-1080/c0.m4s", sizeBytes: 4_000_000, startSeconds: 0 }],
    };
    return { ...d, formats: [hi as MediaFormat, ...d.formats] };
  };
  const scopes = [{ kind: "episode", seasonNumber: 1, episodeNumber: 2 }] as const;

  beforeEach(() => {
    nativeEnqueue.mockReset();
    nativeEnqueue.mockResolvedValue(true);
    nativeGetStatus.mockResolvedValue({ freeBytes: 50_000_000_000, networkType: "wifi" });
  });

  it("OFFL-QUAL-01 prompts once with every quality and size, and downloads the picked one", async () => {
    console.info("[OFFL-QUAL-01 start pick] phase=start");
    const chooseQuality = vi.fn(async () => "420p");
    const result = await startDownload({ details: twoQualities(), scopes, token: "t", loadFullDetails: async () => twoQualities(), chooseQuality });
    console.info("[OFFL-QUAL-01 start pick] result", result, "choices", JSON.stringify(chooseQuality.mock.calls), "enqueue", JSON.stringify(nativeEnqueue.mock.calls));
    expect(chooseQuality).toHaveBeenCalledTimes(1);
    const choices = (chooseQuality.mock.calls[0] as unknown[])[0] as Array<{ quality: string; totalBytes: number }>;
    expect(choices.map((c) => c.quality)).toEqual(["1080p", "420p"]);
    expect(choices[0]!.totalBytes).toBeGreaterThan(choices[1]!.totalBytes);
    expect(result.kind).toBe("enqueued");
    expect(JSON.stringify(nativeEnqueue.mock.calls)).toContain("fmt-420");
    expect(JSON.stringify(nativeEnqueue.mock.calls)).not.toContain("fmt-1080");
  });

  it("OFFL-QUAL-01 closing the prompt cancels the download", async () => {
    const result = await startDownload({ details: twoQualities(), scopes, token: "t", loadFullDetails: async () => twoQualities(), chooseQuality: async () => null });
    console.info("[OFFL-QUAL-01 start cancel] result", result);
    expect(result.kind).toBe("cancelled");
    expect(nativeEnqueue).not.toHaveBeenCalled();
  });

  it("OFFL-QUAL-01 a single quality starts without a prompt", async () => {
    const chooseQuality = vi.fn(async () => null);
    const result = await startDownload({ details: details(true), scopes, token: "t", loadFullDetails: async () => details(true), chooseQuality });
    console.info("[OFFL-QUAL-01 start single] result", result);
    expect(chooseQuality).not.toHaveBeenCalled();
    expect(result.kind).toBe("enqueued");
  });
});

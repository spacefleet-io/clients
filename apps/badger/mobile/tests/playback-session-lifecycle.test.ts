/**
 * @test-id MOBILE-PLAYBACK-SESSION-LIFECYCLE-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists (usePlayerSession):
 *  1. Every remote `media.upsert` flips the library `datasetStatus` and hands
 *     out a new `awaitDatasetReady` identity. Those were effect dependencies,
 *     so a library sync DURING playback tore the session down (stopProxy),
 *     went back to IDLE and reloaded from the stale resume point.
 *  2. Backing out while `startProxy` was still resolving never stopped the
 *     proxy (the `proxyStarted` flag was set after the await), so the native
 *     server leaked and served the next title with the old data source.
 *
 * Mounts the real hook with react-test-renderer around mocked deps (no React
 * Native runtime needed).
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayerSession, type PlayerSession } from "../src/screens/player/usePlayerSession";
import { setViewingScope } from "../src/lib/profiles/activeViewingScope";

const TAG = "[playback-session-lifecycle]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const bridge = {
  startProxyCalls: 0,
  stopProxyCalls: 0,
  /** When set, startProxy waits for this promise before resolving. */
  startGate: null as Promise<void> | null,
};

type DatasetStatus = { core: boolean; metadata: boolean; playback: boolean };

/** Stable identities between changes (like the real provider); a db change hands out new ones. */
const buildLibraryValue = (datasetStatus: DatasetStatus) => ({
  getMediaDetails: async () => {
    library.detailsCalls += 1;
    return details;
  },
  getPlaybackChunks: async () => ({ formats: { fm1: [{ key: "media/placement-1/c0", sizeBytes: null, startSeconds: null }] }, audio: {} }),
  getPlayableTrackIds: async () => ["fm1"],
  getEpisodeResumeMap: async () => ({}),
  getTrackPrefs: async () => null,
  awaitDatasetReady: async () => undefined,
  datasetStatus,
});

const library = {
  detailsCalls: 0,
  value: buildLibraryValue({ core: true, metadata: true, playback: true }),
  change(datasetStatus: DatasetStatus) {
    library.value = buildLibraryValue(datasetStatus);
  },
};

const details = {
  type: "movie",
  files: [{ id: "f1" }],
  formats: [{ id: "fm1", fileId: "f1", durationSeconds: 100, initKey: "media/placement-1/init", chunks: [{ key: "media/placement-1/c0" }] }],
  audioTracks: [],
  subtitleTracks: [],
  chapters: [],
  skipMarkers: [],
  episodes: [],
  progressPct: 0,
};

vi.mock("@space/mobile-mpv-playback", () => ({
  PlaybackBridge: {
    startProxy: async () => {
      bridge.startProxyCalls += 1;
      if (bridge.startGate) await bridge.startGate;
      return "http://127.0.0.1:1/master.m3u8";
    },
    stopProxy: async () => {
      bridge.stopProxyCalls += 1;
      return true;
    },
  },
}));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ token: "token" }) }));
vi.mock("../src/store/library", () => ({
  useLibraryActions: () => library.value,
  useLibraryStatus: () => library.value,
}));
const loadingModal = { showLoading: () => "modal", hideLoading: () => undefined };
vi.mock("../src/components/LoadingModalProvider", () => ({
  useLoadingModal: () => loadingModal,
}));
vi.mock("../src/lib/resume", () => ({ setLastPlayedEpisodeId: async () => undefined }));
vi.mock("../src/lib/onboarding", () => ({ getStoredLibraryKey: async () => "key" }));
// The account's stream limit (ACCT-STREAM) is proven in stream-slot-phone.test.ts; here a place is always free.
vi.mock("../src/lib/playback/streamSlot", () => ({ acquireStream: async () => "play", onStreamTakenOver: () => () => undefined, streamSlots: { release: async () => undefined } }));
vi.mock("../src/lib/playbackGateway", () => ({ resolveGatewayCandidates: async () => ["https://gw"] }));
vi.mock("../src/lib/downloads/offlinePlayback", () => ({
  resolveOfflinePlayback: async () => null,
  filterToDownloadedFormat: () => [],
}));
vi.mock("../src/lib/playback/ingestMetadata", () => ({
  buildIngestMetadata: () => ({ videos: [{ id: "v1", durationSeconds: 100 }], audio: [], subtitles: [], chapters: [] }),
}));
vi.mock("../src/lib/playback/nextEpisode", () => ({
  selectMarkersForPlayback: () => [],
}));
vi.mock("@space/shared/playableEpisodes", () => ({
  getNextPlayableEpisode: () => null,
  getPreviousPlayableEpisode: () => null,
}));

let latest: PlayerSession | null = null;
const Harness = ({ revision }: { revision: number }) => {
  latest = usePlayerSession("media-1", null);
  void revision;
  return null;
};

const flush = async () => {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  // STOR-BW-11: streaming playback needs an active profile.
  setViewingScope({ profileId: "profile-main", prefix: "" });
  bridge.startProxyCalls = 0;
  bridge.stopProxyCalls = 0;
  bridge.startGate = null;
  library.change({ core: true, metadata: true, playback: true });
  library.detailsCalls = 0;
  latest = null;
  // React's act() reads this flag off the global; the global type has no such field.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation((...a) => { console.info("WARN", ...a); });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("usePlayerSession lifecycle", () => {
  it("@bugfix @regression-proof a library datasetStatus change mid-playback does not restart the session", async () => {
    await act(async () => {
      renderer = create(React.createElement(Harness, { revision: 0 }));
    });
    await flush();
    expect(latest?.phase).toBe("ready");
    expect(bridge.startProxyCalls).toBe(1);

    // A remote media.upsert lands: datasetStatus flips (and identities change).
    library.change({ core: true, metadata: false, playback: false });
    await act(async () => renderer?.update(React.createElement(Harness, { revision: 1 })));
    await flush();
    library.change({ core: true, metadata: true, playback: true });
    await act(async () => renderer?.update(React.createElement(Harness, { revision: 2 })));
    await flush();

    log("after datasetStatus flips", { phase: latest?.phase, startProxy: bridge.startProxyCalls, stopProxy: bridge.stopProxyCalls, detailsCalls: library.detailsCalls });
    expect(bridge.stopProxyCalls, "the proxy must stay up while the library syncs").toBe(0);
    expect(bridge.startProxyCalls, "the session must not reload from the stale resume point").toBe(1);
    expect(latest?.phase).toBe("ready");
  });

  it("@bugfix @regression-proof unmounting while startProxy is still resolving stops the proxy that then comes up", async () => {
    const gate = Promise.withResolvers<void>();
    bridge.startGate = gate.promise;
    await act(async () => {
      renderer = create(React.createElement(Harness, { revision: 0 }));
    });
    await flush();
    expect(bridge.startProxyCalls).toBe(1);

    act(() => renderer?.unmount());
    renderer = null;
    gate.resolve();
    await flush();
    log("unmounted before startProxy resolved", { stopProxy: bridge.stopProxyCalls });
    expect(bridge.stopProxyCalls, "the leaked proxy must be stopped once it resolves").toBe(1);
  });
});

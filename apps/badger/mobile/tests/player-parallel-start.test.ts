/**
 * @test-id PLAYER-PARALLEL-START-001
 * @level unit
 *
 * #934 (port of desktop #928): the phone/TV player (`usePlayerSession`) starts the reads a play start waits on
 * together instead of one after another:
 *  - the library key read and the playback dataset wait start at once; the resume map and track prefs start as soon
 *    as the dataset is ready, while the key read may still be running,
 *  - the gateway lookup starts before the offline check answers; a file that plays from disk ignores it,
 *  - failures keep their order and codes: no library key -> `missingLibraryKey` before anything else is read,
 *    a failed gateway lookup on a streamed file -> `gatewayUnavailable`.
 *
 * Mounts the real hook around mocked library/native deps; each read is a promise the test resolves by hand.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

const ctl = vi.hoisted(() => {
  const deferred = <T,>(): Deferred<T> => Promise.withResolvers<T>();
  return {
    deferred,
    calls: [] as string[],
    key: null as unknown as Deferred<string | null>,
    dataset: null as unknown as Deferred<void>,
    gateway: null as unknown as Deferred<string[]>,
    offline: null as unknown as Deferred<unknown>,
    offlineFormats: [] as unknown[],
    startProxyConfigs: [] as unknown[],
  };
});

const show = {
  type: "tv",
  files: [{ id: "f1", season: 1, episode: 1 }],
  formats: [{ id: "fm1", fileId: "f1", durationSeconds: 100, initKey: "media/placement-1/init", chunks: [] }],
  audioTracks: [],
  subtitleTracks: [],
  chapters: [],
  skipMarkers: [],
  episodes: [{ id: "ep1", seasonNumber: 1, episodeNumber: 1 }],
  progressPct: 0,
};

const libraryValue = {
  getMediaDetails: async () => {
    ctl.calls.push("details");
    return show;
  },
  getPlaybackChunks: async () => ({ formats: { fm1: [{ key: "media/placement-1/c0", sizeBytes: null, startSeconds: null }] }, audio: {} }),
  getPlayableTrackIds: async () => ["fm1"],
  getEpisodeResumeMap: async () => {
    ctl.calls.push("resumeMap");
    return {};
  },
  getTrackPrefs: async () => {
    ctl.calls.push("trackPrefs");
    return null;
  },
  awaitDatasetReady: () => {
    ctl.calls.push("datasetWait");
    return ctl.dataset.promise;
  },
  datasetStatus: { core: true, metadata: true, playback: true },
};

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
vi.mock("@space/mobile-mpv-playback", () => ({
  PlaybackBridge: {
    startProxy: async (args: { config: unknown }) => {
      ctl.startProxyConfigs.push(args.config);
      return "http://127.0.0.1:1/master.m3u8";
    },
    stopProxy: async () => true,
  },
}));
vi.mock("@space/mobile-shell/i18n", () => ({ translate: (key: string) => key }));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ token: "token" }) }));
vi.mock("../src/store/library", () => ({ useLibraryActions: () => libraryValue, useLibraryStatus: () => libraryValue }));
vi.mock("../src/components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({ showLoading: () => "modal", hideLoading: () => undefined }),
}));
vi.mock("../src/lib/resume", () => ({ setLastPlayedEpisodeId: async () => undefined, reconcileResumeHints: async () => undefined }));
vi.mock("../src/lib/onboarding", () => ({
  getStoredLibraryKey: () => {
    ctl.calls.push("key");
    return ctl.key.promise;
  },
}));
// The account's stream limit (ACCT-STREAM) is proven in stream-slot-phone.test.ts; here a place is always free.
vi.mock("../src/lib/playback/streamSlot", () => ({ acquireStream: async () => "play", onStreamTakenOver: () => () => undefined, streamSlots: { release: async () => undefined } }));
vi.mock("../src/lib/playbackGateway", () => ({
  resolveGatewayCandidates: () => {
    ctl.calls.push("gateway");
    return ctl.gateway.promise;
  },
}));
vi.mock("../src/lib/downloads/offlinePlayback", () => ({
  resolveOfflinePlayback: () => {
    ctl.calls.push("offline");
    return ctl.offline.promise;
  },
  filterToDownloadedFormat: () => ctl.offlineFormats,
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

import { usePlayerSession, type PlayerSession } from "../src/screens/player/usePlayerSession";
import { setViewingScope } from "../src/lib/profiles/activeViewingScope";
import { clearPlayStartWarm } from "../src/lib/playback/playStartCache";
import { MAIN_VIEWING_SCOPE } from "@space/shared/profileViewing";

const TAG = "[player-parallel-start]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

let latest: PlayerSession | null = null;
const Harness = () => {
  latest = usePlayerSession("show-1", "ep1");
  return null;
};
let renderer: ReactTestRenderer | null = null;

const flush = async () => {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const mount = async () => {
  await act(async () => {
    renderer = create(React.createElement(Harness));
  });
  await flush();
};

beforeEach(() => {
  clearPlayStartWarm();
  ctl.calls = [];
  ctl.key = ctl.deferred();
  ctl.dataset = ctl.deferred();
  ctl.gateway = ctl.deferred();
  ctl.offline = ctl.deferred();
  ctl.offlineFormats = [];
  ctl.startProxyConfigs = [];
  latest = null;
  setViewingScope({ ...MAIN_VIEWING_SCOPE, profileId: "profile-main" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
  setViewingScope(MAIN_VIEWING_SCOPE);
});

describe("@req PLAY-ABR-05[badger-mobile,badger-tv] the player starts its reads together", () => {
  it("@req PLAY-ABR-05[badger-mobile,badger-tv] key, dataset wait, resume map and track prefs run while the key read is pending", async () => {
    await mount();
    log("phase.mounted", ctl.calls);
    expect(ctl.calls).toEqual(expect.arrayContaining(["key", "datasetWait"]));

    ctl.dataset.resolve();
    await flush();
    log("phase.dataset-ready", ctl.calls);
    expect(ctl.calls).toEqual(expect.arrayContaining(["resumeMap", "trackPrefs"]));
    expect(ctl.calls).not.toContain("details");

    ctl.key.resolve("a2V5");
    await flush();
    log("phase.key-read", ctl.calls);
    expect(ctl.calls).toContain("details");
  });

  it("@req PLAY-ABR-05[badger-mobile,badger-tv] the gateway lookup starts before the offline check answers", async () => {
    ctl.dataset.resolve();
    ctl.key.resolve("a2V5");
    await mount();
    log("phase.offline-pending", ctl.calls);
    expect(ctl.calls).toContain("offline");
    expect(ctl.calls).toContain("gateway");
    expect(ctl.calls.indexOf("gateway")).toBeLessThan(ctl.calls.indexOf("offline"));

    ctl.offline.resolve(null);
    ctl.gateway.resolve(["https://gw"]);
    await flush();
    log("phase.started", { phase: latest?.phase, configs: ctl.startProxyConfigs });
    expect(latest?.phase).toBe("ready");
    expect(ctl.startProxyConfigs[0]).toMatchObject({ clientKind: "storage-tunnel", gatewayBaseUrls: ["https://gw"], profileId: "profile-main" });
  });

  it("@req PLAY-ABR-05[badger-mobile,badger-tv] a file on disk plays offline and ignores a failed gateway lookup", async () => {
    ctl.dataset.resolve();
    ctl.key.resolve("a2V5");
    ctl.offlineFormats = [{ id: "fm1", fileId: "f1", durationSeconds: 100 }];
    await mount();
    ctl.gateway.reject(new Error("offline: no network"));
    ctl.offline.resolve({ fileId: "f1" });
    await flush();
    log("phase.offline", { phase: latest?.phase, error: latest?.error, configs: ctl.startProxyConfigs });
    expect(latest?.error).toBeNull();
    expect(ctl.startProxyConfigs).toEqual([{ clientKind: "offline" }]);
  });

  it("@req PLAY-ABR-05[badger-mobile,badger-tv] a failed gateway lookup on a streamed file still ends in gatewayUnavailable", async () => {
    ctl.dataset.resolve();
    ctl.key.resolve("a2V5");
    await mount();
    ctl.gateway.reject(new Error("503"));
    ctl.offline.resolve(null);
    await flush();
    log("phase.gateway-failed", { phase: latest?.phase, error: latest?.error });
    expect(latest?.phase).toBe("error");
    expect(latest?.error).toBe("gatewayUnavailable");
    expect(ctl.startProxyConfigs).toEqual([]);
  });

  it("@req PLAY-ABR-05[badger-mobile,badger-tv] no library key fails first: details, offline check and gateway are never read", async () => {
    ctl.dataset.resolve();
    ctl.key.resolve(null);
    await mount();
    log("phase.no-key", { phase: latest?.phase, error: latest?.error, calls: ctl.calls });
    expect(latest?.error).toBe("missingLibraryKey");
    expect(ctl.calls).not.toContain("details");
    expect(ctl.calls).not.toContain("offline");
    expect(ctl.calls).not.toContain("gateway");
  });
});

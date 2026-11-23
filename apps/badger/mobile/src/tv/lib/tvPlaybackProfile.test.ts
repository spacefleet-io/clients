/**
 * @test-id TV-PLAYBACK-PROFILE-001
 * @level unit
 *
 * STOR-BW-11 on the TV: the TV's `Player` route is the shared `PlayerScreen` / `usePlayerSession`, and the TV runs its
 * profile session with `askEveryStart: true` (`useProfileSession(IS_TV)`). A single-profile account is never asked
 * "Who's watching?", and its playback still names the MAIN profile's real API id: in the native proxy's config (the
 * `POST /storage/tunnel/session` body) and in the traffic poll. A TV still waiting on "Who's watching?" starts nothing.
 *
 * @req STOR-BW-11[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiProfile } from "@space/shared/profiles";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

const ctl = vi.hoisted(() => ({ startProxyConfigs: [] as unknown[] }));

const details = {
  type: "movie",
  files: [{ id: "f1" }],
  formats: [{ id: "fm1", fileId: "f1", durationSeconds: 100, initKey: "media/placement-1/init", chunks: [] }],
  audioTracks: [],
  subtitleTracks: [],
  chapters: [],
  skipMarkers: [],
  episodes: [],
  progressPct: 0,
};

const libraryValue = {
  getMediaDetails: async () => details,
  getPlaybackChunks: async () => ({ formats: { fm1: [{ key: "media/placement-1/c0", sizeBytes: null, startSeconds: null }] }, audio: {} }),
  getPlayableTrackIds: async () => ["fm1"],
  getEpisodeResumeMap: async () => ({}),
  getTrackPrefs: async () => null,
  awaitDatasetReady: async () => undefined,
  datasetStatus: { core: true, metadata: true, playback: true },
};

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
vi.mock("../../store/auth", () => ({ useAuth: () => ({ token: "tv-token" }) }));
vi.mock("../../store/library", () => ({ useLibraryActions: () => libraryValue, useLibraryStatus: () => libraryValue }));
vi.mock("../../components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({ showLoading: () => "modal", hideLoading: () => undefined }),
}));
vi.mock("../../lib/resume", () => ({ setLastPlayedEpisodeId: async () => undefined, reconcileResumeHints: async () => undefined }));
vi.mock("../../lib/onboarding", () => ({ getStoredLibraryKey: async () => "key" }));
// The account's stream limit (ACCT-STREAM) has its own tests; here a place is always free.
vi.mock("../../lib/playback/streamSlot", () => ({ acquireStream: async () => "play", onStreamTakenOver: () => () => undefined, streamSlots: { release: async () => undefined } }));
vi.mock("../../lib/playbackGateway", () => ({ resolveGatewayCandidates: async () => ["https://tv-gw"] }));
vi.mock("../../lib/downloads/offlinePlayback", () => ({
  resolveOfflinePlayback: async () => null,
  filterToDownloadedFormat: () => [],
}));
vi.mock("../../lib/playback/ingestMetadata", () => ({
  buildIngestMetadata: () => ({ videos: [{ id: "v1", durationSeconds: 100 }], audio: [], subtitles: [], chapters: [] }),
}));
vi.mock("../../lib/playback/nextEpisode", () => ({
  selectMarkersForPlayback: () => [],
}));
vi.mock("@space/shared/playableEpisodes", () => ({
  getNextPlayableEpisode: () => null,
  getPreviousPlayableEpisode: () => null,
}));

import { usePlayerSession, type PlayerSession } from "../../screens/player/usePlayerSession";
import { createProfileStore } from "../../lib/profiles/profileStore";
import { getViewingScope, setViewingScope } from "../../lib/profiles/activeViewingScope";
import { MAIN_VIEWING_SCOPE, viewingScopeFor } from "@space/shared/profileViewing";

const TAG = "[tv-playback-profile]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const MAIN_ID = "a3b2c1d0-1e2f-4a5b-8c7d-9e0f1a2b3c4d";
const OTHER_ID = "b4c3d2e1-2f3a-4b5c-9d8e-0f1a2b3c4d5e";

const profile = (id: string, minute: number, isMain: boolean): ApiProfile => ({
  id,
  name: id.slice(0, 4),
  avatar: minute % 8,
  avatarId: "fox" as const,
  createdAt: `2026-10-22T09:${String(minute).padStart(2, "0")}:00.000Z`,
  isMain,
});

/** One TV start (`askEveryStart: true`), wired to the real viewing scope the player reads. */
const startTvProfiles = async (list: ApiProfile[]) => {
  const storage = new Map<string, string>();
  const store = createProfileStore({
    storage: {
      getItem: async (key) => storage.get(key) ?? null,
      setItem: async (key, value) => {
        storage.set(key, value);
      },
      removeItem: async (key) => {
        storage.delete(key);
      },
    },
    api: {
      list: async () => ({ profiles: list, maxProfiles: 5 }),
      create: async () => {
        throw new Error("not used");
      },
      update: async () => {
        throw new Error("not used");
      },
      remove: async () => {
        throw new Error("not used");
      },
    },
    applyScope: (active) => setViewingScope(viewingScopeFor(active)),
    reconcileResumeHints: async () => undefined,
    log: (event, data) => log(`store.${event}`, data),
  });
  await store.startSession({ userId: "tv-user", token: "tv-token", askEveryStart: true });
  log("profiles.started", { snapshot: store.getSnapshot(), scope: getViewingScope() });
  return store;
};

let latest: PlayerSession | null = null;
const Harness = () => {
  latest = usePlayerSession("media-1", null);
  return null;
};
let renderer: ReactTestRenderer | null = null;

const loadSession = async (): Promise<PlayerSession> => {
  await act(async () => {
    renderer = create(React.createElement(Harness));
  });
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  if (!latest) throw new Error("the session hook never rendered");
  return latest;
};

const fetchedUrls: string[] = [];

beforeEach(() => {
  ctl.startProxyConfigs = [];
  latest = null;
  fetchedUrls.length = 0;
  setViewingScope(MAIN_VIEWING_SCOPE);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    fetchedUrls.push(String(input));
    return new Response(JSON.stringify({ traffic: { state: "normal" } }), { status: 200, headers: { "content-type": "application/json" } });
  });
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
  setViewingScope(MAIN_VIEWING_SCOPE);
});

describe("@req STOR-BW-11[badger-tv] TV playback carries the active profile id", () => {
  it("@req STOR-BW-11[badger-tv] single-profile account on the TV: never asked, plays as the MAIN profile's real API id", async () => {
    log("phase.setup single-profile tv");
    const store = await startTvProfiles([profile(MAIN_ID, 0, true)]);
    expect(store.getSnapshot().needsChoice).toBe(false);
    const session = await loadSession();
    log("phase.loaded", { phase: session.phase, error: session.error, configs: ctl.startProxyConfigs });
    expect(session.phase).toBe("ready");
    expect(ctl.startProxyConfigs).toEqual([
      expect.objectContaining({ clientKind: "storage-tunnel", gatewayBaseUrls: ["https://tv-gw"], profileId: MAIN_ID }),
    ]);
    await session.fetchTraffic?.();
    log("phase.traffic-polled", { fetchedUrls });
    expect(fetchedUrls).toEqual([`https://tv-gw/storage/traffic?profileId=${MAIN_ID}`]);
  });

  it("@req STOR-BW-11[badger-tv] a TV still on \"Who's watching?\" starts no playback request", async () => {
    log("phase.setup two-profiles tv");
    const store = await startTvProfiles([profile(MAIN_ID, 0, true), profile(OTHER_ID, 5, false)]);
    expect(store.getSnapshot().needsChoice).toBe(true);
    const session = await loadSession();
    log("phase.loaded", { phase: session.phase, error: session.error, configs: ctl.startProxyConfigs, fetchedUrls });
    expect(session.phase).toBe("error");
    expect(ctl.startProxyConfigs).toEqual([]);
    expect(fetchedUrls).toEqual([]);
  });
});

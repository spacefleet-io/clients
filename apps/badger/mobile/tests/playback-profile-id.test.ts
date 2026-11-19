/**
 * @test-id PLAYBACK-PROFILE-ID-001
 * @level unit
 *
 * STOR-BW-11: every playback request names the profile it is for. The phone player (`usePlayerSession`, shared by the
 * TV's `Player` route) reads the active profile from the profile store's viewing scope and:
 *  - hands its API id to the native proxy (`StartProxyConfig.profileId`), which puts it in the
 *    `POST /storage/tunnel/session` body for `purpose: "playback"`,
 *  - appends it to the fallback traffic poll (`GET /storage/traffic?profileId=…`),
 *  - on a single-profile account sends the MAIN profile's real API id (its library keys are unprefixed, but the wire
 *    still carries the id), never null or a placeholder,
 *  - with no active profile resolved, starts nothing: no proxy, no request, an error on screen.
 *
 * Mounts the real hook and the real profile store (fake API + storage) around mocked library/native deps.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

const ctl = vi.hoisted(() => ({
  startProxyConfigs: [] as unknown[],
  stopProxyCalls: 0,
}));

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
    stopProxy: async () => {
      ctl.stopProxyCalls += 1;
      return true;
    },
  },
}));
vi.mock("@space/mobile-shell/i18n", () => ({ translate: (key: string) => key }));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ token: "token" }) }));
vi.mock("../src/store/library", () => ({ useLibraryActions: () => libraryValue, useLibraryStatus: () => libraryValue }));
vi.mock("../src/components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({ showLoading: () => "modal", hideLoading: () => undefined }),
}));
vi.mock("../src/lib/resume", () => ({ setLastPlayedEpisodeId: async () => undefined, reconcileResumeHints: async () => undefined }));
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

import { usePlayerSession, type PlayerSession } from "../src/screens/player/usePlayerSession";
import { createProfileStore } from "../src/lib/profiles/profileStore";
import { getViewingScope, setViewingScope } from "../src/lib/profiles/activeViewingScope";
import { MAIN_VIEWING_SCOPE, viewingScopeFor } from "@space/shared/profileViewing";

const TAG = "[playback-profile-id]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const MAIN_ID = "6f1c2a7e-0b4d-4e7a-9a51-3c2d1e0f9a11";
const KID_ID = "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f62";

const profile = (id: string, minute: number, isMain: boolean): ApiProfile => ({
  id,
  name: id.slice(0, 4),
  avatar: minute % 8,
  avatarId: "fox" as const,
  createdAt: `2026-10-22T09:${String(minute).padStart(2, "0")}:00.000Z`,
  isMain,
  features: {},
});

/** The app's profile session over a fake API, wired to the real viewing scope the player reads. */
const startProfiles = async (list: ApiProfile[], askEveryStart: boolean) => {
  const storage = new Map<string, string>();
  const response: ProfilesResponse = { profiles: list, maxProfiles: 5 };
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
      list: async () => response,
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
  await store.startSession({ userId: "user-1", token: "token", askEveryStart });
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
  ctl.stopProxyCalls = 0;
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

describe("@req STOR-BW-11[badger-mobile] playback requests carry the active profile id", () => {
  it("@req STOR-BW-11[badger-mobile] single-profile account: the proxy and the traffic poll carry the MAIN profile's real API id", async () => {
    log("phase.setup single-profile");
    await startProfiles([profile(MAIN_ID, 0, true)], false);
    const session = await loadSession();
    log("phase.loaded", { phase: session.phase, error: session.error, configs: ctl.startProxyConfigs });
    expect(session.phase).toBe("ready");
    expect(ctl.startProxyConfigs).toHaveLength(1);
    expect(ctl.startProxyConfigs[0]).toMatchObject({ clientKind: "storage-tunnel", profileId: MAIN_ID });

    log("phase.traffic-poll");
    await session.fetchTraffic?.();
    log("phase.traffic-polled", { fetchedUrls });
    expect(fetchedUrls).toEqual([`https://gw/storage/traffic?profileId=${MAIN_ID}`]);
  });

  it("@req STOR-BW-11[badger-mobile] two profiles: the profile picked in \"Who's watching?\" is the one sent", async () => {
    log("phase.setup two-profiles");
    const store = await startProfiles([profile(MAIN_ID, 0, true), profile(KID_ID, 5, false)], true);
    expect(store.getSnapshot().needsChoice).toBe(true);
    await store.selectProfile(KID_ID);
    log("phase.selected", { activeId: store.getSnapshot().activeId, scope: getViewingScope() });
    const session = await loadSession();
    log("phase.loaded", { phase: session.phase, configs: ctl.startProxyConfigs });
    expect(ctl.startProxyConfigs[0]).toMatchObject({ clientKind: "storage-tunnel", profileId: KID_ID });
    await session.fetchTraffic?.();
    log("phase.traffic-polled", { fetchedUrls });
    expect(fetchedUrls).toEqual([`https://gw/storage/traffic?profileId=${KID_ID}`]);
  });

  it("@req STOR-BW-11[badger-mobile] no active profile: nothing is started and no request is made", async () => {
    log("phase.setup no-active-profile");
    const store = await startProfiles([profile(MAIN_ID, 0, true), profile(KID_ID, 5, false)], true);
    log("phase.state", { activeId: store.getSnapshot().activeId, scope: getViewingScope() });
    expect(store.getSnapshot().activeId).toBeNull();
    const session = await loadSession();
    log("phase.loaded", { phase: session.phase, error: session.error, configs: ctl.startProxyConfigs, fetchedUrls });
    expect(session.phase).toBe("error");
    expect(session.error).toBe("startFailed");
    expect(ctl.startProxyConfigs).toEqual([]);
    expect(fetchedUrls).toEqual([]);
  });
});

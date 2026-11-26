/**
 * ACCT-UNPAID-03 / ACCT-UNPAID-02: when an unpaid account's player fails, the error overlay names the unpaid
 * cause only for a streamed title (the gateway refuses it with 402). A downloaded title plays from disk, never
 * reaches the gateway, and keeps its real cause, also when it fails before the session is ready.
 *
 * Mounts the real `usePlayerSession` hook around mocked native and library deps, then feeds the session it
 * returns into the same `playerFailureMessage` call the player screen makes.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import type { AccountAccess } from "@space/shared/accountAccess";
import { translate } from "@space/mobile-shell/i18n";
import en from "@space/mobile-shell/i18n/en.json";
import { usePlayerSession, type PlayerSession } from "../src/screens/player/usePlayerSession";
import { setViewingScope } from "../src/lib/profiles/activeViewingScope";
import { playerFailureMessage } from "@space/mobile-shell/unpaid-access";

const ctl = vi.hoisted(() => ({ downloaded: false, startProxyFails: false }));

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
    startProxy: async () => {
      if (ctl.startProxyFails) throw new Error("proxy did not start");
      return "http://127.0.0.1:1/master.m3u8";
    },
    stopProxy: async () => true,
  },
}));
// vi.mock factories are hoisted above every import, so this one loads the dictionary itself.
vi.mock("@space/mobile-shell/i18n", async () => {
  const enDict = (await import("@space/mobile-shell/i18n/en.json")).default;
  await i18next.init({
    resources: { en: { translation: enDict } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
  return { translate: (key: string, options?: Record<string, unknown>) => i18next.t(key, options) };
});
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ token: "token" }) }));
vi.mock("../src/store/library", () => ({ useLibraryActions: () => libraryValue, useLibraryStatus: () => libraryValue }));
vi.mock("../src/components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({ showLoading: () => "modal", hideLoading: () => undefined }),
}));
vi.mock("../src/lib/resume", () => ({ setLastPlayedEpisodeId: async () => undefined }));
vi.mock("../src/lib/onboarding", () => ({ getStoredLibraryKey: async () => "key" }));
// The account's stream limit (ACCT-STREAM) is proven in stream-slot-phone.test.ts; here a place is always free.
vi.mock("../src/lib/playback/streamSlot", () => ({ acquireStream: async () => "play", onStreamTakenOver: () => () => undefined, streamSlots: { release: async () => undefined } }));
vi.mock("../src/lib/playbackGateway", () => ({ resolveGatewayCandidates: async () => ["https://gw"] }));
vi.mock("../src/lib/downloads/offlinePlayback", () => ({
  resolveOfflinePlayback: async () => (ctl.downloaded ? { fileId: "f1" } : null),
  filterToDownloadedFormat: <T>(formats: T[]) => (ctl.downloaded ? formats : []),
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

const NOW = Date.parse("2026-10-20T12:00:00Z");
const unpaid: AccountAccess = {
  state: "unpaid",
  paidUntil: "2026-10-17T12:00:00.000Z",
  billingPeriod: "monthly",
  wipeAt: "2026-12-16T12:00:00.000Z",
  qosTier: "free",
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

/** What the player screen's error overlay shows for this session (PlayerScreen `failureText`). */
const overlayText = (session: PlayerSession) =>
  playerFailureMessage(translate, session.error ?? "unavailable", unpaid, "en", NOW, { offline: session.offline });

beforeEach(() => {
  // STOR-BW-11: streaming playback needs an active profile.
  setViewingScope({ profileId: "profile-main", prefix: "" });
  ctl.downloaded = false;
  ctl.startProxyFails = false;
  latest = null;
  // React's act() reads this flag off the global; the global type has no such field.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

describe("player failure text for an unpaid account", () => {
  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("a downloaded title that fails to start keeps its real cause", async () => {
    ctl.downloaded = true;
    ctl.startProxyFails = true;
    const session = await loadSession();
    console.info("downloaded title failed", { phase: session.phase, error: session.error, offline: session.offline });
    expect(session.phase).toBe("error");
    expect(session.error).toBe("startFailed");
    expect(overlayText(session)).toBe(en.player.error.startFailed);
  });

  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("a streamed title that fails to start names the unpaid cause and the wipe date", async () => {
    ctl.startProxyFails = true;
    const session = await loadSession();
    const text = overlayText(session);
    console.info("streamed title failed", { phase: session.phase, error: session.error, offline: session.offline, text });
    expect(session.phase).toBe("error");
    expect(text).toMatch(/^Playback is stopped because your subscription ended\./);
    expect(text).toContain("2026");
  });

  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("a downloaded title that loaded marks the session as playing from disk", async () => {
    ctl.downloaded = true;
    const session = await loadSession();
    expect(session.phase).toBe("ready");
    expect(session.offline).toBe(true);
  });
});

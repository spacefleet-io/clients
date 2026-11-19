/**
 * @test-id MOBILE-PLAYER-SCREEN-PLAYBACK-001
 * @level component
 * @regression-proof
 *
 * The real `PlayerScreen` rendered against a fake mpv (snapshots, loads, pause) and a fake clock:
 *  - PLAY-OPEN-01: the title's picture covers the player from open until the first video frame, and never comes back
 *    afterwards (a quality switch or a rebuffer has no frame for a moment either);
 *  - PLAY-ABR-04: a failure raised while a quality switch retries stops playback: mpv is paused behind the error, the
 *    switch never reloads the player again, and Retry reloads the session; Auto never switches on the very poll that
 *    raises the failure; Retry cancels a switch started under the error overlay.
 *  - PLAY-OVL-03: the centre Previous episode button saves where the viewer left the episode (not watched); Next
 *    episode still saves it as finished.
 *  - PLAY-RESUME-01: the resume prompt (Resume / Start over) appears only when the shared rule offers a position (2 %
 *    AND 15 s watched); below it the player starts at 0 with no prompt. Resume starts mpv at the offered position.
 * Only the boundaries are faked (native module, navigation, session loader, library store, settings); every playback
 * decision (health checks, quality switch machine, Auto) is the production code.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackSnapshot } from "@space/mobile-mpv-playback";
import type { StorageTraffic } from "@space/shared/storageTunnel";
import type { PlayerSession } from "../src/screens/player/usePlayerSession";
import { PlayerScreen } from "../src/screens/PlayerScreen";
import { resolveResumeCandidateSeconds } from "@space/shared/playbackResume";

const LOG = "[player-screen]";
const PLAY_URL = "http://127.0.0.1:40547/playback/hls/4bb5b7c2/master.m3u8";

const snap = (over: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot => ({
  sampledAtMs: 0, position: 0, duration: 3600, paused: false, cacheEnd: 0, cacheDuration: 60, cacheSpeed: 0, eof: false,
  pausedForCache: false, seeking: false, idle: false, coreIdle: false, voConfigured: true, hwdec: "mediacodec",
  currentVo: "gpu", videoCodec: "h264", frameDrops: 0, decoderFrameDrops: 0, avsync: 0, netBps: 50_000_000, cacheSecs: 30, demuxerMaxBytes: 33554432, vid: 1, aid: 1, sid: 0, videoWidth: 1920, videoHeight: 1080,
  ...over,
});

type FakePlayer = {
  snapshot: PlaybackSnapshot | null;
  /** What the player reports after a `loadAt` (a quality switch); null = stuck: idle, no frame. */
  afterLoad: PlaybackSnapshot | null;
  loads: { url: string; startSeconds: number; options: string }[];
  paused: boolean[];
  traffic: StorageTraffic | null;
  reloads: number;
  /** Fake-clock time of the last snapshot read: a playing file's position advances by the time since. */
  readAt: number;
  /** Every `setPlaybackProgress` the screen sent: [mediaId, episodeId, pct, position, final]. */
  progress: { episodeId: string | null; pct: number; positionSeconds: number; final: boolean }[];
  /** The mocked session, so a test can give it an episode and its neighbours before mounting. */
  session: PlayerSession | null;
  /** Every `setKeepScreenOn` the screen sent, in order. */
  keepAwake: boolean[];
};

/** The fake native player: what `getPlaybackSnapshot` reports, and every load / pause the screen sends. */
const fake = vi.hoisted((): FakePlayer => ({ snapshot: null, afterLoad: null, loads: [], paused: [], traffic: null, reloads: 0, readAt: 0, progress: [], session: null, keepAwake: [] }));
/** Signed-in token and the metadata service's episode names per language (LIB-LANG-01); signed out by default. */
const metadata = vi.hoisted(() => ({ token: null as string | null, language: "en", episodes: {} as Record<string, { seasonNumber: number; episodeNumber: number; name: string | null; overview: string | null }[]> }));
vi.mock("../src/lib/metadata/runtime", () => ({
  fetchEpisodes: async (_tvId: number, language: string) => metadata.episodes[language] ?? [],
}));

// The phone Cast picker (PLAY-OVL-04) talks to the Google Cast SDK: a host-element stand-in.
vi.mock("../src/components/PlayerCastPicker", () => ({ PlayerCastPicker: "PlayerCastPicker" }));
// "Get subtitles" (PLAY-SUBGET) loads the metadata client and lucide icons (native modules, Flow sources): a stand-in.
vi.mock("../src/screens/player/PlayerSubtitleFetch", () => ({ PlayerSubtitleFetch: "PlayerSubtitleFetch" }));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T>(styles: T) => styles, absoluteFill: {} },
  View: "View",
  Text: "Text",
  Image: "Image",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  useWindowDimensions: () => ({ width: 960, height: 540 }),
  // The phone is Android: the media session package registers its keep-alive headless task at load (PLAY-OSMEDIA-01).
  Platform: { OS: "android", select: <T>(choices: { android?: T; default?: T }) => choices.android ?? choices.default },
  AppRegistry: { registerHeadlessTask: () => undefined },
  DeviceEventEmitter: { addListener: () => ({ remove: () => undefined }) },
  // No native media session module here (PLAY-OSMEDIA-01 binds to it when present).
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
}));
vi.mock("@react-navigation/native", () => {
  const navigation = { canGoBack: () => true, goBack: () => undefined, navigate: () => undefined, setParams: (params: unknown) => console.info("[player-screen] setParams", JSON.stringify(params)) };
  const route = { params: { mediaId: "media-1", episodeId: null, backdropPath: "/backdrop.jpg", posterPath: "/poster.jpg" } };
  return { useNavigation: () => navigation, useRoute: () => route };
});
vi.mock("@space/mobile-mpv-playback", () => ({
  MpvPlayer: "MpvPlayer",
  PlayerControls: "PlayerControls",
  // The app is in front in these tests: the switch runs at once, with no core held for a hidden switch.
  switchEpisodeKeepingCore: async (_player: unknown, _input: unknown, switchNow: () => void) => switchNow(),
  // The native proxy's traffic events: none in these tests (the poll answers through `fetchTraffic`).
  PlaybackBridge: { onTraffic: () => () => undefined, setBufferCap: async () => true, warmRung: () => null },
  MpvControl: {
    getPlaybackSnapshot: async () => {
      const snapshot = fake.snapshot;
      if (!snapshot) throw new Error("no file");
      const now = Date.now();
      const next = snapshot.voConfigured && !snapshot.paused && !snapshot.idle ? { ...snapshot, position: snapshot.position + (now - fake.readAt) / 1000 } : snapshot;
      fake.snapshot = next;
      fake.readAt = now;
      return { ...next, sampledAtMs: now };
    },
    getTrackList: async () => [],
    getDecoderCaps: async () => {
      throw new Error("decoder caps unavailable");
    },
    loadAt: async (url: string, startSeconds: number, options: string) => {
      fake.loads.push({ url, startSeconds, options });
      console.info(`[player-screen] loadAt #${fake.loads.length} start=${startSeconds} options="${options}" url=${url}`);
      fake.snapshot = fake.afterLoad ?? (fake.snapshot ? { ...fake.snapshot, idle: true, voConfigured: false, position: 0 } : null);
    },
    seek: async () => undefined,
    setPaused: async (paused: boolean) => {
      fake.paused.push(paused);
      if (fake.snapshot) fake.snapshot = { ...fake.snapshot, paused };
    },
    setAudioTrack: async () => undefined,
    addSubtitle: async () => undefined,
    setImmersiveLandscape: async () => undefined,
    setKeepScreenOn: async (enabled: boolean) => {
      fake.keepAwake.push(enabled);
    },
  },
}));
vi.mock("@space/mobile-shell/i18n", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t, i18n: { language: metadata.language } }), getCurrentLanguage: () => metadata.language };
});
vi.mock("../src/lib/uiLanguage", () => ({ ensureI18n: () => undefined }));
vi.mock("../src/lib/useMediaImage", () => ({
  useMediaImage: (path: string | null, size: string) => (path ? `https://img.test/${size}${path}` : null),
}));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ user: null, token: metadata.token, refresh: async () => undefined }) }));
// The phone player under test: the TV runtime is off and its remote is not mounted.
vi.mock("../src/tv/lib/tvRuntime", () => ({ IS_TV: false }));
vi.mock("../src/tv/components/TvPlayerRemote", () => ({ TvPlayerRemote: "TvPlayerRemote" }));
vi.mock("../src/tv/components/TvFocusable", () => ({ TvFocusable: "TvFocusable" }));
vi.mock("../src/store/library", () => {
  const library = {
    setPlaybackProgress: async (_mediaId: string, episodeId: string | null, pct: number, at: { positionSeconds: number }, final: boolean) => {
      fake.progress.push({ episodeId, pct, positionSeconds: at.positionSeconds, final });
    },
    setTrackPrefs: async () => undefined,
  };
  return { useLibraryActions: () => library };
});
vi.mock("../src/lib/appSettings", () => {
  const settings = { autoplayNextEpisode: true, autoSkipIntro: true, autoSkipCredits: true, defaultQuality: "1080p", forceQuality: false };
  return { getAppSettings: () => settings };
});
vi.mock("../src/screens/player/usePlayerSession", () => {
  const video = (id: string, height: number) => ({
    id, quality: id, codec: "h264", codecString: "avc1.640028", initKey: `${id}/init`, initSize: 1000, durationSeconds: 3600,
    totalSize: 1_000_000, bitrateKbps: height * 5, width: Math.round((height * 16) / 9), height, chunks: [],
  });
  const session: PlayerSession = {
    phase: "ready",
    error: null,
    closeReason: null,
    reload: () => {
      fake.reloads += 1;
    },
    playUrl: "http://127.0.0.1:40547/playback/hls/4bb5b7c2/master.m3u8",
    metadata: { encryptionKeyBase64: "", videos: [video("1080p", 1080), video("480p", 480), video("360p", 360)], audioTracks: [], subtitleTracks: [], chapters: [] },
    details: null,
    episode: null,
    nextEpisode: null,
    previousEpisode: null,
    markers: [],
    durationSeconds: 3600,
    resumeCandidateSeconds: null,
    trackPrefs: null,
    fetchTraffic: async () => fake.traffic,
    offline: false,
    previews: null,
  };
  fake.session = session;
  return { usePlayerSession: () => session };
});

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  fake.snapshot = null;
  fake.afterLoad = null;
  fake.loads = [];
  fake.paused = [];
  fake.traffic = { state: "normal", playbackBufferSeconds: null, saturated: false, qualityCap: null, playbackStopped: false };
  fake.reloads = 0;
  fake.readAt = Date.now();
  fake.progress = [];
  fake.keepAwake = [];
  Object.assign(fake.session ?? {}, { episode: null, nextEpisode: null, previousEpisode: null, resumeCandidateSeconds: null });
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
  vi.useRealTimers();
});

const mount = async () => {
  await act(async () => {
    renderer = create(React.createElement(PlayerScreen));
  });
  return renderer as ReactTestRenderer;
};

/** Moves the fake clock in poll-sized steps so every snapshot poll, React effect and switch timer runs in order. */
const advance = async (ms: number) => {
  for (let left = ms; left > 0; left -= 250) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(250, left));
    });
  }
};

/** The mocked react-native and mpv components render as plain strings, so a node's type is its component name. */
const hosts = (tree: ReactTestRenderer, name: string): ReactTestInstance[] => tree.root.findAll((node) => node.type === name);

const backdropShown = (tree: ReactTestRenderer) => hosts(tree, "View").some((node) => node.props.testID === "player-backdrop");

describe("player screen: title picture until the first frame (PLAY-OPEN-01)", () => {
  /** @req PLAY-OPEN-01[badger-mobile] */
  it("covers the starting player with the title's picture, removes it at the first frame and never shows it again", async () => {
    fake.snapshot = snap({ voConfigured: false, position: 0 });
    const tree = await mount();
    await advance(1000);
    const starting = { player: hosts(tree, "MpvPlayer").length, backdrop: backdropShown(tree), images: hosts(tree, "Image").map((node) => node.props.source) };
    fake.snapshot = snap({ position: 1 });
    await advance(1000);
    const firstFrame = backdropShown(tree);
    // A rebuffer / reload later has no frame for a moment: the picture must not flash back over the video.
    fake.snapshot = snap({ voConfigured: false, position: 3 });
    await advance(1000);
    const noFrameLater = backdropShown(tree);
    console.info(`${LOG} backdrop: starting=${JSON.stringify(starting)} firstFrame=${firstFrame} noFrameLater=${noFrameLater}`);
    expect(starting).toEqual({ player: 1, backdrop: true, images: [{ uri: "https://img.test/backdrop/backdrop.jpg" }] });
    expect(firstFrame).toBe(false);
    expect(noFrameLater).toBe(false);
  });
});

/** @req PLAY-ABR-04[badger-mobile] */
describe("player screen: a failure during a quality switch stops playback", () => {
  it("pauses mpv behind the error, the retrying switch never reloads again, and Retry reloads the session", async () => {
    fake.snapshot = snap({ position: 10 });
    const tree = await mount();
    await advance(49_000);
    const loadsBefore = fake.loads.length;
    // The viewer picks 480p; the new rung sticks (idle, no frame), so the machine would retry it every ~15 s.
    await act(async () => {
      hosts(tree, "PlayerControls")[0]!.props.onSelectQuality("480p");
    });
    await advance(2_000);
    const errorWhileSwitching = hosts(tree, "View").some((node) => node.props.testID === "player-error");
    // The silo stops this viewer (polled every 60 s): a failure while the switch is still retrying.
    fake.traffic = { state: "high", playbackBufferSeconds: null, saturated: true, qualityCap: null, playbackStopped: true };
    await advance(60_000);
    const error = hosts(tree, "View").find((node) => node.props.testID === "player-error");
    const errorText = error ? hosts(tree, "Text").map((node) => node.props.children).filter((text) => typeof text === "string") : [];
    console.info(`${LOG} failure during switch: loadsBefore=${loadsBefore} loads=${JSON.stringify(fake.loads.map((l) => [l.url.split("/").pop(), l.startSeconds]))} paused=${JSON.stringify(fake.paused)} errorWhileSwitching=${errorWhileSwitching} text=${JSON.stringify(errorText)}`);
    expect(loadsBefore).toBe(0);
    expect(errorWhileSwitching).toBe(false);
    expect(error).toBeDefined();
    expect(errorText).toContain("player.error.playbackStopped");
    expect(fake.paused).toEqual([true]);
    // One load for the pick; the retries at +15 s and +30 s were cancelled with the failure.
    expect(fake.loads.map((l) => l.url)).toEqual([PLAY_URL.replace("master.m3u8", "master-480p.m3u8")]);

    fake.traffic = { state: "normal", playbackBufferSeconds: null, saturated: false, qualityCap: null, playbackStopped: false };
    const retry = hosts(tree, "Pressable").find((node) => node.props.testID === "player-error-retry");
    await act(async () => {
      retry!.props.onPress();
    });
    await advance(1_000);
    console.info(`${LOG} retry: reloads=${fake.reloads} loads=${fake.loads.length} error=${hosts(tree, "View").some((node) => node.props.testID === "player-error")}`);
    expect(fake.reloads).toBe(1);
    expect(fake.loads).toHaveLength(1);
    expect(hosts(tree, "View").some((node) => node.props.testID === "player-error")).toBe(false);
  });

  it("Auto never switches on the poll that raises the failure: a loading timeout with room to downshift loads nothing", async () => {
    fake.snapshot = snap({ position: 10 });
    const tree = await mount();
    await advance(5_000);
    // A seek that never lands: the frame stays configured, the spinner shows, the buffer is healthy (Auto holds).
    fake.snapshot = snap({ position: fake.snapshot!.position, seeking: true });
    const stuckAt = fake.readAt;
    while (fake.readAt === stuckAt) await advance(250);
    const stuckSince = fake.readAt;
    while (fake.readAt < stuckSince + 59_500) await advance(250);
    const errorBefore = hosts(tree, "View").some((node) => node.props.testID === "player-error");
    // The buffer empties right on the poll that crosses 60 s: Auto would downshift (buffer critical) on that same pass.
    fake.snapshot = { ...fake.snapshot!, cacheDuration: 0 };
    await advance(500);
    const errorText = hosts(tree, "Text").map((node) => node.props.children).filter((text) => typeof text === "string");
    const activeVideoId: unknown = hosts(tree, "PlayerControls")[0]!.props.activeVideoId;
    await advance(20_000);
    console.info(`${LOG} timeout pass: stuckMs=${fake.readAt - stuckSince} errorBefore=${errorBefore} text=${JSON.stringify(errorText)} activeVideoId=${activeVideoId} loads=${JSON.stringify(fake.loads.map((l) => l.url.split("/").pop()))} paused=${JSON.stringify(fake.paused)}`);
    expect(errorBefore).toBe(false);
    expect(errorText).toContain("player.error.loadingTimeout");
    expect(activeVideoId).toBe("1080p");
    expect(fake.loads).toEqual([]);
    expect(fake.paused).toEqual([true]);
  });

  it("Retry cancels a quality switch picked under the error overlay: the cancelled switch never loads again", async () => {
    fake.snapshot = snap({ position: 10 });
    const tree = await mount();
    fake.traffic = { state: "high", playbackBufferSeconds: null, saturated: true, qualityCap: null, playbackStopped: true };
    await advance(61_000);
    const errorShown = hosts(tree, "View").some((node) => node.props.testID === "player-error");
    fake.traffic = { state: "normal", playbackBufferSeconds: null, saturated: false, qualityCap: null, playbackStopped: false };
    // The controls stay under the overlay: the viewer picks 480p there; the new rung sticks (idle, no frame).
    await act(async () => {
      hosts(tree, "PlayerControls")[0]!.props.onSelectQuality("480p");
    });
    await advance(2_000);
    const loadsAtRetry = fake.loads.length;
    const retry = hosts(tree, "Pressable").find((node) => node.props.testID === "player-error-retry");
    await act(async () => {
      retry!.props.onPress();
    });
    // Unless Retry cancelled it, the switch would retry the rung at about +15 s and +30 s.
    await advance(35_000);
    console.info(`${LOG} retry under overlay: errorShown=${errorShown} loadsAtRetry=${loadsAtRetry} loads=${JSON.stringify(fake.loads.map((l) => l.url.split("/").pop()))} reloads=${fake.reloads}`);
    expect(errorShown).toBe(true);
    expect(loadsAtRetry).toBe(1);
    expect(fake.reloads).toBe(1);
    expect(fake.loads.map((l) => l.url)).toEqual([PLAY_URL.replace("master.m3u8", "master-480p.m3u8")]);
  });
});

/** @req PLAY-RESUME-07[badger-mobile,badger-tv] */
describe("player screen: Retry resumes where playback failed", () => {
  it("after a failure under a stuck quality switch (the player reports 0:00), Retry starts the reloaded player at the last played position, not the session's first start", async () => {
    // Séjour 2026-11-08: opened at 0:00 here (the real start was 55:52), played on to ~1:19:00, a switch stuck and failed.
    fake.snapshot = snap({ position: 4700 });
    const tree = await mount();
    await advance(10_000);
    const playedTo = fake.snapshot!.position;
    // The new rung never settles: the player sits idle at 0:00 with no frame, as mpv does after a load that failed.
    await act(async () => {
      hosts(tree, "PlayerControls")[0]!.props.onSelectQuality("480p");
    });
    await advance(2_000);
    fake.traffic = { state: "high", playbackBufferSeconds: null, saturated: true, qualityCap: null, playbackStopped: true };
    await advance(60_000);
    const errorShown = hosts(tree, "View").some((node) => node.props.testID === "player-error");
    fake.traffic = { state: "normal", playbackBufferSeconds: null, saturated: false, qualityCap: null, playbackStopped: false };
    const retry = hosts(tree, "Pressable").find((node) => node.props.testID === "player-error-retry");
    await act(async () => {
      retry!.props.onPress();
    });
    await advance(1_000);
    const startOptions: unknown = hosts(tree, "MpvPlayer")[0]?.props.startOptions;
    const startSeconds = typeof startOptions === "string" ? Number(startOptions.replace("start=", "")) : null;
    console.info(`${LOG} retry position: playedTo=${playedTo.toFixed(1)} reported=${fake.snapshot?.position} errorShown=${errorShown} reloads=${fake.reloads} startOptions=${String(startOptions)}`);
    expect(errorShown).toBe(true);
    expect(fake.reloads).toBe(1);
    expect(startSeconds).not.toBeNull();
    expect(Math.abs(startSeconds! - playedTo)).toBeLessThan(3);
  });
});

/** @req PLAY-AWAKE-01[badger-mobile,badger-tv] */
describe("player screen: the device stays awake while a video plays", () => {
  it("asks to stay awake when the player opens, again each time playback starts or resumes, and lets go when the player closes", async () => {
    fake.snapshot = snap({ voConfigured: false, position: 0 });
    const tree = await mount();
    const atOpen = [...fake.keepAwake];
    fake.snapshot = snap({ position: 1 });
    await advance(2_000);
    const atFirstFrame = [...fake.keepAwake];
    fake.snapshot = { ...fake.snapshot!, paused: true };
    await advance(2_000);
    const whilePaused = [...fake.keepAwake];
    fake.snapshot = { ...fake.snapshot!, paused: false };
    await advance(2_000);
    const afterResume = [...fake.keepAwake];
    await act(async () => {
      tree.unmount();
    });
    renderer = null;
    console.info(`${LOG} keep awake: open=${JSON.stringify(atOpen)} firstFrame=${JSON.stringify(atFirstFrame)} paused=${JSON.stringify(whilePaused)} resumed=${JSON.stringify(afterResume)} closed=${JSON.stringify(fake.keepAwake)}`);
    expect(atOpen).toEqual([true]);
    expect(atFirstFrame).toEqual([true, true]);
    expect(whilePaused).toEqual([true, true]);
    expect(afterResume).toEqual([true, true, true]);
    expect(fake.keepAwake.at(-1)).toBe(false);
  });
});

/** @req PLAY-OVL-03[badger-mobile,badger-tv] @req PLAY-RESUME-02[badger-mobile,badger-tv] */
describe("player screen: previous / next episode buttons save the episode left", () => {
  const episode = (id: string, n: number) => ({ id, seasonNumber: 1, episodeNumber: n, title: `Episode ${n}` }) as never;
  it.each([
    ["previous", "onPreviousEpisode", false],
    ["next", "onNextEpisode", true],
  ] as const)("%s: the episode left is saved %s", async (which, prop, finished) => {
    Object.assign(fake.session!, { episode: episode("ep-5", 5), previousEpisode: episode("ep-4", 4), nextEpisode: episode("ep-6", 6) });
    fake.snapshot = snap({ position: 120 });
    const tree = await mount();
    await advance(2_000);
    fake.progress = [];
    await act(async () => {
      hosts(tree, "PlayerControls")[0]!.props[prop]();
    });
    console.info(`${LOG} ${which}: progress=${JSON.stringify(fake.progress)}`);
    const saved = fake.progress.filter((p) => p.episodeId === "ep-5").at(-1);
    expect(saved).toBeDefined();
    expect(saved!.final).toBe(true);
    if (finished) {
      expect(saved!.pct).toBe(100);
    } else {
      expect(saved!.pct).toBeLessThan(10);
      expect(saved!.positionSeconds).toBeGreaterThanOrEqual(120);
      expect(saved!.positionSeconds).toBeLessThan(200);
    }
  });
});

/** @req PLAY-RESUME-01[badger-mobile] */
describe("player screen: resume prompt follows the 2 % AND 15 s rule", () => {
  const ID = "MOBILE-PLAYER-SCREEN-PLAYBACK-001/resume";
  const promptShown = (tree: ReactTestRenderer) => hosts(tree, "View").some((node) => node.props.testID === "player-resume-prompt");
  const button = (tree: ReactTestRenderer, testID: string) => hosts(tree, "Pressable").find((node) => node.props.testID === testID);
  const mountWithSaved = async (progressPct: number, durationSeconds: number) => {
    // Same call as usePlayerSession for a movie (no credits marker, no saved position): the hook is mocked, the rule is not.
    const candidate = resolveResumeCandidateSeconds(progressPct, durationSeconds, null);
    console.info(`${ID} [phase:seed] saved=${progressPct}% of ${durationSeconds}s -> candidate=${candidate}`);
    Object.assign(fake.session ?? {}, { resumeCandidateSeconds: candidate, durationSeconds });
    fake.snapshot = snap({ voConfigured: false, position: 0, duration: durationSeconds });
    const tree = await mount();
    await advance(500);
    return { tree, candidate };
  };

  afterEach(() => {
    Object.assign(fake.session ?? {}, { resumeCandidateSeconds: null, durationSeconds: 3600 });
  });

  it("10 % of an hour: shows Resume and Start over before mpv loads; Resume starts at 360 s", async () => {
    const { tree, candidate } = await mountWithSaved(10, 3600);
    const before = {
      prompt: promptShown(tree),
      player: hosts(tree, "MpvPlayer").length,
      resume: button(tree, "player-resume-continue")?.props.accessibilityLabel ?? null,
      startOver: button(tree, "player-resume-start-over")?.props.accessibilityLabel ?? null,
    };
    console.info(`${ID} [phase:prompt] ${JSON.stringify(before)}`);
    expect(candidate).toBe(360);
    expect(before).toEqual({ prompt: true, player: 0, resume: "player.resume.resumeAt", startOver: "player.resume.startOver" });

    await act(async () => {
      button(tree, "player-resume-continue")!.props.onPress();
    });
    await advance(500);
    const players = hosts(tree, "MpvPlayer").map((node) => node.props.startOptions);
    console.info(`${ID} [phase:resumed] prompt=${promptShown(tree)} startOptions=${JSON.stringify(players)}`);
    expect(promptShown(tree)).toBe(false);
    expect(players).toEqual(["start=360.000"]);
  });

  it("Start over from the prompt starts mpv at 0", async () => {
    const { tree } = await mountWithSaved(10, 3600);
    await act(async () => {
      button(tree, "player-resume-start-over")!.props.onPress();
    });
    await advance(500);
    const players = hosts(tree, "MpvPlayer").map((node) => node.props.startOptions);
    console.info(`${ID} [phase:start-over] prompt=${promptShown(tree)} startOptions=${JSON.stringify(players)}`);
    expect(promptShown(tree)).toBe(false);
    expect(players).toEqual([null]);
  });

  it.each([
    ["1 % of 2 h (72 s watched, under 2 %)", 1, 7200],
    ["80 % of a 10 s clip (8 s watched, under 15 s)", 80, 10],
    ["1.9 % of 1000 s (19 s watched, under 2 %)", 1.9, 1000],
  ] as const)("%s: no prompt, mpv starts at 0", async (_label, pct, duration) => {
    const { tree, candidate } = await mountWithSaved(pct, duration);
    const players = hosts(tree, "MpvPlayer").map((node) => node.props.startOptions);
    console.info(`${ID} [phase:no-prompt] candidate=${candidate} prompt=${promptShown(tree)} startOptions=${JSON.stringify(players)}`);
    expect(candidate).toBeNull();
    expect(promptShown(tree)).toBe(false);
    expect(players).toEqual([null]);
  });
});

/** @req LIB-LANG-01[badger-mobile,badger-tv] */
describe("player screen: episode names in the interface language, as on the title page", () => {
  const ID = "MOBILE-PLAYER-SCREEN-PLAYBACK-001/localized-names";
  const episode = (n: number, name: string) => ({ id: `ep-${n}`, seasonNumber: 1, episodeNumber: n, name, overview: null, stillPath: null, airDate: null });
  const details = { id: "show-1", type: "tv", catalogId: 4242, title: "The Show", posterPath: null, backdropPath: null, subtitleTracks: [], subtitles: [], audioTracks: [], files: [], formats: [], seasons: [], trailers: [], chapters: [], skipMarkers: [], cast: [], playlistIds: [], episodes: [episode(1, "Pilot"), episode(2, "The Return")] } as never;

  afterEach(() => {
    Object.assign(metadata, { token: null, language: "en", episodes: {} });
    Object.assign(fake.session ?? {}, { details: null });
  });

  it("names the playing episode in French in the header and the resume prompt, and the next one in French too", async () => {
    Object.assign(metadata, {
      token: "tok",
      language: "fr",
      episodes: { fr: [{ seasonNumber: 1, episodeNumber: 1, name: "Le pilote", overview: null }, { seasonNumber: 1, episodeNumber: 2, name: "Le retour", overview: null }] },
    });
    Object.assign(fake.session!, { details, episode: episode(1, "Pilot"), nextEpisode: episode(2, "The Return"), resumeCandidateSeconds: 600 });
    fake.snapshot = snap({ voConfigured: false, position: 0 });
    const tree = await mount();
    await advance(500);
    const prompt = hosts(tree, "Text").map((node) => node.props.children).flat().filter((text) => typeof text === "string" && text.includes("S1E01"));
    console.info(`${ID} [phase:prompt] ${JSON.stringify(prompt)}`);
    expect(prompt).toEqual(["S1E01 - Le pilote"]);

    await act(async () => {
      hosts(tree, "Pressable").find((node) => node.props.testID === "player-resume-continue")!.props.onPress();
    });
    fake.snapshot = snap({ position: 601 });
    await advance(1_000);
    const header = hosts(tree, "PlayerControls")[0]!.props.title;
    console.info(`${ID} [phase:playing] header=${JSON.stringify(header)}`);
    expect(header).toBe("The Show · S1 E1 · Le pilote");
  });
});

/**
 * @test-id TV-PLAYER-SCREEN-001
 * @level component
 * @regression-proof
 *
 * The real `PlayerScreen` rendered as the TV app runs it (`IS_TV` true, `Platform.isTV` true, the remote mounted, the
 * controls in their TV form) against a fake mpv (snapshots, loads, pause, decoder answers) and a fake clock. The TV app
 * is the phone app's binary: this is the screen both TV platforms play through.
 *  - PLAY-QUAL-06: a TV counts software decoders too, so a 4K version only a software decoder handles starts as is;
 *  - PLAY-OPEN-01: the title's picture covers the player until the first frame;
 *  - PLAY-ABR-04 / PLAY-QUAL-04: a quality picked on the TV reloads at the same spot, completes, and stays pinned;
 *  - PLAY-QUAL-03 / PLAY-CODEC-03: a device that can't keep up gets the TV's own wording ("This TV box…"), with the Force
 *    hint when pinned, no switch, and Back on the remote closes the notice;
 *  - PLAY-RESUME-04: progress is saved to the episode that was playing, around a quality switch and next / previous;
 *  - PLAY-TRACK-04: the title's remembered tracks start on the TV, and a pick on the TV overwrites them;
 *  - PLAY-RESUME-03: a resume another device wrote is offered on the TV, Resume opens there, the TV saves it back.
 * Only the boundaries are faked (native module, navigation, session loader, library store, settings, remote link).
 */
import React from "react";
import { useRoute } from "@react-navigation/native";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioTrack, DecoderProbe, MpvTrack, PlaybackSnapshot, SubtitleTrack } from "@space/mobile-mpv-playback";
import type { StorageTraffic } from "@space/shared/storageTunnel";
import type { TrackPrefs, TrackPrefsPatch } from "@space/shared/trackPrefs";
import type { PlayerSession } from "../../screens/player/usePlayerSession";
import { PlayerScreen } from "../../screens/PlayerScreen";

const LOG = "[tv-player-screen]";
const PLAY_URL = "http://127.0.0.1:40547/playback/hls/4bb5b7c2/master.m3u8";
const rungUrl = (id: string) => PLAY_URL.replace("master.m3u8", `master-${id}.m3u8`);

const snap = (over: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot => ({
  sampledAtMs: 0, position: 0, duration: 3600, paused: false, cacheEnd: 0, cacheDuration: 60, cacheSpeed: 0, eof: false,
  pausedForCache: false, seeking: false, idle: false, coreIdle: false, voConfigured: true, hwdec: "mediacodec",
  currentVo: "gpu", videoCodec: "h264", frameDrops: 0, decoderFrameDrops: 0, avsync: 0, netBps: 50_000_000, cacheSecs: 30, demuxerMaxBytes: 33554432, vid: 1, aid: 1, sid: 0, videoWidth: 1920, videoHeight: 1080,
  ...over,
});

type Settings = { autoplayNextEpisode: boolean; autoSkipIntro: boolean; autoSkipCredits: boolean; defaultQuality: string; forceQuality: boolean; defaultAudioLanguage: string | null };

type FakeTv = {
  snapshot: PlaybackSnapshot | null;
  /** What the player reports after a `loadAt` (a quality switch); null = stuck: idle, no frame. */
  afterLoad: ((at: number) => PlaybackSnapshot) | null;
  loads: { url: string; startSeconds: number; options: string }[];
  paused: boolean[];
  traffic: StorageTraffic | null;
  readAt: number;
  progress: { episodeId: string | null; pct: number; positionSeconds: number; final: boolean }[];
  session: PlayerSession | null;
  settings: Settings;
  /** The device's answer per probe id; a probe not listed is answered hardware + software. */
  decoder: Record<string, { hardware: boolean; software: boolean }>;
  probesAsked: DecoderProbe[];
  mpvTracks: MpvTrack[];
  audioSet: number[];
  subtitlesAdded: string[];
  trackSaves: { mediaId: string; patch: TrackPrefsPatch }[];
  remoteAttached: number;
};

const fake = vi.hoisted(
  (): FakeTv => ({
    snapshot: null, afterLoad: null, loads: [], paused: [], traffic: null, readAt: 0, progress: [], session: null,
    settings: { autoplayNextEpisode: true, autoSkipIntro: true, autoSkipCredits: true, defaultQuality: "1080p", forceQuality: false, defaultAudioLanguage: null },
    decoder: {}, probesAsked: [], mpvTracks: [], audioSet: [], subtitlesAdded: [], trackSaves: [], remoteAttached: 0,
  }),
);

// The phone Cast picker (PLAY-OVL-04) talks to the Google Cast SDK: a host-element stand-in.
vi.mock("../../components/PlayerCastPicker", () => ({ PlayerCastPicker: "PlayerCastPicker" }));
// "Get subtitles" (PLAY-SUBGET) loads the metadata client and lucide icons (native modules, Flow sources): a stand-in.
vi.mock("../../screens/player/PlayerSubtitleFetch", () => ({ PlayerSubtitleFetch: "PlayerSubtitleFetch" }));
vi.mock("../../screens/player/PlayerSubtitleVersion", () => ({ PlayerSubtitleVersion: "PlayerSubtitleVersion" }));
vi.mock("react-native", async () => ({
  ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {} },
  View: "View",
  Text: "Text",
  Image: "Image",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  // The TV build: react-native-tvos reports `isTV` on Android TV and Apple TV alike.
  Platform: { isTV: true, OS: "android", select: <T,>(choices: { android?: T; default?: T }) => choices.android ?? choices.default },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  useWindowDimensions: () => ({ width: 960, height: 540 }),
  // Android TV: the media session package registers its keep-alive headless task at load (PLAY-OSMEDIA-01).
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
  const navigation = { canGoBack: () => true, goBack: () => undefined, navigate: () => undefined, setParams: (params: unknown) => console.info("[tv-player-screen] setParams", JSON.stringify(params)) };
  const route = { params: { mediaId: "media-1", episodeId: null, backdropPath: "/backdrop.jpg", posterPath: "/poster.jpg" } };
  return { useNavigation: () => navigation, useRoute: () => route };
});
vi.mock("@space/mobile-mpv-playback", () => ({
  MpvPlayer: "MpvPlayer",
  PlayerControls: "PlayerControls",
  PlaybackBridge: { onTraffic: () => () => undefined, setBufferCap: async () => true, warmRung: () => null },
  // PlayerScreen switches episodes through this since #1762 (PLAY-OSMEDIA-01); the core hold is native, the switch is ours.
  switchEpisodeKeepingCore: async (_player: unknown, _input: unknown, switchNow: () => void) => switchNow(),
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
    getTrackList: async () => fake.mpvTracks,
    // What a TV's MediaCodecList answers per version (`DecoderCaps.kt`): hardware and software separately.
    getDecoderCaps: async (probes: DecoderProbe[]) => {
      fake.probesAsked = probes;
      return { sdk: 34, codecs: [], probes: probes.map((probe) => ({ id: probe.id, ...(fake.decoder[probe.id] ?? { hardware: true, software: true }) })) };
    },
    loadAt: async (url: string, startSeconds: number, options: string) => {
      fake.loads.push({ url, startSeconds, options });
      console.info(`[tv-player-screen] loadAt #${fake.loads.length} start=${startSeconds} options="${options}" url=${url}`);
      fake.snapshot = fake.afterLoad ? fake.afterLoad(startSeconds) : fake.snapshot ? { ...fake.snapshot, idle: true, voConfigured: false, position: 0 } : null;
    },
    seek: async () => undefined,
    setPaused: async (paused: boolean) => {
      fake.paused.push(paused);
      if (fake.snapshot) fake.snapshot = { ...fake.snapshot, paused };
    },
    setAudioTrack: async (id: number) => {
      fake.audioSet.push(id);
    },
    addSubtitle: async (url: string) => {
      fake.subtitlesAdded.push(url);
    },
    removeAllSubtitles: async () => undefined,
    setImmersiveLandscape: async () => undefined,
    setKeepScreenOn: async () => undefined,
  },
}));
vi.mock("@space/mobile-shell/i18n", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t, i18n: { language: "en" } }), getCurrentLanguage: () => "en" };
});
// The notices render once the UI language is loaded.
vi.mock("../../lib/uiLanguage", () => ({ ensureI18n: async () => undefined }));
vi.mock("../../lib/useMediaImage", () => ({
  useMediaImage: (path: string | null, size: string) => (path ? `https://img.test/${size}${path}` : null),
}));
vi.mock("../../store/auth", () => ({ useAuth: () => ({ user: null, refresh: async () => undefined }) }));
// The TV runtime is on: the remote is mounted and the controls take their TV form.
// The metadata service (LIB-LANG-01 episode names) is out of scope here: signed out, nothing localized.
vi.mock("../../lib/metadata/runtime", () => ({ fetchEpisodes: async () => [] }));
vi.mock("../lib/tvRuntime", () => ({ IS_TV: true }));
vi.mock("../components/TvPlayerRemote", () => ({ TvPlayerRemote: "TvPlayerRemote" }));
vi.mock("../components/TvFocusable", () => ({ TvFocusable: "TvFocusable" }));
vi.mock("../../lib/playOnTv/playerLink", () => ({
  attachRemotePlayer: () => {
    fake.remoteAttached += 1;
    return () => undefined;
  },
  publishRemoteState: () => undefined,
  remoteStateWanted: () => false,
}));
vi.mock("../../store/library", () => {
  const library = {
    setPlaybackProgress: async (_mediaId: string, episodeId: string | null, pct: number, at: { positionSeconds: number }, final: boolean) => {
      fake.progress.push({ episodeId, pct, positionSeconds: at.positionSeconds, final });
    },
    setTrackPrefs: async (mediaId: string, patch: TrackPrefsPatch) => {
      fake.trackSaves.push({ mediaId, patch });
    },
  };
  return { useLibraryActions: () => library };
});
vi.mock("../../lib/appSettings", () => ({ getAppSettings: () => fake.settings }));
vi.mock("../../screens/player/usePlayerSession", () => {
  const session = {
    phase: "ready",
    error: null,
    reload: () => undefined,
    playUrl: "http://127.0.0.1:40547/playback/hls/4bb5b7c2/master.m3u8",
    metadata: { encryptionKeyBase64: "", videos: [], audioTracks: [], subtitleTracks: [], chapters: [] },
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
  } as unknown as PlayerSession;
  fake.session = session;
  return { usePlayerSession: () => session };
});

/** One version of the title: `codec` "hevc" or "h264", sized from its label. */
const video = (id: string, height: number, codec: "hevc" | "h264") => ({
  id, quality: id, codec, codecString: codec === "hevc" ? "hvc1.1.6.L150.90" : "avc1.640028", initKey: `${id}/init`, initSize: 1000,
  durationSeconds: 3600, totalSize: 1_000_000, bitrateKbps: height * 5, width: Math.round((height * 16) / 9), height, chunks: [],
});
/** 4K HEVC, 1080p H.264, 480p H.264. */
const LADDER = [video("2160p", 2160, "hevc"), video("1080p", 1080, "h264"), video("480p", 480, "h264")];

const audio = (id: string, language: string, isDefault = false): AudioTrack =>
  ({ id, language, label: language, isDefault, codec: "aac", codecString: "mp4a.40.2", initKey: `${id}/init`, initSize: 1, durationSeconds: 3600, totalSize: 1, chunks: [] }) as AudioTrack;
const subtitle = (id: string, language: string): SubtitleTrack =>
  ({ id, language, label: language, isDefault: false, format: "vtt", encrypted: false, url: `subs-${language}/${language}.vtt` }) as SubtitleTrack;

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  Object.assign(fake, {
    snapshot: null, afterLoad: null, loads: [], paused: [], readAt: Date.now(), progress: [], decoder: {}, probesAsked: [], mpvTracks: [],
    audioSet: [], subtitlesAdded: [], trackSaves: [], remoteAttached: 0,
    traffic: { state: "normal", playbackBufferSeconds: null, saturated: false, qualityCap: null, playbackStopped: false },
    settings: { autoplayNextEpisode: true, autoSkipIntro: true, autoSkipCredits: true, defaultQuality: "1080p", forceQuality: false, defaultAudioLanguage: null },
  });
  Object.assign(fake.session ?? {}, {
    episode: null, nextEpisode: null, previousEpisode: null, trackPrefs: null, resumeCandidateSeconds: null,
    metadata: { encryptionKeyBase64: "", videos: LADDER, audioTracks: [], subtitleTracks: [], chapters: [] },
  });
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
const byTestId = (tree: ReactTestRenderer, testID: string) => tree.root.findAll((node) => typeof node.type === "string" && node.props.testID === testID);
const controls = (tree: ReactTestRenderer) => hosts(tree, "PlayerControls")[0]!.props;
const remote = (tree: ReactTestRenderer) => hosts(tree, "TvPlayerRemote")[0]?.props;
const backdropShown = (tree: ReactTestRenderer) => byTestId(tree, "player-backdrop").length > 0;
const tooWeak = (tree: ReactTestRenderer) => {
  const textOf = (id: string) => byTestId(tree, id).map((node) => node.props.children)[0] ?? null;
  return { shown: byTestId(tree, "player-device-too-weak").length > 0, message: textOf("player-device-too-weak-message"), hint: textOf("player-device-too-weak-hint") };
};
/** What the TV is playing: the start source mpv was opened on and the rung the controls show. */
const playingNow = (tree: ReactTestRenderer) => ({
  source: hosts(tree, "MpvPlayer")[0]?.props.source ?? null,
  activeVideoId: controls(tree).activeVideoId,
  qualityMode: controls(tree).qualityMode,
});

/** The device drops `perSecond` frames every second for `seconds` while the buffer stays healthy. */
const dropFrames = async (perSecond: number, seconds: number) => {
  for (let s = 0; s < seconds; s++) {
    await advance(1000);
    if (fake.snapshot) fake.snapshot = { ...fake.snapshot, frameDrops: fake.snapshot.frameDrops + perSecond };
  }
};

/** Like `dropFrames`, but the drops stop once the player loads another version (the lighter one keeps up). */
const dropFramesUntilSwitch = async (perSecond: number, maxSeconds: number) => {
  const before = fake.loads.length;
  for (let s = 0; s < maxSeconds && fake.loads.length === before; s++) {
    await advance(1000);
    if (fake.snapshot && fake.loads.length === before) fake.snapshot = { ...fake.snapshot, frameDrops: fake.snapshot.frameDrops + perSecond };
  }
  console.info(`${LOG} dropFramesUntilSwitch: loads ${before} -> ${fake.loads.length}`);
};

describe("TV player: the start quality counts software decoders too (PLAY-QUAL-06)", () => {
  /** @req PLAY-QUAL-06[badger-tv] */
  it("starts the 4K version only a software decoder handles, on the Settings quality", async () => {
    console.info(`${LOG} QUAL-06 phase=setup: Settings 2160p Auto; the TV's hardware HEVC stops at 1080p, its software HEVC decoder handles 4K`);
    fake.settings.defaultQuality = "2160p";
    fake.decoder = { "2160p": { hardware: false, software: true } };
    fake.snapshot = snap({ voConfigured: false, hwdec: "no", videoCodec: "hevc" });
    const tree = await mount();
    await advance(1000);
    const started = playingNow(tree);
    console.info(`${LOG} QUAL-06 phase=started: probes=${JSON.stringify(fake.probesAsked.map((p) => [p.id, p.mime, `${p.width}x${p.height}`]))} playing=${JSON.stringify(started)} tvControls=${controls(tree).tv}`);
    expect(fake.probesAsked.map((p) => p.id)).toEqual(["2160p", "1080p", "480p"]);
    expect(controls(tree).tv).toBe(true);
    expect(started).toEqual({ source: rungUrl("2160p"), activeVideoId: "2160p", qualityMode: "auto" });

    console.info(`${LOG} QUAL-06 phase=playing: smooth software decode for 20 s must not move the TV off 4K`);
    fake.snapshot = snap({ position: 1, hwdec: "no", videoCodec: "hevc" });
    await advance(20_000);
    console.info(`${LOG} QUAL-06 phase=after-20s: loads=${JSON.stringify(fake.loads)} playing=${JSON.stringify(playingNow(tree))} tooWeak=${JSON.stringify(tooWeak(tree))}`);
    expect(fake.loads).toEqual([]);
    expect(playingNow(tree).activeVideoId).toBe("2160p");
    expect(tooWeak(tree).shown).toBe(false);
  });

  /** @req PLAY-QUAL-06[badger-tv] */
  it("a version no decoder of the TV handles is skipped for the best one it can play", async () => {
    fake.settings.defaultQuality = "2160p";
    fake.decoder = { "2160p": { hardware: false, software: false } };
    fake.snapshot = snap({ voConfigured: false });
    const tree = await mount();
    await advance(1000);
    console.info(`${LOG} QUAL-06 undecodable 4K: playing=${JSON.stringify(playingNow(tree))}`);
    expect(playingNow(tree)).toEqual({ source: rungUrl("1080p"), activeVideoId: "1080p", qualityMode: "auto" });
  });
});

describe("TV player: title picture until the first frame (PLAY-OPEN-01)", () => {
  /** @req PLAY-OPEN-01[badger-tv] */
  it("covers the starting player with the title's picture, removes it at the first frame and never shows it again", async () => {
    fake.snapshot = snap({ voConfigured: false, position: 0 });
    const tree = await mount();
    await advance(1000);
    const starting = { player: hosts(tree, "MpvPlayer").length, remote: remote(tree) !== undefined, backdrop: backdropShown(tree), images: hosts(tree, "Image").map((node) => node.props.source) };
    console.info(`${LOG} OPEN-01 phase=starting: ${JSON.stringify(starting)} remoteAttached=${fake.remoteAttached}`);
    fake.snapshot = snap({ position: 1 });
    await advance(1000);
    const firstFrame = backdropShown(tree);
    fake.snapshot = snap({ voConfigured: false, position: 3 });
    await advance(1000);
    const noFrameLater = backdropShown(tree);
    console.info(`${LOG} OPEN-01 phase=done: firstFrame=${firstFrame} noFrameLater=${noFrameLater}`);
    expect(starting).toEqual({ player: 1, remote: true, backdrop: true, images: [{ uri: "https://img.test/backdrop/backdrop.jpg" }] });
    expect(fake.remoteAttached).toBe(1);
    expect(firstFrame).toBe(false);
    expect(noFrameLater).toBe(false);
  });
});

describe("TV player: a quality picked on the TV (PLAY-ABR-04, PLAY-QUAL-04)", () => {
  /** @req PLAY-ABR-04[badger-tv] @req PLAY-QUAL-04[badger-tv] */
  it("reloads at the spot the viewer was at, completes, stays pinned through a slow network, and Auto unpins it", async () => {
    fake.snapshot = snap({ position: 600 });
    // The new rung opens where it was asked to and plays.
    fake.afterLoad = (at) => snap({ position: at, videoWidth: 854, videoHeight: 480 });
    const tree = await mount();
    await advance(10_000);
    const before = { at: Math.round(fake.snapshot!.position), playing: playingNow(tree) };
    console.info(`${LOG} ABR-04 phase=pick: before=${JSON.stringify(before)}`);
    await act(async () => {
      controls(tree).onSelectQuality("480p");
    });
    await advance(5_000);
    const afterPick = { loads: fake.loads.map((l) => [l.url.split("/").pop(), Math.round(l.startSeconds)]), playing: playingNow(tree), spinner: hosts(tree, "PlayerSpinner").length, position: Math.round(fake.snapshot!.position) };
    console.info(`${LOG} ABR-04 phase=after-pick: ${JSON.stringify(afterPick)}`);
    expect(fake.loads).toHaveLength(1);
    expect(fake.loads[0]!.url).toBe(rungUrl("480p"));
    expect(fake.loads[0]!.startSeconds).toBeGreaterThanOrEqual(before.at);
    expect(fake.loads[0]!.startSeconds).toBeLessThan(before.at + 5);
    expect(afterPick.playing).toEqual({ source: rungUrl("1080p"), activeVideoId: "480p", qualityMode: "manual" });
    expect(afterPick.position).toBeGreaterThan(before.at);

    console.info(`${LOG} QUAL-04 phase=throttle: a fast network then a crawling one must not move the pinned 480p`);
    fake.snapshot = { ...fake.snapshot!, netBps: 400_000_000 };
    await advance(30_000);
    fake.snapshot = { ...fake.snapshot!, netBps: 100_000, cacheDuration: 2 };
    await advance(30_000);
    console.info(`${LOG} QUAL-04 phase=after-throttle: loads=${fake.loads.length} playing=${JSON.stringify(playingNow(tree))}`);
    expect(fake.loads).toHaveLength(1);
    expect(playingNow(tree).activeVideoId).toBe("480p");
    expect(playingNow(tree).qualityMode).toBe("manual");

    await act(async () => {
      controls(tree).onSelectQuality("auto");
    });
    await advance(1_000);
    console.info(`${LOG} QUAL-04 phase=auto-again: playing=${JSON.stringify(playingNow(tree))}`);
    expect(playingNow(tree).qualityMode).toBe("auto");
  });
});

describe("TV player: Auto follows the network (PLAY-ABR-01, PLAY-ABR-02)", () => {
  /** @req PLAY-ABR-01[badger-tv] @req PLAY-ABR-02[badger-tv] */
  it("steps down when the network drops before the buffer runs dry, and climbs back to the Settings quality once it recovers", async () => {
    fake.snapshot = snap({ position: 100 });
    fake.afterLoad = (at) => {
      const rung = fake.loads.at(-1)!.url;
      const height = rung.includes("480p") ? 480 : rung.includes("2160p") ? 2160 : 1080;
      return snap({ position: at, videoWidth: Math.round((height * 16) / 9), videoHeight: height, netBps: fake.snapshot?.netBps ?? 50_000_000, cacheDuration: fake.snapshot?.cacheDuration ?? 60 });
    };
    const tree = await mount();
    await advance(10_000);
    console.info(`${LOG} ABR-01 phase=steady: playing=${JSON.stringify(playingNow(tree))}`);
    expect(playingNow(tree)).toMatchObject({ activeVideoId: "1080p", qualityMode: "auto" });

    console.info(`${LOG} ABR-01 phase=drop: the link falls to 1.5 Mbit/s and the buffer drains`);
    for (let s = 0; s < 40 && fake.loads.length === 0; s++) {
      const left = Math.max(1, 30 - s);
      fake.snapshot = { ...fake.snapshot!, netBps: 1_500_000, cacheDuration: left, cacheSecs: left };
      await advance(1_000);
    }
    const down = { loads: fake.loads.map((l) => [l.url.split("/").pop(), Math.round(l.startSeconds)]), playing: playingNow(tree), buffer: fake.snapshot!.cacheDuration, error: byTestId(tree, "player-error").length };
    console.info(`${LOG} ABR-01 phase=stepped-down: ${JSON.stringify(down)}`);
    expect(fake.loads).toHaveLength(1);
    expect(fake.loads[0]!.url).toBe(rungUrl("480p"));
    expect(down.buffer).toBeGreaterThan(0);
    expect(down.playing).toMatchObject({ activeVideoId: "480p", qualityMode: "auto" });
    expect(down.error).toBe(0);

    console.info(`${LOG} ABR-02 phase=recover: the link is fast again with a full buffer`);
    let recoveredAfterS: number | null = null;
    for (let s = 0; s < 180 && recoveredAfterS === null; s++) {
      fake.snapshot = { ...fake.snapshot!, netBps: 80_000_000, cacheDuration: 60, cacheSecs: 60 };
      await advance(1_000);
      if (playingNow(tree).activeVideoId === "1080p") recoveredAfterS = s + 1;
    }
    const up = { recoveredAfterS, loads: fake.loads.map((l) => [l.url.split("/").pop(), Math.round(l.startSeconds)]), playing: playingNow(tree) };
    console.info(`${LOG} ABR-02 phase=recovered: ${JSON.stringify(up)}`);
    expect(recoveredAfterS).not.toBeNull();
    expect(recoveredAfterS!).toBeLessThanOrEqual(150);
    expect(fake.loads.at(-1)!.url).toBe(rungUrl("1080p"));
    // Never above the Settings quality (1080p): the 4K version stays untouched.
    expect(fake.loads.some((l) => l.url === rungUrl("2160p"))).toBe(false);
    expect(up.playing).toMatchObject({ activeVideoId: "1080p", qualityMode: "auto" });
  });
});

describe("TV player: the stall timers never change quality (PLAY-ABR-03)", () => {
  /** @req PLAY-ABR-03[badger-tv] */
  it("a loading stretch shows the hint at 30 s and the error at 60 s, with no quality switch on the way", async () => {
    // On the lightest version Auto has nowhere lower to go, so any switch in this stall could only come from the timers.
    fake.settings.defaultQuality = "480p";
    fake.snapshot = snap({ position: 300, videoWidth: 854, videoHeight: 480 });
    const tree = await mount();
    await advance(5_000);
    console.info(`${LOG} ABR-03 phase=stall: the player waits for data with a healthy network estimate`);
    fake.snapshot = { ...fake.snapshot!, pausedForCache: true, paused: false, cacheDuration: 0, cacheSecs: 0 };
    const hintShown = () => byTestId(tree, "player-loading-slow").length > 0;
    await advance(25_000);
    const at25 = { hint: hintShown(), error: byTestId(tree, "player-error").length, loads: fake.loads.length };
    await advance(10_000);
    const at35 = { hint: hintShown(), error: byTestId(tree, "player-error").length, loads: fake.loads.length };
    await advance(30_000);
    const at65 = { error: byTestId(tree, "player-error").length, loads: fake.loads.length };
    console.info(`${LOG} ABR-03 phase=timeline: ${JSON.stringify({ at25, at35, at65, loads: fake.loads })}`);
    expect(at25).toEqual({ hint: false, error: 0, loads: 0 });
    expect(at35).toEqual({ hint: true, error: 0, loads: 0 });
    expect(at65).toEqual({ error: 1, loads: 0 });
  });
});

describe("TV player: a device that can't keep up gets a lighter existing version (PLAY-CODEC-01)", () => {
  /** @req PLAY-CODEC-01[badger-tv] */
  it("HEVC dropping frames with a full buffer moves to the H.264 copy at the same resolution, never back", async () => {
    // The ladder the spec's first step needs: the same 1080p in HEVC and H.264 (the server's hidden H.264 copy has its own id
    // but the same quality label), and a lighter 480p.
    fake.session!.metadata!.videos = [video("1080p", 1080, "hevc"), { ...video("1080p-avc", 1080, "h264"), quality: "1080p" }, video("480p", 480, "h264")] as never;
    fake.snapshot = snap({ position: 20, videoCodec: "hevc" });
    fake.afterLoad = (at) => snap({ position: at, videoCodec: "h264" });
    const tree = await mount();
    await advance(5_000);
    const started = playingNow(tree);
    console.info(`${LOG} CODEC-01 hevc phase=started: probes=${JSON.stringify(fake.probesAsked.map((p) => [p.id, p.mime]))} playing=${JSON.stringify(started)}`);
    expect(started).toMatchObject({ activeVideoId: "1080p", qualityMode: "auto" });

    console.info(`${LOG} CODEC-01 hevc phase=struggle: 10 dropped frames a second, buffer full`);
    await dropFramesUntilSwitch(10, 30);
    const fellBack = { loads: fake.loads.map((l) => [l.url.split("/").pop(), Math.round(l.startSeconds)]), playing: playingNow(tree), tooWeak: tooWeak(tree) };
    console.info(`${LOG} CODEC-01 hevc phase=fell-back: ${JSON.stringify(fellBack)}`);
    expect(fellBack.loads.map(([url]) => url)).toEqual(["master-1080p-avc.m3u8"]);
    expect(fellBack.playing).toMatchObject({ activeVideoId: "1080p-avc", qualityMode: "auto" });
    expect(fellBack.tooWeak.shown).toBe(false);

    console.info(`${LOG} CODEC-01 hevc phase=fast-network: 120 s of a fast link must not bring HEVC back`);
    for (let s = 0; s < 120; s++) {
      fake.snapshot = { ...fake.snapshot!, netBps: 400_000_000, cacheDuration: 60, cacheSecs: 60 };
      await advance(1_000);
    }
    console.info(`${LOG} CODEC-01 hevc phase=after-120s: loads=${JSON.stringify(fake.loads.map((l) => l.url.split("/").pop()))} playing=${JSON.stringify(playingNow(tree))}`);
    expect(fake.loads.map((l) => l.url.split("/").pop())).toEqual(["master-1080p-avc.m3u8"]);
  });

  /** @req PLAY-CODEC-01[badger-tv] */
  it("4K HEVC with no H.264 copy at 4K drops to the best lower H.264 version", async () => {
    fake.settings.defaultQuality = "2160p";
    fake.snapshot = snap({ position: 20, videoCodec: "hevc", videoWidth: 3840, videoHeight: 2160 });
    fake.afterLoad = (at) => snap({ position: at, videoCodec: "h264" });
    const tree = await mount();
    await advance(5_000);
    console.info(`${LOG} CODEC-01 4k phase=started: playing=${JSON.stringify(playingNow(tree))}`);
    expect(playingNow(tree)).toMatchObject({ activeVideoId: "2160p", qualityMode: "auto" });
    await dropFramesUntilSwitch(10, 30);
    const fellBack = { loads: fake.loads.map((l) => l.url.split("/").pop()), playing: playingNow(tree) };
    console.info(`${LOG} CODEC-01 4k phase=fell-back: ${JSON.stringify(fellBack)}`);
    // The best H.264 below 4K, not the bottom of the ladder.
    expect(fellBack.loads).toEqual(["master-1080p.m3u8"]);
    expect(fellBack.playing).toMatchObject({ activeVideoId: "1080p", qualityMode: "auto" });
  });

  /** @req PLAY-CODEC-01[badger-tv] */
  it("dropped frames while the buffer is starved are the network's business, not a device verdict", async () => {
    const warn = vi.spyOn(console, "warn");
    fake.snapshot = snap({ position: 20, cacheDuration: 0.5, cacheSecs: 0.5, netBps: 50_000_000 });
    const tree = await mount();
    await advance(5_000);
    await dropFrames(10, 20);
    const decoderVerdicts = warn.mock.calls.filter(([event]) => event === "playback.hevc.lag" || event === "playback.device.too_weak");
    const networkMoves = warn.mock.calls.filter(([event]) => event === "playback.abr.decision").map(([, json]) => String(json));
    console.info(`${LOG} CODEC-01 starved phase=after-drops: decoderVerdicts=${decoderVerdicts.length} networkMoves=${JSON.stringify(networkMoves)} loads=${JSON.stringify(fake.loads.map((l) => l.url.split("/").pop()))} tooWeak=${JSON.stringify(tooWeak(tree))}`);
    // A starved buffer may make the NETWORK rules step down (buffer-critical): that is PLAY-ABR, not a decoder verdict.
    expect(decoderVerdicts).toEqual([]);
    expect(tooWeak(tree).shown).toBe(false);
    warn.mockRestore();
  });
});

describe("TV player: the device fallback sticks for the file (PLAY-CODEC-02)", () => {
  /** @req PLAY-CODEC-02[badger-tv] @req PLAY-CODEC-01[badger-tv] */
  it("after dropping to a lighter version for lag, a fast network never climbs back above it while that file plays", async () => {
    fake.snapshot = snap({ position: 50 });
    fake.afterLoad = (at) => snap({ position: at, videoWidth: 854, videoHeight: 480 });
    const tree = await mount();
    await advance(5_000);
    console.info(`${LOG} CODEC-02 phase=struggle: Auto 1080p, 10 dropped frames a second with a full buffer`);
    await dropFrames(10, 20);
    const fellBack = { loads: fake.loads.map((l) => l.url.split("/").pop()), playing: playingNow(tree) };
    console.info(`${LOG} CODEC-02 phase=fell-back: ${JSON.stringify(fellBack)}`);
    expect(fellBack.loads).toEqual(["master-480p.m3u8"]);
    expect(fellBack.playing).toMatchObject({ activeVideoId: "480p", qualityMode: "auto" });

    console.info(`${LOG} CODEC-02 phase=fast-network: 150 s of a fast link, smooth playback, full buffer`);
    for (let s = 0; s < 150; s++) {
      fake.snapshot = { ...fake.snapshot!, netBps: 400_000_000, cacheDuration: 60, cacheSecs: 60 };
      await advance(1_000);
    }
    const later = { loads: fake.loads.map((l) => l.url.split("/").pop()), playing: playingNow(tree) };
    console.info(`${LOG} CODEC-02 phase=after-150s: ${JSON.stringify(later)}`);
    expect(later.loads).toEqual(["master-480p.m3u8"]);
    expect(later.playing).toMatchObject({ activeVideoId: "480p", qualityMode: "auto" });
  });
});

describe("TV player: a device that can't keep up (PLAY-QUAL-03, PLAY-CODEC-03)", () => {
  /** @req PLAY-QUAL-03[badger-tv] @req PLAY-CODEC-02[badger-tv] */
  it("Force on: no switch, the TV's notice with the Force hint, and Back on the remote closes it", async () => {
    fake.settings.forceQuality = true;
    fake.snapshot = snap({ position: 10 });
    const tree = await mount();
    await advance(5_000);
    console.info(`${LOG} QUAL-03 phase=struggle: Force 1080p, 10 dropped frames a second with a full buffer`);
    await dropFrames(10, 20);
    const notice = tooWeak(tree);
    const context = remote(tree)?.context;
    console.info(`${LOG} QUAL-03 phase=notice: ${JSON.stringify(notice)} remoteContext=${JSON.stringify(context)} loads=${fake.loads.length} playing=${JSON.stringify(playingNow(tree))} paused=${JSON.stringify(fake.paused)}`);
    expect(notice).toEqual({ shown: true, message: "player.deviceTooWeak.messageTv", hint: "player.deviceTooWeak.pinnedHint" });
    expect(byTestId(tree, "player-device-too-weak-keep")).toHaveLength(1);
    expect(context).toMatchObject({ noticeOpen: true, promptOpen: true });
    expect(fake.loads).toEqual([]);
    expect(playingNow(tree)).toMatchObject({ activeVideoId: "1080p", qualityMode: "manual" });
    expect(fake.paused).toEqual([]);

    console.info(`${LOG} QUAL-03 phase=back: Back on the remote while the notice is open`);
    await act(async () => {
      remote(tree)!.onDismissPrompt("notice");
    });
    await dropFrames(10, 10);
    console.info(`${LOG} QUAL-03 phase=after-back: ${JSON.stringify(tooWeak(tree))} loads=${fake.loads.length}`);
    expect(tooWeak(tree).shown).toBe(false);
    expect(fake.loads).toEqual([]);
  });

  /** @req PLAY-CODEC-03[badger-tv] */
  it("Auto on the lightest version: the TV's notice without the Force hint, playback keeps going", async () => {
    fake.settings.defaultQuality = "480p";
    fake.snapshot = snap({ position: 10, videoWidth: 854, videoHeight: 480 });
    const tree = await mount();
    await advance(5_000);
    await dropFrames(10, 20);
    const notice = tooWeak(tree);
    console.info(`${LOG} CODEC-03 phase=notice: ${JSON.stringify(notice)} loads=${fake.loads.length} playing=${JSON.stringify(playingNow(tree))}`);
    expect(notice).toEqual({ shown: true, message: "player.deviceTooWeak.messageTv", hint: null });
    expect(fake.loads).toEqual([]);
    expect(fake.paused).toEqual([]);
    await act(async () => {
      byTestId(tree, "player-device-too-weak-keep")[0]!.props.onPress();
    });
    console.info(`${LOG} CODEC-03 phase=keep-watching: ${JSON.stringify(tooWeak(tree))}`);
    expect(tooWeak(tree).shown).toBe(false);
  });
});

describe("TV player: progress goes to the episode that was playing (PLAY-RESUME-04)", () => {
  const episode = (id: string, n: number) => ({ id, seasonNumber: 1, episodeNumber: n, title: `Episode ${n}` }) as never;

  /** @req PLAY-RESUME-04[badger-tv] */
  it.each([
    ["previous", "onPreviousEpisode", false],
    ["next", "onNextEpisode", true],
  ] as const)("a quality switch then %s: every save names the episode left", async (which, prop, finished) => {
    Object.assign(fake.session!, { episode: episode("ep-5", 5), previousEpisode: episode("ep-4", 4), nextEpisode: episode("ep-6", 6) });
    fake.snapshot = snap({ position: 120 });
    fake.afterLoad = (at) => snap({ position: at });
    const tree = await mount();
    await advance(5_000);
    await act(async () => {
      controls(tree).onSelectQuality("480p");
    });
    await advance(20_000);
    await act(async () => {
      controls(tree)[prop]();
    });
    console.info(`${LOG} RESUME-04 ${which}: loads=${JSON.stringify(fake.loads.map((l) => [l.url.split("/").pop(), Math.round(l.startSeconds)]))} progress=${JSON.stringify(fake.progress)}`);
    expect(fake.loads).toHaveLength(1);
    expect(fake.progress.length).toBeGreaterThan(0);
    expect(new Set(fake.progress.map((p) => p.episodeId))).toEqual(new Set(["ep-5"]));
    const saved = fake.progress.at(-1)!;
    if (finished) {
      expect(saved.final).toBe(true);
      expect(saved.pct).toBe(100);
    } else {
      // Previous leaves the episode where the viewer stopped; a final save at the spot the periodic save just wrote is
      // skipped (`shouldPersistProgress`), so the last record may be that periodic one.
      expect(saved.pct).toBeLessThan(10);
      expect(saved.positionSeconds).toBeGreaterThanOrEqual(140);
      expect(saved.positionSeconds).toBeLessThan(200);
    }
  });
});

describe("TV player: remembered tracks (PLAY-TRACK-04)", () => {
  /** @req PLAY-TRACK-04[badger-tv] */
  it("starts on the title's remembered audio and subtitle, and a pick with the remote overwrites that title's choice", async () => {
    const prefs: TrackPrefs = { audioLanguage: "fr", subtitle: { language: "en", format: "vtt" }, updatedAt: "2026-11-01T00:00:00.000Z" };
    Object.assign(fake.session!, {
      trackPrefs: prefs,
      metadata: { ...fake.session!.metadata, audioTracks: [audio("a-en", "eng", true), audio("a-fr", "fre")], subtitleTracks: [subtitle("s-en", "eng"), subtitle("s-fr", "fre")] },
    });
    fake.mpvTracks = [
      { id: 1, type: "audio", selected: true, lang: "eng", title: null },
      { id: 2, type: "audio", selected: false, lang: "fre", title: null },
    ];
    fake.snapshot = snap({ voConfigured: false });
    const tree = await mount();
    await advance(1_000);
    const beforeFrame = { audioSet: [...fake.audioSet], subtitlesAdded: [...fake.subtitlesAdded] };
    fake.snapshot = snap({ position: 1 });
    await advance(2_000);
    const props = controls(tree);
    console.info(`${LOG} TRACK-04 phase=start: beforeFrame=${JSON.stringify(beforeFrame)} audioSet=${JSON.stringify(fake.audioSet)} subtitlesAdded=${JSON.stringify(fake.subtitlesAdded)} initialAudioIdx=${props.initialAudioIdx} initialSubtitleIdx=${props.initialSubtitleIdx}`);
    expect(beforeFrame).toEqual({ audioSet: [], subtitlesAdded: [] });
    expect(fake.audioSet).toEqual([2]);
    expect(fake.subtitlesAdded).toHaveLength(1);
    expect(fake.subtitlesAdded[0]).toContain("/playback/object/");
    expect(props.initialAudioIdx).toBe(1);
    expect(props.initialSubtitleIdx).toBe(0);
    expect(fake.trackSaves).toEqual([]);

    console.info(`${LOG} TRACK-04 phase=pick: English audio, then subtitles Off, from the TV controls`);
    await act(async () => {
      props.onAudioPick(audio("a-en", "eng", true));
      props.onSubtitlePick(null);
    });
    console.info(`${LOG} TRACK-04 phase=saved: ${JSON.stringify(fake.trackSaves)}`);
    expect(fake.trackSaves).toEqual([
      { mediaId: "media-1", patch: { audioLanguage: "en" } },
      { mediaId: "media-1", patch: { subtitle: "off" } },
    ]);
  });
});

describe("TV player: a resume another device wrote (PLAY-RESUME-03)", () => {
  const episode = (id: string, n: number) => ({ id, seasonNumber: 1, episodeNumber: n, title: `Episode ${n}` }) as never;
  const anyByTestId = (tree: ReactTestRenderer, testID: string) => tree.root.findAll((node) => node.props.testID === testID);

  /** @req PLAY-RESUME-03[badger-tv] */
  it("offers the spot the phone or desktop stopped at, Resume opens there, and the TV's saves go back to that episode", async () => {
    // `usePlayerSession` turns the synced `episode_resume_v1:ep-2` entry (750 s of 2400 s, written by another device)
    // into `resumeCandidateSeconds` through `resolveResumeCandidateSeconds` (library-episode-resume-sync.test.ts).
    Object.assign(fake.session!, { episode: episode("ep-2", 2), resumeCandidateSeconds: 750 });
    fake.snapshot = snap({ voConfigured: false, position: 750 });
    const tree = await mount();
    await advance(1_000);
    const offered = {
      prompt: anyByTestId(tree, "player-resume-prompt").length > 0,
      player: hosts(tree, "MpvPlayer").length,
      resume: anyByTestId(tree, "player-resume-continue").map((node) => node.props.accessibilityLabel)[0] ?? null,
    };
    console.info(`${LOG} RESUME-03 phase=offer: ${JSON.stringify(offered)}`);
    expect(offered.prompt).toBe(true);
    expect(offered.player).toBe(0);
    expect(offered.resume).toBe("player.resume.resumeAt");

    console.info(`${LOG} RESUME-03 phase=resume: OK on "Resume" with the remote`);
    await act(async () => {
      anyByTestId(tree, "player-resume-continue")[0]!.props.onPress();
    });
    await advance(1_000);
    const player = hosts(tree, "MpvPlayer")[0]?.props ?? null;
    console.info(`${LOG} RESUME-03 phase=opened: startOptions=${JSON.stringify(player?.startOptions ?? null)} source=${player?.source ?? null}`);
    expect(player?.startOptions).toBe("start=750.000");

    console.info(`${LOG} RESUME-03 phase=watch: 20 s on the TV, its saves are what the other device reads next`);
    fake.snapshot = snap({ position: 751 });
    await advance(20_000);
    console.info(`${LOG} RESUME-03 phase=saved: ${JSON.stringify(fake.progress)}`);
    expect(fake.progress.length).toBeGreaterThan(0);
    const saved = fake.progress.at(-1)!;
    expect(saved.episodeId).toBe("ep-2");
    expect(saved.positionSeconds).toBeGreaterThan(750);
    expect(saved.positionSeconds).toBeLessThan(800);
  });
});

describe("TV player: Home's Continue watching Resume (UX-TV-05)", () => {
  const anyByTestId = (tree: ReactTestRenderer, testID: string) => tree.root.findAll((node) => node.props.testID === testID);

  /** @req UX-TV-05[badger-tv] */
  it("opens straight at the saved position, with no resume question, when the Home card's Resume asks for it", async () => {
    // TvHomeScreen's Resume navigates to Player with `startAt: "resume"` (tvHomeLibraryLayout.test.tsx, "Resume and Start
    // over open the player at that point"); this is the other half: the player starts at the saved spot.
    // The mocked `useRoute` hands every caller the same route object, so the test sets Home's params on it.
    const route = (useRoute as unknown as () => { params: Record<string, unknown> })();
    const before = { ...route.params };
    Object.assign(route.params, { startAt: "resume" });
    try {
      Object.assign(fake.session!, { resumeCandidateSeconds: 1_234 });
      fake.snapshot = snap({ voConfigured: false, position: 1_234 });
      console.info(`${LOG} HOME-RESUME phase=mount: params=${JSON.stringify(route.params)} saved=1234`);
      const tree = await mount();
      await advance(1_000);
      const player = hosts(tree, "MpvPlayer")[0]?.props ?? null;
      const state = {
        prompt: anyByTestId(tree, "player-resume-prompt").length > 0,
        startOptions: player?.startOptions ?? null,
        source: player?.source ?? null,
      };
      console.info(`${LOG} HOME-RESUME phase=opened: ${JSON.stringify(state)}`);
      expect(state.prompt).toBe(false);
      expect(state.startOptions).toBe("start=1234.000");
    } finally {
      for (const key of Object.keys(route.params)) delete route.params[key];
      Object.assign(route.params, before);
    }
  });
});

describe("TV player: Get subtitles and Try another version in the player (PLAY-SUBGET-02, -07, #2500)", () => {
  const sintel = {
    id: "media-1",
    type: "movie",
    title: "Sintel",
    tmdbId: 45745,
    episodes: [],
    files: [{ filename: "Sintel (2010).mkv", season: null, episode: null }],
    subtitleTracks: [],
  };
  const fetchedEs = { ...subtitle("sub-es", "es"), label: "Spanish", source: "opensubtitles:11" } as SubtitleTrack;

  /** @req PLAY-SUBGET-02[badger-tv] */
  it("offers Get more on TV, and opening it pauses and shows the panel holding the D-pad", async () => {
    const session = fake.session as unknown as { details: unknown };
    session.details = sintel;
    try {
      fake.snapshot = snap({ position: 30 });
      const tree = await mount();
      await advance(500);
      const getMore = controls(tree).getMoreSubtitles as { title: string; unavailableReason: string | null; onPress: () => void } | null;
      console.info(`${LOG} SUBGET-02 tv getMore=${JSON.stringify(getMore && { title: getMore.title, unavailableReason: getMore.unavailableReason })}`);
      expect(getMore).not.toBeNull();
      expect(getMore!.unavailableReason).toBeNull();
      const pausedBefore = fake.paused.length;
      await act(async () => {
        getMore!.onPress();
      });
      await advance(250);
      const remote = hosts(tree, "TvPlayerRemote")[0]!.props.context as { promptOpen: boolean };
      console.info(`${LOG} SUBGET-02 tv opened: paused=${JSON.stringify(fake.paused.slice(pausedBefore))} panel=${hosts(tree, "PlayerSubtitleFetch").length} promptOpen=${remote.promptOpen}`);
      expect(fake.paused.slice(pausedBefore)).toContain(true);
      expect(hosts(tree, "PlayerSubtitleFetch")).toHaveLength(1);
      expect(remote.promptOpen).toBe(true);
    } finally {
      session.details = null;
    }
  });

  /** @req PLAY-SUBGET-07[badger-tv] */
  it("Try another version puts the new subtitle in the old one's row, switches it on and resumes; Back resumes unchanged", async () => {
    const session = fake.session as unknown as { details: unknown; metadata: { subtitleTracks: SubtitleTrack[] } };
    session.details = sintel;
    session.metadata = { ...session.metadata, subtitleTracks: [subtitle("sub-en", "en"), fetchedEs] };
    try {
      fake.snapshot = snap({ position: 30 });
      const tree = await mount();
      await advance(500);
      const picks: unknown[] = [];
      const handle = controls(tree).handleRef as { current: unknown };
      handle.current = {
        selectSubtitle: async (idx: number, options?: { reload?: boolean }) => void picks.push([idx, options ?? null]),
        trackState: () => ({ audioIdx: 0, subtitleIdx: 1 }),
      };
      const tryAnother = controls(tree).tryAnotherSubtitle as { isFetched: (t: SubtitleTrack) => boolean; onPress: (t: SubtitleTrack) => void };
      expect(tryAnother.isFetched(fetchedEs)).toBe(true);
      expect(tryAnother.isFetched(subtitle("sub-en", "en"))).toBe(false);

      console.info(`${LOG} SUBGET-07 phase=back: open, then Back with nothing saved`);
      let pausedAt = fake.paused.length;
      await act(async () => tryAnother.onPress(fetchedEs));
      expect(hosts(tree, "PlayerSubtitleVersion")[0]!.props.track).toEqual({ id: "sub-es", language: "es", label: "Spanish", source: "opensubtitles:11" });
      await act(async () => (hosts(tree, "PlayerSubtitleVersion")[0]!.props.onClose as (r: null) => void)(null));
      console.info(`${LOG} SUBGET-07 back: paused=${JSON.stringify(fake.paused.slice(pausedAt))} picks=${JSON.stringify(picks)}`);
      expect(fake.paused.slice(pausedAt)).toEqual([true, false]);
      expect(hosts(tree, "PlayerSubtitleVersion")).toHaveLength(0);
      expect((controls(tree).subtitleTracks as SubtitleTrack[]).map((t) => t.id)).toEqual(["sub-en", "sub-es"]);
      expect(picks).toEqual([]);

      console.info(`${LOG} SUBGET-07 phase=replaced`);
      pausedAt = fake.paused.length;
      await act(async () => tryAnother.onPress(fetchedEs));
      const replacement = { id: "sub-es-2", language: "es", label: "Spanish", objectKey: "obj/es-2.srt", format: "srt", source: "opensubtitles:12" };
      await act(async () => (hosts(tree, "PlayerSubtitleVersion")[0]!.props.onClose as (r: typeof replacement) => void)(replacement));
      await advance(250);
      const tracks = controls(tree).subtitleTracks as SubtitleTrack[];
      console.info(
        `${LOG} SUBGET-07 replaced: tracks=${JSON.stringify(tracks.map((t) => [t.id, t.label, t.source ?? null]))} picks=${JSON.stringify(picks)} paused=${JSON.stringify(fake.paused.slice(pausedAt))}`,
      );
      expect(tracks.map((t) => [t.id, t.label, t.source ?? null])).toEqual([
        ["sub-en", "en", null],
        ["sub-es-2", "Spanish", "opensubtitles:12"],
      ]);
      expect(picks).toEqual([[1, { reload: true }]]);
      expect(fake.paused.slice(pausedAt)).toEqual([true, false]);
    } finally {
      session.details = null;
    }
  });
});

/**
 * @test-id MOBILE-PLAYER-NEXT-EPISODE-START-QUALITY-001
 * @level unit
 *
 * PLAY-QUAL-05 on the phone: when playback moves to the next episode it starts at the Settings quality, never at the
 * quality the previous episode ended on. The test renders the real `PlayerScreen` with the real Settings store and the
 * real quality controller, plays episode 1, makes it end on another rung (a manual pick, or a Settings change), then
 * moves the route to episode 2 exactly as autoplay and the "Next episode" button do (`navigation.setParams` with the
 * new `episodeId`). It reads what the screen hands to the player: the rung the controls show and the playlist mpv
 * loads. The player session (network, proxy), the native player and the overlays are stubbed.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoFormat } from "@space/mobile-mpv-playback";
import { __resetAppSettingsForTests, updateAppSettings } from "../src/lib/appSettings";
import { PlayerScreen } from "../src/screens/PlayerScreen";
import type { PlayerSession } from "../src/screens/player/usePlayerSession";
import { createFakeAsyncStorage } from "./harness";

type ControlsProps = { activeVideoId: string | null; qualityMode: "auto" | "manual"; onSelectQuality: (picked: string) => void };

const screen = vi.hoisted(() => ({
  params: { mediaId: "show", episodeId: "e1" as string | null },
  controls: null as ControlsProps | null,
  playerSource: null as string | null,
}));
const fakeStorage = createFakeAsyncStorage();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));
vi.mock("react-native", () => {
  const host = (name: string) => (props: { children?: ReactNode }) => createElement(name, props, props.children);
  return {
    View: host("View"),
    Text: host("Text"),
    ActivityIndicator: host("ActivityIndicator"),
    StyleSheet: { create: <T>(styles: T): T => styles, hairlineWidth: 1, absoluteFillObject: {} },
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: "android", select: <T>(spec: { android?: T; default?: T }) => spec.android ?? spec.default },
    // The media session package registers its keep-alive headless task at load; no native session module here.
    AppRegistry: { registerHeadlessTask: () => undefined },
    DeviceEventEmitter: { addListener: () => ({ remove: () => undefined }) },
    NativeModules: {},
    NativeEventEmitter: class {
      addListener() {
        return { remove: () => undefined };
      }
    },
    useWindowDimensions: () => ({ width: 960, height: 540 }),
  };
});
const navigation = { setParams: () => undefined, canGoBack: () => true, goBack: () => undefined, navigate: () => undefined };
vi.mock("@react-navigation/native", () => ({
  useRoute: () => ({ params: screen.params }),
  useNavigation: () => navigation,
}));
vi.mock("@space/mobile-mpv-playback", () => ({
  PlaybackBridge: { onTraffic: () => () => undefined, setBufferCap: async () => true, warmRung: () => null },
  MpvControl: {
    getDecoderCaps: async () => null,
    setImmersiveLandscape: async () => undefined,
    setKeepScreenOn: async () => undefined,
  },
  MpvPlayer: (props: { source: string | null }) => {
    screen.playerSource = props.source;
    return null;
  },
  PlayerControls: (props: ControlsProps) => {
    screen.controls = props;
    return null;
  },
}));
// The shell package ships its own copy of React, so react-i18next's hook cannot run inside this app's renderer; the
// real i18next instance stays, only the hook is bound to it directly.
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/i18n")>();
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: "en" } }) };
});
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ user: null, refresh: async () => undefined }) }));
// The phone player under test: the TV runtime is off and its remote is not mounted.
// The metadata service (LIB-LANG-01 episode names) is out of scope here: signed out, nothing localized.
vi.mock("../src/lib/metadata/runtime", () => ({ fetchEpisodes: async () => [] }));
vi.mock("../src/tv/lib/tvRuntime", () => ({ IS_TV: false }));
vi.mock("../src/tv/components/TvPlayerRemote", () => ({ TvPlayerRemote: () => null }));
// The cast picker drives the Google Cast SDK (a native module); casting is not under test.
vi.mock("../src/components/PlayerCastPicker", () => ({ PlayerCastPicker: () => null }));
// "Get subtitles" (PLAY-SUBGET) loads the metadata client and lucide icons (native modules, Flow sources): a stand-in.
vi.mock("../src/screens/player/PlayerSubtitleFetch", () => ({ PlayerSubtitleFetch: () => null }));
vi.mock("../src/screens/player/PlayerSubtitleFile", () => ({ PlayerSubtitleFile: () => null }));
// The lock-screen poster (PLAY-OSMEDIA-01) reads the image through the keychain-held library key; no poster here.
vi.mock("../src/lib/useMediaImage", () => ({ useMediaImage: () => null }));
const library = { setPlaybackProgress: async () => undefined, setTrackPrefs: async () => undefined };
vi.mock("../src/store/library", () => ({ useLibraryActions: () => library }));
vi.mock("../src/lib/playback/usePlaybackSnapshot", () => ({ usePlaybackSnapshot: () => noSnapshot }));
vi.mock("../src/screens/player/PlayerOverlays", () => {
  const none = () => null;
  return { DeviceTooWeakNotice: none, NextEpisodeCard: none, PlayerError: none, PlayerLoadingBackdrop: none, PlayerSpinner: none, ResumePrompt: none, SkipPill: none, TrafficCapNotice: none };
});
vi.mock("../src/screens/player/usePlayerSession", () => ({
  usePlayerSession: (_mediaId: string, episodeId: string | null) => sessions[episodeId ?? ""]!,
}));

const noSnapshot = { snapshot: null, latest: { current: null } };

const video = (id: string, quality: string, bitrateKbps: number, height: number): VideoFormat => ({
  id,
  quality,
  codec: "h264",
  codecString: "avc1.640028",
  initKey: `${id}/init`,
  initSize: 1_000,
  durationSeconds: 1_400,
  totalSize: 1_000_000,
  bitrateKbps,
  height,
  width: Math.round((height * 16) / 9),
  chunks: [],
});

const episode = (id: string, n: number) => ({ id, seasonNumber: 1, episodeNumber: n, name: `Episode ${n}`, overview: null, stillPath: null, airDate: null });

/** A ready session for one episode of the show: its own versions (one file each) and its own proxy master playlist. */
const session = (id: string, n: number): PlayerSession => ({
  phase: "ready",
  error: null,
  closeReason: null,
  reload: () => undefined,
  playUrl: `http://127.0.0.1:9000/${id}/master.m3u8`,
  metadata: {
    encryptionKeyBase64: "",
    videos: [video(`${id}-f`, "1080p", 6_000, 1080), video(`${id}-h`, "720p", 2_500, 720), video(`${id}-s`, "480p", 1_000, 480)],
    audioTracks: [],
    subtitleTracks: [],
    chapters: [],
  },
  details: null,
  episode: episode(id, n),
  nextEpisode: n === 1 ? episode("e2", 2) : null,
  previousEpisode: null,
  markers: [],
  durationSeconds: 1_400,
  resumeCandidateSeconds: null,
  trackPrefs: null,
  fetchTraffic: null,
  offline: false,
  previews: null,
});
const sessions: Record<string, PlayerSession> = { e1: session("e1", 1), e2: session("e2", 2) };

/** What the screen shows and loads right now: the controls' rung and mode, and the playlist given to mpv. */
const observed = () => ({
  rung: screen.controls?.activeVideoId ?? null,
  mode: screen.controls?.qualityMode ?? null,
  playlist: screen.playerSource?.replace("http://127.0.0.1:9000/", "") ?? null,
});

let tree: ReactTestRenderer | null = null;

const playEpisode1 = async () => {
  screen.params = { mediaId: "show", episodeId: "e1" };
  act(() => {
    tree = create(createElement(PlayerScreen));
  });
  // Let the async quality start (decoder caps, then the controller) settle.
  await act(async () => undefined);
};

/** What autoplay and the "Next episode" button do: `navigation.setParams({ mediaId, episodeId: next.id })`. */
const goToEpisode2 = async () => {
  screen.params = { mediaId: "show", episodeId: "e2" };
  act(() => {
    tree!.update(createElement(PlayerScreen));
  });
  await act(async () => undefined);
};

describe("the next episode starts at the Settings quality on the phone", () => {
  beforeAll(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });
  beforeEach(() => {
    __resetAppSettingsForTests();
    screen.controls = null;
    screen.playerSource = null;
  });
  afterEach(() => {
    act(() => tree?.unmount());
    tree = null;
  });

  /** @req PLAY-QUAL-05[badger-mobile,badger-tv] */
  it("after a manual pick of a lower rung, episode 2 starts at the Settings rung in Auto", async () => {
    updateAppSettings({ defaultQuality: "1080p", forceQuality: false });
    await playEpisode1();
    console.info(`episode 1 start: ${JSON.stringify(observed())}`);
    expect(observed()).toEqual({ rung: "e1-f", mode: "auto", playlist: "e1/master-e1-f.m3u8" });

    act(() => screen.controls!.onSelectQuality("e1-s"));
    console.info(`episode 1 after picking 480p: ${JSON.stringify(observed())}`);
    expect(observed().rung).toBe("e1-s");
    expect(observed().mode).toBe("manual");

    await goToEpisode2();
    console.info(`episode 2 start: ${JSON.stringify(observed())}`);
    expect(observed()).toEqual({ rung: "e2-f", mode: "auto", playlist: "e2/master-e2-f.m3u8" });
  });

  /** @req PLAY-QUAL-05[badger-mobile,badger-tv] */
  it("a Settings quality changed during episode 1 is the one episode 2 starts at", async () => {
    updateAppSettings({ defaultQuality: "1080p", forceQuality: false });
    await playEpisode1();
    console.info(`episode 1 start: ${JSON.stringify(observed())}`);
    expect(observed().rung).toBe("e1-f");

    updateAppSettings({ defaultQuality: "480p" });
    await goToEpisode2();
    console.info(`episode 2 start with Settings 480p: ${JSON.stringify(observed())}`);
    expect(observed()).toEqual({ rung: "e2-s", mode: "auto", playlist: "e2/master-e2-s.m3u8" });
  });
});

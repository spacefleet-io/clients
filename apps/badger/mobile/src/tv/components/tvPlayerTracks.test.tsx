/**
 * @test-id TV-PLAYER-TRACKS-001
 * @level component
 * @regression-proof
 *
 * The player controls in their TV form (`tv`: D-pad focus, tabbed menus), as the TV's `PlayerScreen` mounts them,
 * against a fake mpv. Menus are opened with their chrome buttons and rows chosen with OK (`onPress`), as the remote does.
 *  - PLAY-TRACK-01: audio and subtitles are picked separately during playback; one pick keeps the other choice;
 *  - PLAY-TRACK-02: the TV subtitle menu lists the translated "Off" first and choosing it removes the subtitles; the
 *    audio menu has no "Off" row;
 *  - PLAY-TRACK-06: a picked subtitle that fails to load shows "Subtitles couldn't load", the previous subtitle is put
 *    back in mpv and in the menu, and the failed pick is not reported for remembering.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlayerControls,
  type PlayerControlsHandle,
  type PlayerControlsLabels,
  type PlayerControlsProps,
} from "@space/mobile-mpv-playback/PlayerControls";
import type { AudioTrack, SubtitleTrack } from "@space/mobile-mpv-playback/types";

const TAG = "[tv-player-tracks]";

/** What the fake mpv was asked, in order, and which subtitle URLs fail to load. */
const mpv = vi.hoisted(() => ({ calls: [] as string[], failingUrls: new Set<string>() }));

// PlayerControls draws its chrome glyphs with react-native-svg (PLAY-OVL-04): host-element stand-ins.
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path", Rect: "Rect", Circle: "Circle", Line: "Line" }));
vi.mock("react-native", async () => {
  class Value {
    value: number;
    stop: (() => void) | null = null;
    constructor(value: number) {
      this.value = value;
    }
    setValue(value: number) {
      this.stop?.();
      this.value = value;
    }
    extractOffset() {}
    interpolate() {
      return this;
    }
    flattenOffset() {}
  }
  const settle = (target: Value, config: { toValue: number }) => ({
    start: (onEnd?: (result: { finished: boolean }) => void) => {
      target.stop?.();
      const id = setTimeout(() => {
        target.stop = null;
        target.value = config.toValue;
        onEnd?.({ finished: true });
      }, 200);
      target.stop = () => {
        clearTimeout(id);
        target.stop = null;
        onEnd?.({ finished: false });
      };
    },
  });
  const parallel = (animations: { start: (onEnd?: () => void) => void }[]) => ({
    start: (onEnd?: (result: { finished: boolean }) => void) => {
      let left = animations.length;
      for (const animation of animations) animation.start(() => (--left === 0 ? onEnd?.({ finished: true }) : undefined));
    },
  });
  return {
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    TVFocusGuideView: "TVFocusGuideView",
    StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { View: "AnimatedView", Value, timing: settle, spring: settle, parallel },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Dimensions: { get: () => ({ width: 1920, height: 1080 }) },
    useWindowDimensions: () => ({ width: 1920, height: 1080 }),
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  };
});
vi.mock("@space/mobile-mpv-playback/MpvControl", () => ({
  MpvControl: {
    getTrackList: async () => [
      { id: 1, type: "audio", selected: true, lang: "eng", title: null },
      { id: 2, type: "audio", selected: false, lang: "fre", title: null },
    ],
    setAudioTrack: async (id: number) => {
      mpv.calls.push(`setAudioTrack ${id}`);
    },
    removeAllSubtitles: async () => {
      mpv.calls.push("removeAllSubtitles");
    },
    addSubtitle: async (url: string) => {
      const fails = mpv.failingUrls.has(url);
      mpv.calls.push(`addSubtitle ${url}${fails ? " (fails)" : ""}`);
      if (fails) throw Object.assign(new Error("sub-add failed"), { code: "subtitle_load_failed" });
    },
    seek: async () => undefined,
    setPaused: async () => undefined,
  },
}));

const labels: PlayerControlsLabels = {
  closePlayer: "Close player",
  videoSurface: "Video",
  chapters: "Chapters",
  previousEpisode: "Previous episode",
  nextEpisode: "Next episode",
  subtitles: "Subtitles",
  audio: "Audio",
  quality: "Quality",
  volume: "Volume",
  brightness: "Brightness",
  seekBackToast: "-10 s",
  seekForwardToast: "+10 s",
  seekBy: (amount: string) => `${amount} s`,
  play: "Play",
  pause: "Pause",
  seekBar: "Seek bar",
  qualityAuto: "Auto",
  subtitlesOff: "Aucun",
  subtitleLoadFailed: "Les sous-titres n'ont pas pu être chargés",
  trackFallback: (position: number) => `Track ${position}`,
};

const audio = (id: string, language: string, label: string): AudioTrack =>
  ({ id, language, label, isDefault: language === "eng", codec: "aac", codecString: "mp4a.40.2", initKey: `${id}/init`, initSize: 1, durationSeconds: 600, totalSize: 1, chunks: [] }) as AudioTrack;
const subtitle = (id: string, language: string, label: string): SubtitleTrack =>
  ({ id, language, label, isDefault: false, format: "vtt", encrypted: false, url: `subs-${language}/${language}.vtt` }) as SubtitleTrack;

const AUDIO = [audio("a-en", "eng", "English"), audio("a-fr", "fre", "Français")];
const SUBS = [subtitle("s-en", "eng", "English"), subtitle("s-fr", "fre", "Français")];

let renderer: ReactTestRenderer | null = null;
const handle = React.createRef<PlayerControlsHandle>();
let audioPicks: (string | null)[] = [];
let subtitlePicks: (string | null)[] = [];

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  mpv.calls = [];
  mpv.failingUrls = new Set();
  audioPicks = [];
  subtitlePicks = [];
});

afterEach(async () => {
  console.info(TAG, "mpv calls", JSON.stringify(mpv.calls));
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
  vi.useRealTimers();
});

const root = (): ReactTestInstance => {
  if (!renderer) throw new Error(`${TAG} nothing mounted`);
  return renderer.root;
};
const hosts = (testID: string) => root().findAll((node) => node.props.testID === testID && typeof node.type === "string");
const one = (testID: string) => {
  const found = hosts(testID);
  if (found.length !== 1) throw new Error(`${TAG} expected one ${testID}, found ${found.length}`);
  return found[0]!;
};
const textsUnder = (node: ReactTestInstance): string[] =>
  node.findAll((n) => String(n.type) === "Text").flatMap((n) => [n.props.children].flat().filter((c): c is string => typeof c === "string"));
/** The open menu's rows, top to bottom: testID, first text, selected. */
const rows = (prefix: string) =>
  root()
    .findAll((n) => typeof n.type === "string" && typeof n.props.testID === "string" && n.props.testID.startsWith(prefix))
    .map((n) => ({ id: n.props.testID as string, title: textsUnder(n)[0] ?? null, selected: n.props.accessibilityState?.selected === true }));
const noticeShown = () => textsUnder(root()).includes(labels.subtitleLoadFailed);

const mount = async (props: Partial<PlayerControlsProps> = {}) => {
  await act(async () => {
    renderer = create(
      React.createElement(PlayerControls, {
        labels,
        tv: true,
        handleRef: handle,
        hlsUrl: "http://127.0.0.1:40547/playback/hls/4bb5b7c2/master.m3u8",
        fullDuration: 600,
        videos: [],
        audioTracks: AUDIO,
        subtitleTracks: SUBS,
        chapters: [],
        snapshot: { position: 30, duration: 600, paused: false, cacheEnd: 60 } as never,
        onBackPress: () => undefined,
        onAudioPick: (track: AudioTrack) => audioPicks.push(track.id),
        onSubtitlePick: (track: SubtitleTrack | null) => subtitlePicks.push(track?.id ?? null),
        title: "Friends · S1 E1",
        ...props,
      }),
      { createNodeMock: () => ({ requestTVFocus: () => undefined, measure: () => undefined }) },
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
};

/** OK on a chrome button (opens its menu), then the menu's slide-in. */
const openMenu = async (button: string) => {
  await act(async () => {
    handle.current!.show("top");
    await vi.advanceTimersByTimeAsync(200);
  });
  await act(async () => {
    one(button).props.onPress();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
};
/** OK on a menu row; the pick's native calls settle. */
const choose = async (testID: string) => {
  await act(async () => {
    one(testID).props.onPress();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
};

describe("TV player: audio and subtitles are picked separately (PLAY-TRACK-01)", () => {
  /** @req PLAY-TRACK-01[badger-tv] */
  it("an audio pick leaves the subtitle as it was, and a subtitle pick leaves the audio", async () => {
    await mount({ initialAudioIdx: 0, initialSubtitleIdx: 1 });
    console.info(TAG, "TRACK-01 phase=start", JSON.stringify(handle.current!.trackState()));

    await openMenu("player-audio-button");
    const audioMenu = { tabs: hosts("player-sheet-tabs").map(textsUnder), rows: rows("player-audio-option") };
    console.info(TAG, "TRACK-01 phase=audio-menu", JSON.stringify(audioMenu));
    expect(audioMenu.tabs).toEqual([["Subtitles", "Audio", "Quality"]]);
    await choose("player-audio-option-1");
    const afterAudio = { state: handle.current!.trackState(), calls: [...mpv.calls], audioPicks, subtitlePicks };
    console.info(TAG, "TRACK-01 phase=after-audio", JSON.stringify(afterAudio));
    expect(afterAudio.state).toEqual({ audioIdx: 1, subtitleIdx: 1 });
    expect(afterAudio.calls).toEqual(["setAudioTrack 2"]);
    expect(audioPicks).toEqual(["a-fr"]);
    expect(subtitlePicks).toEqual([]);

    mpv.calls = [];
    await openMenu("player-subtitles-button");
    await choose("player-subtitle-option-0");
    const afterSub = { state: handle.current!.trackState(), calls: [...mpv.calls], audioPicks, subtitlePicks };
    console.info(TAG, "TRACK-01 phase=after-subtitle", JSON.stringify(afterSub));
    expect(afterSub.state).toEqual({ audioIdx: 1, subtitleIdx: 0 });
    expect(afterSub.calls[0]).toBe("removeAllSubtitles");
    expect(afterSub.calls[1]).toMatch(/^addSubtitle http:\/\/127\.0\.0\.1:40547\/playback\/object\//);
    expect(afterSub.calls.some((c) => c.startsWith("setAudioTrack"))).toBe(false);
    expect(audioPicks).toEqual(["a-fr"]);
    expect(subtitlePicks).toEqual(["s-en"]);
  });
});

describe("TV player: subtitles can always be turned off (PLAY-TRACK-02)", () => {
  /** @req PLAY-TRACK-02[badger-tv] */
  it("the TV subtitle menu starts with the translated Off row, choosing it removes the subtitles; audio has no Off", async () => {
    await mount({ initialSubtitleIdx: 0 });
    await openMenu("player-subtitles-button");
    const subMenu = rows("player-subtitle-option");
    console.info(TAG, "TRACK-02 phase=subtitle-menu", JSON.stringify(subMenu));
    expect(subMenu.map((r) => r.id)).toEqual(["player-subtitle-option-off", "player-subtitle-option-0", "player-subtitle-option-1"]);
    expect(subMenu[0]).toEqual({ id: "player-subtitle-option-off", title: "Aucun", selected: false });
    expect(subMenu[1]!.selected).toBe(true);

    await choose("player-subtitle-option-off");
    const afterOff = { state: handle.current!.trackState(), calls: [...mpv.calls], subtitlePicks };
    console.info(TAG, "TRACK-02 phase=after-off", JSON.stringify(afterOff));
    expect(afterOff.calls).toEqual(["removeAllSubtitles"]);
    expect(afterOff.state.subtitleIdx).toBe(-1);
    expect(subtitlePicks).toEqual([null]);

    await openMenu("player-subtitles-button");
    const reopened = rows("player-subtitle-option");
    console.info(TAG, "TRACK-02 phase=reopened", JSON.stringify(reopened));
    expect(reopened[0]).toMatchObject({ id: "player-subtitle-option-off", selected: true });

    await act(async () => {
      handle.current!.closeSheet();
      await vi.advanceTimersByTimeAsync(400);
    });
    await openMenu("player-audio-button");
    const audioMenu = rows("player-audio-option");
    console.info(TAG, "TRACK-02 phase=audio-menu", JSON.stringify(audioMenu));
    expect(audioMenu.map((r) => r.title)).toEqual(["English", "Français"]);
  });
});

describe("TV player: a subtitle that fails to load (PLAY-TRACK-06)", () => {
  /** @req PLAY-TRACK-06[badger-tv] */
  it("shows the notice, puts the previous subtitle back in mpv and in the menu, and does not report the failed pick", async () => {
    await mount({ initialSubtitleIdx: 0 });
    console.info(TAG, "TRACK-06 phase=learn-url: a first French pick that loads, to learn its sidecar URL");
    await openMenu("player-subtitles-button");
    await choose("player-subtitle-option-1");
    console.info(TAG, "TRACK-06 phase=learned", JSON.stringify(mpv.calls));
    const frenchUrl = mpv.calls.find((c) => c.startsWith("addSubtitle"))!.slice("addSubtitle ".length);

    console.info(TAG, "TRACK-06 phase=reset: back to English, then the French sidecar fails to load (a proxy 502)");
    await openMenu("player-subtitles-button");
    await choose("player-subtitle-option-0");
    mpv.calls = [];
    subtitlePicks = [];
    mpv.failingUrls = new Set([frenchUrl]);
    await openMenu("player-subtitles-button");
    await choose("player-subtitle-option-1");
    const failed = { notice: noticeShown(), state: handle.current!.trackState(), calls: [...mpv.calls], subtitlePicks };
    console.info(TAG, "TRACK-06 phase=failed", JSON.stringify(failed));
    expect(failed.notice).toBe(true);
    expect(failed.state.subtitleIdx).toBe(0);
    expect(failed.calls[0]).toBe("removeAllSubtitles");
    expect(failed.calls[1]).toBe(`addSubtitle ${frenchUrl} (fails)`);
    expect(failed.calls[2]).toMatch(/^addSubtitle .*\/playback\/object\//);
    expect(failed.calls[2]).not.toContain("(fails)");
    expect(failed.calls).toHaveLength(3);
    expect(subtitlePicks).toEqual([]);

    await openMenu("player-subtitles-button");
    const menu = rows("player-subtitle-option");
    console.info(TAG, "TRACK-06 phase=menu-after", JSON.stringify(menu));
    expect(menu.find((r) => r.selected)?.id).toBe("player-subtitle-option-0");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    console.info(TAG, "TRACK-06 phase=later", JSON.stringify({ notice: noticeShown() }));
    expect(noticeShown()).toBe(false);
  });
});

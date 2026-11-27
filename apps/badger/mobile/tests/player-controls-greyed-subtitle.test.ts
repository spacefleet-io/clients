// @bugfix @regression-proof
// @req PLAY-TRACK-05
// Emulator hand check of #804 (2026-10-29): under direct rendering the greyed picture rows (no OCR twin) of the TV
// subtitle menu were disabled Pressables, so Android TV could not focus them. DOWN past the last pickable row sent
// focus to the menu's ScrollView: no row showed the focus ring until UP. Like the greyed episodes (UX-TV-08), a greyed
// row stays reachable by the remote and OK on it does nothing; on a phone it stays a disabled control.
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PlayerControls,
  type PlayerControlsHandle,
  type PlayerControlsLabels,
} from "../../../../packages/mobile-mpv-playback/src/components/PlayerControls";
import type { SubtitleTrack } from "../../../../packages/mobile-mpv-playback/src/types";

const TAG = "[player-controls-greyed-subtitle]";

// PlayerControls draws its chrome glyphs with react-native-svg (PLAY-OVL-04): host-element stand-ins.
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path", Rect: "Rect", Circle: "Circle", Line: "Line" }));
vi.mock("react-native", async () => {
  class Value {
    value: number;
    constructor(value: number) {
      this.value = value;
    }
    setValue(value: number) {
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
      setTimeout(() => {
        target.value = config.toValue;
        onEnd?.({ finished: true });
      }, 200);
    },
  });
  const parallel = (animations: { start: (onEnd?: () => void) => void }[]) => ({
    start: (onEnd?: (result: { finished: boolean }) => void) => {
      let left = animations.length;
      for (const animation of animations) animation.start(() => (--left === 0 ? onEnd?.({ finished: true }) : undefined));
    },
  });
  return {
    ...(await import("./setup/reactNativeMock")).reactNativeBase(),
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    TVFocusGuideView: "TVFocusGuideView",
    StyleSheet: { create: <T>(styles: T) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { View: "AnimatedView", Value, timing: settle, spring: settle, parallel },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Dimensions: { get: () => ({ width: 1920, height: 1080 }) },
    useWindowDimensions: () => ({ width: 1920, height: 1080 }),
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  };
});
vi.mock("../../../../packages/mobile-mpv-playback/src/MpvControl", () => ({
  MpvControl: new Proxy({}, { get: () => () => Promise.resolve([]) }),
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
  subtitlesOff: "Off",
  subtitleLoadFailed: "Subtitles couldn't load",
  trackFallback: (position: number) => `Track ${position}`,
};

/** LOTR on the emulator: a PGS track with an OCR twin (pickable) and a CJK one without (greyed). */
const subtitleTracks: SubtitleTrack[] = [
  { id: "fre", language: "fr", label: "FRE", isDefault: false, format: "pgs", encrypted: false, url: "subs/fre.sup", ocrTwin: { id: "fre-ocr", url: "subs/fre.srt" } },
  { id: "chi", language: "zh", label: "CHI", isDefault: false, format: "pgs", encrypted: false, url: "subs/chi.sup", ocrTwin: null },
];

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
  vi.useRealTimers();
});

const mount = async (tv: boolean, handle: React.RefObject<PlayerControlsHandle | null>) => {
  await act(async () => {
    renderer = create(
      React.createElement(PlayerControls, {
        labels,
        hlsUrl: "http://127.0.0.1/playback/master.m3u8",
        fullDuration: 600,
        videos: [],
        audioTracks: [],
        subtitleTracks,
        chapters: [],
        snapshot: { position: 30, duration: 600, paused: false, cacheEnd: 60, currentVo: "mediacodec_embed" } as never,
        tv,
        handleRef: handle,
        onBackPress: () => undefined,
      }),
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  await act(async () => {
    handle.current!.openSheet("subtitles");
  });
};

const row = (testID: string): ReactTestInstance => {
  const found = renderer!.root.findAll((node) => String(node.type) === "Pressable" && node.props.testID === testID);
  expect(found, `${TAG} ${testID} on screen`).toHaveLength(1);
  return found[0]!;
};
const sheetOpen = (): boolean => renderer!.root.findAll((node) => node.props.testID === "player-sheet-tabs" && typeof node.type === "string").length > 0;
const rowState = (node: ReactTestInstance) => ({
  disabled: node.props.disabled === true,
  focusable: node.props.focusable !== false && node.props.disabled !== true,
  a11yDisabled: node.props.accessibilityState?.disabled === true,
  onPress: typeof node.props.onPress === "function",
});

it("@req PLAY-TRACK-05 TV: a greyed picture row takes the remote's focus, and OK on it picks nothing", async () => {
  const handle = React.createRef<PlayerControlsHandle>();
  await mount(true, handle);
  const greyed = row("player-subtitle-option-1");
  const twin = row("player-subtitle-option-0");
  console.info(TAG, "tv rows", JSON.stringify({ greyed: rowState(greyed), twin: rowState(twin) }));
  expect(rowState(twin)).toEqual({ disabled: false, focusable: true, a11yDisabled: false, onPress: true });
  // Reachable by DOWN like any row, still announced and drawn as unavailable.
  expect(rowState(greyed).focusable).toBe(true);
  expect(rowState(greyed).a11yDisabled).toBe(true);

  await act(async () => {
    greyed.props.onPress?.();
  });
  console.info(TAG, "after OK on greyed", JSON.stringify({ trackState: handle.current!.trackState(), sheetOpen: sheetOpen() }));
  expect(handle.current!.trackState().subtitleIdx).toBe(-1);
  expect(sheetOpen(), `${TAG} OK on a greyed row must leave the menu open`).toBe(true);
});

it("@req PLAY-TRACK-05 phone: a greyed picture row stays a disabled control", async () => {
  const handle = React.createRef<PlayerControlsHandle>();
  await mount(false, handle);
  const greyed = rowState(row("player-subtitle-option-1"));
  console.info(TAG, "phone greyed row", JSON.stringify(greyed));
  expect(greyed.disabled).toBe(true);
  expect(greyed.a11yDisabled).toBe(true);
});

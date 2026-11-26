// @bugfix @regression-proof
// @req PLAT-TV-07[badger-tv]
// On an Android TV box (Chris 2026-10-28) the Subtitles / Quality menus took up to a second to appear after the key.
// The press set the wanted menu, and only an effect after that render mounted it: a second full render of the
// overlay before anything moved on screen. The menu the remote asks for must be in the very first commit after the key.
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PlayerControls,
  type PlayerControlsHandle,
  type PlayerControlsLabels,
} from "@space/mobile-mpv-playback/PlayerControls";

const TAG = "[player-controls-sheet-open]";

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
vi.mock("@space/mobile-mpv-playback/MpvControl", () => ({
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

let renderer: ReactTestRenderer | null = null;
/** One entry per commit of the controls: which menu tabs row was on screen in that commit. */
const commits: { phase: string; sheetTabs: boolean; title: string | null }[] = [];

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  commits.length = 0;
});

afterEach(async () => {
  console.info(TAG, "commits", JSON.stringify(commits));
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
const sheetOnScreen = (): { sheetTabs: boolean; title: string | null } => {
  if (!renderer) return { sheetTabs: false, title: null };
  const tabs = root().findAll((node) => node.props.testID === "player-sheet-tabs" && typeof node.type === "string");
  const titles = root()
    .findAll((node) => String(node.type) === "Text" && typeof node.props.children === "string")
    .map((node) => node.props.children as string);
  // The open menu's name is on screen twice: its tab in the tabs row and the menu title under it.
  const title = ["Subtitles", "Audio", "Quality"].find((label) => titles.filter((text) => text === label).length >= 2) ?? null;
  return { sheetTabs: tabs.length > 0, title };
};

const mount = async (handle: React.RefObject<PlayerControlsHandle | null>) => {
  await act(async () => {
    renderer = create(
      React.createElement(
        React.Profiler,
        {
          id: "controls",
          onRender: (_id: string, phase: string) => {
            commits.push({ phase, ...sheetOnScreen() });
          },
        },
        React.createElement(PlayerControls, {
          labels,
          hlsUrl: "http://127.0.0.1/master.m3u8",
          fullDuration: 600,
          videos: [],
          audioTracks: [],
          subtitleTracks: [],
          chapters: [],
          snapshot: { position: 30, duration: 600, paused: false, cacheEnd: 60 } as never,
          tv: true,
          handleRef: handle,
          onBackPress: () => undefined,
        }),
      ),
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
};

// The remote opens one menu directly: its captions key opens Subtitles (`openSheet("subtitles")`, playerRemote.ts).
// Quality is reached from an open menu by a left/right key (`cycleSheet`: Subtitles -1 lands on Quality).
it.each([["subtitles"], ["video"]] as const)("the %s menu is drawn in the first commit after the remote asks for it", async (kind) => {
  const handle = React.createRef<PlayerControlsHandle>();
  await mount(handle);
  expect(handle.current, `${TAG} handle not wired`).not.toBeNull();
  expect(sheetOnScreen().sheetTabs).toBe(false);

  if (kind === "video") {
    await act(async () => {
      handle.current!.openSheet("subtitles");
    });
    expect(sheetOnScreen().title, `${TAG} subtitles menu not open before the cycle`).toBe("Subtitles");
  }
  const before = commits.length;
  console.info(TAG, "open", JSON.stringify({ kind, commitsBefore: before, onScreen: sheetOnScreen() }));

  await act(async () => {
    if (kind === "video") handle.current!.cycleSheet(-1);
    else handle.current!.openSheet("subtitles");
  });

  const afterPress = commits.slice(before);
  console.info(TAG, "after press", JSON.stringify({ kind, afterPress }));
  expect(afterPress.length).toBeGreaterThan(0);
  expect(afterPress[0]!.sheetTabs, `${TAG} first commit after the key had no menu: ${JSON.stringify(afterPress)}`).toBe(true);
  expect(afterPress[0]!.title).toBe(kind === "video" ? "Quality" : "Subtitles");
});

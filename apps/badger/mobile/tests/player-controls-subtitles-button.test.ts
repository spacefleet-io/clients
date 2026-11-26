/**
 * @test-id BADGER-MOBILE-SUBGET-002
 * @level component
 * @why Issue #2500 (Chris 2026-11-15): on a video without subtitles the subtitles button looked dead. Chris 2026-11-18
 *   (Black Hawk Down on phone): it then searched for subtitles online instead of showing the subtitles the film already had.
 *   The button (and the TV remote's subtitles key) now always opens the menu, with nothing searched: Off, every
 *   subtitle the title has, then "Get more subtitles…" (greyed offline with why) and, while a fetched subtitle is on,
 *   "Try another version" (#2502). Picking a stored subtitle downloads nothing (PLAY-SUBGET-24).
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlayerControls,
  type PlayerControlsHandle,
  type PlayerControlsLabels,
} from "../../../../packages/mobile-mpv-playback/src/components/PlayerControls";
import type { SubtitleTrack } from "../../../../packages/mobile-mpv-playback/src/types";

const TAG = "[player-controls-subtitles-button]";
const log = (label: string, value?: unknown) => console.info(`${TAG} ${label}${value === undefined ? "" : `: ${JSON.stringify(value)}`}`);

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

const spanish: SubtitleTrack = {
  id: "sub-es",
  language: "es",
  label: "Spanish",
  isDefault: false,
  format: "vtt",
  encrypted: false,
  url: "obj/es.srt",
  source: "fetched:11",
};

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

type Options = {
  tv: boolean;
  subtitleTracks: SubtitleTrack[];
  initialSubtitleIdx?: number;
  unavailableReason?: string | null;
  getMore?: () => void;
  tryAnother?: (track: SubtitleTrack) => void;
  addFile?: () => void;
};

const mount = async (options: Options) => {
  const handle = React.createRef<PlayerControlsHandle | null>();
  await act(async () => {
    renderer = create(
      React.createElement(PlayerControls, {
        labels,
        hlsUrl: "http://127.0.0.1/playback/master.m3u8",
        fullDuration: 600,
        videos: [],
        audioTracks: [],
        subtitleTracks: options.subtitleTracks,
        initialSubtitleIdx: options.initialSubtitleIdx ?? -1,
        chapters: [],
        snapshot: { position: 30, duration: 600, paused: false, cacheEnd: 60, currentVo: "mediacodec_embed" } as never,
        tv: options.tv,
        handleRef: handle,
        onBackPress: () => undefined,
        getMoreSubtitles: options.getMore
          ? { title: "Get more subtitles…", unavailableReason: options.unavailableReason ?? null, onPress: options.getMore }
          : null,
        tryAnotherSubtitle: options.tryAnother
          ? {
              title: "Try another version",
              isFetched: (track: SubtitleTrack) => (track.source ?? "").startsWith("fetched"),
              unavailableReason: options.unavailableReason ?? null,
              onPress: options.tryAnother,
            }
          : null,
        addSubtitleFile: options.addFile
          ? { title: "Add a subtitle file…", unavailableReason: options.unavailableReason ?? null, onPress: options.addFile }
          : null,
      }),
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  return handle;
};

const byTestId = (testID: string): ReactTestInstance[] =>
  renderer!.root.findAll((node) => typeof node.type === "string" && node.props.testID === testID);
// The subtitle menu is open when its "Off" row is on screen (the TV's tab strip is TV-only).
const sheetOpen = () => byTestId("player-subtitle-option-off").length > 0;
const texts = () =>
  renderer!.root
    .findAll((node) => (node.type as unknown) === "Text")
    .flatMap((node) => node.children)
    .filter((child): child is string => typeof child === "string");
const pressSubtitlesButton = async () => {
  const [button] = byTestId("player-subtitles-button");
  expect(button, `${TAG} subtitles button on screen`).toBeDefined();
  await act(async () => {
    button!.props.onPress();
  });
};

describe("the subtitles button with no subtitle (PLAY-SUBGET-24)", () => {
  /** @req PLAY-SUBGET-24[badger-mobile] */
  it("phone: opens the menu with Off and Get more subtitles, and searches nothing", async () => {
    const getMore = vi.fn();
    await mount({ tv: false, subtitleTracks: [], getMore });
    log("phone, no tracks: press the subtitles button");
    await pressSubtitlesButton();
    log("after press", { getMoreCalls: getMore.mock.calls.length, sheetOpen: sheetOpen() });
    expect(getMore).not.toHaveBeenCalled();
    expect(sheetOpen()).toBe(true);
    expect(byTestId("player-subtitle-option-get-more")).toHaveLength(1);
  });

  /** @req PLAY-SUBGET-24[badger-mobile] @req PLAY-SUBGET-23[badger-mobile] */
  it("phone: the menu lists Off, Get more subtitles…, Add a subtitle file…; the file row closes the menu and opens the picker", async () => {
    const getMore = vi.fn();
    const addFile = vi.fn();
    await mount({ tv: false, subtitleTracks: [], getMore, addFile });
    await pressSubtitlesButton();
    const known = ["player-subtitle-option-off", "player-subtitle-option-get-more", "player-subtitle-option-add-file"];
    const rowIds = renderer!.root
      .findAll((node) => typeof node.type === "string" && known.includes(String(node.props.testID)))
      .map((node) => node.props.testID as string)
      .filter((id, index, all) => all.indexOf(id) === index);
    log("phone, no tracks: rows", rowIds);
    expect(rowIds).toEqual(known);
    expect(texts()).toContain("Add a subtitle file…");
    const [row] = byTestId("player-subtitle-option-add-file");
    await act(async () => {
      row!.props.onPress();
    });
    log("after add-file press", { addFileCalls: addFile.mock.calls.length, getMoreCalls: getMore.mock.calls.length });
    expect(addFile).toHaveBeenCalledTimes(1);
    expect(getMore).not.toHaveBeenCalled();
  });

  /** @req PLAY-SUBGET-24[badger-mobile] @req PLAY-SUBGET-12[badger-mobile] */
  it("phone offline: the menu opens, Get more subtitles greyed with the reason", async () => {
    const getMore = vi.fn();
    await mount({ tv: false, subtitleTracks: [], getMore, unavailableReason: "Needs an internet connection" });
    await pressSubtitlesButton();
    log("offline texts", texts().filter((text) => text.includes("internet")));
    expect(getMore).not.toHaveBeenCalled();
    expect(sheetOpen()).toBe(true);
    const [row] = byTestId("player-subtitle-option-get-more");
    expect(row?.props.disabled).toBe(true);
    expect(texts()).toContain("Needs an internet connection");
  });

  /** @req PLAY-SUBGET-24[badger-tv] */
  it("TV: the remote's subtitles key opens the menu, and searches nothing", async () => {
    const getMore = vi.fn();
    const handle = await mount({ tv: true, subtitleTracks: [], getMore });
    log("tv, no tracks: subtitles key");
    await act(async () => {
      handle.current!.openSheet("subtitles");
    });
    expect(getMore).not.toHaveBeenCalled();
    expect(sheetOpen()).toBe(true);
    expect(byTestId("player-subtitle-option-get-more")).toHaveLength(1);
  });
});

describe("a subtitle the title already has (PLAY-SUBGET-24)", () => {
  const english: SubtitleTrack = {
    id: "sub-en",
    language: "en",
    label: "English",
    isDefault: false,
    format: "vtt",
    encrypted: true,
    url: "obj/en.vtt",
    source: "upload",
  };

  /** @req PLAY-SUBGET-24[badger-mobile] */
  it("phone: is listed in the menu and picking it switches it on, with no search or download", async () => {
    const getMore = vi.fn();
    const tryAnother = vi.fn();
    await mount({ tv: false, subtitleTracks: [english], getMore, tryAnother });
    await pressSubtitlesButton();
    expect(sheetOpen()).toBe(true);
    const [row] = byTestId("player-subtitle-option-0");
    log("stored row", { found: Boolean(row) });
    expect(row).toBeDefined();
    await act(async () => {
      row!.props.onPress();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(getMore).not.toHaveBeenCalled();
    expect(tryAnother).not.toHaveBeenCalled();
  });
});

describe("the subtitles button with subtitles", () => {
  /** @req PLAY-SUBGET-02[badger-mobile] @req PLAY-SUBGET-07[badger-mobile] */
  it("phone: opens the menu ending with Get more, then Try another version for the fetched subtitle on", async () => {
    const getMore = vi.fn();
    const tryAnother = vi.fn();
    await mount({ tv: false, subtitleTracks: [spanish], initialSubtitleIdx: 0, getMore, tryAnother });
    await pressSubtitlesButton();
    expect(sheetOpen()).toBe(true);
    expect(getMore).not.toHaveBeenCalled();
    const getMoreRow = byTestId("player-subtitle-option-get-more");
    const tryRow = byTestId("player-subtitle-option-try-another");
    log("menu rows", { getMore: getMoreRow.length, tryAnother: tryRow.length });
    expect(getMoreRow).toHaveLength(1);
    expect(tryRow).toHaveLength(1);
    await act(async () => {
      tryRow[0]!.props.onPress();
    });
    // The menu slides away (the mocked animation ends on the fake clock).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    log("after Try another", { calls: tryAnother.mock.calls.map(([track]) => (track as SubtitleTrack).id), sheetOpen: sheetOpen() });
    expect(tryAnother).toHaveBeenCalledWith(spanish);
    expect(sheetOpen()).toBe(false);
  });

  /** @req PLAY-SUBGET-07[badger-tv] */
  it("TV: the subtitles key opens the menu with Try another version", async () => {
    const tryAnother = vi.fn();
    const handle = await mount({ tv: true, subtitleTracks: [spanish], initialSubtitleIdx: 0, getMore: vi.fn(), tryAnother });
    await act(async () => {
      handle.current!.openSheet("subtitles");
    });
    expect(sheetOpen()).toBe(true);
    expect(byTestId("player-subtitle-option-try-another").length).toBeGreaterThan(0);
  });
});

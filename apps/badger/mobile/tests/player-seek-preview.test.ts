/**
 * @test-id MOBILE-PLAYER-SEEK-PREVIEW-001
 * @level unit
 *
 * MPV-PREV-01 in the phone / TV controls (`PlayerControls`): on the phone the picture of the moment shows above the
 * finger while it drags the seek bar; on the TV above the bar while the user steps left / right with the controls up,
 * and with the controls hidden a step brings up the progress bar alone with the aimed time and its picture (no bare
 * ±seconds toast), gone a few seconds after the last step. Without previews the phone bar is as before.
 * MPV-PREV-04: a source handed over mid-playback (previews recorded after the player opened) shows at once.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlayerControls,
  type PlayerControlsHandle,
  type PlayerControlsLabels,
} from "@space/mobile-mpv-playback/PlayerControls";
import type { SeekPreviewFrame, SeekPreviewSource } from "@space/mobile-mpv-playback/seekPreview";
import type { PlaybackSnapshot } from "@space/mobile-mpv-playback/types";

const TAG = "[player-seek-preview]";

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
  }
  const timing = (target: Value, config: { toValue: number; duration: number }) => ({
    start: (onEnd?: (result: { finished: boolean }) => void) => {
      setTimeout(() => {
        target.value = config.toValue;
        onEnd?.({ finished: true });
      }, config.duration);
    },
  });
  return {
    ...(await import("./setup/reactNativeMock")).reactNativeBase(),
    View: "View",
    Text: "Text",
    Image: "Image",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    TVFocusGuideView: "TVFocusGuideView",
    StyleSheet: { create: <T>(styles: T) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { View: "AnimatedView", Value, timing, spring: () => ({ start: () => undefined }) },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Dimensions: { get: () => ({ width: 1200, height: 600 }) },
    useWindowDimensions: () => ({ width: 1200, height: 600 }),
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  };
});
vi.mock("@space/mobile-mpv-playback/MpvControl", () => ({
  MpvControl: new Proxy({}, { get: () => () => Promise.resolve(0) }),
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

const BAR_WIDTH = 1000;
const DURATION = 600;

/** A loaded 10 x 10 sheet of 160 x 90 pictures, one every 5 s, as the app's source hands it out. */
const fakeSource = () => {
  const wanted: number[] = [];
  const frameAt = (seconds: number): SeekPreviewFrame => {
    const picture = Math.floor(seconds / 5) % 100;
    return { uri: "data:image/jpeg;base64,AAAA", sheetWidth: 1600, sheetHeight: 900, x: (picture % 10) * 160, y: Math.floor(picture / 10) * 90, width: 160, height: 90 };
  };
  const source: SeekPreviewSource = { frameAt, want: (seconds) => wanted.push(seconds), subscribe: () => () => undefined };
  return { source, wanted };
};

let renderer: ReactTestRenderer | null = null;
const handle = React.createRef<PlayerControlsHandle>();

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

const root = (): ReactTestInstance => {
  if (!renderer) throw new Error(`${TAG} nothing mounted`);
  return renderer.root;
};
const hostById = (id: string) => root().findAll((node) => node.props.testID === id && typeof node.type === "string");
const preview = () => hostById("player-seek-preview")[0] ?? null;
const previewState = () => {
  const wrap = preview();
  if (!wrap) return null;
  const box = hostById("player-seek-preview-picture")[0]!;
  const image = box.findAll((node) => String(node.type) === "Image")[0];
  const flat = (style: unknown) => Object.assign({}, ...[style].flat()) as Record<string, unknown>;
  const boxStyle = flat(box.props.style);
  return { left: flat(wrap.props.style).left, width: boxStyle.width, height: boxStyle.height, uri: image?.props.source?.uri, image: flat(image?.props.style) };
};
const texts = () => root().findAll((node) => String(node.type) === "Text").map((node) => [node.props.children].flat().join(""));

const mountProps = (props: { tv?: boolean; seekPreview?: SeekPreviewSource | null; fullDuration?: number; snapshot?: PlaybackSnapshot | null }) =>
  React.createElement(PlayerControls, {
    labels,
    hlsUrl: "http://127.0.0.1/master.m3u8",
    fullDuration: props.fullDuration ?? DURATION,
    videos: [],
    audioTracks: [],
    subtitleTracks: [],
    chapters: [],
    snapshot: props.snapshot ?? null,
    onBackPress: () => undefined,
    tv: props.tv,
    handleRef: props.tv ? handle : undefined,
    seekPreview: props.seekPreview,
  });

/** A host node's flattened style. */
const styleOf = (node: ReactTestInstance): Record<string, unknown> => Object.assign({}, ...[node.props.style].flat());

const mount = async (props: { tv?: boolean; seekPreview?: SeekPreviewSource | null; fullDuration?: number; snapshot?: PlaybackSnapshot | null }) => {
  await act(async () => {
    renderer = create(mountProps(props));
  });
  const timeline = hostById("player-timeline")[0]!;
  await act(async () => {
    timeline.props.onLayout({ nativeEvent: { layout: { width: BAR_WIDTH } }, target: {} });
  });
};

const touch = (x: number) => ({ nativeEvent: { locationX: x, pageX: x } });
const drag = async (phase: "onResponderGrant" | "onResponderMove" | "onResponderRelease", x: number) => {
  await act(async () => {
    await hostById("player-timeline")[0]!.props[phase](touch(x));
  });
};

describe("phone: the picture follows the finger on the seek bar (MPV-PREV-01)", () => {
  // @req MPV-PREV-01[badger-mobile]
  it("shows the cropped picture of the dragged-to moment above the thumb, and hides it on release", async () => {
    const { source, wanted } = fakeSource();
    await mount({ seekPreview: source });
    expect(preview(), "nothing before a drag").toBeNull();

    await drag("onResponderGrant", 500); // 300 s -> picture 60 -> column 0, row 6
    const atGrant = previewState();
    console.info(TAG, "grant", JSON.stringify({ wanted, atGrant }));
    expect(wanted).toContain(300);
    expect(atGrant).toMatchObject({ left: 420, width: 160, height: 90, uri: "data:image/jpeg;base64,AAAA" });
    expect(atGrant?.image).toMatchObject({ width: 1600, height: 900, left: -0, top: -540 });

    await drag("onResponderMove", 770); // 462 s -> picture 92 -> column 2, row 9
    const moved = previewState();
    console.info(TAG, "move", JSON.stringify(moved));
    expect(wanted).toContain(462);
    expect(moved).toMatchObject({ left: 690 });
    expect(moved?.image).toMatchObject({ left: -320, top: -810 });
    expect(texts(), "the picture carries the time it points at").toContain("7:42");

    await drag("onResponderRelease", 770);
    expect(preview()).toBeNull();
  });

  // @req MPV-PREV-01[badger-mobile]
  it("near the bar's ends the picture stays over the bar", async () => {
    const { source } = fakeSource();
    await mount({ seekPreview: source });
    await drag("onResponderGrant", 5);
    expect(previewState()?.left).toBe(0);
    await drag("onResponderMove", 999);
    expect(previewState()?.left).toBe(BAR_WIDTH - 160);
  });

  // @req MPV-PREV-01[badger-mobile]
  it("without previews the drag behaves as before: no picture, no placeholder", async () => {
    await mount({ seekPreview: null });
    await drag("onResponderGrant", 500);
    expect(preview()).toBeNull();
    expect(root().findAll((node) => String(node.type) === "Image")).toHaveLength(0);
  });

  // @req MPV-PREV-01[badger-mobile]
  it("a sheet not loaded yet draws nothing (no placeholder) until it arrives", async () => {
    let loaded = false;
    let notify: () => void = () => undefined;
    const { source: base, wanted } = fakeSource();
    const source: SeekPreviewSource = {
      frameAt: (seconds) => (loaded ? base.frameAt(seconds) : null),
      want: base.want,
      subscribe: (listener) => {
        notify = listener;
        return () => undefined;
      },
    };
    await mount({ seekPreview: source });
    await drag("onResponderGrant", 500);
    expect(wanted).toContain(300);
    expect(preview()).toBeNull();
    await act(async () => {
      loaded = true;
      notify();
    });
    expect(previewState()).toMatchObject({ left: 420 });
  });
});

describe("TV: the picture follows left / right while the seek bar is up (MPV-PREV-01)", () => {
  // @req MPV-PREV-01[badger-tv]
  it("steps with the controls up show the picture of the aimed moment above the bar, then it goes", async () => {
    const { source, wanted } = fakeSource();
    await mount({ tv: true, seekPreview: source });
    await act(async () => {
      handle.current!.stepSeek(1);
    });
    await act(async () => {
      handle.current!.stepSeek(1, 30);
    });
    const shown = previewState();
    console.info(TAG, "tv steps", JSON.stringify({ wanted, shown }));
    // From 0 s: +10 then +30 -> aiming at 40 s (picture 8), 40 / 600 of the bar.
    expect(wanted).toEqual([10, 40]);
    expect(shown).toMatchObject({ left: 0, width: 208, height: 117 });
    expect(shown?.image).toMatchObject({ left: -8 * 160 * 1.3, top: -0 });
    expect(texts(), "the remote's toast is still shown").toContain("+30 s");
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(preview(), "the picture leaves once the steps stop").toBeNull();
  });

  // @req MPV-PREV-01[badger-tv]
  it("without the library's duration the aim stops at mpv's duration, the end of the bar", async () => {
    const { source, wanted } = fakeSource();
    // Only the fields the controls read; the rest of the native snapshot does not matter here.
    const snapshot = { position: 590, duration: 600, paused: false, cacheEnd: 0 } as PlaybackSnapshot;
    await mount({ tv: true, seekPreview: source, fullDuration: 0, snapshot });
    await act(async () => {
      handle.current!.stepSeek(1, 30);
    });
    console.info(TAG, "tv clamp", JSON.stringify({ wanted }));
    expect(wanted).toEqual([600]);
  });

  // @req MPV-PREV-01[badger-tv]
  it("with the controls hidden a step brings up the bar alone with the aimed time and picture, then it goes", async () => {
    const { source, wanted } = fakeSource();
    const snapshot = { position: 300, duration: 600, paused: false, cacheEnd: 0 } as PlaybackSnapshot;
    await mount({ tv: true, seekPreview: source, snapshot });
    await act(async () => {
      handle.current!.hide();
      vi.advanceTimersByTime(250);
    });
    expect(hostById("player-scrub"), "nothing before a step").toHaveLength(0);
    console.info(TAG, "tv hidden: phase steps");
    await act(async () => {
      handle.current!.stepSeek(-1);
    });
    await act(async () => {
      handle.current!.stepSeek(-1, 30);
    });
    const scrub = hostById("player-scrub");
    const thumb = hostById("player-scrub-thumb")[0];
    const shown = previewState();
    const thumbLeft = thumb ? styleOf(thumb).left : null;
    console.info(TAG, "tv hidden", JSON.stringify({ wanted, shown, thumbLeft, scrub: scrub.length, texts: texts() }));
    // From 300 s: -10 then -30 -> aiming at 260 s (picture 52 -> column 2, row 5), 260 / 600 of the bar.
    expect(scrub).toHaveLength(1);
    expect(wanted).toEqual([290, 260]);
    expect(thumbLeft).toBeCloseTo((260 / 600) * BAR_WIDTH - 3);
    expect(shown).toMatchObject({ width: 208, height: 117 });
    expect(shown?.image).toMatchObject({ left: -2 * 160 * 1.3, top: -5 * 90 * 1.3 });
    expect(texts(), "the aimed time and the bar's length").toEqual(expect.arrayContaining(["4:20", "10:00"]));
    expect(texts(), "no bare toast").not.toContain("-30 s");
    expect(texts()).not.toContain("-10 s");

    console.info(TAG, "tv hidden: phase wait");
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(hostById("player-scrub"), "still up 2.5 s after the last step").toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    console.info(TAG, "tv hidden: after hold", JSON.stringify({ scrub: hostById("player-scrub").length, preview: !!preview() }));
    expect(hostById("player-scrub"), "gone a few seconds after the last step").toHaveLength(0);
    expect(preview()).toBeNull();
  });

  // @req MPV-PREV-01[badger-tv]
  it("with the controls hidden and no previews a step still brings up the bar, with no picture", async () => {
    const snapshot = { position: 120, duration: 600, paused: false, cacheEnd: 0 } as PlaybackSnapshot;
    await mount({ tv: true, seekPreview: null, snapshot });
    await act(async () => {
      handle.current!.hide();
      vi.advanceTimersByTime(250);
    });
    await act(async () => {
      handle.current!.stepSeek(1);
    });
    console.info(TAG, "tv hidden no previews", JSON.stringify({ scrub: hostById("player-scrub").length, texts: texts() }));
    expect(hostById("player-scrub")).toHaveLength(1);
    expect(preview()).toBeNull();
    expect(texts()).toContain("2:10");
  });
});

describe("previews recorded while the video plays show up in that playback (MPV-PREV-04)", () => {
  // @req MPV-PREV-04[badger-mobile]
  it("phone: a source handed over mid-drag shows the picture without a reopen", async () => {
    const { source, wanted } = fakeSource();
    await mount({ seekPreview: null });
    await drag("onResponderGrant", 500);
    expect(preview(), "no previews yet").toBeNull();
    console.info(TAG, "late phone: phase source arrives");
    await act(async () => {
      renderer!.update(mountProps({ seekPreview: source }));
    });
    const shown = previewState();
    console.info(TAG, "late phone", JSON.stringify({ wanted, shown }));
    expect(wanted).toContain(300);
    expect(shown).toMatchObject({ left: 420, width: 160 });
  });

  // @req MPV-PREV-04[badger-tv]
  it("TV: after the source arrives, a step with the controls hidden shows the picture", async () => {
    const { source, wanted } = fakeSource();
    const snapshot = { position: 300, duration: 600, paused: false, cacheEnd: 0 } as PlaybackSnapshot;
    await mount({ tv: true, seekPreview: null, snapshot });
    await act(async () => {
      handle.current!.hide();
      vi.advanceTimersByTime(250);
    });
    await act(async () => {
      handle.current!.stepSeek(1);
    });
    expect(preview(), "no previews yet: the bar only").toBeNull();
    console.info(TAG, "late tv: phase source arrives");
    await act(async () => {
      renderer!.update(mountProps({ tv: true, seekPreview: source, snapshot }));
    });
    await act(async () => {
      handle.current!.stepSeek(1);
    });
    const shown = previewState();
    console.info(TAG, "late tv", JSON.stringify({ wanted, shown }));
    expect(wanted).toContain(320);
    expect(shown).toMatchObject({ width: 208 });
  });
});

// @bugfix @regression-proof
// The player controls fade out after a few seconds; while hidden they ignore touches, so a tap only brings them back
// (that is by design and is what a tap on a hidden back arrow does). A fade cut short — `show()` sets the controls back to
// full opacity mid-fade, e.g. on a double-tap seek — must not finish as if it had completed: before the fix it hid the
// controls again, leaving the back arrow drawn at full opacity but untouchable, so the next tap was lost.
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlayerControls, type PlayerControlsLabels } from "../../../../packages/mobile-mpv-playback/src/components/PlayerControls";

const TAG = "[player-controls-fade]";

// Animated mirrors react-native-tvos 0.85.3-3: `setValue()`, or a new animation on the same value, stops the running
// animation, whose `start()` callback then fires with `{ finished: false }` (AnimatedValue.setValue -> TimingAnimation.stop).
// PlayerControls draws its chrome glyphs with react-native-svg (PLAY-OVL-04): host-element stand-ins.
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path", Rect: "Rect", Circle: "Circle", Line: "Line" }));
vi.mock("react-native", async () => {
  type End = (result: { finished: boolean }) => void;
  class Value {
    value: number;
    running: { stop: () => void } | null = null;
    constructor(value: number) {
      this.value = value;
    }
    setValue(value: number) {
      const running = this.running;
      this.running = null;
      running?.stop();
      this.value = value;
    }
  }
  const timing = (target: Value, config: { toValue: number; duration: number }) => ({
    start: (onEnd?: End) => {
      const previous = target.running;
      target.running = null;
      previous?.stop();
      const timer = setTimeout(() => {
        target.running = null;
        target.value = config.toValue;
        onEnd?.({ finished: true });
      }, config.duration);
      target.running = {
        stop: () => {
          clearTimeout(timer);
          onEnd?.({ finished: false });
        },
      };
    },
  });
  return {
    ...(await import("./setup/reactNativeMock")).reactNativeBase(),
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    StyleSheet: { create: <T>(styles: T) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { View: "AnimatedView", Value, timing },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Dimensions: { get: () => ({ width: 800, height: 400 }) },
    useWindowDimensions: () => ({ width: 800, height: 400 }),
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  };
});
vi.mock("../../../../packages/mobile-mpv-playback/src/MpvControl", () => ({
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

const root = (): ReactTestInstance => {
  if (!renderer) throw new Error(`${TAG} nothing mounted`);
  return renderer.root;
};
// The first Animated.View is the controls overlay (top bar with the back arrow, centre buttons, seek bar).
const overlayTouches = (): string => String(root().findAll((node) => String(node.type) === "AnimatedView")[0]?.props.pointerEvents);
const dump = (phase: string) => {
  const backArrow = root().find((node) => node.props.testID === "player-close" && typeof node.type === "string");
  console.info(TAG, phase, JSON.stringify({ overlayPointerEvents: overlayTouches(), backArrowLabel: backArrow.props.accessibilityLabel }));
};

const mount = async () => {
  await act(async () => {
    renderer = create(
      React.createElement(PlayerControls, {
        labels,
        hlsUrl: "http://127.0.0.1/master.m3u8",
        fullDuration: 600,
        videos: [],
        audioTracks: [],
        subtitleTracks: [],
        chapters: [],
        snapshot: null,
        onBackPress: () => undefined,
      }),
    );
  });
  dump("mounted");
};

/** One surface tap on the left half: press-in at `downAt`, release at `upAt` (ms). */
const tapSurface = async (downAt: number, upAt: number) => {
  await act(async () => {
    const surface = root().find((node) => node.props.testID === "player-surface");
    surface.props.onPressIn({ nativeEvent: { timestamp: downAt } });
    surface.props.onPress({ nativeEvent: { locationX: 100, timestamp: upAt } });
  });
};

it("hidden controls ignore touches until a tap brings them back", async () => {
  await mount();
  expect(overlayTouches()).toBe("box-none");

  await act(async () => {
    vi.advanceTimersByTime(4000 + 300);
  });
  dump("after auto-hide");
  expect(overlayTouches()).toBe("none");

  await tapSurface(10_000, 10_050);
  dump("after reveal tap");
  expect(overlayTouches()).toBe("box-none");
});

it("a double-tap seek during the fade-out leaves the back arrow pressable", async () => {
  await mount();
  expect(overlayTouches()).toBe("box-none");

  await tapSurface(1000, 1050); // single tap: starts the 200 ms fade-out
  dump("after first tap (fading out)");
  await tapSurface(1150, 1200); // same half 100 ms later: double tap -> seek -10 s and show the controls
  dump("after double tap");
  expect(overlayTouches()).toBe("box-none");

  // Nothing left over from the cut-short fade flips the controls back to untouchable.
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
  dump("250 ms later");
  expect(overlayTouches()).toBe("box-none");
});

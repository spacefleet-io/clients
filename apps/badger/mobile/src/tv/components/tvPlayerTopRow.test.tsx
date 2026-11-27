/**
 * @test-id TV-PLAYER-TOPROW-001
 * @level component
 *
 * The TV player's four round buttons at the top right (Badger TV redesign, Chris 2026-11-12 (chat): the TV player stays
 * as it is, only these icons are the redesign's), in their TV form (`tv`: D-pad focus), as the TV's `PlayerScreen`
 * mounts them:
 *  - PLAY-OVL-04 / PLAY-OVL-05: chapters, subtitles, audio and quality each draw the same glyph the phone player draws
 *    (three lines, captions box, sound wave, cog), in white;
 *  - PLAY-OVL-02 / UX-TV-01: the row is Chapters (file with chapters), subtitles, audio, quality, left to right; every
 *    button takes the D-pad focus while the controls are up, and the remote walks the row in that order (left of the
 *    first button is Close, right of quality stays on quality, down is play / pause).
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlayerControls,
  type PlayerControlsHandle,
  type PlayerControlsLabels,
  type PlayerControlsProps,
} from "../../../../../../packages/mobile-mpv-playback/src/components/PlayerControls";

const TAG = "[tv-player-top-row]";

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
vi.mock("../../../../../../packages/mobile-mpv-playback/src/MpvControl", () => ({
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

const CHAPTERS = [
  { title: "Opening", startSeconds: 0, endSeconds: 300 },
  { title: "The chase", startSeconds: 300, endSeconds: 600 },
];

/** The four round buttons, left to right, with the glyph each draws (the phone player's, `ChromeGlyphIcon`). */
const ROW = [
  { button: "player-chapters-button", icon: "chapters" },
  { button: "player-subtitles-button", icon: "subtitles" },
  { button: "player-audio-button", icon: "audio" },
  { button: "player-quality-button", icon: "quality" },
] as const;

let renderer: ReactTestRenderer | null = null;
const handle = React.createRef<PlayerControlsHandle>();
/** testIDs of the views `requestTVFocus` was called on, in order. */
let focusRequests: string[] = [];

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  focusRequests = [];
});

afterEach(async () => {
  console.info(TAG, "focus requests", JSON.stringify(focusRequests));
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
const hosts = (testID: string, under: ReactTestInstance = root()) =>
  under.findAll((node) => node.props.testID === testID && typeof node.type === "string");
const one = (testID: string) => {
  const found = hosts(testID);
  if (found.length !== 1) throw new Error(`${TAG} expected one ${testID}, found ${found.length}`);
  return found[0]!;
};
/** Every button of the top bar, left to right (accessibility role "button"). */
const topBarButtons = () =>
  one("player-top-bar")
    .findAll((n) => typeof n.type === "string" && n.props.accessibilityRole === "button")
    .map((n) => n.props.testID as string);
/** The glyph testIDs drawn inside a button. */
const glyphsIn = (button: string) =>
  one(button)
    .findAll((n) => typeof n.type === "string" && String(n.props.testID ?? "").startsWith("player-icon-"))
    .map((n) => n.props.testID as string);
/** The shapes of a glyph: element type plus the geometry that tells the icons apart, and the stroke colour. */
const shapes = (icon: string) =>
  one(`player-icon-${icon}`)
    .findAll((n) => ["Path", "Rect", "Circle", "Line"].includes(String(n.type)))
    .map((n) => ({ type: String(n.type), d: n.props.d, w: n.props.width, h: n.props.height, r: n.props.r, stroke: n.props.stroke, fill: n.props.fill }));
const dump = (why: string) =>
  console.info(
    TAG,
    why,
    JSON.stringify({ top: topBarButtons(), glyphs: Object.fromEntries(ROW.filter((r) => hosts(r.button).length).map((r) => [r.button, glyphsIn(r.button)])) }),
  );

const mount = async (props: Partial<PlayerControlsProps> = {}) => {
  await act(async () => {
    renderer = create(
      React.createElement(PlayerControls, {
        labels,
        tv: true,
        handleRef: handle,
        hlsUrl: "http://127.0.0.1/master.m3u8",
        fullDuration: 600,
        videos: [],
        audioTracks: [],
        subtitleTracks: [],
        chapters: CHAPTERS,
        snapshot: { position: 30, duration: 600, paused: false, cacheEnd: 60 } as never,
        onBackPress: () => undefined,
        title: "The General (1926)",
        ...props,
      }),
      {
        createNodeMock: (element) => {
          const p: unknown = element.props;
          const testID = p && typeof p === "object" && "testID" in p ? String(p.testID) : "?";
          return { requestTVFocus: () => focusRequests.push(testID), measure: () => undefined };
        },
      },
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
};

const settle = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/**
 * The remote on a top-row button: OK opens its menu, Back closes it, then an arrow. Returns where the focus went.
 * (Between menus the native focus engine moves the focus; right after Back the controls step it themselves, which is
 * the path this drives, `focusArrow`.)
 */
const okBackArrow = async (button: string, key: "left" | "right" | "down") => {
  await act(async () => {
    one(button).props.onPress();
  });
  await settle(400);
  focusRequests = [];
  await act(async () => {
    handle.current!.closeSheet();
    handle.current!.focusArrow(key);
  });
  await settle(400);
  console.info(TAG, `OK, Back, ${key} on ${button}`, JSON.stringify(focusRequests));
  return focusRequests.at(-1);
};

describe("TV player: the four top-right buttons draw the redesign icons (PLAY-OVL-04, PLAY-OVL-05)", () => {
  /** @req PLAY-OVL-04[badger-tv] */
  it("chapters, subtitles, audio and quality each hold exactly their own glyph", async () => {
    await mount();
    dump("mounted");
    for (const { button, icon } of ROW) expect(glyphsIn(button), button).toEqual([`player-icon-${icon}`]);
    // The TV has no Cast button (PLAY-OVL-04): the phone's first glyph never shows.
    expect(hosts("player-cast-button")).toEqual([]);
  });

  /** @req PLAY-OVL-04[badger-tv] @req PLAY-OVL-05[badger-tv] */
  it("the glyphs are the phone player's: three lines, captions box, sound wave, cog, in white", async () => {
    await mount();
    const drawn = Object.fromEntries(ROW.map(({ icon }) => [icon, shapes(icon)]));
    console.info(TAG, "glyph shapes", JSON.stringify(drawn));
    expect(drawn.chapters).toEqual([expect.objectContaining({ type: "Path", d: "M4 5h16M4 12h16M4 19h16" })]);
    expect(drawn.subtitles.map((s) => s.type)).toEqual(["Rect", "Path"]);
    expect(drawn.subtitles[0]).toMatchObject({ w: "18", h: "14" });
    expect(drawn.subtitles[1]!.d).toBe("M7 15h4M15 15h2M7 11h2M13 11h4");
    expect(drawn.audio).toEqual([expect.objectContaining({ type: "Path", d: "M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3" })]);
    expect(drawn.quality.map((s) => s.type)).toEqual(["Path", "Circle"]);
    expect(drawn.quality[1]).toMatchObject({ r: "3" });
    for (const [icon, list] of Object.entries(drawn)) {
      for (const s of list) {
        expect(s.stroke, `${icon} stroke`).toBe("#fff");
        expect(s.fill, `${icon} fill`).toBe("none");
      }
    }
  });
});

describe("TV player: the four buttons stay on the D-pad, in order (PLAY-OVL-02, UX-TV-01)", () => {
  /** @req PLAY-OVL-02[badger-tv] @req UX-TV-01[badger-tv] */
  it("the row is Chapters, subtitles, audio, quality after Close, each focusable while the controls are up", async () => {
    await mount();
    dump("controls up");
    expect(topBarButtons()).toEqual(["player-close", ...ROW.map((r) => r.button)]);
    const focusable = Object.fromEntries(ROW.map(({ button }) => [button, one(button).props.focusable === true]));
    console.info(TAG, "focusable", JSON.stringify(focusable));
    expect(Object.values(focusable)).toEqual([true, true, true, true]);
  });

  /** @req UX-TV-01[badger-tv] */
  it("up shows the controls on Chapters, and right walks Chapters, subtitles, audio, quality, then stays", async () => {
    await mount();
    await act(async () => {
      handle.current!.hide();
    });
    await settle(300);
    focusRequests = [];
    await act(async () => {
      handle.current!.show("top");
    });
    await settle(200);
    console.info(TAG, "show(top)", JSON.stringify(focusRequests));
    expect(focusRequests.at(-1)).toBe("player-chapters-button");

    const walked: (string | undefined)[] = [];
    for (const { button } of ROW) walked.push(await okBackArrow(button, "right"));
    expect(walked).toEqual(["player-subtitles-button", "player-audio-button", "player-quality-button", "player-quality-button"]);
  });

  /** @req UX-TV-01[badger-tv] */
  it("left walks back to Close, and down from any of the four goes to play / pause", async () => {
    await mount();
    const left: (string | undefined)[] = [];
    for (const { button } of [...ROW].reverse()) left.push(await okBackArrow(button, "left"));
    expect(left).toEqual(["player-audio-button", "player-subtitles-button", "player-chapters-button", "player-close"]);
    const down: (string | undefined)[] = [];
    for (const { button } of ROW) down.push(await okBackArrow(button, "down"));
    expect(down).toEqual(ROW.map(() => "player-play-pause"));
  });

  /** @req PLAY-OVL-02[badger-tv] @req UX-TV-01[badger-tv] */
  it("a file without chapters: subtitles, audio, quality, with the focus starting on subtitles and left reaching Close", async () => {
    await mount({ chapters: [] });
    dump("no chapters");
    expect(topBarButtons()).toEqual(["player-close", "player-subtitles-button", "player-audio-button", "player-quality-button"]);
    for (const { button, icon } of ROW.slice(1)) expect(glyphsIn(button), button).toEqual([`player-icon-${icon}`]);
    focusRequests = [];
    await act(async () => {
      handle.current!.show("top");
    });
    await settle(200);
    expect(focusRequests.at(-1)).toBe("player-subtitles-button");
    expect(await okBackArrow("player-subtitles-button", "left")).toBe("player-close");
  });
});

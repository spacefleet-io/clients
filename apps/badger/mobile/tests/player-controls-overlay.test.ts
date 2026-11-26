// The player overlay as Chris decided it on 2026-10-29 (chat, player overlay): a "what's playing" line top-left on every
// file instead of the chapter stamp, a Chapters button in the top-right row only when the file has chapters (no next
// episode button there any more), centre previous / next buttons that change EPISODE (never chapter) and only exist
// where there is such an episode, and on TV every one of those buttons reachable with the remote's D-pad.
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlayerControls,
  type PlayerControlsHandle,
  type PlayerControlsLabels,
  type PlayerControlsProps,
} from "@space/mobile-mpv-playback/PlayerControls";

const TAG = "[player-controls-overlay]";

// PlayerControls draws its chrome glyphs with react-native-svg (PLAY-OVL-04): host-element stand-ins.
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path", Rect: "Rect", Circle: "Circle", Line: "Line" }));
vi.mock("react-native", () => {
  class Value {
    value: number;
    /** The running animation: `setValue` stops it, like React Native's (its end callback gets finished: false). */
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
    // PlayerControls imports @space/mobile-media-volume, which reads NativeModules.MediaVolume at load; no module = no
    // native volume, like an un-autolinked build.
    NativeModules: {},
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

const CHAPTERS = [
  { title: "Opening", startSeconds: 0, endSeconds: 300 },
  { title: "The heist", startSeconds: 300, endSeconds: 600 },
];
const EPISODE_TITLE = "Lodgers · S1 E1 · The New Lodger";

let renderer: ReactTestRenderer | null = null;
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
/** Host nodes (the mocked primitives are strings) with this testID. */
const hosts = (testID: string) => root().findAll((node) => node.props.testID === testID && typeof node.type === "string");
const one = (testID: string) => {
  const found = hosts(testID);
  if (found.length !== 1) throw new Error(`${TAG} expected one ${testID}, found ${found.length}`);
  return found[0]!;
};
const textsUnder = (node: ReactTestInstance): string[] =>
  node.findAll((n) => String(n.type) === "Text").flatMap((n) => [n.props.children].flat().filter((c): c is string => typeof c === "string"));
/** Every button of the top bar, left to right (accessibility role "button"). */
const topBarButtons = () =>
  one("player-top-bar")
    .findAll((n) => typeof n.type === "string" && n.props.accessibilityRole === "button")
    .map((n) => n.props.testID as string);
const centreButtons = () =>
  one("player-centre-controls")
    .findAll((n) => typeof n.type === "string" && n.props.accessibilityRole === "button")
    .map((n) => n.props.testID as string);
const dump = (why: string) =>
  console.info(TAG, why, JSON.stringify({ top: topBarButtons(), centre: centreButtons(), title: hosts("player-now-playing").map(textsUnder) }));

const mount = async (props: Partial<PlayerControlsProps> = {}) => {
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
        snapshot: { position: 30, duration: 600, paused: false, cacheEnd: 60 } as never,
        onBackPress: () => undefined,
        title: EPISODE_TITLE,
        ...props,
      }),
      {
        createNodeMock: (element) => {
          const props: unknown = element.props;
          const testID = props && typeof props === "object" && "testID" in props ? String(props.testID) : "?";
          return { requestTVFocus: () => focusRequests.push(testID), measure: () => undefined };
        },
      },
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
};

describe("phone and TV layout", () => {
  // @req PLAY-OVL-01[badger-mobile,badger-tv]
  it.each([["with chapters", CHAPTERS], ["without chapters", []]] as const)(
    "[PLAY-OVL-01] the top-left line says what is playing %s, and no chapter stamp is drawn",
    async (_name, chapters) => {
      await mount({ chapters: [...chapters] });
      dump("mounted");
      expect(textsUnder(one("player-now-playing"))).toEqual([EPISODE_TITLE]);
      // The chapter stamp ("0:00 • Opening") is gone everywhere.
      const all = textsUnder(root());
      expect(all).not.toContain("•");
      expect(all).not.toContain("Opening");
    },
  );

  // @req PLAY-OVL-02[badger-mobile,badger-tv]
  it("[PLAY-OVL-02] top-right row: Chapters (file with chapters), then subtitles, audio, quality; never a next-episode button", async () => {
    await mount({ chapters: CHAPTERS, onNextEpisode: () => undefined, onPreviousEpisode: () => undefined });
    dump("with chapters");
    expect(topBarButtons()).toEqual([
      "player-close",
      "player-chapters-button",
      "player-subtitles-button",
      "player-audio-button",
      "player-quality-button",
    ]);
    await act(async () => {
      one("player-chapters-button").props.onPress();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    // The chapter list opens: its rows are the file's chapters ("#2: The heist", trackRows.chapterRowTitle).
    expect(textsUnder(root())).toContain("#2: The heist");
  });

  // @req PLAY-OVL-02[badger-mobile,badger-tv]
  it("[PLAY-OVL-02] no Chapters button on a file without chapters", async () => {
    await mount({ chapters: [] });
    dump("no chapters");
    expect(topBarButtons()).toEqual(["player-close", "player-subtitles-button", "player-audio-button", "player-quality-button"]);
  });

  // @req PLAY-OVL-03[badger-mobile,badger-tv]
  it("[PLAY-OVL-03] centre row: previous / next episode around play-pause, each only when that episode exists; no chapter skip", async () => {
    const onPreviousEpisode = vi.fn();
    const onNextEpisode = vi.fn();
    await mount({ chapters: CHAPTERS, onPreviousEpisode, onNextEpisode });
    dump("middle episode");
    expect(centreButtons()).toEqual(["player-previous-episode", "player-play-pause", "player-next-episode"]);
    expect(one("player-previous-episode").props.accessibilityLabel).toBe("Previous episode");
    expect(one("player-next-episode").props.accessibilityLabel).toBe("Next episode");
    await act(async () => {
      one("player-previous-episode").props.onPress();
      one("player-next-episode").props.onPress();
    });
    expect(onPreviousEpisode).toHaveBeenCalledTimes(1);
    expect(onNextEpisode).toHaveBeenCalledTimes(1);
  });

  // @req PLAY-OVL-03[badger-mobile,badger-tv]
  it.each([
    ["first episode (no previous)", { onNextEpisode: () => undefined }, ["player-play-pause", "player-next-episode"]],
    ["last uploaded episode (no next)", { onPreviousEpisode: () => undefined }, ["player-previous-episode", "player-play-pause"]],
    ["movie", {}, ["player-play-pause"]],
  ] as const)("[PLAY-OVL-03] %s", async (_name, props, expected) => {
    await mount({ chapters: CHAPTERS, ...props });
    dump(_name);
    expect(centreButtons()).toEqual([...expected]);
  });

  // @req PLAY-OVL-04[badger-mobile,badger-tv]
  it("[PLAY-OVL-04] the phone's Cast button opens the row when a cast handler is given; subtitles, audio and quality draw the Badger glyphs", async () => {
    const onCastPress = vi.fn();
    await mount({ chapters: [], onCastPress });
    dump("with cast");
    expect(topBarButtons()).toEqual(["player-close", "player-cast-button", "player-subtitles-button", "player-audio-button", "player-quality-button"]);
    for (const icon of ["cast", "subtitles", "audio", "quality"]) expect(hosts(`player-icon-${icon}`).length).toBeGreaterThan(0);
    await act(async () => {
      one("player-cast-button").props.onPress();
    });
    expect(onCastPress).toHaveBeenCalledTimes(1);
  });

  // @req PLAY-OVL-04[badger-mobile,badger-tv]
  it("[PLAY-OVL-04] no Cast button without a cast handler (TV)", async () => {
    await mount({ chapters: [] });
    expect(hosts("player-cast-button")).toEqual([]);
    expect(hosts("player-icon-subtitles").length).toBeGreaterThan(0);
  });

  // @req PLAY-OVL-04[badger-mobile,badger-tv]
  it("[PLAY-OVL-04] back, chapters, pause and the episode skips draw the mockup's lucide glyphs (arrow-left, menu, pause, skip-back, skip-forward)", async () => {
    await mount({ chapters: CHAPTERS, onPreviousEpisode: () => undefined, onNextEpisode: () => undefined });
    dump("all chrome icons");
    for (const icon of ["back", "chapters", "pause", "previous", "next", "subtitles", "audio", "quality"]) {
      console.log(`[PLAY-OVL-04] player-icon-${icon}: ${hosts(`player-icon-${icon}`).length} host(s)`);
      expect(hosts(`player-icon-${icon}`).length, `player-icon-${icon}`).toBeGreaterThan(0);
    }
    expect(hosts("player-icon-play")).toEqual([]);
  });

  // @req PLAY-OVL-05[badger-mobile,badger-tv]
  it("[PLAY-OVL-05] the subtitles button draws the captions icon (lucide captions: rounded box plus two rows of text lines)", async () => {
    await mount({ chapters: [] });
    const [icon] = hosts("player-icon-subtitles");
    const rects = icon.findAll((n) => String(n.type) === "Rect");
    const paths = icon.findAll((n) => String(n.type) === "Path").map((n) => String(n.props.d));
    console.log(`[PLAY-OVL-05] subtitles glyph: ${rects.length} rect(s), paths ${JSON.stringify(paths)}`);
    expect(rects.map((n) => [n.props.width, n.props.height, n.props.rx].map(String))).toEqual([["18", "14", "2"]]);
    expect(paths.join(" ")).toContain("M7 15h4M15 15h2M7 11h2M13 11h4");
  });
});

describe("TV: the controls are on the D-pad", () => {
  const handle = React.createRef<PlayerControlsHandle>();
  const chrome = ["player-close", "player-chapters-button", "player-subtitles-button", "player-audio-button", "player-quality-button", "player-previous-episode", "player-play-pause", "player-next-episode", "player-timeline"];
  const tvProps = (extra: Partial<PlayerControlsProps> = {}): Partial<PlayerControlsProps> => ({
    tv: true,
    handleRef: handle,
    chapters: CHAPTERS,
    onPreviousEpisode: () => undefined,
    onNextEpisode: () => undefined,
    ...extra,
  });
  const focusable = () => Object.fromEntries(chrome.map((id) => [id, one(id).props.focusable === true]));

  // @req UX-A11Y-04[badger-tv]
  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] every chrome button and the progress bar take the focus while the controls are up, none once hidden", async () => {
    await mount(tvProps());
    console.info(TAG, "focusable while up", JSON.stringify(focusable()));
    expect(Object.values(focusable()).every(Boolean)).toBe(true);
    await act(async () => {
      handle.current!.hide();
      await vi.advanceTimersByTimeAsync(300);
    });
    console.info(TAG, "focusable once hidden", JSON.stringify(focusable()));
    expect(Object.values(focusable()).some(Boolean)).toBe(false);
  });

  // @req UX-TV-01[badger-tv]
  it.each([
    ["top, file with chapters", "top", CHAPTERS, "player-chapters-button"],
    ["top, file without chapters", "top", [], "player-subtitles-button"],
    ["progress", "progress", CHAPTERS, "player-timeline"],
    ["play", "play", CHAPTERS, "player-play-pause"],
  ] as const)("[UX-TV-01] show(%s) puts the D-pad focus on the right control", async (_name, focus, chapters, expected) => {
    await mount(tvProps({ chapters: [...chapters] }));
    await act(async () => {
      handle.current!.hide();
      await vi.advanceTimersByTimeAsync(300);
    });
    focusRequests = [];
    await act(async () => {
      handle.current!.show(focus);
    });
    // React renders the shown controls when the act above ends; the focus request follows TV_FOCUS_DELAY_MS later.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    console.info(TAG, "show", focus, JSON.stringify(focusRequests));
    expect(focusRequests.at(-1)).toBe(expected);
  });

  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] the progress bar reports its focus so the remote's left / right jump there", async () => {
    const onProgressFocusChange = vi.fn();
    await mount(tvProps({ onProgressFocusChange }));
    await act(async () => {
      one("player-timeline").props.onFocus();
    });
    await act(async () => {
      one("player-timeline").props.onBlur();
    });
    console.info(TAG, "progress focus calls", JSON.stringify(onProgressFocusChange.mock.calls));
    expect(onProgressFocusChange.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] left / right stay on the focused progress bar: a focus guide traps them so they only jump 10 s", async () => {
    await mount(tvProps());
    const guide = one("player-timeline").parent;
    console.info(TAG, "timeline parent", String(guide?.type), JSON.stringify(guide?.props && { left: guide.props.trapFocusLeft, right: guide.props.trapFocusRight, up: guide.props.trapFocusUp, down: guide.props.trapFocusDown }));
    expect(String(guide?.type)).toBe("TVFocusGuideView");
    expect(guide?.props.trapFocusLeft).toBe(true);
    expect(guide?.props.trapFocusRight).toBe(true);
    // Up still leaves the bar for the centre row.
    expect(guide?.props.trapFocusUp).toBeFalsy();
  });

  it("[UX-TV-01] a phone keeps the plain progress bar (no focus guide)", async () => {
    await mount({ chapters: CHAPTERS });
    expect(String(one("player-timeline").parent?.type)).not.toBe("TVFocusGuideView");
  });

  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] closing the Chapters menu puts the D-pad focus back on the Chapters button", async () => {
    await mount(tvProps());
    await act(async () => {
      one("player-chapters-button").props.onPress();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(hosts("player-chapter-row-0").length + textsUnder(root()).filter((t) => t === "#2: The heist").length).toBeGreaterThan(0);
    focusRequests = [];
    await act(async () => {
      handle.current!.closeSheet();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    console.info(TAG, "after closing chapters", JSON.stringify(focusRequests));
    // Once: the ask that put the focus on Chapters before the menu opened is not replayed on close (issue 953).
    expect(focusRequests).toEqual(["player-chapters-button"]);
  });

  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] the subtitles key over hidden controls, then Back: the focus goes to the subtitles button once", async () => {
    await mount(tvProps({ subtitleTracks: [] }));
    await act(async () => {
      handle.current!.hide();
      await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => {
      handle.current!.openSheet("subtitles");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    focusRequests = [];
    await act(async () => {
      handle.current!.closeSheet();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    console.info(TAG, "after closing subtitles opened from hidden controls", JSON.stringify(focusRequests));
    expect(focusRequests).toEqual(["player-subtitles-button"]);
  });

  const openChaptersFromTop = async () => {
    await act(async () => {
      handle.current!.show("top");
      await vi.advanceTimersByTimeAsync(200);
    });
    await act(async () => {
      one("player-chapters-button").props.onPress();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    focusRequests = [];
  };

  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] an arrow pressed with Back, before the menu even re-rendered closed, moves the focus from its button (issue 1004)", async () => {
    await mount(tvProps());
    await openChaptersFromTop();
    // Back and right in one go: the arrow reaches the controls before the close is committed.
    await act(async () => {
      handle.current!.closeSheet();
      handle.current!.focusArrow("right");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    console.info(TAG, "back+right in one go", JSON.stringify(focusRequests));
    expect(focusRequests).toEqual(["player-subtitles-button"]);
  });

  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] an arrow right after a menu closes, before its button got the focus, steps from that button (issue 1004)", async () => {
    await mount(tvProps());
    await openChaptersFromTop();
    await act(async () => {
      handle.current!.closeSheet();
    });
    // The remote's left press arrives before the restore's TV_FOCUS_DELAY_MS ran out: Chapters is first, close is left of it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
      handle.current!.focusArrow("left");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    console.info(TAG, "close then left", JSON.stringify(focusRequests));
    expect(focusRequests).toEqual(["player-close"]);
  });

  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] at human speed the menu's button gets the focus once and later arrows are left to the native focus", async () => {
    await mount(tvProps());
    await openChaptersFromTop();
    await act(async () => {
      handle.current!.closeSheet();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      handle.current!.focusArrow("right");
      handle.current!.focusArrow("down");
      await vi.advanceTimersByTimeAsync(400);
    });
    console.info(TAG, "close, wait, then arrows", JSON.stringify(focusRequests));
    expect(focusRequests).toEqual(["player-chapters-button"]);
  });

  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] a D-pad press before any other focus placement lands wins: that placement is dropped", async () => {
    await mount(tvProps());
    await act(async () => {
      handle.current!.hide();
      await vi.advanceTimersByTimeAsync(300);
    });
    focusRequests = [];
    await act(async () => {
      handle.current!.show("play");
      handle.current!.focusArrow("up");
      await vi.advanceTimersByTimeAsync(400);
    });
    console.info(TAG, "show then up", JSON.stringify(focusRequests));
    expect(focusRequests).toEqual([]);
    // A later showing of the controls places the focus again.
    await act(async () => {
      handle.current!.hide();
      await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => {
      handle.current!.show();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    console.info(TAG, "shown again", JSON.stringify(focusRequests));
    expect(focusRequests).toEqual(["player-play-pause"]);
  });

  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] moving the focus restarts the auto-hide: the controls never hide while the user is navigating", async () => {
    const onVisibilityChange = vi.fn();
    await mount(tvProps({ onVisibilityChange }));
    const visibleNow = () => onVisibilityChange.mock.calls.at(-1)?.[0];
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
        one(i % 2 ? "player-audio-button" : "player-subtitles-button").props.onFocus?.();
      });
      console.info(TAG, "after focus move", i, "visible", visibleNow());
      expect(visibleNow()).toBe(true);
    }
    await act(async () => {
      handle.current!.keepVisible();
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(visibleNow()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    console.info(TAG, "after idle", visibleNow());
    expect(visibleNow()).toBe(false);
  });

  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] a remote key during the fade-out keeps the controls up", async () => {
    const onVisibilityChange = vi.fn();
    await mount(tvProps({ onVisibilityChange }));
    const visibleNow = () => onVisibilityChange.mock.calls.at(-1)?.[0];
    await act(async () => {
      handle.current!.keepVisible();
      // AUTO_HIDE_MS (4 s) then 100 ms into the 300 ms fade.
      await vi.advanceTimersByTimeAsync(4100);
    });
    await act(async () => {
      handle.current!.keepVisible();
      await vi.advanceTimersByTimeAsync(1000);
    });
    console.info(TAG, "key during fade", visibleNow());
    expect(visibleNow()).toBe(true);
  });

  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] the controls read as hidden the moment the fade-out ends, before the owner re-renders", async () => {
    // The remote decides a key from what the controls say now (isVisible), not from the screen's next render: a key
    // ~20 ms after the fade-out ended was lost (run 20261116-113824).
    const onVisibilityChange = vi.fn();
    await mount(tvProps({ onVisibilityChange }));
    let inFade: boolean | undefined;
    let afterFade: boolean | undefined;
    await act(async () => {
      handle.current!.keepVisible();
      // AUTO_HIDE_MS (4 s) then 100 ms into the 300 ms fade: still up.
      await vi.advanceTimersByTimeAsync(4100);
      inFade = handle.current!.isVisible();
      await vi.advanceTimersByTimeAsync(400);
      afterFade = handle.current!.isVisible();
    });
    console.info(TAG, "isVisible in fade", inFade, "after fade", afterFade, "owner", onVisibilityChange.mock.calls.at(-1)?.[0]);
    expect(inFade).toBe(true);
    expect(afterFade).toBe(false);
    expect(onVisibilityChange.mock.calls.at(-1)?.[0]).toBe(false);
    expect(handle.current!.isVisible()).toBe(false);
  });

  // @req UX-TV-01[badger-tv]
  it("[UX-TV-01] the controls read as up the moment show() runs, before the owner re-renders", async () => {
    // A Back during a JS stall right after OK paused and showed the controls was decided on the bare video and left
    // the player (tv-player run on PR #2806): the reading must turn true with show(), not with the next render.
    const onVisibilityChange = vi.fn();
    await mount(tvProps({ onVisibilityChange }));
    await act(async () => {
      handle.current!.keepVisible();
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(handle.current!.isVisible()).toBe(false);
    let beforeRender: boolean | undefined;
    await act(async () => {
      handle.current!.show("play");
      beforeRender = handle.current!.isVisible();
    });
    console.info(TAG, "isVisible right after show", beforeRender, "owner", onVisibilityChange.mock.calls.at(-1)?.[0]);
    expect(beforeRender).toBe(true);
    expect(onVisibilityChange.mock.calls.at(-1)?.[0]).toBe(true);
    expect(handle.current!.isVisible()).toBe(true);
  });

  it("[UX-TV-01] a phone never makes the chrome focusable and never moves the focus", async () => {
    await mount({ chapters: CHAPTERS, onPreviousEpisode: () => undefined, onNextEpisode: () => undefined });
    expect(Object.values(focusable()).some(Boolean)).toBe(false);
    expect(focusRequests).toEqual([]);
  });
});

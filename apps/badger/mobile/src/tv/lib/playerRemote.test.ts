import { describe, expect, it } from "vitest";
import {
  HOLD_TICK_MS,
  holdStepSeconds,
  liveRemoteContext,
  remoteAction,
  remoteHoldFromEvent,
  remoteKeyFromEvent,
  remoteScrubContext,
  swipeHandledByPan,
  type RemoteAction,
  type RemoteContext,
  type RemoteKey,
} from "./playerRemote";

const VIDEO_ONLY: RemoteContext = {
  overlayVisible: false,
  sheetOpen: false,
  promptOpen: false,
  nextCardOpen: false,
  noticeOpen: false,
  pillVisible: false,
  progressFocused: false,
};
const OVERLAY: RemoteContext = { ...VIDEO_ONLY, overlayVisible: true };
const SHEET: RemoteContext = { ...OVERLAY, sheetOpen: true };
const PROMPT: RemoteContext = { ...VIDEO_ONLY, promptOpen: true };
const NEXT_CARD: RemoteContext = { ...PROMPT, nextCardOpen: true };
const PILL: RemoteContext = { ...VIDEO_ONLY, pillVisible: true };
/** The controls up with the D-pad focus on the progress bar. */
const PROGRESS: RemoteContext = { ...OVERLAY, progressFocused: true };
/** The device-too-weak / traffic-cap notice: a prompt with a "Keep watching" button. */
const NOTICE: RemoteContext = { ...PROMPT, noticeOpen: true };

const NATIVE_FOCUS: RemoteAction = { type: "native-focus" };
const IGNORE: RemoteAction = { type: "ignore" };

describe("TV player remote: events to keys", () => {
  it("[TV-PLAYER-KEY-001] every key the player uses maps from its event type, a press acts on release", () => {
    console.info("[TV-PLAYER-KEY-001] phase=start");
    const types = ["left", "right", "up", "down", "select", "playPause", "play", "pause", "stop", "rewind", "fastForward", "captions"] as const;
    const keys = types.map((eventType) => remoteKeyFromEvent({ eventType, eventKeyAction: 1 }));
    console.info("[TV-PLAYER-KEY-001] phase=keys", keys);
    expect(keys).toEqual([...types]);
    // tvOS recognisers report -1 (unknown) or nothing: still a press.
    expect(remoteKeyFromEvent({ eventType: "left", eventKeyAction: -1 })).toBe("left");
    expect(remoteKeyFromEvent({ eventType: "left" })).toBe("left");
    expect(remoteKeyFromEvent({ eventType: "left", eventKeyAction: "1" })).toBe("left");
  });

  it("[TV-PLAYER-KEY-003] a finished Siri Remote swipe is its arrow, so the touch surface works like the ring", () => {
    console.info("[TV-PLAYER-KEY-003] phase=start");
    const ended = { state: "Ended" };
    expect(remoteKeyFromEvent({ eventType: "swipeUp", body: ended })).toBe("up");
    expect(remoteKeyFromEvent({ eventType: "swipeDown", body: ended })).toBe("down");
    expect(remoteKeyFromEvent({ eventType: "swipeLeft", body: ended })).toBe("left");
    expect(remoteKeyFromEvent({ eventType: "swipeRight", body: ended })).toBe("right");
    expect(remoteKeyFromEvent({ eventType: "swipeLeft" })).toBe("left");
    // A swipe still in progress (or cancelled) is not a key yet: one swipe acts once.
    expect(remoteKeyFromEvent({ eventType: "swipeLeft", body: { state: "Began" } })).toBeNull();
    expect(remoteKeyFromEvent({ eventType: "swipeUp", body: { state: "Cancelled" } })).toBeNull();
  });

  it("[TV-PLAYER-KEY-002] key-down, long presses, pans, other keys and malformed events are not keys", () => {
    console.info("[TV-PLAYER-KEY-002] phase=start");
    const noise = [
      { eventType: "left", eventKeyAction: 0 },
      { eventType: "left", eventKeyAction: "0" },
      { eventType: "longLeft", eventKeyAction: 1 },
      { eventType: "longRight", eventKeyAction: 0 },
      { eventType: "longSelect", eventKeyAction: 1 },
      { eventType: "pan", body: { x: 1 } },
      { eventType: "menu", eventKeyAction: 1 },
      { eventType: "info", eventKeyAction: 1 },
      { eventType: 3 },
      {},
      null,
      undefined,
    ];
    const keys = noise.map((event) => remoteKeyFromEvent(event as never));
    console.info("[TV-PLAYER-KEY-002] phase=keys", keys);
    expect(keys.every((key) => key === null)).toBe(true);
  });
});

describe("TV player remote: a held left / right", () => {
  it("[TV-PLAYER-HOLD-001] longLeft / longRight down starts a hold and up ends it; nothing else is a hold", () => {
    console.info("[TV-PLAYER-HOLD-001] phase=start");
    const edges = [
      remoteHoldFromEvent({ eventType: "longLeft", eventKeyAction: 0 }),
      remoteHoldFromEvent({ eventType: "longLeft", eventKeyAction: 1 }),
      remoteHoldFromEvent({ eventType: "longRight", eventKeyAction: 0 }),
      remoteHoldFromEvent({ eventType: "longRight", eventKeyAction: 1 }),
      // tvOS long-press Changed / Cancelled carry no (or another) key action: not an edge, so a cancelled hold cannot restart.
      remoteHoldFromEvent({ eventType: "longRight", eventKeyAction: -1 }),
      remoteHoldFromEvent({ eventType: "longRight" }),
    ];
    console.info("[TV-PLAYER-HOLD-001] phase=edges", edges);
    expect(edges).toEqual([
      { direction: -1, phase: "start" },
      { direction: -1, phase: "end" },
      { direction: 1, phase: "start" },
      { direction: 1, phase: "end" },
      null,
      null,
    ]);
    const notHolds = [{ eventType: "left", eventKeyAction: 1 }, { eventType: "longUp", eventKeyAction: 0 }, { eventType: "longSelect" }, { eventType: 4 }, {}, null, undefined];
    expect(notHolds.map((event) => remoteHoldFromEvent(event as never))).toEqual(notHolds.map(() => null));
  });

  it("[TV-PLAYER-HOLD-002] the jump grows with the hold: 10 s, then 30 s, then 60 s", () => {
    console.info("[TV-PLAYER-HOLD-002] phase=start");
    const ticks = Array.from({ length: 12 }, (_, i) => ({ heldMs: i * HOLD_TICK_MS, seconds: holdStepSeconds(i * HOLD_TICK_MS) }));
    console.info("[TV-PLAYER-HOLD-002] phase=ticks", JSON.stringify(ticks));
    expect(holdStepSeconds(0)).toBe(10);
    expect(holdStepSeconds(HOLD_TICK_MS * 2)).toBe(10);
    expect(holdStepSeconds(1200)).toBe(30);
    expect(holdStepSeconds(3199)).toBe(30);
    expect(holdStepSeconds(3200)).toBe(60);
    expect(holdStepSeconds(60_000)).toBe(60);
    // Never slower as the hold goes on.
    const seconds = ticks.map((tick) => tick.seconds);
    expect([...seconds].sort((a, b) => a - b)).toEqual(seconds);
  });

  it("[TV-PLAYER-HOLD-003] a hold only scrubs where a plain left / right seeks", () => {
    console.info("[TV-PLAYER-HOLD-003] phase=start");
    const contexts: [string, RemoteContext, "seek" | "other"][] = [
      ["video alone", VIDEO_ONLY, "seek"],
      ["overlay, focus on a button", OVERLAY, "other"],
      ["overlay, focus on the progress bar", PROGRESS, "seek"],
      ["pill", PILL, "seek"],
      ["menu", SHEET, "other"],
      ["prompt", PROMPT, "other"],
    ];
    for (const [name, context, expected] of contexts) {
      const left = remoteAction("left", context);
      const right = remoteAction("right", context);
      console.info("[TV-PLAYER-HOLD-003] phase=context", name, JSON.stringify({ left, right }));
      expect(left.type === "seek").toBe(expected === "seek");
      expect(right.type === "seek").toBe(expected === "seek");
    }
  });
});

describe("TV player remote: video alone on screen", () => {
  // @req UX-TV-01[badger-tv]
  const cases: [RemoteKey, RemoteAction][] = [
    ["left", { type: "seek", direction: -1 }],
    ["right", { type: "seek", direction: 1 }],
    ["up", { type: "show-overlay", focus: "top" }],
    ["down", { type: "show-overlay", focus: "progress" }],
    ["select", { type: "toggle-pause-and-show" }],
    ["playPause", { type: "toggle-pause" }],
    ["play", { type: "set-paused", paused: false }],
    ["pause", { type: "set-paused", paused: true }],
    ["stop", { type: "leave-player" }],
    ["rewind", { type: "seek", direction: -1 }],
    ["fastForward", { type: "seek", direction: 1 }],
    ["captions", { type: "open-sheet", sheet: "subtitles" }],
    ["back", { type: "leave-player" }],
  ];
  it.each(cases)("[TV-PLAYER-HIDDEN-001] %s", (key, expected) => {
    const action = remoteAction(key, VIDEO_ONLY);
    console.info("[TV-PLAYER-HIDDEN-001] key=%s action=%s", key, JSON.stringify(action));
    expect(action).toEqual(expected);
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-PLAYER-HIDDEN-002] up / down only bring the controls up, with the focus on the top-right row / the progress bar: no menu opens", () => {
    const up = remoteAction("up", VIDEO_ONLY);
    const down = remoteAction("down", VIDEO_ONLY);
    console.info("[TV-PLAYER-HIDDEN-002] up=%s down=%s", JSON.stringify(up), JSON.stringify(down));
    expect(up.type).toBe("show-overlay");
    expect(down.type).toBe("show-overlay");
    expect(up).not.toEqual(down);
  });

  it("[TV-PLAYER-HIDDEN-003] a skip pill holds the focus: select is its native press, the other keys are unchanged", () => {
    console.info("[TV-PLAYER-HIDDEN-003] phase=start");
    expect(remoteAction("select", PILL)).toEqual(NATIVE_FOCUS);
    for (const [key, expected] of cases) {
      if (key === "select" || key === "back") continue;
      expect(remoteAction(key, PILL)).toEqual(expected);
    }
  });
});

describe("TV player remote: controls overlay visible", () => {
  // @req UX-TV-01[badger-tv]
  // @req UX-A11Y-04[badger-tv]
  it("[TV-PLAYER-OVERLAY-001] the controls are on the D-pad: the arrows move the focus and OK presses the focused button", () => {
    console.info("[TV-PLAYER-OVERLAY-001] phase=start");
    for (const key of ["left", "right", "up", "down", "select"] as const) {
      const action = remoteAction(key, OVERLAY);
      console.info("[TV-PLAYER-OVERLAY-001] key=%s action=%s", key, JSON.stringify(action));
      expect(action).toEqual(NATIVE_FOCUS);
    }
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-PLAYER-OVERLAY-002] on the progress bar left / right jump 10 s; up, down and OK stay the focus engine's", () => {
    console.info("[TV-PLAYER-OVERLAY-002] phase=start");
    expect(remoteAction("left", PROGRESS)).toEqual({ type: "seek", direction: -1 });
    expect(remoteAction("right", PROGRESS)).toEqual({ type: "seek", direction: 1 });
    for (const key of ["up", "down", "select"] as const) expect(remoteAction(key, PROGRESS)).toEqual(NATIVE_FOCUS);
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-PLAYER-OVERLAY-003] the transport keys and the subtitles key work the same with the controls up", () => {
    console.info("[TV-PLAYER-OVERLAY-003] phase=start");
    for (const key of ["playPause", "play", "pause", "rewind", "fastForward", "stop", "captions"] as const) {
      const action = remoteAction(key, OVERLAY);
      console.info("[TV-PLAYER-OVERLAY-003] key=%s action=%s", key, JSON.stringify(action));
      expect(action).toEqual(remoteAction(key, VIDEO_ONLY));
    }
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-PLAYER-OVERLAY-004] a key right after the controls hid, before the screen re-rendered, acts on the bare video", () => {
    console.info("[TV-PLAYER-OVERLAY-004] phase=start");
    // The screen still says the controls are up (its re-render comes later); the controls say they are gone. Run
    // 20261116-113824: a left ~20 ms after the fade-out ended was decided as a focus move on hidden buttons and lost.
    for (const stale of [OVERLAY, PROGRESS]) {
      const live = liveRemoteContext(stale, false);
      console.info("[TV-PLAYER-OVERLAY-004] stale=%s live=%s", JSON.stringify(stale), JSON.stringify(live));
      for (const key of ["left", "right", "up", "down", "select", "back"] as const) {
        expect(remoteAction(key, live)).toEqual(remoteAction(key, VIDEO_ONLY));
      }
    }
    // Controls still up (or no reading yet): nothing changes. A menu keeps the controls up whatever they say.
    expect(liveRemoteContext(OVERLAY, true)).toBe(OVERLAY);
    expect(liveRemoteContext(OVERLAY, undefined)).toBe(OVERLAY);
    expect(liveRemoteContext(SHEET, false)).toBe(SHEET);
    expect(liveRemoteContext(VIDEO_ONLY, false)).toBe(VIDEO_ONLY);
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-PLAYER-OVERLAY-005] a key right after the controls came up, before the screen re-rendered, acts on the controls", () => {
    console.info("[TV-PLAYER-OVERLAY-005] phase=start");
    // OK on the bare video paused and showed the controls; a 1.5 s JS stall delayed the screen's re-render, and the Back
    // pressed in between was decided on the bare video: it left the player instead of hiding the controls.
    const live = liveRemoteContext(VIDEO_ONLY, true);
    console.info("[TV-PLAYER-OVERLAY-005] stale=%s live=%s", JSON.stringify(VIDEO_ONLY), JSON.stringify(live));
    expect(remoteAction("back", live)).toEqual({ type: "hide-overlay" });
    for (const key of ["left", "right", "up", "down", "select", "back"] as const) {
      expect(remoteAction(key, live)).toEqual(remoteAction(key, OVERLAY));
    }
    // Controls hidden (or no reading yet): nothing changes. The prompts above the video keep their own keys.
    expect(liveRemoteContext(VIDEO_ONLY, undefined)).toBe(VIDEO_ONLY);
    expect(remoteAction("back", liveRemoteContext(PROMPT, true))).toEqual(remoteAction("back", PROMPT));
    expect(remoteAction("back", liveRemoteContext(NEXT_CARD, true))).toEqual(remoteAction("back", NEXT_CARD));
  });
});

describe("TV player remote: the subtitles key (KEYCODE_CAPTIONS)", () => {
  // @req UX-TV-01[badger-tv]
  it("[TV-PLAYER-CAPTIONS-001] opens the subtitles menu, also from another menu; not under a resume or error prompt", () => {
    console.info("[TV-PLAYER-CAPTIONS-001] phase=start");
    const opens = { type: "open-sheet", sheet: "subtitles" };
    expect(remoteKeyFromEvent({ eventType: "captions", eventKeyAction: 1 })).toBe("captions");
    expect(remoteKeyFromEvent({ eventType: "captions", eventKeyAction: 0 })).toBeNull();
    expect(remoteAction("captions", VIDEO_ONLY)).toEqual(opens);
    expect(remoteAction("captions", SHEET)).toEqual(opens);
    expect(remoteAction("captions", PILL)).toEqual(opens);
    expect(remoteAction("captions", NEXT_CARD)).toEqual(IGNORE);
    expect(remoteAction("captions", PROMPT)).toEqual(IGNORE);
  });
});

describe("TV player remote: menus and prompts own the focus", () => {
  it("[TV-PLAYER-SHEET-001] in a track menu up / down / select are the focus engine's, left / right switch menu", () => {
    console.info("[TV-PLAYER-SHEET-001] phase=start");
    expect(remoteAction("up", SHEET)).toEqual(NATIVE_FOCUS);
    expect(remoteAction("down", SHEET)).toEqual(NATIVE_FOCUS);
    expect(remoteAction("select", SHEET)).toEqual(NATIVE_FOCUS);
    expect(remoteAction("left", SHEET)).toEqual({ type: "cycle-sheet", direction: -1 });
    expect(remoteAction("right", SHEET)).toEqual({ type: "cycle-sheet", direction: 1 });
  });

  it("[TV-PLAYER-SHEET-002] the transport keys still work behind a menu", () => {
    console.info("[TV-PLAYER-SHEET-002] phase=start");
    expect(remoteAction("playPause", SHEET)).toEqual({ type: "toggle-pause" });
    expect(remoteAction("rewind", SHEET)).toEqual({ type: "seek", direction: -1 });
    expect(remoteAction("fastForward", SHEET)).toEqual({ type: "seek", direction: 1 });
    expect(remoteAction("play", SHEET)).toEqual({ type: "set-paused", paused: false });
    expect(remoteAction("pause", SHEET)).toEqual({ type: "set-paused", paused: true });
  });

  it("[TV-PLAYER-PROMPT-001] under a prompt every key but Back is the focus engine's or ignored", () => {
    console.info("[TV-PLAYER-PROMPT-001] phase=start");
    for (const key of ["left", "right", "up", "down", "select"] as const) {
      expect(remoteAction(key, PROMPT)).toEqual(NATIVE_FOCUS);
    }
    for (const key of ["playPause", "play", "pause", "rewind", "fastForward"] as const) {
      expect(remoteAction(key, PROMPT)).toEqual(IGNORE);
    }
    expect(remoteAction("select", NEXT_CARD)).toEqual(NATIVE_FOCUS);
  });
});

describe("TV player remote: Back precedence", () => {
  const cases: [string, RemoteContext, RemoteAction][] = [
    ["video alone leaves the player", VIDEO_ONLY, { type: "leave-player" }],
    ["controls up hide the controls", OVERLAY, { type: "hide-overlay" }],
    ["a menu closes first", SHEET, { type: "close-sheet" }],
    ["a skip pill is dismissed before the controls hide", { ...OVERLAY, pillVisible: true }, { type: "dismiss-prompt", prompt: "pill" }],
    ["the next-episode card is dismissed, not left", NEXT_CARD, { type: "dismiss-prompt", prompt: "next-card" }],
    ["another prompt leaves the player (existing behaviour)", PROMPT, { type: "leave-player" }],
    ["a menu beats a prompt", { ...PROMPT, sheetOpen: true }, { type: "close-sheet" }],
  ];
  it.each(cases)("[TV-PLAYER-BACK-001] %s", (name, context, expected) => {
    const action = remoteAction("back", context);
    console.info("[TV-PLAYER-BACK-001] case=%s action=%s", name, JSON.stringify(action));
    expect(action).toEqual(expected);
  });

  it("[TV-PLAYER-BACK-002] Back then Back: the controls hide, then the player is left", () => {
    console.info("[TV-PLAYER-BACK-002] phase=start");
    expect(remoteAction("back", OVERLAY)).toEqual({ type: "hide-overlay" });
    expect(remoteAction("back", VIDEO_ONLY)).toEqual({ type: "leave-player" });
  });

  // @bugfix: the too-weak notice appeared over the open chapter list; Back closed the list underneath and the next Back
  // left the player with the notice still up (Android e2e tv-prompts, 2026-10-23).
  // @req UX-TV-01[badger-tv]
  it("[TV-PLAYER-BACK-003] Back closes the topmost thing first: notice over a menu, then the menu, the controls, the player", () => {
    const steps: [string, RemoteContext, RemoteAction][] = [
      ["notice over the chapter list", { ...NOTICE, overlayVisible: true, sheetOpen: true }, { type: "dismiss-prompt", prompt: "notice" }],
      ["chapter list", SHEET, { type: "close-sheet" }],
      ["controls", OVERLAY, { type: "hide-overlay" }],
      ["video alone", VIDEO_ONLY, { type: "leave-player" }],
    ];
    for (const [name, context, expected] of steps) {
      const action = remoteAction("back", context);
      console.info("[TV-PLAYER-BACK-003] step=%s context=%s action=%s", name, JSON.stringify(context), JSON.stringify(action));
      expect(action).toEqual(expected);
    }
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-PLAYER-BACK-004] Back on a notice alone dismisses it (keep watching), it never leaves the player", () => {
    for (const [name, context] of [
      ["video alone", NOTICE],
      ["controls up", { ...NOTICE, overlayVisible: true }],
    ] as [string, RemoteContext][]) {
      const action = remoteAction("back", context);
      console.info("[TV-PLAYER-BACK-004] case=%s action=%s", name, JSON.stringify(action));
      expect(action).toEqual({ type: "dismiss-prompt", prompt: "notice" });
    }
  });
});

describe("TV player remote: separate transport keys (Android KEYCODE_MEDIA_PLAY / PAUSE / STOP)", () => {
  // @req UX-TV-01[badger-tv]
  const contexts: [string, RemoteContext][] = [
    ["video alone", VIDEO_ONLY],
    ["controls up", OVERLAY],
    ["menu open", SHEET],
    ["skip pill", PILL],
    ["prompt", PROMPT],
    ["next-episode card", NEXT_CARD],
    ["too-weak / traffic-cap notice", NOTICE],
  ];
  /** Only a resume or error prompt stops the transport keys: the video plays on under the card and the notices. */
  const blocksTransport = (context: RemoteContext) => context.promptOpen && !context.nextCardOpen && !context.noticeOpen;

  it.each(contexts)("[TV-PLAYER-TRANSPORT-001] play and pause set the state, never toggle: %s", (name, context) => {
    const play = remoteAction("play", context);
    const pause = remoteAction("pause", context);
    console.info("[TV-PLAYER-TRANSPORT-001] context=%s play=%s pause=%s", name, JSON.stringify(play), JSON.stringify(pause));
    if (blocksTransport(context)) {
      expect(play).toEqual(IGNORE);
      expect(pause).toEqual(IGNORE);
      return;
    }
    expect(play).toEqual({ type: "set-paused", paused: false });
    expect(pause).toEqual({ type: "set-paused", paused: true });
    // Pressing play twice stays playing: the action carries the target state, not a toggle.
    expect(remoteAction("play", context)).toEqual(play);
  });

  it.each(contexts)("[TV-PLAYER-TRANSPORT-002] stop leaves the player for the title in every state: %s", (name, context) => {
    const action = remoteAction("stop", context);
    console.info("[TV-PLAYER-TRANSPORT-002] context=%s action=%s", name, JSON.stringify(action));
    expect(action).toEqual({ type: "leave-player" });
  });

  // @bugfix: the remote's Play / Pause did nothing while the next-episode card or a notice was up, though the video
  // keeps playing under them (review of feat/tv-integration, 2026-10-23).
  // @req UX-TV-01[badger-tv]
  it.each([
    ["next-episode card", NEXT_CARD],
    ["notice", NOTICE],
    ["notice over the controls", { ...NOTICE, overlayVisible: true }],
  ] as [string, RemoteContext][])("[TV-PLAYER-TRANSPORT-004] every transport key drives playback under the %s", (name, context) => {
    const actions = Object.fromEntries(
      (["playPause", "play", "pause", "rewind", "fastForward"] as const).map((key) => [key, remoteAction(key, context)])
    );
    console.info("[TV-PLAYER-TRANSPORT-004] context=%s actions=%s", name, JSON.stringify(actions));
    expect(actions).toEqual({
      playPause: { type: "toggle-pause" },
      play: { type: "set-paused", paused: false },
      pause: { type: "set-paused", paused: true },
      rewind: { type: "seek", direction: -1 },
      fastForward: { type: "seek", direction: 1 },
    });
    // The directions and OK stay with the prompt's focused button.
    expect(remoteAction("select", context)).toEqual(NATIVE_FOCUS);
  });

  it("[TV-PLAYER-TRANSPORT-003] the react-native-tvos event types of the Android media keys become keys on release only", () => {
    console.info("[TV-PLAYER-TRANSPORT-003] phase=start");
    for (const eventType of ["play", "pause", "stop", "playPause", "rewind", "fastForward"] as const) {
      const up = remoteKeyFromEvent({ eventType, eventKeyAction: 1 });
      const down = remoteKeyFromEvent({ eventType, eventKeyAction: 0 });
      console.info("[TV-PLAYER-TRANSPORT-003] eventType=%s up=%s down=%s", eventType, up, down);
      expect(up).toBe(eventType);
      expect(down).toBeNull();
    }
    // next / previous / record are emitted by react-native-tvos but the player does not use them.
    for (const eventType of ["next", "previous", "record"]) {
      expect(remoteKeyFromEvent({ eventType, eventKeyAction: 1 })).toBeNull();
    }
    // Rewind / fast-forward are the 10 s jump, the same step as left / right.
    expect(remoteAction("rewind", VIDEO_ONLY)).toEqual(remoteAction("left", VIDEO_ONLY));
    expect(remoteAction("fastForward", VIDEO_ONLY)).toEqual(remoteAction("right", VIDEO_ONLY));
  });
});

describe("TV player remote: touch-surface scrub vs swipes (Siri Remote pan)", () => {
  const swipeEvent = (eventType: string) => ({ eventType, body: { state: "Ended" } });

  // @req UX-TV-01[badger-tv]
  it("[TV-PLAYER-SCRUB-001] the scrub context is where left / right jump: the video alone (even under a skip pill) or the focused progress bar", () => {
    const contexts: [string, RemoteContext, boolean][] = [
      ["video", VIDEO_ONLY, true],
      ["pill", PILL, true],
      ["progress", PROGRESS, true],
      ["overlay-button", OVERLAY, false],
      ["sheet", SHEET, false],
      ["prompt", PROMPT, false],
      ["next-card", NEXT_CARD, false],
      ["notice", NOTICE, false],
    ];
    for (const [name, context, expected] of contexts) {
      const got = remoteScrubContext(context);
      console.info("[TV-PLAYER-SCRUB-001] context=%s scrub=%s", name, got);
      expect(got).toBe(expected);
    }
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-PLAYER-SCRUB-002] with the pan on, a left / right swipe in the scrub context is the pan's, not a 10 s jump", () => {
    for (const context of [VIDEO_ONLY, PROGRESS, PILL]) {
      for (const eventType of ["swipeLeft", "swipeRight"]) {
        const handled = swipeHandledByPan(swipeEvent(eventType), context, { panEnabled: true, scrubbing: false });
        console.info("[TV-PLAYER-SCRUB-002] eventType=%s context=%s handled=%s", eventType, JSON.stringify(context), handled);
        expect(handled).toBe(true);
      }
    }
    // A scrub under way owns the swipe even while the context catches up (the controls coming up, focus not landed).
    expect(swipeHandledByPan(swipeEvent("swipeRight"), OVERLAY, { panEnabled: true, scrubbing: true })).toBe(true);
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-PLAYER-SCRUB-003] elsewhere swipes stay arrows; up / down swipes and ring clicks are never the pan's", () => {
    const off = { panEnabled: true, scrubbing: false };
    // Controls up with the focus on a button: the swipe moves the focus like the arrow.
    expect(swipeHandledByPan(swipeEvent("swipeRight"), OVERLAY, off)).toBe(false);
    expect(remoteKeyFromEvent(swipeEvent("swipeRight"))).toBe("right");
    expect(swipeHandledByPan(swipeEvent("swipeLeft"), SHEET, off)).toBe(false);
    // Up / down swipes keep showing the controls, even mid-scrub.
    expect(swipeHandledByPan(swipeEvent("swipeUp"), VIDEO_ONLY, off)).toBe(false);
    expect(swipeHandledByPan(swipeEvent("swipeDown"), VIDEO_ONLY, { panEnabled: true, scrubbing: true })).toBe(false);
    // Ring clicks (plain left / right) keep their 10 s jump.
    for (const eventType of ["left", "right"]) {
      expect(swipeHandledByPan({ eventType, eventKeyAction: 1 }, VIDEO_ONLY, { panEnabled: true, scrubbing: true })).toBe(false);
    }
    expect(remoteAction("right", VIDEO_ONLY)).toEqual({ type: "seek", direction: 1 });
    expect(remoteAction("left", PROGRESS)).toEqual({ type: "seek", direction: -1 });
    console.info("[TV-PLAYER-SCRUB-003] phase=done");
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-PLAYER-SCRUB-004] without the pan (Android TV) nothing changes: a swipe-typed event stays its arrow", () => {
    const android = { panEnabled: false, scrubbing: false };
    for (const eventType of ["swipeLeft", "swipeRight", "swipeUp", "swipeDown"]) {
      const handled = swipeHandledByPan(swipeEvent(eventType), VIDEO_ONLY, android);
      console.info("[TV-PLAYER-SCRUB-004] eventType=%s handled=%s", eventType, handled);
      expect(handled).toBe(false);
    }
    expect(remoteAction(remoteKeyFromEvent({ eventType: "left", eventKeyAction: 1 })!, VIDEO_ONLY)).toEqual({ type: "seek", direction: -1 });
  });
});

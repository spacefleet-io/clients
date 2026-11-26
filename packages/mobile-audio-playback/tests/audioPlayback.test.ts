import { afterEach, describe, expect, test, vi } from "vitest";
import type { AudioPlaybackState, AudioQueueItem } from "../src/index";

// The JS face of Parrot's phone player: what reaches the native module and what the play/pause button shows.
type Call = [string, ...unknown[]];
const calls: Call[] = [];
const listeners = new Map<string, (state: AudioPlaybackState) => void>();

const state = (over: Partial<AudioPlaybackState> = {}): AudioPlaybackState => ({
  state: "ready",
  playing: true,
  playWhenReady: true,
  suppressed: false,
  positionMs: 0,
  durationMs: 180_000,
  index: 0,
  count: 1,
  mediaId: "a",
  error: null,
  shuffle: false,
  repeat: "off",
  ...over,
});

const record =
  (name: string) =>
  async (...args: unknown[]) => {
    calls.push([name, ...args]);
    return state();
  };

const nativeModule = {
  setQueue: record("setQueue"),
  addItems: record("addItems"),
  play: record("play"),
  pause: record("pause"),
  next: record("next"),
  previous: record("previous"),
  seekTo: record("seekTo"),
  getState: record("getState"),
  getUpNext: async () => ["b", "c"],
  stop: record("stop"),
  setShuffle: record("setShuffle"),
  setGains: record("setGains"),
  setLimiting: record("setLimiting"),
  setRepeatMode: record("setRepeatMode"),
  canShowOutputSwitcher: async () => true,
  showOutputSwitcher: async () => true,
  setKeepScreenOn: async (enabled: boolean) => {
    calls.push(["setKeepScreenOn", enabled]);
    return true;
  },
};

const mockReactNative = (withNative: boolean) =>
  vi.doMock("react-native", () => ({
    NativeModules: withNative ? { AudioPlayback: nativeModule } : {},
    DeviceEventEmitter: {
      addListener: (name: string, fn: (s: AudioPlaybackState) => void) => {
        listeners.set(name, fn);
        return { remove: () => listeners.delete(name) };
      },
    },
  }));

const load = async (withNative: boolean) => {
  vi.resetModules();
  mockReactNative(withNative);
  return import("../src/index");
};

const items: AudioQueueItem[] = [
  { id: "s1", url: "http://127.0.0.1:7000/s1", title: "One", gainDb: -3.5, key: "q0" },
  { id: "s2", url: "http://127.0.0.1:7000/s2", title: "Two", artist: "B", key: "q1" },
  { id: "s1", url: "http://127.0.0.1:7000/s1", title: "One again", key: "q2" },
];

afterEach(() => {
  calls.length = 0;
  listeners.clear();
  vi.doUnmock("react-native");
});

// @req PLAY-FOCUS-01[parrot]
describe("showsPause: what the play/pause button shows (PLAY-FOCUS-01 item 5)", () => {
  test("a call holding the music back shows play, though the player will resume by itself", async () => {
    const { showsPause } = await load(true);
    const cases: Array<[Pick<AudioPlaybackState, "playWhenReady" | "suppressed" | "state">, boolean]> = [
      [{ playWhenReady: true, suppressed: false, state: "ready" }, true],
      [{ playWhenReady: true, suppressed: false, state: "buffering" }, true],
      [{ playWhenReady: true, suppressed: true, state: "ready" }, false],
      [{ playWhenReady: true, suppressed: false, state: "ended" }, false],
      [{ playWhenReady: false, suppressed: false, state: "ready" }, false],
      [{ playWhenReady: false, suppressed: true, state: "buffering" }, false],
    ];
    for (const [input, expected] of cases) {
      const shown = showsPause(input);
      console.info("[PLAY-FOCUS-01] showsPause", { input, shown, expected });
      expect(shown).toBe(expected);
    }
  });
});

// @req PAR-PLAY-01[parrot]
describe("AudioPlayback bridge (PAR-PLAY-01)", () => {
  test("setQueue hands every song, in list order and with its gain and key, to the native player", async () => {
    const { AudioPlayback } = await load(true);
    await AudioPlayback.setQueue(items, 2, 41_000);
    await AudioPlayback.setQueue(items.slice(0, 1));
    console.info("[PAR-PLAY-01] setQueue calls", JSON.stringify(calls));
    const [first, second] = calls;
    expect(first?.[0]).toBe("setQueue");
    const sent = JSON.parse(String(first?.[1])) as AudioQueueItem[];
    expect(sent.map((item) => item.key)).toEqual(["q0", "q1", "q2"]);
    expect(sent[0]?.gainDb).toBe(-3.5);
    expect(sent[1]?.artist).toBe("B");
    expect(first?.slice(2)).toEqual([2, 41_000]);
    // A queue started without a position plays the first song from its start.
    expect(second?.slice(2)).toEqual([0, 0]);
  });

  test("Play next and Add to queue reach the player with where the songs go", async () => {
    const { AudioPlayback } = await load(true);
    await AudioPlayback.addItems(items.slice(1, 2), "next");
    await AudioPlayback.addItems(items.slice(2), "end");
    console.info("[PAR-PLAY-01] addItems calls", JSON.stringify(calls));
    expect(calls.map((call) => call[2])).toEqual(["next", "end"]);
    expect((JSON.parse(String(calls[0]?.[1])) as AudioQueueItem[]).map((item) => item.key)).toEqual(["q1"]);
  });

  test("seeking before the start or to a fraction of a millisecond sends a whole, non-negative position", async () => {
    const { AudioPlayback } = await load(true);
    for (const target of [-250, 0, 1234.6, 59_999.4]) await AudioPlayback.seekTo(target);
    console.info("[PAR-PLAY-01] seekTo calls", JSON.stringify(calls));
    expect(calls.map((call) => call[1])).toEqual([0, 0, 1235, 59_999]);
  });

  test("song gains are sent by song id so Even out volume changes the playing song too", async () => {
    const { AudioPlayback } = await load(true);
    await AudioPlayback.setGains({ s1: -6.25, s2: 2 });
    console.info("[PAR-PLAY-01] setGains calls", JSON.stringify(calls));
    expect(JSON.parse(String(calls[0]?.[1]))).toEqual({ s1: -6.25, s2: 2 });
  });

  test("onState delivers every player change to the screen and stops after remove()", async () => {
    const { AudioPlayback } = await load(true);
    const seen: AudioPlaybackState[] = [];
    const subscription = AudioPlayback.onState((next) => seen.push(next));
    console.info("[PAR-PLAY-01] listeners", [...listeners.keys()]);
    listeners.get("AudioPlaybackState")?.(state({ playing: false, suppressed: true }));
    subscription.remove();
    listeners.get("AudioPlaybackState")?.(state());
    console.info("[PAR-PLAY-01] seen", JSON.stringify(seen));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.suppressed).toBe(true);
  });
});

describe("a build without the native player", () => {
  test("transport calls fail with audio_playback_unavailable instead of doing nothing", async () => {
    const { AudioPlayback } = await load(false);
    const attempts: Array<[string, () => unknown]> = [
      ["setQueue", () => AudioPlayback.setQueue(items)],
      ["addItems", () => AudioPlayback.addItems(items, "end")],
      ["play", () => AudioPlayback.play()],
      ["seekTo", () => AudioPlayback.seekTo(10)],
      ["getState", () => AudioPlayback.getState()],
      ["showOutputSwitcher", () => AudioPlayback.showOutputSwitcher()],
    ];
    for (const [name, attempt] of attempts) {
      let message = "";
      try {
        await attempt();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      console.info("[no-native] attempt", { name, message });
      expect(message).toBe("audio_playback_unavailable");
    }
  });

  test("the output picker button and keep-awake just report false, so screens still open", async () => {
    const { AudioPlayback } = await load(false);
    const picker = await AudioPlayback.canShowOutputSwitcher();
    const awake = await AudioPlayback.setKeepScreenOn(true);
    console.info("[no-native] optional features", { picker, awake });
    expect(picker).toBe(false);
    expect(awake).toBe(false);
  });
});

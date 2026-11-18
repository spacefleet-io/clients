/** @req PLAY-OSMEDIA-01[badger-mobile] */
/** @req PLAY-OSMEDIA-01[parrot] */
import { describe, expect, it, vi } from "vitest";
import type { MediaSessionState } from "@space/media-session";
import {
  ACTION_EVENT,
  createMediaSessionBinderFor,
  type NativeMediaSessionEvent,
  type NativeMediaSessionPlan,
} from "../src/binder";

const TAG = "[mobile-media-session.binder]";

/** A fake `SpaceMediaSession` module plus its event emitter; `history()` dumps everything it saw. */
const fakeNative = () => {
  const calls: Array<{ op: "update"; plan: NativeMediaSessionPlan } | { op: "release" }> = [];
  /** Every binder subscribes its own listener, as on the real React Native emitter. */
  const listeners = new Map<string, Set<(event: NativeMediaSessionEvent) => void>>();
  return {
    calls,
    native: {
      update: (plan: NativeMediaSessionPlan) => calls.push({ op: "update", plan }),
      release: () => calls.push({ op: "release" }),
    },
    events: {
      addListener: (name: string, listener: (event: NativeMediaSessionEvent) => void) => {
        const set = listeners.get(name) ?? new Set();
        set.add(listener);
        listeners.set(name, set);
        return { remove: () => set.delete(listener) };
      },
    },
    emit: (event: NativeMediaSessionEvent) => {
      console.info(TAG, "emit", JSON.stringify(event), "listeners", listeners.get(ACTION_EVENT)?.size ?? 0);
      for (const listener of [...(listeners.get(ACTION_EVENT) ?? [])]) listener(event);
    },
    listening: () => listeners.get(ACTION_EVENT)?.size ?? 0,
    history: () => JSON.stringify(calls, null, 1),
  };
};

const handlersMock = () => ({
  play: vi.fn(),
  pause: vi.fn(),
  stop: vi.fn(),
  next: vi.fn(),
  previous: vi.fn(),
  seekTo: vi.fn(),
});

const episode = (patch: Partial<MediaSessionState> = {}): MediaSessionState => ({
  status: "playing",
  info: { title: "Pilot", artist: "Test Show", album: "S1 E1", artworkUrl: "file:///data/user/0/app/cache/poster.jpg" },
  positionS: 60,
  durationS: 1200,
  rate: 1,
  canNext: true,
  canPrevious: false,
  canSeek: true,
  ...patch,
});

const setup = () => {
  const fake = fakeNative();
  let clock = 1_000_000;
  const logs: string[] = [];
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  /** A binder over the shared native module, as each mount of the player screen creates; logs carry its name. */
  const mount = (name: string) => {
    const handlers = handlersMock();
    const binder = createMediaSessionBinderFor(
      fake.native,
      fake.events,
      {
        handlers: () => handlers,
        log: (message, detail) => logs.push(`${name} ${message} ${JSON.stringify(detail ?? {})}`),
        schedule: (fn, ms) => {
          const timer = { at: clock + ms, fn, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      },
      () => clock,
    );
    console.info(TAG, "mount", name, "at", clock);
    return { handlers, binder };
  };
  const { handlers, binder } = mount("first");
  /** Moves the clock and fires the scheduled callbacks that came due. */
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers.splice(0)) {
      if (timer.cancelled) continue;
      if (timer.at <= clock) timer.fn();
      else timers.push(timer);
    }
  };
  const dump = () => console.info(TAG, "native history", fake.history(), "\nlogs", logs.join("\n"));
  return { fake, handlers, binder, mount, advance, logs, dump };
};

describe("createMediaSessionBinderFor", () => {
  it("sends the flattened plan in ms with only the offered actions and local artwork", () => {
    const { fake, binder, dump } = setup();
    binder.update(episode());
    dump();
    expect(fake.calls).toEqual([
      {
        op: "update",
        plan: {
          playbackState: "playing",
          title: "Pilot",
          artist: "Test Show",
          album: "S1 E1",
          artworkUri: "file:///data/user/0/app/cache/poster.jpg",
          durationMs: 1_200_000,
          positionMs: 60_000,
          rate: 1,
          actions: ["play", "pause", "stop", "nexttrack", "seekto", "seekbackward", "seekforward"],
          loading: false,
        },
      },
    ]);
  });

  it("never passes a remote or blob image to the native card", () => {
    const { fake, binder, dump } = setup();
    binder.update(episode({ info: { title: "Song", artworkUrl: "https://image.tmdb.org/x.jpg" } }));
    binder.update(episode({ info: { title: "Song", artworkUrl: "blob:abc" } }));
    dump();
    expect(fake.calls.map((call) => (call.op === "update" ? call.plan.artworkUri : "release"))).toEqual([null, null]);
  });

  it("offers no next on the last song and no seeking without a duration", () => {
    const { fake, binder, dump } = setup();
    binder.update(episode({ canNext: false, durationS: undefined }));
    dump();
    const call = fake.calls[0];
    expect(call?.op === "update" && call.plan.actions).toEqual(["play", "pause", "stop"]);
    expect(call?.op === "update" && call.plan.durationMs).toBeNull();
  });

  it("keeps the session on pause and releases it once on stop, then can claim again", () => {
    const { fake, binder, dump } = setup();
    binder.update(episode());
    binder.update(episode({ status: "paused" }));
    expect(fake.listening()).toBe(1);
    binder.update(episode({ status: "none" }));
    binder.update(episode({ status: "none" }));
    binder.release();
    expect(fake.listening()).toBe(0);
    binder.update(episode());
    dump();
    expect(fake.calls.map((call) => (call.op === "update" ? call.plan.playbackState : call.op))).toEqual([
      "playing",
      "paused",
      "release",
      "playing",
    ]);
    expect(fake.listening()).toBe(1);
  });

  it("routes play, pause, stop, next and absolute seek to the handlers", () => {
    const { fake, handlers, binder, dump } = setup();
    binder.update(episode({ canPrevious: true }));
    fake.emit({ action: "pause" });
    fake.emit({ action: "play" });
    fake.emit({ action: "nexttrack" });
    fake.emit({ action: "previoustrack" });
    fake.emit({ action: "seekto", seekTimeMs: 300_500 });
    fake.emit({ action: "stop" });
    dump();
    expect(handlers.pause).toHaveBeenCalledTimes(1);
    expect(handlers.play).toHaveBeenCalledTimes(1);
    expect(handlers.next).toHaveBeenCalledTimes(1);
    expect(handlers.previous).toHaveBeenCalledTimes(1);
    expect(handlers.seekTo).toHaveBeenCalledWith(300.5);
    expect(handlers.stop).toHaveBeenCalledTimes(1);
  });

  it("stop falls back to pause when the player has no stop", () => {
    const fake = fakeNative();
    const pause = vi.fn();
    const binder = createMediaSessionBinderFor(fake.native, fake.events, { handlers: () => ({ play: vi.fn(), pause }) });
    binder.update(episode());
    fake.emit({ action: "stop" });
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("ignores actions the card does not offer (headset double press on the last episode)", () => {
    const { fake, handlers, binder, logs, dump } = setup();
    binder.update(episode({ canNext: false, canPrevious: false }));
    fake.emit({ action: "nexttrack" });
    fake.emit({ action: "previoustrack" });
    dump();
    expect(handlers.next).not.toHaveBeenCalled();
    expect(handlers.previous).not.toHaveBeenCalled();
    expect(logs.filter((line) => line.startsWith("first media_session.action_ignored"))).toHaveLength(2);
  });

  it("steps 10 s from the extrapolated position while playing, clamped to the media", () => {
    const { fake, handlers, binder, advance, dump } = setup();
    binder.update(episode({ positionS: 60 }));
    advance(5_000);
    fake.emit({ action: "seekforward" });
    fake.emit({ action: "seekbackward", seekOffsetMs: 30_000 });
    binder.update(episode({ positionS: 1195, status: "paused" }));
    advance(60_000);
    fake.emit({ action: "seekforward" });
    dump();
    expect(handlers.seekTo.mock.calls).toEqual([[75], [35], [1200]]);
  });

  it("does nothing on events after release", () => {
    const { fake, handlers, binder } = setup();
    binder.update(episode());
    binder.release();
    fake.emit({ action: "play" });
    expect(handlers.play).not.toHaveBeenCalled();
  });

  /**
   * @bugfix lock-screen next stalled the phone: the switch released the card (and its foreground service) while the
   * next episode loaded, so the locked phone stopped running JS after `library.dataset.await.ready` and the
   * notification vanished.
   * @regression-proof fails without the handover hold: the `none` plan of the loading episode released the session.
   */
  it.each(["nexttrack", "previoustrack"] as const)(
    "holds the card as loading across a %s press until the new episode plays",
    (action) => {
      const { fake, binder, advance, dump } = setup();
      binder.update(episode({ canPrevious: true }));
      fake.emit({ action });
      advance(1_000);
      binder.update(episode({ canPrevious: true, positionS: 61 }));
      binder.update(episode({ status: "none" }));
      advance(5_000);
      binder.update(episode({ status: "none" }));
      binder.update(episode({ info: { title: "Second", artist: "Test Show", album: "S1 E2" }, positionS: 0 }));
      dump();
      expect(fake.calls.some((call) => call.op === "release")).toBe(false);
      expect(fake.listening()).toBe(1);
      const states = fake.calls.map((call) => (call.op === "update" ? [call.plan.title, call.plan.playbackState, call.plan.loading] : [call.op]));
      expect(states).toEqual([
        ["Pilot", "playing", false],
        ["Pilot", "playing", false],
        ["Pilot", "paused", true],
        ["Second", "playing", false],
      ]);
      const held = fake.calls[2];
      expect(held?.op === "update" && held.plan.positionMs).toBe(61_000);
    },
  );

  it("releases a held card when the next episode never comes", () => {
    const { fake, binder, advance, dump } = setup();
    binder.update(episode());
    fake.emit({ action: "nexttrack" });
    binder.update(episode({ status: "none" }));
    advance(29_000);
    expect(fake.calls.at(-1)?.op).toBe("update");
    advance(1_000);
    binder.update(episode({ status: "none" }));
    dump();
    expect(fake.calls.map((call) => call.op)).toEqual(["update", "update", "release"]);
  });

  it("releases at once on stop, on a none without a switch, and on release during a hold", () => {
    const { fake, binder, advance, dump } = setup();
    binder.update(episode());
    fake.emit({ action: "stop" });
    binder.update(episode({ status: "none" }));
    binder.update(episode());
    fake.emit({ action: "nexttrack" });
    binder.update(episode({ status: "none" }));
    binder.release();
    advance(60_000);
    dump();
    expect(fake.calls.map((call) => (call.op === "update" ? call.plan.playbackState : call.op))).toEqual([
      "playing",
      "release",
      "playing",
      "paused",
      "release",
    ]);
  });

  /**
   * @bugfix lock-screen next still dropped the card on the emulator: `PlayerScreenInner` is keyed by episode, so the
   * switch unmounts the player and its cleanup calls `binder.release()`, which removed the card and its foreground
   * service mid-load.
   * @regression-proof fails without the park-and-adopt handover: the old player's release removed the card.
   */
  it.each(["nexttrack", "previoustrack"] as const)(
    "hands the card from the unmounted player to the next player's binder across a %s press",
    (action) => {
      const { fake, handlers, binder, mount, advance, logs, dump } = setup();
      binder.update(episode({ canPrevious: true }));
      fake.emit({ action });
      binder.update(episode({ status: "none" }));
      binder.release();
      console.info(TAG, "parked; listeners", fake.listening());
      advance(4_000);
      const second = mount("second");
      second.binder.update(episode({ status: "none" }));
      advance(4_000);
      second.binder.update(episode({ info: { title: "Second", artist: "Test Show", album: "S1 E2" }, positionS: 0 }));
      advance(60_000);
      fake.emit({ action: "pause" });
      dump();
      expect(fake.calls.some((call) => call.op === "release")).toBe(false);
      expect(fake.calls.map((call) => (call.op === "update" ? [call.plan.title, call.plan.playbackState, call.plan.loading] : [call.op]))).toEqual([
        ["Pilot", "playing", false],
        ["Pilot", "paused", true],
        ["Second", "playing", false],
      ]);
      expect(logs.filter((line) => line.includes("handover_"))).toEqual([
        'first media_session.handover_hold {"title":"Pilot"}',
        'first media_session.handover_parked {"title":"Pilot"}',
        'second media_session.handover_done {"title":"Second","adopted":true}',
      ]);
      expect(fake.listening()).toBe(1);
      expect(handlers.pause).not.toHaveBeenCalled();
      expect(second.handlers.pause).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["stop", "pause"] as const)("a %s press on the parked card removes it; the next player claims afresh", (press) => {
    const { fake, handlers, binder, mount, advance, logs, dump } = setup();
    binder.update(episode());
    fake.emit({ action: "nexttrack" });
    binder.release();
    const second = mount("second");
    second.binder.update(episode({ status: "none" }));
    fake.emit({ action: press });
    console.info(TAG, "after", press, "listeners", fake.listening());
    expect(fake.listening()).toBe(0);
    advance(1_000);
    second.binder.update(episode({ info: { title: "Second", artist: "Test Show", album: "S1 E2" }, positionS: 0 }));
    dump();
    expect(fake.calls.map((call) => (call.op === "update" ? [call.plan.title, call.plan.loading] : [call.op]))).toEqual([
      ["Pilot", false],
      ["Pilot", true],
      ["release"],
      ["Second", false],
    ]);
    expect(handlers.stop).not.toHaveBeenCalled();
    expect(handlers.pause).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes('"adopted":true'))).toBe(false);
    expect(logs).toContain('second media_session.claim {"title":"Second"}');
  });

  it("a parked card no player adopts is removed after HANDOVER_HOLD_MS", () => {
    const { fake, binder, mount, advance, logs, dump } = setup();
    binder.update(episode({ canPrevious: true }));
    fake.emit({ action: "previoustrack" });
    binder.release();
    const second = mount("second");
    advance(29_999);
    second.binder.update(episode({ status: "none" }));
    expect(fake.calls.at(-1)?.op).toBe("update");
    advance(1);
    console.info(TAG, "after expiry listeners", fake.listening());
    expect(fake.calls.at(-1)?.op).toBe("release");
    expect(fake.listening()).toBe(0);
    second.binder.update(episode({ info: { title: "Second", artist: "Test Show", album: "S1 E2" }, positionS: 0 }));
    dump();
    expect(logs.filter((line) => line.includes("handover_"))).toEqual([
      'first media_session.handover_hold {"title":"Pilot"}',
      'first media_session.handover_parked {"title":"Pilot"}',
      'first media_session.handover_expired {"holdMs":30000}',
    ]);
    expect(fake.calls.map((call) => call.op)).toEqual(["update", "update", "release", "update"]);
  });
});

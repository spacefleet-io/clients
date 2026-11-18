import { describe, expect, it, vi } from "vitest";
import {
  type ActionDetailsLike,
  type AudioElementLike,
  createMediaSessionBinder,
  createSilentKeepAlive,
  type MediaSessionLike,
  type MediaSessionState,
  planMediaSession,
  silentWav,
  steppedSeekTarget,
} from "../src/index";

const song = (over: Partial<MediaSessionState> = {}): MediaSessionState => ({
  status: "playing",
  info: { title: "Song", artist: "Artist", album: "Album", artworkUrl: "blob:http://x/abc" },
  positionS: 12,
  durationS: 200,
  canNext: true,
  canPrevious: true,
  canSeek: true,
  ...over,
});

class FakeSession implements MediaSessionLike {
  metadata: unknown = null;
  playbackState = "none";
  handlers = new Map<string, (d: ActionDetailsLike) => void>();
  positions: unknown[] = [];
  setActionHandler(action: string, handler: ((d: ActionDetailsLike) => void) | null) {
    if (action === "stop" && this.rejectStop) throw new TypeError("unknown action");
    if (handler) this.handlers.set(action, handler);
    else this.handlers.delete(action);
  }
  setPositionState(state?: unknown) {
    this.positions.push(state);
  }
  rejectStop = false;
  fire(action: string, details: Partial<ActionDetailsLike> = {}) {
    this.handlers.get(action)?.({ action, ...details });
  }
}

/** @req PLAY-OSMEDIA-01[badger-desktop,badger-mobile,badger-web-player,parrot,parrot-web-player] */
describe("planMediaSession", () => {
  it("shows title, artist, local artwork, position and every sensible action while playing", () => {
    const plan = planMediaSession(song());
    expect(plan.playbackState).toBe("playing");
    expect(plan.metadata).toEqual({
      title: "Song",
      artist: "Artist",
      album: "Album",
      artwork: [{ src: "blob:http://x/abc" }],
    });
    expect(plan.position).toEqual({ duration: 200, position: 12, playbackRate: 1 });
    expect([...plan.actions].sort()).toEqual(
      ["nexttrack", "pause", "play", "previoustrack", "seekbackward", "seekforward", "seekto", "stop"].sort(),
    );
  });

  it("never hands a remote artwork URL to the OS", () => {
    const plan = planMediaSession(song({ info: { title: "T", artworkUrl: "https://cdn.example/cover.jpg" } }));
    expect(plan.metadata?.artwork).toEqual([]);
  });

  it("offers no next on the last song and no next/previous on a single movie", () => {
    expect(planMediaSession(song({ canNext: false })).actions.has("nexttrack")).toBe(false);
    const movie = planMediaSession(song({ canNext: false, canPrevious: false }));
    expect(movie.actions.has("nexttrack")).toBe(false);
    expect(movie.actions.has("previoustrack")).toBe(false);
    expect(movie.actions.has("play")).toBe(true);
  });

  it("drops seeking and position when the duration is unknown", () => {
    const plan = planMediaSession(song({ durationS: Number.NaN }));
    expect(plan.position).toBeNull();
    expect(plan.actions.has("seekto")).toBe(false);
  });

  it("clamps the position into the media", () => {
    expect(planMediaSession(song({ positionS: 999 })).position?.position).toBe(200);
    expect(planMediaSession(song({ positionS: -3 })).position?.position).toBe(0);
  });

  it("keeps the session while paused and releases it on stop", () => {
    expect(planMediaSession(song({ status: "paused" })).playbackState).toBe("paused");
    expect(planMediaSession(song({ status: "paused" })).actions.has("play")).toBe(true);
    const released = planMediaSession(song({ status: "none" }));
    expect(released.metadata).toBeNull();
    expect(released.actions.size).toBe(0);
  });

  it("steps seeks by 10 s inside the media", () => {
    expect(steppedSeekTarget(5, 100, "backward")).toBe(0);
    expect(steppedSeekTarget(95, 100, "forward")).toBe(100);
    expect(steppedSeekTarget(50, 100, "forward")).toBe(60);
  });
});

/** @req PLAY-OSMEDIA-01[badger-desktop,badger-web-player,parrot,parrot-web-player] */
describe("createMediaSessionBinder", () => {
  const setup = () => {
    const session = new FakeSession();
    const h = { play: vi.fn(), pause: vi.fn(), stop: vi.fn(), next: vi.fn(), previous: vi.fn(), seekTo: vi.fn() };
    const createMetadata = vi.fn((m) => ({ wrapped: m }));
    const binder = createMediaSessionBinder({ session, createMetadata, handlers: () => h });
    return { session, h, createMetadata, binder };
  };

  it("routes OS actions to the player", () => {
    const { session, h, binder } = setup();
    binder.update(song());
    session.fire("pause");
    session.fire("play");
    session.fire("nexttrack");
    session.fire("previoustrack");
    session.fire("stop");
    session.fire("seekto", { seekTime: 42 });
    session.fire("seekforward");
    session.fire("seekbackward", { seekOffset: 5 });
    console.log("[media-session test] handler calls", JSON.stringify(h.seekTo.mock.calls));
    expect(h.pause).toHaveBeenCalledOnce();
    expect(h.play).toHaveBeenCalledOnce();
    expect(h.next).toHaveBeenCalledOnce();
    expect(h.previous).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.seekTo.mock.calls).toEqual([[42], [22], [7]]);
    expect(session.playbackState).toBe("playing");
    expect(session.positions.at(-1)).toEqual({ duration: 200, position: 12, playbackRate: 1 });
  });

  it("only rebuilds metadata when it changes", () => {
    const { binder, createMetadata } = setup();
    binder.update(song());
    binder.update(song({ positionS: 13 }));
    binder.update(song({ status: "paused" }));
    expect(createMetadata).toHaveBeenCalledOnce();
    binder.update(song({ info: { title: "Other" } }));
    expect(createMetadata).toHaveBeenCalledTimes(2);
  });

  it("unbinds next when it stops making sense and releases everything on close", () => {
    const { session, binder } = setup();
    binder.update(song());
    expect(session.handlers.has("nexttrack")).toBe(true);
    binder.update(song({ canNext: false }));
    expect(session.handlers.has("nexttrack")).toBe(false);
    binder.release();
    expect(session.handlers.size).toBe(0);
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(session.positions.at(-1)).toBeUndefined();
  });

  it("survives an engine that rejects the stop action", () => {
    const { session, binder } = setup();
    session.rejectStop = true;
    expect(() => binder.update(song())).not.toThrow();
    expect(session.handlers.has("play")).toBe(true);
  });
});

/** @req PLAY-OSMEDIA-01[badger-desktop] */
describe("silent keep-alive", () => {
  it("builds a valid silent WAV longer than 5 s", () => {
    const wav = silentWav();
    const text = (o: number, n: number) => String.fromCharCode(...wav.slice(o, o + n));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    const view = new DataView(wav.buffer);
    const rate = view.getUint32(24, true);
    const dataLen = view.getUint32(40, true);
    expect(dataLen / rate).toBeGreaterThan(5);
    expect(wav.slice(44).every((b) => b === 0x80)).toBe(true);
  });

  it("plays, pauses and unloads with the external player", () => {
    const audio: AudioElementLike & { playing: boolean } = {
      src: "",
      loop: false,
      muted: true,
      volume: 0,
      playing: false,
      get paused() {
        return !this.playing;
      },
      play: vi.fn(function (this: { playing: boolean }) {
        this.playing = true;
        return Promise.resolve();
      }),
      pause: vi.fn(function (this: { playing: boolean }) {
        this.playing = false;
      }),
      load: vi.fn(),
      removeAttribute: vi.fn(function (this: { src: string }) {
        this.src = "";
      }),
    };
    const revoke = vi.fn();
    const ka = createSilentKeepAlive({ createAudio: () => audio, createUrl: () => "blob:silent", revokeUrl: revoke });
    ka.set("playing");
    expect(audio.src).toBe("blob:silent");
    expect(audio.muted).toBe(false);
    expect(audio.loop).toBe(true);
    expect(audio.paused).toBe(false);
    ka.set("paused");
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe("blob:silent");
    ka.set("none");
    expect(audio.src).toBe("");
    expect(ka.status).toBe("none");
    ka.dispose();
    expect(revoke).toHaveBeenCalledWith("blob:silent");
  });
});

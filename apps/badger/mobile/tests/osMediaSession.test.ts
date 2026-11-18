/** @req PLAY-OSMEDIA-01[badger-mobile] */
import { describe, expect, it, vi } from "vitest";
import { planMediaSession } from "@space/media-session";
import { castMediaHandlers, castMediaState, localPlaybackMediaState, tvRemoteMediaHandlers, tvRemoteMediaState, type CastMediaInput } from "../src/lib/playback/osMediaSession";
import { IDLE_STATE, type TvState } from "../src/lib/playOnTv/protocol";

const TAG = "[badger.osMediaSession]";
const dump = (label: string, value: unknown) => console.info(TAG, label, JSON.stringify(value, (_k, v) => (v instanceof Set ? [...v] : v)));

const show = { type: "tv" as const, title: "Test Show", year: "2021" };
const movie = { type: "movie" as const, title: "Test Movie", year: "1995-05-01" };
const snap = (patch: Partial<{ position: number; duration: number; paused: boolean; voConfigured: boolean }> = {}) => ({
  position: 42,
  duration: 1500,
  paused: false,
  voConfigured: true,
  ...patch,
});

describe("localPlaybackMediaState", () => {
  const base = {
    ready: true,
    snapshot: snap(),
    details: show,
    episode: { seasonNumber: 1, episodeNumber: 2, name: "Second" },
    posterUrl: "file:///data/user/0/com.spacefleet.badger/cache/assets/poster.jpg",
    fallbackDurationSeconds: 0,
    hasNextEpisode: true,
    hasPreviousEpisode: true,
  };

  it("shows episode, show and code with the local poster, next and previous, and seeking", () => {
    const state = localPlaybackMediaState(base);
    const plan = planMediaSession(state);
    dump("episode", { state, plan });
    expect(state.info).toEqual({ title: "S01E02 · Second", artist: "Test Show", artworkUrl: base.posterUrl });
    expect(plan.playbackState).toBe("playing");
    expect([...plan.actions].sort()).toEqual(
      ["nexttrack", "pause", "play", "previoustrack", "seekbackward", "seekforward", "seekto", "stop"].sort(),
    );
    expect(plan.position).toEqual({ duration: 1500, position: 42, playbackRate: 1 });
  });

  it("a movie shows its title and year, no next or previous", () => {
    const state = localPlaybackMediaState({ ...base, details: movie, episode: null, hasNextEpisode: false, hasPreviousEpisode: false });
    const plan = planMediaSession(state);
    dump("movie", { state, plan });
    expect(plan.metadata?.title).toBe("Test Movie (1995)");
    expect(plan.actions.has("nexttrack")).toBe(false);
    expect(plan.actions.has("previoustrack")).toBe(false);
  });

  it("keeps the card on pause, holds nothing before the file is loaded or once the player is not ready", () => {
    expect(localPlaybackMediaState({ ...base, snapshot: snap({ paused: true }) }).status).toBe("paused");
    expect(localPlaybackMediaState({ ...base, snapshot: snap({ voConfigured: false, duration: 0 }) }).status).toBe("none");
    // An episode started from the lock screen plays its sound with the picture off: no frame, but a known duration.
    expect(localPlaybackMediaState({ ...base, snapshot: snap({ voConfigured: false }) }).status).toBe("playing");
    expect(localPlaybackMediaState({ ...base, snapshot: null }).status).toBe("none");
    expect(localPlaybackMediaState({ ...base, ready: false }).status).toBe("none");
  });

  it("falls back to the library duration while mpv does not know it yet", () => {
    const state = localPlaybackMediaState({ ...base, snapshot: snap({ duration: 0 }), fallbackDurationSeconds: 1300 });
    dump("fallback", state);
    expect(state.durationS).toBe(1300);
    expect(state.canSeek).toBe(true);
  });

  it("an episode without a name is titled by its code", () => {
    const state = localPlaybackMediaState({ ...base, episode: { seasonNumber: 3, episodeNumber: 4, name: null } as never });
    expect(state.info).toMatchObject({ title: "S03E04", artist: "Test Show" });
  });
});

describe("tvRemoteMediaState", () => {
  const tv = (patch: Partial<TvState>): TvState => ({
    ...IDLE_STATE,
    phase: "playing",
    mediaId: "m1",
    title: "Test Show · S1E02",
    positionSeconds: 100,
    durationSeconds: 1500,
    ...patch,
  });

  it("follows the TV's playing and paused state with its title, position and the poster", () => {
    const playing = tvRemoteMediaState({ status: "connected", tv: tv({}) }, "fallback", "file:///poster.jpg");
    const paused = tvRemoteMediaState({ status: "connected", tv: tv({ phase: "paused" }) }, "fallback", null);
    dump("tv", { playing, paused });
    expect(playing).toMatchObject({ status: "playing", info: { title: "Test Show · S1E02", artworkUrl: "file:///poster.jpg" }, positionS: 100, durationS: 1500, canSeek: true, canNext: false });
    expect(paused.status).toBe("paused");
  });

  it("releases while loading, after the TV ended or failed, or once the remote session ended", () => {
    for (const phase of ["idle", "loading", "ended", "failed"] as const) {
      expect(tvRemoteMediaState({ status: "connected", tv: tv({ phase }) }, "t", null).status).toBe("none");
    }
    expect(tvRemoteMediaState({ status: "ended", tv: tv({}) }, "t", null).status).toBe("none");
    expect(tvRemoteMediaState({ status: "connecting", tv: null }, "t", null).status).toBe("none");
  });

  it("uses the title the phone started when the TV has none", () => {
    expect(tvRemoteMediaState({ status: "connected", tv: tv({ title: null }) }, "Started title", null).info?.title).toBe("Started title");
  });

  it("card and headset presses become remote commands to the TV", () => {
    const send = vi.fn();
    const handlers = tvRemoteMediaHandlers(send);
    handlers.play();
    handlers.pause();
    handlers.seekTo?.(-3);
    handlers.seekTo?.(250);
    handlers.stop?.();
    dump("sent", send.mock.calls);
    expect(send.mock.calls.map(([action]) => action)).toEqual([
      { type: "play" },
      { type: "pause" },
      { type: "seekTo", positionSeconds: 0 },
      { type: "seekTo", positionSeconds: 250 },
      { type: "stop" },
    ]);
  });
});

describe("castMediaState", () => {
  const view = (patch: Partial<CastMediaInput>): CastMediaInput => ({
    phase: "casting",
    title: "The Lord of the Rings",
    episodeLabel: null,
    playing: true,
    positionSeconds: 42,
    durationSeconds: 600,
    ...patch,
  });

  /** @req UX-TV-03[badger-mobile] */
  it("follows the device's playing and paused state while casting, with the episode label as the album", () => {
    const playing = castMediaState(view({}));
    const paused = castMediaState(view({ playing: false, episodeLabel: "S1E02 · Pilot" }));
    dump("cast", { playing, paused });
    expect(playing).toMatchObject({ status: "playing", info: { title: "The Lord of the Rings" }, positionS: 42, durationS: 600, canSeek: true, canNext: false, canPrevious: false });
    expect(paused).toMatchObject({ status: "paused", info: { title: "The Lord of the Rings", album: "S1E02 · Pilot" } });
    expect(planMediaSession(playing).actions.has("pause")).toBe(true);
  });

  /** @req UX-TV-03[badger-mobile] */
  it("shows no card before the device plays, after it ended or failed, or without a title", () => {
    for (const phase of ["preparing", "connecting", "ended", "refused", "error"] as const) {
      expect(castMediaState(view({ phase })).status).toBe("none");
    }
    expect(castMediaState(view({ title: "" })).status).toBe("none");
    expect(castMediaState(view({ durationSeconds: 0 })).canSeek).toBe(false);
  });

  /** @req UX-TV-03[badger-mobile] */
  it("card and headset presses become the cast screen's commands to the device", () => {
    const calls: unknown[] = [];
    const handlers = castMediaHandlers({
      setPlaying: (playing) => calls.push(["setPlaying", playing]),
      seekTo: (seconds) => calls.push(["seekTo", seconds]),
      stop: () => calls.push(["stop"]),
    });
    handlers.pause();
    handlers.play();
    handlers.seekTo?.(-5);
    handlers.seekTo?.(120);
    handlers.stop?.();
    dump("cast controls", calls);
    expect(calls).toEqual([["setPlaying", false], ["setPlaying", true], ["seekTo", 0], ["seekTo", 120], ["stop"]]);
  });
});

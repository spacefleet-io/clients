import { describe, expect, it } from "vitest";
import { planMediaSession } from "@space/media-session";
import { buildBadgerMediaSessionState, type BadgerNowPlayingInput } from "@/lib/osMediaSession";

const episodeInput = (patch: Partial<BadgerNowPlayingInput> = {}): BadgerNowPlayingInput => ({
  open: true,
  isPlaying: true,
  currentTime: 12,
  duration: 1500,
  title: "Severance",
  episode: { seasonNumber: 1, episodeNumber: 2, name: "Half Loop" },
  hasNext: true,
  hasPrevious: true,
  artworkUrl: "blob:poster",
  ...patch,
});

describe("Badger desktop OS media session state (mpv)", () => {
  /** @req PLAY-OSMEDIA-01[badger-desktop] */
  it("shows the show and the episode, with the local poster, the position and the duration", () => {
    const plan = planMediaSession(buildBadgerMediaSessionState(episodeInput()));
    expect(plan.playbackState).toBe("playing");
    expect(plan.metadata).toEqual({
      title: "S01E02 · Half Loop",
      artist: "Severance",
      album: "",
      artwork: [{ src: "blob:poster" }],
    });
    expect(plan.position).toEqual({ duration: 1500, position: 12, playbackRate: 1 });
    expect([...plan.actions].sort()).toEqual(
      ["nexttrack", "pause", "play", "previoustrack", "seekbackward", "seekforward", "seekto", "stop"].sort()
    );
  });

  /** @req PLAY-OSMEDIA-01[badger-desktop] */
  it("offers no next or previous on a single movie, keeps the session on pause and releases it on close", () => {
    const movie = episodeInput({ title: "Orchard", episode: null, hasNext: false, hasPrevious: false, isPlaying: false });
    const paused = planMediaSession(buildBadgerMediaSessionState(movie));
    expect(paused.playbackState).toBe("paused");
    expect(paused.metadata?.title).toBe("Orchard");
    expect(paused.actions.has("nexttrack")).toBe(false);
    expect(paused.actions.has("previoustrack")).toBe(false);
    expect(paused.actions.has("play")).toBe(true);

    const closed = planMediaSession(buildBadgerMediaSessionState({ ...movie, open: false }));
    expect(closed.playbackState).toBe("none");
    expect(closed.metadata).toBeNull();
  });
});

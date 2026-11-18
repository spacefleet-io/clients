import { afterEach, describe, expect, it } from "vitest";
import { browserMediaSession, episodeCode, videoMediaInfo } from "../src";

/** @req PLAY-OSMEDIA-01[badger-web-player] */
describe("videoMediaInfo", () => {
  it("shows a movie by its title, an episode as code · name with the show as artist", () => {
    expect(videoMediaInfo({ title: "Lantern Harbor", episode: null }, null)).toEqual({ title: "Lantern Harbor" });
    const episode = { seasonNumber: 1, episodeNumber: 2, name: "The Road" };
    expect(videoMediaInfo({ title: "Night Shift", episode }, "blob:http://x/p")).toEqual({
      title: "S01E02 · The Road",
      artist: "Night Shift",
      artworkUrl: "blob:http://x/p",
    });
    expect(videoMediaInfo({ title: "Night Shift", episode: { ...episode, name: null } }, null).title).toBe("S01E02");
    expect(episodeCode(12, 105)).toBe("S12E105");
  });
});

/** @req PLAY-OSMEDIA-01[badger-web-player] */
describe("browserMediaSession", () => {
  const saved = { navigator: Reflect.get(globalThis, "navigator"), MediaMetadata: Reflect.get(globalThis, "MediaMetadata") };
  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", { value: saved.navigator, configurable: true, writable: true });
    Object.defineProperty(globalThis, "MediaMetadata", { value: saved.MediaMetadata, configurable: true, writable: true });
  });

  it("is null without the Media Session API, and wraps navigator.mediaSession with it", () => {
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
    Object.defineProperty(globalThis, "MediaMetadata", { value: undefined, configurable: true, writable: true });
    expect(browserMediaSession()).toBeNull();

    const session = { metadata: null, playbackState: "none", setActionHandler: () => undefined };
    class FakeMetadata {
      constructor(readonly init: unknown) {}
    }
    Object.defineProperty(globalThis, "navigator", { value: { mediaSession: session }, configurable: true, writable: true });
    Object.defineProperty(globalThis, "MediaMetadata", { value: FakeMetadata, configurable: true, writable: true });
    const bound = browserMediaSession();
    expect(bound?.session).toBe(session);
    const made = bound?.createMetadata({ title: "t", artist: "", album: "", artwork: [] });
    expect(made).toBeInstanceOf(FakeMetadata);
  });
});

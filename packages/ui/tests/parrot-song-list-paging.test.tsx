// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ParrotSongList } from "../src/parrot/library";
import { useParrotPlaylistEditor } from "../src/parrot/playlists";
import { PARROT_LIKED_PLAYLIST_ID } from "@space/parrot-core";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A stand-in IntersectionObserver the test fires by hand: `reach()` says the list's end came near. */
const watched = new Set<{ callback: IntersectionObserverCallback; target: Element | null }>();
class FakeObserver {
  private entry: { callback: IntersectionObserverCallback; target: Element | null };
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, target: null };
    watched.add(this.entry);
  }
  observe(target: Element) {
    this.entry.target = target;
  }
  disconnect() {
    watched.delete(this.entry);
  }
}
const reach = () =>
  act(() => {
    for (const { callback, target } of [...watched]) callback([{ isIntersecting: true, target } as IntersectionObserverEntry], {} as IntersectionObserver);
  });

const songs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `Song ${i}`, artistName: "Artist", albumTitle: "Album", durationMs: 1000 }));
const labels = { song: "Song", artist: "Artist", album: "Album", time: "Time", unknownArtist: "?", play: (title: string) => `Play ${title}`, missing: "Missing" };

describe("[parrot] song list on a big library (#3350 C4)", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    watched.clear();
  });

  const rows = () => container.querySelectorAll('[data-testid="library-track"]').length;

  it("draws 200 rows of 1,000 at first, then 200 more each time the end comes near, and stops at the last song", () => {
    act(() => root.render(<ParrotSongList tracks={songs(1_000)} labels={labels} playingId={undefined} playing={false} showAlbum={false} onPlay={() => undefined} />));
    console.info("[parrot-song-list] first draw", rows());
    expect(rows()).toBe(200);
    expect(container.querySelector('[data-testid="library-tracks-more"]')).not.toBeNull();
    reach();
    expect(rows()).toBe(400);
    for (let i = 0; i < 5; i += 1) reach();
    console.info("[parrot-song-list] after scrolling to the end", rows());
    expect(rows()).toBe(1_000);
    expect(container.querySelector('[data-testid="library-tracks-more"]')).toBeNull();
  });

  it("a short list is drawn whole, with no end marker", () => {
    act(() => root.render(<ParrotSongList tracks={songs(12)} labels={labels} playingId={undefined} playing={false} showAlbum={false} onPlay={() => undefined} />));
    expect(rows()).toBe(12);
    expect(container.querySelector('[data-testid="library-tracks-more"]')).toBeNull();
  });

  // @req PAR-PL-04
  it("each row's heart reads Liked songs from one set: 2,000 liked of 10,000 draw the right hearts", () => {
    const all = songs(10_000);
    const liked = all.filter((_, i) => i % 5 === 0).map((song) => song.id);
    const playlists = [{ id: PARROT_LIKED_PLAYLIST_ID, name: "", trackIds: liked, trackCount: liked.length, createdAt: 0, updatedAt: 0 }];
    function Hearts() {
      const editor = useParrotPlaylistEditor({ playlists, save: async () => ({ ok: true }), t: (key) => key, detail: () => "", notify: () => undefined });
      return <ParrotSongList tracks={all} labels={labels} playingId={undefined} playing={false} showAlbum={false} onPlay={() => undefined} actions={editor.songActions()} />;
    }
    const started = performance.now();
    act(() => root.render(<Hearts />));
    console.info("[parrot-song-list] 200 rows with hearts drawn in", Math.round(performance.now() - started), "ms");
    const hearts = [...container.querySelectorAll('[data-testid="song-like"]')];
    expect(hearts).toHaveLength(200);
    const pressed = hearts.map((heart) => heart.getAttribute("aria-pressed") === "true");
    expect(pressed.filter(Boolean)).toHaveLength(40);
    expect(pressed[0]).toBe(true);
    expect(pressed[1]).toBe(false);
  });
});

// @vitest-environment jsdom
/**
 * @test-id UI-PARROT-ROW-PLAY-001
 * @level unit
 * @req PAR-PLAY-10[parrot,parrot-web-player]
 * @why Chris, 2026-11-24: a click on a song row (not only on its play button) plays the song, or pauses or resumes it
 *   when it is the song playing now; Enter or Space on a focused row does the same. The row's own controls (add to
 *   queue, the "..." menu and what it opens, the artist and album links) keep their own action and never also toggle
 *   playback, a double-click plays once, and a song not reachable offline does nothing. The shared list draws every
 *   song list of the desktop app and the web player (album, playlist, artist, library songs, search results).
 */
import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ParrotSongList } from "../src/parrot/library";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[UI-PARROT-ROW-PLAY-001]";
const log = (step: string, detail: unknown) => console.info(`${SUITE} ${step}`, JSON.stringify(detail));

const tracks = [
  { id: "t1", title: "Harbour", artistName: "Test Band", artistId: "ar1", albumTitle: "First Light", albumId: "al1", durationMs: 180_000 },
  { id: "t2", title: "Lantern", artistName: "Test Band", artistId: "ar1", albumTitle: "First Light", albumId: "al1", durationMs: 200_000 },
  { id: "t3", title: "Gale", artistName: "Test Band", artistId: "ar1", albumTitle: "Second Wind", albumId: "al2", durationMs: 210_000 },
];
const labels = {
  song: "Songs",
  artist: "Artist",
  album: "Album",
  time: "Time",
  unknownArtist: "Unknown artist",
  play: (title: string) => `Play ${title}`,
  pause: (title: string) => `Pause ${title}`,
};

describe("[parrot] a click on a song row does what its play button does (PAR-PLAY-10)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onPlay: Mock<(index: number) => void>;
  let onToggle: Mock<() => void>;
  let onAddToQueue: Mock<(id: string) => void>;
  let onMenu: Mock<(id: string) => void>;
  let onMenuItem: Mock<(id: string) => void>;
  let onOpenArtist: Mock<(id: string) => void>;

  const render = ({ playingId, playing = true, away = [] as string[] }: { playingId?: string; playing?: boolean; away?: string[] } = {}) =>
    act(() =>
      root.render(
        <ParrotSongList
          tracks={tracks}
          playingId={playingId}
          playing={playing}
          showAlbum
          labels={labels}
          onPlay={onPlay}
          onToggle={onToggle}
          unavailable={(track) => away.includes(track.id)}
          links={{ onOpenArtist, onOpenAlbum: () => undefined }}
          actions={(track) => (
            <>
              <button type="button" data-testid="song-add-to-queue" onClick={() => onAddToQueue(track.id)}>
                +
              </button>
              <button type="button" data-testid="song-menu" onClick={() => onMenu(track.id)}>
                …
              </button>
              {/* An open menu, drawn in a portal like the app's dropdowns: its clicks still bubble to the row through React. */}
              {track.id === "t2" &&
                createPortal(
                  <div role="menuitem" data-testid="song-menu-item" onClick={() => onMenuItem(track.id)}>
                    Add to playlist
                  </div>,
                  document.body
                )}
            </>
          )}
        />
      )
    );
  const rows = () => [...container.querySelectorAll<HTMLElement>('[data-testid="library-track"]')];
  const row = (title: string) => rows().find((el) => el.textContent?.includes(title))!;
  const click = (el: Element, detail = 1) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail })));
  const key = (el: Element, keyName: string) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true })));
  const calls = () => ({ play: onPlay.mock.calls, toggle: onToggle.mock.calls.length, queue: onAddToQueue.mock.calls, menu: onMenu.mock.calls, menuItem: onMenuItem.mock.calls, artist: onOpenArtist.mock.calls });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onPlay = vi.fn();
    onToggle = vi.fn();
    onAddToQueue = vi.fn();
    onMenu = vi.fn();
    onMenuItem = vi.fn();
    onOpenArtist = vi.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("the list is a grid of focusable rows, each named after its song", () => {
    render({ playingId: "t1" });
    const grid = container.querySelector('[data-testid="library-tracks"]')!;
    const semantics = rows().map((el) => ({ role: el.getAttribute("role"), tabIndex: el.tabIndex, label: el.getAttribute("aria-label"), selected: el.getAttribute("aria-selected") }));
    log("grid", { role: grid.getAttribute("role"), label: grid.getAttribute("aria-label"), rows: semantics });
    expect(grid.getAttribute("role")).toBe("grid");
    expect(grid.getAttribute("aria-label")).toBe("Songs");
    expect(semantics).toEqual([
      { role: "row", tabIndex: 0, label: "Pause Harbour", selected: "true" },
      { role: "row", tabIndex: 0, label: "Play Lantern", selected: "false" },
      { role: "row", tabIndex: 0, label: "Play Gale", selected: "false" },
    ]);
    expect(row("Harbour").querySelector('[data-testid="song-play"]')!.getAttribute("aria-label")).toBe("Pause Harbour");
  });

  it("a click on a row's title, length or empty space plays that song from the list", () => {
    render();
    click(row("Lantern").querySelector(".font-medium")!);
    log("title click", calls());
    expect(onPlay.mock.calls).toEqual([[1]]);
    click(row("Gale").querySelector(".tabular-nums")!);
    click(row("Harbour"));
    log("length and row clicks", calls());
    expect(onPlay.mock.calls).toEqual([[1], [2], [0]]);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("on the song playing now, a click on the row or its play button pauses or resumes instead of starting it again", () => {
    render({ playingId: "t2" });
    click(row("Lantern").querySelector(".font-medium")!);
    click(row("Lantern").querySelector('[data-testid="song-play"]')!);
    log("current row clicks", calls());
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onPlay).not.toHaveBeenCalled();
    render({ playingId: "t2", playing: false });
    expect(row("Lantern").getAttribute("aria-label")).toBe("Play Lantern");
    click(row("Lantern"));
    expect(onToggle).toHaveBeenCalledTimes(3);
  });

  it("the play button fires once, not once for itself and again for the row", () => {
    render();
    click(row("Gale").querySelector('[data-testid="song-play"]')!);
    log("play button", calls());
    expect(onPlay.mock.calls).toEqual([[2]]);
  });

  it("Enter or Space on a focused row plays it; keys typed in the row's buttons stay theirs", () => {
    render({ playingId: "t1" });
    row("Lantern").focus();
    key(row("Lantern"), "Enter");
    key(row("Gale"), " ");
    key(row("Harbour"), "Enter");
    key(row("Gale"), "a");
    key(row("Gale").querySelector('[data-testid="song-menu"]')!, "Enter");
    log("keys", calls());
    expect(onPlay.mock.calls).toEqual([[1], [2]]);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("add to queue, the menu button, a menu item and the artist link keep their own click and never toggle playback", () => {
    render({ playingId: "t2" });
    click(row("Lantern").querySelector('[data-testid="song-add-to-queue"]')!);
    click(row("Lantern").querySelector('[data-testid="song-menu"]')!);
    click(document.querySelector('[data-testid="song-menu-item"]')!);
    click(row("Gale").querySelector('[data-testid="song-artist-link"]')!);
    log("row controls", calls());
    expect(onAddToQueue.mock.calls).toEqual([["t2"]]);
    expect(onMenu.mock.calls).toEqual([["t2"]]);
    expect(onMenuItem.mock.calls).toEqual([["t2"]]);
    expect(onOpenArtist.mock.calls).toEqual([["ar1"]]);
    expect(onPlay).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("a double-click plays the song once (its second click is not a pause)", () => {
    render();
    const title = row("Harbour").querySelector(".font-medium")!;
    click(title, 1);
    click(title, 2);
    act(() => void title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })));
    log("double-click", calls());
    expect(onPlay.mock.calls).toEqual([[0]]);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("a click that ends a text selection in the row does not play", () => {
    render();
    const title = row("Gale").querySelector(".font-medium")!;
    const range = document.createRange();
    range.selectNodeContents(title);
    // A selection only takes a range when it holds none (an earlier test may have left one).
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    click(title);
    log("selection click", { selected: document.getSelection()!.toString(), ...calls() });
    expect(onPlay).not.toHaveBeenCalled();
    document.getSelection()!.removeAllRanges();
  });

  it("a song not on hand offline (PAR-OFFL-04) does nothing on click or key, and leaves the tab order", () => {
    render({ away: ["t3"] });
    click(row("Gale"));
    key(row("Gale"), "Enter");
    log("away row", { tabIndex: row("Gale").tabIndex, disabled: row("Gale").getAttribute("aria-disabled"), ...calls() });
    expect(onPlay).not.toHaveBeenCalled();
    expect(row("Gale").tabIndex).toBe(-1);
    expect(row("Gale").getAttribute("aria-disabled")).toBe("true");
  });
});

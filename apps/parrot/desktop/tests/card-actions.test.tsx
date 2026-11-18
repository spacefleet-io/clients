// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-CARD-001
 * @level integration (shared album tile, overlay and "..." menu with the desktop translator; player callbacks recorded)
 * @why Hand-try, Chris 2026-11-09: an album card on Home and in the library shows Badger's centred Play on hover or
 *   focus and a "..." menu with Play, Shuffle, Play next, Add to queue, Go to artist and Add to playlist, so music
 *   starts without opening the album page. Every control must be reachable with the keyboard.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ParrotAlbumTile } from "@space/ui/parrot/library";
import { parrotCardControls, type ParrotCardPlayer } from "@space/ui/parrot/card-actions";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-CARD-001]";
const songs = ["s1", "s2", "s3"];
const album = { id: "al1", title: "Meltway", artistName: "Linnet Park", year: 2003, artistId: "ar1" };

let root: Root;
let host: HTMLDivElement;
let calls: string[];

const render = (language: "en" | "fr" = "en", details = false) => {
  const t = translator(language);
  const player: ParrotCardPlayer<string> = {
    play: (list) => calls.push(`play:${list.join(",")}`),
    shuffle: (list) => calls.push(`shuffle:${list.join(",")}`),
    playNext: (list) => calls.push(`playNext:${list.join(",")}`),
    addToQueue: (list) => calls.push(`addToQueue:${list.join(",")}`),
  };
  const controls = parrotCardControls(t, () => songs, player, {
    onGoToArtist: () => calls.push("goToArtist:ar1"),
    onAddToPlaylist: (list) => calls.push(`addToPlaylist:${list.join(",")}`),
    ...(details ? { onEdit: () => calls.push("edit:al1") } : {}),
  });
  act(() =>
    root.render(<ParrotAlbumTile album={album} src={null} unknownArtist="?" onOpen={() => calls.push("open")} controls={controls} testId="home-album" />)
  );
};
const byTestId = (id: string) => document.querySelector<HTMLButtonElement>(`button[data-testid="${id}"]`);
const openMenu = () => {
  const more = byTestId("home-album-more");
  expect(more).toBeTruthy();
  act(() => more?.click());
};

describe(`${SUITE} album card Play and "..." menu`, () => {
  beforeEach(() => {
    calls = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  // @req PAR-CARD-01
  it("centred Play replaces the queue with the album and does not open the album page", () => {
    render();
    const play = byTestId("home-album-play");
    console.info(SUITE, "play button", play?.outerHTML.slice(0, 160));
    expect(play).toBeTruthy();
    expect(play?.getAttribute("aria-label")).toBe("Play");
    act(() => play?.click());
    console.info(SUITE, "calls", calls);
    expect(calls).toEqual([`play:${songs.join(",")}`]);
  });

  // @req PAR-CARD-01
  it("the cover opens the album: the veil passes clicks, and Play and \"...\" catch them only while the card shows them", () => {
    render();
    const controls = document.querySelector<HTMLElement>("[data-card-controls]");
    console.info(SUITE, "controls classes (menu closed)", controls?.className);
    expect(controls).toBeTruthy();
    const closed = controls?.className.split(" ") ?? [];
    // The whole layer over the cover ignores the pointer, so a click on the cover reaches the open button under it.
    expect(closed).toContain("pointer-events-none");
    // Its buttons catch the pointer only on hover or keyboard focus, never while they are invisible (a tap or a quick click).
    expect(closed).toContain("group-hover:[&_button]:pointer-events-auto");
    expect(closed).toContain("group-focus-within:[&_button]:pointer-events-auto");
    expect(closed).not.toContain("[&_button]:pointer-events-auto");
    // The open button is the card under the layer: clicking it opens the album and plays nothing.
    act(() => byTestId("home-album")?.click());
    console.info(SUITE, "calls after cover click", calls);
    expect(calls).toEqual(["open"]);
    // With the menu open the pointer may have left the card: Play and "..." stay clickable.
    openMenu();
    const open = document.querySelector<HTMLElement>("[data-card-controls]");
    console.info(SUITE, "controls classes (menu open)", open?.className, "menu-open", open?.dataset.menuOpen);
    expect(open?.dataset.menuOpen).toBe("true");
    expect(open?.className.split(" ")).toContain("[&_button]:pointer-events-auto");
  });

  // @req PAR-CARD-01
  it('"..." lists Play, Shuffle, Play next, Add to queue, Go to artist, Add to playlist in that order', () => {
    render();
    openMenu();
    const items = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].map((item) => item.textContent?.trim());
    console.info(SUITE, "menu items", items);
    expect(items).toEqual(["Play", "Shuffle", "Play next", "Add to queue", "Go to artist", "Add to playlist"]);
  });

  // @req PAR-CARD-01
  it("each menu item calls its player action with the album's songs", () => {
    for (const [id, expected] of [
      ["home-album-more-shuffle", `shuffle:${songs.join(",")}`],
      ["home-album-more-play-next", `playNext:${songs.join(",")}`],
      ["home-album-more-add-to-queue", `addToQueue:${songs.join(",")}`],
      ["home-album-more-go-to-artist", "goToArtist:ar1"],
      ["home-album-more-add-to-playlist", `addToPlaylist:${songs.join(",")}`],
    ] as const) {
      calls = [];
      render();
      openMenu();
      const item = byTestId(id);
      console.info(SUITE, "select", id, Boolean(item));
      expect(item).toBeTruthy();
      act(() => item?.click());
      console.info(SUITE, "calls", calls);
      expect(calls).toEqual([expected]);
    }
  });

  // @req PAR-CARD-01, PAR-META-18, PAR-LYR-05
  // The lookups live in the edit panel (PAR-META-20): the "..." has no separate fetch entries.
  it('on the desktop "..." ends with Edit details, which opens the panel', () => {
    render("en", true);
    openMenu();
    const items = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].map((item) => item.textContent?.trim());
    console.info(SUITE, "menu items with details", items);
    expect(items).toEqual(["Play", "Shuffle", "Play next", "Add to queue", "Go to artist", "Add to playlist", "Edit details"]);
    expect(byTestId("home-album-more-fetch-metadata")).toBeNull();
    expect(byTestId("home-album-more-fetch-lyrics")).toBeNull();
    openMenu(); // closes it again before each item is picked from a fresh open
    for (const [id, expected] of [["home-album-more-edit", "edit:al1"]] as const) {
      calls = [];
      render("en", true);
      openMenu();
      const item = byTestId(id);
      console.info(SUITE, "select", id, Boolean(item));
      expect(item).toBeTruthy();
      act(() => item?.click());
      expect(calls).toEqual([expected]);
    }
  });

  // @req PAR-CARD-01
  it("the controls are buttons reached with Tab, and the menu moves with the arrow keys", () => {
    render();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    console.info(SUITE, "tab order", buttons.map((button) => button.getAttribute("aria-label") ?? button.dataset.testid));
    expect(buttons.every((button) => button.tabIndex >= 0)).toBe(true);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(expect.arrayContaining(["Play", "More options"]));
    openMenu();
    const items = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    console.info(SUITE, "focused after open", document.activeElement?.textContent);
    expect(document.activeElement).toBe(items[0]);
    act(() => {
      items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    console.info(SUITE, "focused after ArrowDown", document.activeElement?.textContent);
    expect(document.activeElement).toBe(items[1]);
  });

  // @req PAR-CARD-01
  it("the labels are translated", () => {
    render("fr");
    openMenu();
    const items = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].map((item) => item.textContent?.trim());
    console.info(SUITE, "fr menu items", items);
    expect(items).not.toContain("Play next");
    expect(items).toHaveLength(6);
  });
});

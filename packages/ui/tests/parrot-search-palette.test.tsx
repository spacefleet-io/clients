// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParrotSearchPalette } from "../src/parrot/search-palette";

const log = (msg: string) => console.info(`[parrot-search-palette.test] ${msg}`);
Element.prototype.scrollIntoView = () => undefined;

const artists = [
  { id: "ar-lp", name: "Linnet Park" },
  { id: "ar-cp", name: "Cloudline" },
];
const albums = [
  { id: "al-ht", title: "Hollow Signal", artistName: "Linnet Park" },
  { id: "al-pa", title: "Parasails", artistName: "Cloudline" },
];
const songs = () => [
  { id: "s-saffron", title: "Saffron", artistName: "Cloudline", albumId: "al-pa", albumTitle: "Parasails" },
  { id: "s-crawl", title: "Cresting", artistName: "Linnet Park", albumId: "al-ht", albumTitle: "Hollow Signal" },
];
const rows = () => screen.queryAllByTestId("search-palette-result").map((r) => r.textContent ?? "");

/**
 * @level component
 * @why Chris (2026-11-09 hand-try) asked for Parrot to get the same Alfred-style palette as Badger: Enter on an artist
 *   opens the artist, on an album the album, and a song opens its album (Parrot has no page for one song).
 */
describe("ParrotSearchPalette (UX-SEARCH-01)", () => {
  afterEach(cleanup);

  // @req UX-SEARCH-01[parrot,parrot-web-player]
  it("finds Linnet Park from 'linnt park' and Enter opens the artist", () => {
    const onOpenArtist = vi.fn();
    const onOpenAlbum = vi.fn();
    render(<ParrotSearchPalette open onOpenChange={() => undefined} artists={artists} albums={albums} songs={songs} language="en" onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum} />);
    fireEvent.change(screen.getByTestId("search-palette-input"), { target: { value: "linnt park" } });
    log(`rows: ${JSON.stringify(rows())}`);
    expect(rows()[0]).toContain("Linnet Park");
    fireEvent.keyDown(screen.getByTestId("search-palette-input"), { key: "Enter" });
    log(`artist calls ${JSON.stringify(onOpenArtist.mock.calls)}`);
    expect(onOpenArtist).toHaveBeenCalledWith("ar-lp");
    expect(onOpenAlbum).not.toHaveBeenCalled();
  });

  // @req UX-SEARCH-01[parrot,parrot-web-player]
  it("a song opens its album, in the app's language", () => {
    const onOpenAlbum = vi.fn();
    render(<ParrotSearchPalette open onOpenChange={() => undefined} artists={artists} albums={albums} songs={songs} language="fr" onOpenArtist={vi.fn()} onOpenAlbum={onOpenAlbum} />);
    fireEvent.change(screen.getByTestId("search-palette-input"), { target: { value: "safron" } });
    log(`rows: ${JSON.stringify(rows())}`);
    expect(rows()[0]).toContain("Saffron");
    fireEvent.keyDown(screen.getByTestId("search-palette-input"), { key: "Enter" });
    log(`album calls ${JSON.stringify(onOpenAlbum.mock.calls)}`);
    expect(onOpenAlbum).toHaveBeenCalledWith("al-pa");
  });
});

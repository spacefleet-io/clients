// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPalette, useSearchPaletteShortcut, type SearchPaletteItem } from "../src/search-palette";

const log = (msg: string) => console.info(`[search-palette.test] ${msg}`);

// jsdom has no layout, so no scrollIntoView; the palette scrolls the highlighted row into view.
Element.prototype.scrollIntoView = () => undefined;
const items: SearchPaletteItem[] = [
  { key: "artist:1", kind: "artist", title: "Linnet Park" },
  { key: "album:1", kind: "album", title: "Hollow Signal", subtitle: "Linnet Park", keywords: ["Linnet Park"] },
  { key: "artist:2", kind: "artist", title: "Cloudline" },
  { key: "title:1", kind: "title", title: "Harry Potter and the Philosopher's Stone", keywords: ["Daniel Radcliffe"] },
];
const labels = {
  title: "Search",
  placeholder: "Search your library",
  empty: "Nothing found",
  hint: "Type a name",
  matchedVia: "With",
  kinds: { artist: "Artist", album: "Album", title: "Title" },
};

const rows = () => screen.queryAllByTestId("search-palette-result").map((r) => r.textContent ?? "");

/**
 * @level component
 * @why Chris (2026-11-09 hand-try): the header search button "just opens the library with the search selected. I'd
 *   have expected a modal to have opened with live search as the user types, like alfred". The palette must list
 *   matches on each keystroke, typo-tolerant, move with the arrow keys and open the highlighted one with Enter.
 */
describe("SearchPalette (UX-SEARCH-01)", () => {
  afterEach(cleanup);

  // @req UX-SEARCH-01[badger-desktop,badger-web-player,parrot,parrot-web-player]
  it("lists matches live as the user types 'linnt park', and Enter opens the highlighted one", () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(<SearchPalette open onOpenChange={onOpenChange} items={items} labels={labels} onSelect={onSelect} />);
    const input = screen.getByTestId("search-palette-input");
    expect(screen.getByTestId("search-palette-status").textContent).toBe("Type a name");
    fireEvent.change(input, { target: { value: "linnt" } });
    log(`after "linnt": ${JSON.stringify(rows())}`);
    expect(rows()[0]).toContain("Linnet Park");
    fireEvent.change(input, { target: { value: "linnt park" } });
    log(`after "linnt park": ${JSON.stringify(rows())}`);
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain("Artist");
    expect(rows()[1]).toContain("Hollow Signal");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    log(`selected: ${JSON.stringify(onSelect.mock.calls)}`);
    expect(onSelect).toHaveBeenCalledWith(items[1]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // @req UX-SEARCH-01[badger-desktop,badger-web-player,parrot,parrot-web-player]
  it("draws the highlighted row's subtitle and kind in the accent's own text colour, so they stay readable", () => {
    render(<SearchPalette open onOpenChange={() => undefined} items={items} labels={labels} onSelect={() => undefined} />);
    const input = screen.getByTestId("search-palette-input");
    fireEvent.change(input, { target: { value: "hollow" } });
    const sub = screen.getByTestId("search-palette-subtitle");
    const kind = screen.getByTestId("search-palette-kind");
    log(`active subtitle class: ${sub.className} | kind class: ${kind.className}`);
    expect(sub.className).toContain("text-accent-foreground");
    expect(sub.className).not.toContain("text-muted-foreground");
    expect(kind.className).toContain("text-accent-foreground");
    expect(kind.className).not.toContain("text-muted-foreground");
  });

  // @req UX-SEARCH-01[badger-desktop,badger-web-player,parrot,parrot-web-player]
  it("names the person a title matched through, says when nothing matches, and closes on Esc", () => {
    const onOpenChange = vi.fn();
    render(<SearchPalette open onOpenChange={onOpenChange} items={items} labels={labels} onSelect={() => undefined} />);
    const input = screen.getByTestId("search-palette-input");
    fireEvent.change(input, { target: { value: "daniel radclife" } });
    log(`rows: ${JSON.stringify(rows())}`);
    expect(rows()[0]).toContain("With Daniel Radcliffe");
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(screen.getByTestId("search-palette-status").textContent).toBe("Nothing found");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // @req UX-SEARCH-01[badger-desktop,badger-web-player,parrot,parrot-web-player]
  it("opens on Ctrl+K and Cmd+K, not on a plain K", () => {
    const onOpen = vi.fn();
    renderHook(() => useSearchPaletteShortcut(onOpen));
    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(window, { key: "K", metaKey: true });
    log(`opened ${onOpen.mock.calls.length} times`);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

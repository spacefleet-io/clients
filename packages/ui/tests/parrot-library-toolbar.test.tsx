// @vitest-environment jsdom
/**
 * @test-id UI-PARROT-LIBRARY-TOOLBAR-001
 * @level component
 * @why Chris (2026-11-20) wants Parrot's and Badger's library rows to be the same design: one pinned row with the
 *   Albums / Artists / Songs switch, a divider and the quiet counts on the left; on the right a Filter button (count
 *   badge, Clear link) opening the tab's filters in a panel with Reset / Apply, then Sort opening the tab's sorts. No
 *   title, no search box, no view button (Parrot has one view per tab). Each tab keeps its own picks in this
 *   computer's or browser's storage.
 * @covers packages/ui/src/parrot/library-toolbar.tsx
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PARROT_LIBRARY_PREFS_STORAGE_KEY, parseHistory, type ParrotLibraryTab, type ParrotLibraryTabPrefs } from "@space/parrot-core";
import { SHELL_EN, type ParrotShellKey } from "@space/parrot-core/shell-strings";
import { ParrotLibraryToolbar, parrotLibraryToolbarLabels, useParrotLibraryShown } from "../src/parrot/library-toolbar";

const log = (msg: string, payload?: unknown) => console.info(`[parrot-library-toolbar.test] ${msg}`, payload === undefined ? "" : JSON.stringify(payload));

const albums = [
  { id: "al-a", title: "Anchor", artistName: "Juniper Skies", artistId: "ar-j", year: 1998, addedAt: 1, genre: "Rock" },
  { id: "al-b", title: "Bloom", artistName: "Juniper Skies", artistId: "ar-j", year: 2004, addedAt: 2, genre: "Pop" },
];
const songs = [
  { id: "s-1", albumId: "al-a", title: "Harbour", artistName: "Juniper Skies", artistId: "ar-j", albumTitle: "Anchor", durationMs: 1, year: 1998, genre: "Rock", lossless: true, hasLyrics: true },
  { id: "s-2", albumId: "al-b", title: "Gale", artistName: "Juniper Skies", artistId: "ar-j", albumTitle: "Bloom", durationMs: 2, year: 2004, genre: "Pop", lossless: false, hasLyrics: false },
];
const artists = [{ id: "ar-j", name: "Juniper Skies", albumCount: 2, trackCount: 2 }];
const history = parseHistory(null);
const liked = new Set(["s-2"]);
const t = (key: ParrotShellKey, vars?: Record<string, string | number>) => SHELL_EN[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));

/** The row and its list as an app draws them: the open tab's list under the row. */
function Page({ start = "albums" }: { start?: ParrotLibraryTab }) {
  const [tab, setTab] = useState<ParrotLibraryTab>(start);
  const shown = useParrotLibraryShown({ tab, albums, artists, songs, history, likedSongIds: liked });
  const list = tab === "albums" ? shown.shownAlbums.map((a) => a.title) : tab === "artists" ? shown.shownArtists.map((a) => a.name) : shown.shownSongs.map((s) => s.title);
  return (
    <>
      <ParrotLibraryToolbar
        tab={tab}
        onTab={setTab}
        counts={[{ n: shown.shownCount, text: `${shown.shownCount} shown` }]}
        prefs={shown.prefs}
        onPrefs={shown.setPrefs}
        genres={shown.genres}
        decades={shown.decades}
        labels={parrotLibraryToolbarLabels(t)}
        pinTop={64}
      />
      <ul data-testid="list">
        {list.map((title) => (
          <li key={title}>{title}</li>
        ))}
      </ul>
    </>
  );
}

const listed = () => [...screen.getByTestId("list").querySelectorAll("li")].map((li) => li.textContent);
const press = (testId: string) => act(() => fireEvent.click(screen.getByTestId(testId)));
/** Presses the pill named `name` in a panel section. */
const pick = (section: string, name: string) => act(() => fireEvent.click(within(screen.getByTestId(section)).getByRole("button", { name })));
const pills = (container: HTMLElement) => within(container).getAllByRole("button").filter((el) => el.hasAttribute("aria-pressed"));
/** The Sort panel's choices, the picked one marked with a star; the panel closes again with Done. */
const sortPanel = () => {
  press("library-sort-button");
  const shown = pills(screen.getByTestId("library-sort-modal")).map((el) => `${el.getAttribute("aria-pressed") === "true" ? "*" : ""}${el.textContent}`);
  press("library-sort-done");
  return shown;
};

describe("ParrotLibraryToolbar (PAR-LIB-06)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  // @req PAR-LIB-06[parrot,parrot-web-player]
  it("draws Badger's row: switch, divider, counts, then Filter and Sort; no view button; sticky under the top bar", () => {
    render(<Page />);
    const row = screen.getByTestId("library-row");
    const order = [...row.children].map((el) => el.getAttribute("data-testid"));
    log("row order", order);
    expect(order).toEqual(["library-tabs", "library-row-divider", "library-counts", "library-row-actions"]);
    expect([...screen.getByTestId("library-row-actions").children].map((el) => el.getAttribute("data-testid"))).toEqual(["library-filter-button", "library-sort-button"]);
    expect(screen.queryByTestId("library-view-cycle")).toBeNull();
    expect(within(screen.getByTestId("library-tabs")).getAllByRole("tab").map((el) => `${el.textContent}:${el.getAttribute("aria-selected")}`)).toEqual([
      "Albums:true",
      "Artists:false",
      "Songs:false",
    ]);
    expect(screen.queryByRole("searchbox")).toBeNull();
    const pinned = screen.getByTestId("library-toolbar");
    log("pinned row", { className: pinned.className, top: pinned.style.top, pinned: pinned.dataset.pinned });
    expect(pinned.className).toContain("sticky");
    expect(pinned.style.top).toBe("64px");
    expect(pinned.dataset.pinned).toBe("false");
    expect(screen.getByTestId("library-filter-button").textContent).toBe("Filter");
    expect(screen.getByTestId("library-sort-button").textContent).toBe("Sort");
  });

  // @req PAR-LIB-06[parrot,parrot-web-player]
  it("the Sort panel lists the tab's sorts, says which way each runs and marks the current one", () => {
    render(<Page />);
    log("albums sorts", sortPanel());
    expect(sortPanel()).toEqual(["*Recently added", "Recently played", "Title (A–Z)", "Artist (A–Z)", "Release year (newest first)"]);
    press("library-sort-button");
    press("library-sort-year");
    press("library-sort-done");
    expect(sortPanel()[4]).toBe("*Release year (newest first)");
    press("library-chip-artists");
    expect(sortPanel()).toEqual(["*Name (A–Z)", "Most played", "Most albums", "Most songs"]);
    press("library-chip-songs");
    log("songs sorts", sortPanel());
    expect(sortPanel()).toEqual(["*Title (A–Z)", "Artist (A–Z)", "Album (A–Z)", "Release year (newest first)", "Longest first"]);
  });

  // @req PAR-LIB-06[parrot,parrot-web-player]
  it("the Filter panel edits a draft: Apply keeps it, the button counts it, Clear turns every filter off", () => {
    render(<Page />);
    expect(listed()).toEqual(["Bloom", "Anchor"]);
    press("library-filter-button");
    const modal = screen.getByTestId("library-filter-modal");
    expect([...modal.querySelectorAll("section")].map((el) => el.getAttribute("data-testid"))).toEqual(["library-filter-genre", "library-filter-decade", "library-filter-flags"]);
    pick("library-filter-genre", "Rock");
    press("library-filter-lossless");
    // Nothing changes until Apply.
    expect(listed()).toEqual(["Bloom", "Anchor"]);
    press("library-filter-apply");
    log("after Rock + Lossless", listed());
    expect(listed()).toEqual(["Anchor"]);
    expect(screen.getByTestId("library-filter-button").textContent).toBe("Filter · 2");
    // Reset empties the draft; closing without Apply keeps what was applied.
    press("library-filter-button");
    press("library-filter-reset");
    expect(pills(screen.getByTestId("library-filter-modal")).filter((el) => el.getAttribute("aria-pressed") === "true")).toHaveLength(0);
    act(() => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    expect(listed()).toEqual(["Anchor"]);
    press("library-filter-clear");
    log("after clear", listed());
    expect(listed()).toEqual(["Bloom", "Anchor"]);
    expect(screen.queryByTestId("library-filter-clear")).toBeNull();
    expect(screen.getByTestId("library-filter-button").textContent).toBe("Filter");
  });

  // @req PAR-LIB-06[parrot,parrot-web-player]
  it("Songs' panel offers Genre, Decade, then Liked / With lyrics / Lossless under Show only", () => {
    render(<Page start="songs" />);
    press("library-filter-button");
    const flags = pills(screen.getByTestId("library-filter-flags")).map((el) => el.textContent);
    log("songs flags", flags);
    expect(flags).toEqual(["Liked", "With lyrics", "Lossless"]);
    expect(pills(screen.getByTestId("library-filter-decade")).map((el) => el.textContent).sort()).toEqual(["1990s", "2000s"]);
    press("library-filter-lyrics");
    press("library-filter-apply");
    log("with lyrics", listed());
    expect(listed()).toEqual(["Harbour"]);
    press("library-filter-button");
    press("library-filter-liked");
    press("library-filter-apply");
    expect(listed()).toEqual([]);
    expect(screen.getByTestId("library-filter-button").textContent).toBe("Filter · 2");
  });

  // @req PAR-LIB-06[parrot,parrot-web-player]
  it("each tab keeps its own sort and filters in storage, and they come back after a restart", () => {
    const first = render(<Page />);
    press("library-sort-button");
    press("library-sort-title");
    press("library-sort-done");
    press("library-chip-songs");
    expect(sortPanel()[0]).toBe("*Title (A–Z)");
    press("library-sort-button");
    press("library-sort-duration");
    press("library-sort-done");
    press("library-filter-button");
    press("library-filter-liked");
    press("library-filter-apply");
    const stored = JSON.parse(localStorage.getItem(PARROT_LIBRARY_PREFS_STORAGE_KEY) ?? "{}");
    log("stored", stored);
    expect(stored.albums).toEqual({ sort: "title", filters: {} });
    expect(stored.songs).toEqual({ sort: "duration", filters: { liked: true } });
    first.unmount();

    render(<Page />);
    expect(sortPanel()[2]).toBe("*Title (A–Z)");
    expect(listed()).toEqual(["Anchor", "Bloom"]);
    press("library-chip-songs");
    expect(sortPanel()[4]).toBe("*Longest first");
    expect(listed()).toEqual(["Gale"]);
  });

  // @req PAR-LIB-06[parrot,parrot-web-player]
  it("opens Albums in the order picked before the row existed (parrot.albumSort) until the user picks anew", () => {
    localStorage.setItem("parrot.albumSort", "title");
    const first = render(<Page />);
    log("legacy sort", { panel: sortPanel(), list: listed() });
    expect(sortPanel()[2]).toBe("*Title (A–Z)");
    expect(listed()).toEqual(["Anchor", "Bloom"]);
    press("library-sort-button");
    press("library-sort-recent");
    press("library-sort-done");
    first.unmount();

    render(<Page />);
    expect(sortPanel()[0]).toBe("*Recently added");
    expect(JSON.parse(localStorage.getItem(PARROT_LIBRARY_PREFS_STORAGE_KEY) ?? "{}").albums.sort).toBe("recent");
  });

  // @req PAR-LIB-06[parrot,parrot-web-player]
  it("an active genre stays in the panel, picked, even when the library no longer offers it, so it can be cleared", () => {
    let picked: ParrotLibraryTabPrefs | null = null;
    render(
      <ParrotLibraryToolbar
        tab="albums"
        onTab={() => undefined}
        counts={[]}
        prefs={{ sort: "recent", filters: { genre: "Jazz" } }}
        onPrefs={(next) => {
          picked = next;
        }}
        genres={[]}
        decades={[]}
        labels={parrotLibraryToolbarLabels(t)}
      />
    );
    expect(screen.queryByTestId("library-row-divider")).toBeNull();
    expect(screen.getByTestId("library-filter-button").textContent).toBe("Filter · 1");
    press("library-filter-button");
    const genre = pills(screen.getByTestId("library-filter-genre"));
    log("stale genre", genre.map((el) => `${el.textContent}:${el.getAttribute("aria-pressed")}`));
    expect(genre.map((el) => `${el.textContent}:${el.getAttribute("aria-pressed")}`)).toEqual(["Jazz:true"]);
    expect(screen.queryByTestId("library-filter-decade")).toBeNull();
    pick("library-filter-genre", "Jazz");
    press("library-filter-apply");
    expect(picked).toEqual({ sort: "recent", filters: {} });
  });

  // @req PAR-LIB-06[parrot,parrot-web-player]
  it("greys out Filter where the panel would be empty (Artists in a library without genre tags), until a pick is on", () => {
    const draw = (filters: ParrotLibraryTabPrefs["filters"]) =>
      render(
        <ParrotLibraryToolbar
          tab="artists"
          onTab={() => undefined}
          counts={[]}
          prefs={{ sort: "name", filters } as ParrotLibraryTabPrefs}
          onPrefs={() => undefined}
          genres={[]}
          decades={[]}
          labels={parrotLibraryToolbarLabels(t)}
        />
      );
    draw({});
    expect((screen.getByTestId("library-filter-button") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    draw({ genre: "Jazz" });
    const button = screen.getByTestId("library-filter-button") as HTMLButtonElement;
    log("artists with a stale genre", { disabled: button.disabled, text: button.textContent });
    expect(button.disabled).toBe(false);
  });
});

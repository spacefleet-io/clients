// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-EXTRAS-001
 * @level integration (real Library screen, shared sort button / "…" menu / "Also by" row, real translator; `window.parrot` mocked)
 * @why The approved demo (PAR-LOOK-01) shows three library pieces the desktop lacked: the Sort button at the end of the
 *   library's row, whose panel starts on "Recently added" (PAR-LIB-06), the album page's "…" after Play and Shuffle, and the "Also by <artist>" row of the
 *   artist's other albums under the songs. The "…" holds the album's actions (Play next, Add to queue, Go to artist,
 *   Add to playlist, Edit details (whose panel holds the lookups), Save offline, Delete), each wired to the
 *   app's existing handler.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import type { ParrotLibrary, ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-EXTRAS-001]";
const state: ParrotState = {
  setup: { step: "errorReports", done: true, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: true,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "http://localhost:11000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
};
const track = (id: string, title: string, albumId: string, albumTitle: string, artistId: string, artistName: string) => ({
  id,
  title,
  albumId,
  albumTitle,
  artistId,
  artistName,
  disc: 1,
  number: 1,
  durationMs: 180_000,
  fileId: `file-${id}`,
  mime: "audio/flac",
  sizeBytes: 1000,
});
const album = (id: string, title: string, artistId: string, artistName: string, year: number, addedAt: number) => ({
  id,
  title,
  artistId,
  artistName,
  year,
  trackCount: 1,
  addedAt,
  coverUrl: null,
  coverThumbUrl: null,
});
// Added in the order Anchor, Zephyr, Meadow, Solo: "Recently added" shows Solo first, then Meadow, Zephyr, Anchor.
const library: ParrotLibrary = {
  snapshotVersion: 1,
  artists: [
    { id: "art-1", name: "Juniper Skies", albumCount: 3, trackCount: 3 },
    { id: "art-2", name: "Lone Star", albumCount: 1, trackCount: 1 },
  ],
  albums: [
    album("alb-a", "Anchor", "art-1", "Juniper Skies", 2018, 1_000),
    album("alb-z", "Zephyr", "art-1", "Juniper Skies", 2021, 2_000),
    album("alb-m", "Meadow", "art-1", "Juniper Skies", 2019, 3_000),
    album("alb-s", "Solo", "art-2", "Lone Star", 2024, 4_000),
  ],
  tracks: [
    track("t-a", "Harbour", "alb-a", "Anchor", "art-1", "Juniper Skies"),
    track("t-z", "Signal Fires", "alb-z", "Zephyr", "art-1", "Juniper Skies"),
    track("t-m", "Paper Moon", "alb-m", "Meadow", "art-1", "Juniper Skies"),
    track("t-s", "Alone", "alb-s", "Solo", "art-2", "Lone Star"),
  ],
  playlists: [{ id: "liked-songs", name: "", createdAt: 1, updatedAt: 1, trackIds: [], trackCount: 0 }],
};

describe("Parrot desktop: the demo's sort button, album menu and Also by row", () => {
  let container: HTMLDivElement;
  let root: Root;
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const q = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const click = async (element: HTMLElement | undefined) => {
    expect(element).toBeTruthy();
    await act(async () => element!.click());
    await flush();
  };
  const titles = (id = "library-album") => q(id).map((tile) => tile.querySelector("p")?.textContent ?? "");
  const openAlbum = async (title: string) => {
    await click(q("library-tab")[0]);
    await click(q("library-album").find((tile) => tile.textContent?.includes(title)));
  };
  const menuItems = () => q("album-menu-list")[0]?.querySelectorAll("[role=menuitem]") ?? [];

  const mount = async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Library t={translator("en")} state={state} onState={() => undefined} />));
    await flush();
  };

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...exportBridgeStub(),
        getLibrary: vi.fn(async () => ({ ok: true, library })),
        getImportStatus: vi.fn(async () => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0 })),
        getImportScan: vi.fn(async () => null),
        getLyrics: vi.fn(async () => null),
        // A playing song without lyrics asks main for them, once (PAR-LYR-05).
        wantLyrics: vi.fn(async () => undefined),
        fetchLyrics: vi.fn(async () => ({ ok: true as const, outcome: "none" as const, lyrics: null })),
        onLyricsChanged: vi.fn(() => () => undefined),
        onLibraryChanged: vi.fn(() => () => undefined),
        onLibraryPatch: vi.fn(() => () => undefined),
        onImportStatus: vi.fn(() => () => undefined),
        getCoversWaiting: vi.fn(async () => []),
        onCoversWaiting: vi.fn(() => () => undefined),
        getImportJobs: vi.fn(async () => []),
        onImportJobs: vi.fn(() => () => undefined),
        dismissImportJob: vi.fn(async () => []),
        getBackgroundWork: vi.fn(async () => []),
        onBackgroundWork: vi.fn(() => () => undefined),
        getKept: vi.fn(async () => ({ entries: [], songs: [], downloading: false })),
        onKept: vi.fn(() => () => undefined),
        keepChoices: vi.fn(async () => []),
        keep: vi.fn(async (kind: string, id: string) => ({ entries: [{ kind, id, choice: null, keptAt: 1, bytes: 1, done: 0, total: 1 }], songs: [], downloading: true })),
        previewDelete: vi.fn(async () => ({ ok: true, trackCount: 1 })),
        playbackUrl: vi.fn(async () => "blob:none"),
        editPlaylists: vi.fn(async () => ({ ok: true, library })),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  // @req PAR-LOOK-01[parrot]
  // @req PAR-LIB-06[parrot]
  it("sorts the album grid by Recently added from the Sort panel at the row's end, keeps another pick for next time, and Songs keeps its own", async () => {
    await mount();
    await click(q("library-tab")[0]);
    const button = q("library-sort-button")[0];
    /** The Sort panel's choices, and the one marked picked. */
    const panel = () => {
      const pills = [...(q("library-sort-modal")[0]?.querySelectorAll<HTMLElement>("[aria-pressed]") ?? [])];
      return { items: pills.map((pill) => pill.textContent), picked: pills.find((pill) => pill.getAttribute("aria-pressed") === "true")?.textContent };
    };
    console.log(SUITE, "sort button", button?.textContent, "grid", titles());
    expect(button?.textContent).toBe("Sort");
    // At the end of the row, after the counts, as in the draft.
    expect(button?.closest('[data-testid="library-row-actions"]')?.lastElementChild?.contains(button)).toBe(true);
    expect(q("library-search")).toHaveLength(0);
    expect(titles()).toEqual(["Solo", "Meadow", "Zephyr", "Anchor"]);

    await click(button);
    console.log(SUITE, "sort panel", panel());
    expect(panel()).toEqual({ items: ["Recently added", "Recently played", "Title (A–Z)", "Artist (A–Z)", "Release year (newest first)"], picked: "Recently added" });
    await click(q("library-sort-title")[0]);
    console.log(SUITE, "by title", titles(), "stored", localStorage.getItem("parrot.libraryPrefs"));
    expect(titles()).toEqual(["Anchor", "Meadow", "Solo", "Zephyr"]);
    expect(panel().picked).toBe("Title (A–Z)");
    expect(JSON.parse(localStorage.getItem("parrot.libraryPrefs") ?? "{}").albums.sort).toBe("title");
    await click(q("library-sort-done")[0]);
    expect(q("library-sort-modal")).toHaveLength(0);

    // Songs have their own orders, and picking one leaves the albums' as it was.
    await click(q("library-chip-songs")[0]);
    await click(q("library-sort-button")[0]);
    console.log(SUITE, "song sort panel", panel());
    expect(panel()).toEqual({ items: ["Title (A–Z)", "Artist (A–Z)", "Album (A–Z)", "Release year (newest first)", "Longest first"], picked: "Title (A–Z)" });
    await click(q("library-sort-duration")[0]);
    expect(panel().picked).toBe("Longest first");
    await click(q("library-sort-done")[0]);

    act(() => root.unmount());
    container.remove();
    await mount();
    await click(q("library-tab")[0]);
    await click(q("library-sort-button")[0]);
    console.log(SUITE, "after restart", panel(), titles());
    expect(panel().picked).toBe("Title (A–Z)");
    expect(titles()).toEqual(["Anchor", "Meadow", "Solo", "Zephyr"]);
  });

  // @req PAR-LOOK-01[parrot]
  // @req PAR-LOOK-05[parrot]
  it("the album page shows Play, Shuffle, the heart and the …, whose actions queue, open the artist, add to a playlist, keep, edit and delete", async () => {
    await mount();
    await openAlbum("Zephyr");
    expect(q("album-title")[0]?.textContent).toBe("Zephyr");
    // The demo's row: Play, Shuffle, the heart, then "…"; keep, edit and delete moved into the menu.
    expect(q("library-play-all")).toHaveLength(1);
    expect(q("album-shuffle")).toHaveLength(1);
    expect(q("album-like")[0]?.getAttribute("data-liked")).toBe("false");
    expect(q("library-delete")).toHaveLength(0);
    expect(q("library-edit")).toHaveLength(0);
    expect(q("keep-toggle")).toHaveLength(0);
    expect(q("album-menu")[0]?.getAttribute("aria-label")).toBe("More options");

    await click(q("album-menu")[0]);
    const labels = [...menuItems()].map((item) => item.textContent);
    console.log(SUITE, "album menu", labels);
    // The album card's list (PAR-CARD-01) without Play and Shuffle, its Edit details (PAR-META-18; the lookups live
    // in the panel, PAR-META-20), then the page's own Save offline (its one offline action, OFFL-FILE-01) and Delete
    // (PAR-LOOK-05); no "Download file" (Chris 2026-11-21: export is Settings' Download everything only).
    expect(labels).toEqual([
      "Play next",
      "Add to queue",
      "Go to artist",
      "Add to playlist",
      "Edit details",
      "Save offline",
      "Delete",
    ]);

    // Play next into an empty queue starts the album.
    await click(q("album-menu-play-next")[0]);
    console.log(SUITE, "now playing", q("player-title")[0]?.textContent);
    expect(q("player-title")[0]?.textContent).toContain("Signal Fires");

    await click(q("album-menu")[0]);
    await click(q("album-menu-add-to-playlist")[0]);
    console.log(SUITE, "add-to-playlist dialog", q("add-to-playlist-dialog")[0]?.textContent);
    expect(q("add-to-playlist-dialog")).toHaveLength(1);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();

    await click(q("album-menu")[0]);
    await click(q("album-menu-keep")[0]);
    expect(window.parrot.keep).toHaveBeenCalledWith("album", "alb-z", null);
    console.log(SUITE, "kept line", q("kept-line")[0]?.textContent);
    expect(q("kept-line")[0]?.textContent).toBe("Downloading 0 of 1");

    await click(q("album-menu")[0]);
    await click(q("album-menu-delete")[0]);
    expect(window.parrot.previewDelete).toHaveBeenCalledWith({ kind: "album", id: "alb-z" });
    console.log(SUITE, "delete confirm", document.body.textContent?.includes("Delete Zephyr?"));
    expect(document.body.textContent).toContain("Delete Zephyr?");
  });

  // @req PAR-LOOK-05[parrot]
  it("Go to artist opens the album's artist", async () => {
    await mount();
    await openAlbum("Zephyr");
    await click(q("album-menu")[0]);
    await click(q("album-menu-go-to-artist")[0]);
    console.log(SUITE, "artist page", q("artist-title")[0]?.textContent);
    expect(q("artist-title")[0]?.textContent).toBe("Juniper Skies");
  });

  // @req PAR-LOOK-01[parrot]
  it("Also by lists the artist's other albums under the songs, opens one, and is absent when there are none", async () => {
    await mount();
    await openAlbum("Zephyr");
    const row = q("album-also-by")[0];
    console.log(SUITE, "also by", row?.querySelector("h2")?.textContent, titles("library-album"));
    expect(row?.querySelector("h2")?.textContent).toBe("Also by Juniper Skies");
    expect(titles("library-album")).toEqual(["Anchor", "Meadow"]);

    await click(q("library-album").find((tile) => tile.textContent?.includes("Meadow")));
    expect(q("album-title")[0]?.textContent).toBe("Meadow");
    expect(titles("library-album")).toEqual(["Anchor", "Zephyr"]);

    await click(q("library-back")[0]);
    await click(q("library-back")[0]);
    await click(q("library-album").find((tile) => tile.textContent?.includes("Solo")));
    console.log(SUITE, "solo artist", q("album-title")[0]?.textContent, q("album-also-by").length);
    expect(q("album-title")[0]?.textContent).toBe("Solo");
    expect(q("album-also-by")).toHaveLength(0);
  });
});

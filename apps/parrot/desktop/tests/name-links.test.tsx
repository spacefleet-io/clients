// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-NAME-LINKS-001
 * @level integration (real Library shell, album and artist pages, player bar, now-playing page and search palette; `window.parrot` mocked)
 * @why Chris, 2026-11-15 (issue #2508): on Meltway's page the artist's name could not be clicked. Songs, albums and
 *   artists link to each other wherever they are named: an artist's or album's name opens that page.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import type { ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-NAME-LINKS-001]";
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
const track = (id: string, title: string, albumId: string, albumTitle: string, number: number) => ({
  id,
  title,
  albumId,
  albumTitle,
  artistId: "art-lp",
  artistName: "Linnet Park",
  disc: 1,
  number,
  durationMs: 180_000,
  fileId: `file-${id}`,
  mime: "audio/flac",
  sizeBytes: 1000,
});
const library = {
  snapshotVersion: 1,
  artists: [{ id: "art-lp", name: "Linnet Park", albumCount: 2, trackCount: 3 }],
  albums: [
    { id: "alb-ht", title: "Hollow Signal", artistId: "art-lp", artistName: "Linnet Park", year: 2000, trackCount: 1, coverUrl: null, coverThumbUrl: null },
    { id: "alb-met", title: "Meltway", artistId: "art-lp", artistName: "Linnet Park", year: 2003, trackCount: 2, coverUrl: null, coverThumbUrl: null },
  ],
  tracks: [
    track("t-end", "At the Gate", "alb-ht", "Hollow Signal", 8),
    track("t-some", "Somewhere I Wander", "alb-met", "Meltway", 3),
    track("t-nook", "Nook", "alb-met", "Meltway", 13),
  ],
};

describe("Parrot desktop: artist and album names open their pages (PAR-NAV-05)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const q = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const press = async (el: HTMLElement | undefined, what: string) => {
    console.info(SUITE, "click", what, JSON.stringify(el?.textContent ?? null));
    expect(el, what).toBeTruthy();
    await act(async () => el!.click());
    await flush();
  };
  const page = () => ({
    album: q("album-title")[0]?.textContent ?? null,
    artist: q("artist-title")[0]?.textContent ?? null,
  });
  const openMeltway = async () => {
    const tile = q("home-album").find((el) => el.textContent?.includes("Meltway"));
    await press(tile, "Meltway tile");
    expect(page().album).toBe("Meltway");
  };
  const playFromMeltway = async (title: string) => {
    await openMeltway();
    const row = q("library-track").find((el) => el.textContent?.includes(title));
    const play = row?.querySelector<HTMLElement>("button") ?? undefined;
    await press(play, `${title} row play`);
    console.info(SUITE, "player", q("player-title")[0]?.textContent);
    expect(q("player-title")[0]?.textContent).toContain(title);
  };

  beforeEach(async () => {
    localStorage.clear();
    Element.prototype.scrollIntoView = () => undefined;
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
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
        playbackUrl: vi.fn(async () => "blob:none"),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Library t={translator("en")} state={state} onState={() => undefined} />));
    await flush();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req PAR-NAV-05
  it("Meltway's page: the artist's name in the header opens Linnet Park's page", async () => {
    await openMeltway();
    const link = q("album-artist-link")[0];
    expect(link?.tagName).toBe("BUTTON");
    await press(link, "album header artist");
    console.info(SUITE, "after header link", page());
    expect(q("library-artist-page")).toHaveLength(1);
    expect(page().artist).toBe("Linnet Park");
  });

  // @req PAR-NAV-05
  it("an album tile's artist line opens the artist; the tile itself still opens the album", async () => {
    const tile = q("home-album").find((el) => el.textContent?.includes("Hollow Signal"));
    const artist = q("home-album-artist").find((el) => el.closest("li") === tile?.closest("li"));
    // The name is not inside the tile's button (no button in a button).
    expect(artist?.closest('[data-testid="home-album"]')).toBeNull();
    await press(artist, "Hollow Signal tile artist");
    expect(page().artist).toBe("Linnet Park");
  });

  // @req PAR-NAV-05
  it("in the Songs list a song's artist and album open their pages, and the row still plays", async () => {
    await press(q("library-tab")[0], "Library tab");
    await press(q("library-chip-songs")[0], "Songs chip");
    const row = q("library-track").find((el) => el.textContent?.includes("At the Gate"));
    const album = row?.querySelector<HTMLElement>('[data-testid="song-album-link"]') ?? undefined;
    await press(album, "song album link");
    expect(page().album).toBe("Hollow Signal");
    // Nothing started: the name opened the album, it did not play the song.
    expect(q("player-title")).toHaveLength(0);
    await press(q("library-tab")[0], "Library tab");
    await press(q("library-chip-songs")[0], "Songs chip");
    const again = q("library-track").find((el) => el.textContent?.includes("At the Gate"));
    await press(again?.querySelector<HTMLElement>('[data-testid="song-artist-link"]') ?? undefined, "song artist link");
    expect(page().artist).toBe("Linnet Park");
  });

  // @req PAR-NAV-05
  it("the player bar's artist and album names open their pages", async () => {
    await playFromMeltway("Nook");
    await press(q("library-tab")[0], "Library tab");
    await press(q("player-album-link")[0], "player album");
    expect(page().album).toBe("Meltway");
    await press(q("player-artist-link")[0], "player artist");
    expect(page().artist).toBe("Linnet Park");
  });

  // @req PAR-NAV-05
  it("now playing: the subtitle, the Up next rows and the About tab link the artist and the album", async () => {
    // Somewhere I Wander (#3) leaves Nook (#13) up next.
    await playFromMeltway("Somewhere I Wander");
    await press(q("player-queue")[0], "player queue");
    expect(q("now-playing")).toHaveLength(1);
    await press(q("now-playing-artist-link")[0], "now playing artist");
    expect(page().artist).toBe("Linnet Park");

    await press(q("player-queue")[0], "player queue");
    await press(q("now-playing-tab-queue")[0], "queue tab");
    const queueArtist = q("now-playing-queue-artist-link")[0];
    await press(queueArtist, "queue row artist");
    expect(page().artist).toBe("Linnet Park");

    await press(q("player-queue")[0], "player queue");
    await press(q("now-playing-tab-about")[0], "about tab");
    const about = q("now-playing-about")[0]!;
    const aboutLinks = [...about.querySelectorAll<HTMLElement>("button")];
    console.info(SUITE, "about links", aboutLinks.map((b) => b.textContent));
    await press(aboutLinks.find((b) => b.textContent === "Meltway"), "about album");
    expect(page().album).toBe("Meltway");
  });

  // @req PAR-NAV-05
  it("search: a song result's artist and album names open their pages; Enter still opens the result", async () => {
    await act(async () => q("parrot-top-nav-search")[0]!.click());
    const input = q("search-palette-input")[0] as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "nook");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const row = q("search-palette-result").find((el) => el.textContent?.includes("Nook"));
    const links = [...(row?.querySelectorAll<HTMLElement>('[data-testid="search-palette-subtitle-link"]') ?? [])];
    console.info(SUITE, "palette links", links.map((l) => l.textContent));
    expect(links.map((l) => l.textContent)).toEqual(["Linnet Park", "Meltway"]);
    await press(links[0], "palette artist");
    expect(q("search-palette")).toHaveLength(0);
    expect(page().artist).toBe("Linnet Park");
  });
});

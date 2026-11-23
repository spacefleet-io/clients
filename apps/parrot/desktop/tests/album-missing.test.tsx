// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-MISSING-001
 * @level integration (real Library screen, real translator; `window.parrot` mocked)
 * @why Chris, 2026-11-11: an album page lists the album's songs the user does not have, greyed and not playable, like
 *   Badger's missing episodes. They are not in the Songs list, the search, play-all or the queue, and the artist page
 *   shows only the albums the user owns. A song kept as is at import carries an "Unidentified" mark.
 * @req PAR-LIB-05[parrot]
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import type { ParrotListedTrack } from "@space/parrot-core";
import type { ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-MISSING-001]";
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
const track = (id: string, title: string, albumId: string, albumTitle: string, number: number, unidentified = false) => ({
  id,
  title,
  albumId,
  albumTitle,
  artistId: "art-1",
  artistName: "Test Band",
  disc: 1,
  number,
  durationMs: 180_000,
  fileId: `file-${id}`,
  mime: "audio/flac",
  sizeBytes: 1000,
  unidentified,
});
const listed = (number: number, title: string): ParrotListedTrack => ({ disc: 1, number, title, durationMs: 200_000 });
const album = (id: string, title: string, trackCount: number, tracklist: ParrotListedTrack[] | null) => ({
  id,
  title,
  artistId: "art-1",
  artistName: "Test Band",
  year: 2020,
  trackCount,
  addedAt: 1,
  coverUrl: null,
  coverThumbUrl: null,
  tracklist,
});
const library = {
  snapshotVersion: 1,
  artists: [{ id: "art-1", name: "Test Band", albumCount: 2, trackCount: 3 }],
  albums: [
    // 2 of 4: "Prelude" (1) and "Coda" (4) are missing.
    album("alb-1", "First Light", 2, [listed(1, "Prelude"), listed(2, "Harbour"), listed(3, "Lantern"), listed(4, "Coda")]),
    // Tracklist unknown (imported before tracklists were kept): only the owned song.
    album("alb-2", "Second Wind", 1, null),
  ],
  tracks: [track("t1", "Harbour", "alb-1", "First Light", 2), track("t2", "Lantern", "alb-1", "First Light", 3), track("t3", "Gale", "alb-2", "Second Wind", 1, true)],
};

describe("Parrot desktop album page: missing songs", () => {
  let container: HTMLDivElement;
  let root: Root;
  let playbackUrl: ReturnType<typeof vi.fn>;
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const q = (id: string) => [...container.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
  const click = async (el: Element | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => (el as HTMLElement).click());
    await flush();
  };
  const titles = (id: string) => q(id).map((row) => row.querySelector(".font-medium")?.textContent);
  const openAlbum = (title: string) => click(q("library-album").find((tile) => tile.textContent?.includes(title)));

  beforeEach(async () => {
    playbackUrl = vi.fn(async () => "blob:none");
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
        onLibraryChanged: vi.fn(() => () => undefined),
        onLibraryPatch: vi.fn(() => () => undefined),
        onLyricsChanged: vi.fn(() => () => undefined),
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
        playbackUrl,
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Library t={translator("en")} state={state} onSignedOut={() => undefined} />));
    await flush();
    await click(q("library-tab")[0]);
    console.info(SUITE, "phase: library open", q("library-album").map((tile) => tile.textContent));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("lists the missing songs greyed, in tracklist order, without a play button", async () => {
    await openAlbum("First Light");
    const list = q("library-tracks")[0]!;
    const order = [...list.children].map((row) => `${row.getAttribute("data-testid") ?? row.firstElementChild?.getAttribute("data-testid")}:${row.querySelector(".font-medium")?.textContent}`);
    console.info(SUITE, "phase: album rows", order);
    expect(order).toEqual(["library-missing-track:Prelude", "library-track:Harbour", "library-track:Lantern", "library-missing-track:Coda"]);
    const missing = q("library-missing-track");
    for (const row of missing) {
      console.info(SUITE, "missing row", row.className, row.textContent);
      expect(row.className).toContain("opacity-40");
      expect(row.className).toContain("grayscale");
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.querySelector("button")).toBeNull();
      expect(row.textContent).toContain("Not in your library");
    }
    // The header counts the songs the user has.
    expect(q("library-album-page")[0]?.textContent).toContain("2 songs");
  });

  it("play-all and the queue hold only the owned songs; double-clicking a missing row plays nothing", async () => {
    await openAlbum("First Light");
    await act(async () => q("library-missing-track")[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await flush();
    console.info(SUITE, "phase: after double-click on a missing row", playbackUrl.mock.calls);
    expect(playbackUrl).not.toHaveBeenCalled();

    await click(q("library-play-all")[0]);
    const heard = [q("player-title")[0]?.textContent];
    await click(q("player-next")[0]);
    heard.push(q("player-title")[0]?.textContent);
    console.info(SUITE, "phase: played", heard, "files", playbackUrl.mock.calls.map((call) => call[0]));
    expect(heard[0]).toContain("Harbour");
    expect(heard[1]).toContain("Lantern");
    expect(playbackUrl.mock.calls.map((call) => call[0]).every((fileId) => ["file-t1", "file-t2"].includes(String(fileId)))).toBe(true);
  });

  it("an album with an unknown tracklist lists only its owned songs", async () => {
    await openAlbum("Second Wind");
    console.info(SUITE, "phase: second wind rows", titles("library-track"));
    expect(titles("library-track")).toEqual(["Gale"]);
    expect(q("library-missing-track")).toHaveLength(0);
  });

  it("missing songs are not in the Songs list", async () => {
    await click(q("library-chip-songs")[0]);
    console.info(SUITE, "phase: songs list", titles("library-track"));
    expect(titles("library-track")).toEqual(["Gale", "Harbour", "Lantern"]);
    expect(q("library-missing-track")).toHaveLength(0);
  });

  it("the artist page shows only the albums the user owns", async () => {
    await click(q("library-chip-artists")[0]);
    await click(q("library-artist")[0]);
    const tiles = q("library-album").map((tile) => tile.querySelector("p")?.textContent);
    console.info(SUITE, "phase: artist albums", tiles);
    expect(tiles).toEqual(["First Light", "Second Wind"]);
    expect(q("library-missing-track")).toHaveLength(0);
  });

  it("a song kept as is at import carries the Unidentified mark", async () => {
    await openAlbum("Second Wind");
    const marks = q("song-unidentified").map((mark) => mark.closest('[data-testid="library-track"]')?.querySelector(".font-medium")?.textContent);
    console.info(SUITE, "phase: unidentified marks", marks);
    expect(marks).toEqual(["Gale"]);
    expect(q("song-unidentified")[0]?.textContent).toBe("Unidentified");
  });
});

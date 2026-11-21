// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-KEPT-UI-001
 * @level integration (real Library shell, shared keep button / chip / copy question, real translator; `window.parrot` mocked)
 * @why The approved demo keeps an album, a playlist or a song on the computer: the album page has the keep button and
 *   the "Kept on this computer · size" line (a progress line while it downloads), two stored formats ask once which
 *   copy to keep, and a kept album's songs carry the held tick in the Songs list. The library has no "Kept offline"
 *   chip: what is kept is seen on each item (PAR-OFFL-04).
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStorageUnitBase, setStorageUnitBase } from "@space/shared/format";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import type { KeepCopyChoice, KeptKind, KeptStatus } from "@space/parrot-core";
import type { ParrotLibrary, ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-KEPT-UI-001]";
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
  artistId: albumId === "alb-1" ? "art-1" : "art-2",
  artistName: albumId === "alb-1" ? "Test Band" : "Other Band",
  disc: 1,
  number,
  durationMs: 180_000,
  fileId: `file-${id}`,
  mime: "audio/flac",
  sizeBytes: 1000,
});
const library: ParrotLibrary = {
  snapshotVersion: 1,
  artists: [
    { id: "art-1", name: "Test Band", albumCount: 1, trackCount: 2 },
    { id: "art-2", name: "Other Band", albumCount: 1, trackCount: 1 },
  ],
  albums: [
    { id: "alb-1", title: "First Light", artistId: "art-1", artistName: "Test Band", year: 2020, trackCount: 2, coverUrl: null, coverThumbUrl: null },
    { id: "alb-2", title: "Second Wind", artistId: "art-2", artistName: "Other Band", year: 2021, trackCount: 1, coverUrl: null, coverThumbUrl: null },
  ],
  tracks: [track("t1", "Harbour", "alb-1", "First Light", 1), track("t2", "Lantern", "alb-1", "First Light", 2), track("t3", "Gale", "alb-2", "Second Wind", 1)],
  playlists: [],
};
const CHOICES: KeepCopyChoice[] = [
  { key: "FLAC:lossless", label: "FLAC", lossless: true, bitrateKbps: null, songs: 2, bytes: 60_000_000 },
  { key: "MP3:320k", label: "MP3 320 kbps", lossless: false, bitrateKbps: 320, songs: 2, bytes: 18_000_000 },
];

describe("Parrot desktop: save offline", () => {
  let container: HTMLDivElement;
  let root: Root;
  let kept: KeptStatus;
  let choices: KeepCopyChoice[];
  let keepCalls: Array<[KeptKind, string, string | null]>;
  let pushKept: ((status: KeptStatus) => void) | null;
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
  const albumTitles = () => q("library-album").map((tile) => tile.textContent ?? "");
  const mount = async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Library t={translator("en")} state={state} onState={() => undefined} />));
    await flush();
  };
  const keptAlbum = (done: number, total: number, choice: string | null): KeptStatus => ({
    entries: [{ kind: "album", id: "alb-1", choice, keptAt: 1, bytes: 18_000_000, done, total }],
    songs: [
      { trackId: "t1", fileId: "file-t1", onDevice: done >= 1 },
      { trackId: "t2", fileId: "file-t2", onDevice: done >= 2 },
    ],
    downloading: done < total,
  });

  beforeEach(() => {
    localStorage.clear();
    kept = { entries: [], songs: [], downloading: false };
    choices = CHOICES;
    keepCalls = [];
    pushKept = null;
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...exportBridgeStub(),
        getLibrary: vi.fn(async () => ({ ok: true, library })),
        getImportStatus: vi.fn(async () => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0 })),
        getImportScan: vi.fn(async () => null),
        onImportStatus: vi.fn(() => () => undefined),
        getCoversWaiting: vi.fn(async () => []),
        onCoversWaiting: vi.fn(() => () => undefined),
        getImportJobs: vi.fn(async () => []),
        onImportJobs: vi.fn(() => () => undefined),
        dismissImportJob: vi.fn(async () => []),
        getBackgroundWork: vi.fn(async () => []),
        onBackgroundWork: vi.fn(() => () => undefined),
        onLibraryChanged: vi.fn(() => () => undefined),
        onLibraryPatch: vi.fn(() => () => undefined),
        onLyricsChanged: vi.fn(() => () => undefined),
        getKept: vi.fn(async () => kept),
        onKept: vi.fn((listener: (status: KeptStatus) => void) => {
          pushKept = listener;
          return () => undefined;
        }),
        keepChoices: vi.fn(async () => choices),
        keep: vi.fn(async (kind: KeptKind, id: string, choice: string | null) => {
          keepCalls.push([kind, id, choice]);
          kept = keptAlbum(0, 2, choice);
          return kept;
        }),
        unkeep: vi.fn(async () => {
          kept = { entries: [], songs: [], downloading: false };
          return kept;
        }),
        playbackUrl: vi.fn(async () => "blob:none"),
        editPlaylists: vi.fn(async () => ({ ok: true, library })),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    // Sizes below read in 1000-based units, as macOS / GNOME show them (STOR-UNIT-01).
    setStorageUnitBase(1000);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  // @req PAR-OFFL-01[parrot]
  // @req PAR-OFFL-02[parrot]
  it("keeps an album after asking which copy, shows the progress then the kept line, and removes it", async () => {
    await mount();
    await click(q("library-tab")[0]);
    await click(q("library-album")[0]);
    // The album's keep sits in its "…" menu (PAR-LOOK-01: the demo's album page shows Play, Shuffle, the heart and "…").
    await click(q("album-menu")[0]);
    const toggle = q("album-menu-keep")[0];
    console.log(SUITE, "album keep item", toggle?.textContent);
    expect(toggle?.textContent).toBe("Save offline");
    expect(q("kept-line")).toHaveLength(0);

    await click(toggle);
    const dialog = q("keep-choice-dialog")[0];
    console.log(SUITE, "copy question", dialog?.textContent);
    expect(dialog?.textContent).toContain("Which copy should be kept?");
    expect(q("keep-choice").map((row) => row.textContent ?? "")).toEqual([expect.stringContaining("FLAC"), expect.stringContaining("MP3 320 kbps")]);
    await click(q("keep-choice")[1]);
    console.log(SUITE, "keep calls", JSON.stringify(keepCalls));
    expect(keepCalls).toEqual([["album", "alb-1", "MP3:320k"]]);
    expect(q("kept-line")[0]?.textContent).toBe("Downloading 0 of 2");

    await act(async () => pushKept?.(keptAlbum(2, 2, "MP3:320k")));
    await flush();
    console.log(SUITE, "kept line", q("kept-line")[0]?.textContent, "unit base", getStorageUnitBase());
    // 18,000,000 bytes on a 1000-based computer (STOR-UNIT-01); MB has no decimal (STOR-UNIT-02).
    expect(q("kept-line")[0]?.textContent).toBe("Kept on this computer · 18 MB");
    await click(q("album-menu")[0]);
    expect(q("album-menu-keep")[0]?.textContent).toBe("Remove from this computer");

    await click(q("album-menu-keep")[0]);
    expect(window.parrot.unkeep).toHaveBeenCalledWith("album", "alb-1");
    expect(q("kept-line")).toHaveLength(0);
  });

  // @req PAR-OFFL-02[parrot]
  it("keeps without asking when the songs have one format", async () => {
    choices = [CHOICES[0]!];
    await mount();
    await click(q("library-tab")[0]);
    await click(q("library-album")[0]);
    await click(q("album-menu")[0]);
    await click(q("album-menu-keep")[0]);
    expect(q("keep-choice-dialog")).toHaveLength(0);
    expect(keepCalls).toEqual([["album", "alb-1", null]]);
  });

  // @req PAR-OFFL-01[parrot]
  it("has no Kept offline chip; the songs of a kept album show the held tick", async () => {
    await mount();
    await click(q("library-tab")[0]);
    expect(q("library-chip-kept")).toHaveLength(0);
    expect(q("library-chip-playlists")).toHaveLength(0);
    await act(async () => pushKept?.(keptAlbum(2, 2, null)));
    await flush();
    await click(q("library-chip-songs")[0]);
    const songs = q("library-track").map((row) => row.textContent ?? "");
    console.log(SUITE, "songs", songs);
    expect(songs).toHaveLength(3);
    const songToggles = q("song-keep");
    console.log(SUITE, "song toggles", songToggles.map((b) => `${b.dataset.keepState}/${b.dataset.keepHeld}/${b.getAttribute("aria-label")}`));
    // Songs list by title (PAR-LIB-06 default): Gale (Second Wind, not kept), then Harbour and Lantern (First Light, kept).
    expect(songToggles.map((b) => [b.dataset.keepState, b.dataset.keepHeld, (b as HTMLButtonElement).disabled])).toEqual([
      ["off", undefined, false],
      ["kept", "true", true],
      ["kept", "true", true],
    ]);
    expect(songToggles[1]!.getAttribute("aria-label")).toBe("Kept with its album or playlist");
  });

  // @req PAR-OFFL-04[parrot]
  it("offline, greys out and disables what is not kept on this computer; kept items stay in colour", async () => {
    kept = keptAlbum(2, 2, null);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await mount();
    await click(q("library-tab")[0]);
    const albums = q("library-album") as HTMLButtonElement[];
    console.log(SUITE, "offline albums", albums.map((b) => `${b.textContent}/${b.dataset.unavailable}/${b.disabled}`));
    expect(albums.map((b) => [b.dataset.unavailable, b.disabled])).toEqual([
      [undefined, false],
      ["true", true],
    ]);
    expect(albums[1]!.className).toContain("grayscale");
    await click(q("library-chip-artists")[0]);
    // Artists by name (PAR-LIB-06 default): Other Band (nothing kept) before Test Band.
    expect(q("library-artist").map((b) => (b as HTMLButtonElement).disabled)).toEqual([true, false]);
    await click(q("library-chip-songs")[0]);
    expect(q("library-track").map((row) => row.dataset.unavailable)).toEqual(["true", undefined, undefined]);
    expect(q("library-track")[0]!.querySelector("button")!.disabled).toBe(true);

    // Back online: everything in colour again.
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    await flush();
    expect(q("library-track").map((row) => row.dataset.unavailable)).toEqual([undefined, undefined, undefined]);
  });
});

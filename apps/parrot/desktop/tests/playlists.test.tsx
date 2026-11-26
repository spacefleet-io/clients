// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-PLAYLISTS-001
 * @level integration (real Library shell, real shared playlist logic and dialogs, real translator; `window.parrot` mocked)
 * @why Chris, 2026-11-09: "you should build everything in the app like the demo you had showed me ... When a validate a
 *   design I expect you to follow it". The demo has a Playlists tab, a Playlists chip in the library, the heart on the
 *   album page and next to the playing song, and "Add to playlist". Liked songs comes first and is what the heart
 *   fills; a playlist can be made, renamed, filled from an album, emptied song by song and deleted; a save that fails
 *   says so and puts the playlists back.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import { applyPlaylistEditsLocally, PARROT_LIKED_PLAYLIST_ID, type ParrotPlaylist, type ParrotPlaylistEdit } from "@space/parrot-core";
import type { ParrotLibrary, ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-PLAYLISTS-001]";
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
const track = (id: string, title: string, number: number) => ({
  id,
  title,
  albumId: "alb-1",
  albumTitle: "First Light",
  artistId: "art-1",
  artistName: "Test Band",
  disc: 1,
  number,
  durationMs: 180_000,
  fileId: `file-${id}`,
  mime: "audio/flac",
  sizeBytes: 1000,
});
const playlist = (id: string, name: string, trackIds: string[]): ParrotPlaylist => ({ id, name, createdAt: 1, updatedAt: 1, trackIds, trackCount: trackIds.length });
const baseLibrary = (playlists: ParrotPlaylist[]): ParrotLibrary => ({
  snapshotVersion: 1,
  artists: [{ id: "art-1", name: "Test Band", albumCount: 1, trackCount: 3 }],
  albums: [{ id: "alb-1", title: "First Light", artistId: "art-1", artistName: "Test Band", year: 2020, trackCount: 3, coverUrl: null, coverThumbUrl: null }],
  tracks: [track("t1", "Harbour", 1), track("t2", "Lantern", 2), track("t3", "Gale", 3)],
  playlists,
});

describe("Parrot desktop playlists", () => {
  let container: HTMLDivElement;
  let root: Root;
  let server: ParrotLibrary;
  let failSaves: boolean;
  let saved: ParrotPlaylistEdit[][];
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  // Dialogs render outside the app's root, so look in the whole document.
  const q = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const click = async (element: HTMLElement | undefined) => {
    expect(element).toBeTruthy();
    await act(async () => element!.click());
    await flush();
  };
  const type = async (id: string, value: string) => {
    const input = q(id)[0] as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submitName = async (name: string) => {
    await type("playlist-name-input", name);
    await click(q("playlist-name-submit")[0]);
  };
  const titles = (listId: string) => [...document.querySelectorAll(`[data-testid="${listId}"] [data-testid="library-track"]`)].map((row) => row.textContent ?? "");
  const tileNames = () => q("library-playlist").map((tile) => tile.querySelector("p")?.textContent);
  const mount = async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Library t={translator("en")} state={state} onState={() => undefined} />));
    await flush();
  };

  beforeEach(() => {
    localStorage.clear();
    server = baseLibrary([playlist("pl-gym", "Gym", ["t3"])]);
    failSaves = false;
    saved = [];
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...exportBridgeStub(),
        getLibrary: vi.fn(async () => ({ ok: true, library: server })),
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
        editPlaylists: vi.fn(async (edits: ParrotPlaylistEdit[]) => {
          saved.push(edits);
          if (failSaves) return { ok: false, error: "network down" };
          server = { ...server, snapshotVersion: (server.snapshotVersion ?? 0) + 1, playlists: applyPlaylistEditsLocally(server.playlists, edits, Date.now()) };
          return { ok: true, library: server };
        }),
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

  // @req PAR-PL-02
  // @req PAR-NAV-06[parrot]
  it("the Playlists tab lists the playlists under no title and a new playlist made there opens empty", async () => {
    await mount();
    await click(q("playlists-tab")[0]);
    expect(q("playlists-tab")[0]!.getAttribute("aria-current")).toBe("page");
    expect(q("playlists-page")).toHaveLength(1);
    expect(q("playlists-heading")).toHaveLength(0);
    console.log(SUITE, "tiles", tileNames());
    expect(tileNames()).toEqual(["Gym"]);

    await click(q("playlist-new")[0]);
    await submitName("Road trip");
    console.log(SUITE, "saved", JSON.stringify(saved));
    expect(saved).toHaveLength(1);
    expect(saved[0]![0]).toMatchObject({ kind: "create", name: "Road trip", trackIds: [] });
    expect(q("playlist-title")[0]!.textContent).toBe("Road trip");
    expect(q("playlist-empty")[0]!.textContent).toContain("No songs here yet");
    // The tab stays lit on a playlist page.
    expect(q("playlists-tab")[0]!.getAttribute("aria-current")).toBe("page");
  });

  // @req PAR-PL-02
  it("adds a song from the album page, then removes it, renames and deletes the playlist", async () => {
    await mount();
    await click(q("library-tab")[0]);
    await click(q("library-album")[0]);
    // "Add to playlist" on Lantern (row 2) → Gym.
    await click(q("song-add-to-playlist")[1]);
    expect(q("add-to-playlist-dialog")[0]!.textContent).toContain("Add “Lantern” to a playlist");
    await click(q("add-to-playlist-choice").find((row) => row.dataset.playlistId === "pl-gym"));
    expect(saved.at(-1)).toEqual([{ kind: "add", id: "pl-gym", trackIds: ["t2"] }]);

    await click(q("playlists-tab")[0]);
    await click(q("library-playlist")[0]);
    console.log(SUITE, "Gym", titles("playlist-tracks"));
    expect(titles("playlist-tracks").map((row) => row.includes("Gale") || row.includes("Lantern"))).toEqual([true, true]);
    expect(titles("playlist-tracks")[1]).toContain("Lantern");

    await click(q("song-remove")[0]);
    expect(saved.at(-1)).toEqual([{ kind: "remove", id: "pl-gym", position: 0, trackId: "t3" }]);
    expect(titles("playlist-tracks")).toHaveLength(1);
    expect(titles("playlist-tracks")[0]).toContain("Lantern");

    await click(q("playlist-rename")[0]);
    await submitName("Gym 2");
    expect(saved.at(-1)).toEqual([{ kind: "rename", id: "pl-gym", name: "Gym 2" }]);
    expect(q("playlist-title")[0]!.textContent).toBe("Gym 2");

    await click(q("playlist-delete")[0]);
    expect(q("playlist-confirm-dialog")[0]!.textContent).toContain("Delete “Gym 2”?");
    await click(q("playlist-confirm")[0]);
    expect(saved.at(-1)).toEqual([{ kind: "delete", id: "pl-gym" }]);
    expect(q("playlists-page")).toHaveLength(1);
    expect(tileNames()).toEqual([]);
  });

  // @req PAR-PL-02
  it("“New playlist” in the picker makes a playlist that starts with the song", async () => {
    await mount();
    await click(q("library-tab")[0]);
    await click(q("library-chip-songs")[0]);
    await click(q("song-add-to-playlist")[0]);
    await click(q("add-to-playlist-new")[0]);
    await submitName("Calm");
    // The Songs list opens by title (PAR-LIB-06), so its first row is Gale (t3).
    expect(saved.at(-1)![0]).toMatchObject({ kind: "create", name: "Calm", trackIds: ["t3"] });
    await click(q("playlists-tab")[0]);
    expect(tileNames()).toEqual(["Calm", "Gym"]);
  });

  // @req PAR-PL-04
  it("the heart fills, puts the song in Liked songs listed first, and empties it again", async () => {
    await mount();
    await click(q("library-tab")[0]);
    await click(q("library-album")[0]);
    const heart = () => q("song-like")[0]!;
    expect(heart().dataset.liked).toBe("false");
    expect(heart().getAttribute("aria-label")).toBe("Add to Liked songs");
    await click(heart());
    expect(saved.at(-1)).toEqual([{ kind: "like", trackId: "t1", liked: true }]);
    expect(heart().dataset.liked).toBe("true");
    expect(heart().getAttribute("aria-label")).toBe("Remove from Liked songs");
    expect(heart().querySelector("svg")!.getAttribute("class")).toContain("fill-current");

    await click(q("playlists-tab")[0]);
    console.log(SUITE, "tiles after like", tileNames());
    expect(tileNames()).toEqual(["Liked songs", "Gym"]);
    expect(q("library-playlist")[0]!.dataset.liked).toBe("true");
    await click(q("library-playlist")[0]);
    // Liked songs can be neither renamed nor deleted.
    expect(q("playlist-rename")).toHaveLength(0);
    expect(q("playlist-delete")).toHaveLength(0);
    expect(titles("playlist-tracks")[0]).toContain("Harbour");
    await click(q("song-like")[0]);
    expect(saved.at(-1)).toEqual([{ kind: "like", trackId: "t1", liked: false }]);
    expect(server.playlists.find((p) => p.id === PARROT_LIKED_PLAYLIST_ID)?.trackIds).toEqual([]);
  });

  // @req PAR-PL-04
  it("the now-playing page has the heart next to the title", async () => {
    await mount();
    await click(q("library-tab")[0]);
    await click(q("library-album")[0]);
    await click(q("library-play-all")[0]);
    const hearts = q("like-button");
    console.log(SUITE, "hearts in the player", hearts.length);
    expect(hearts.length).toBeGreaterThan(0);
    await click(hearts[0]);
    expect(saved.at(-1)).toEqual([{ kind: "like", trackId: "t1", liked: true }]);
    expect(q("like-button")[0]!.dataset.liked).toBe("true");
  });

  // @req PAR-PL-03
  it("a save that fails says so and puts the playlists back", async () => {
    await mount();
    failSaves = true;
    await click(q("playlists-tab")[0]);
    await click(q("library-playlist")[0]);
    await click(q("song-remove")[0]);
    console.log(SUITE, "after failed save", titles("playlist-tracks"));
    expect(titles("playlist-tracks")).toHaveLength(1);
    expect(titles("playlist-tracks")[0]).toContain("Gale");
    expect(q("nav-notifications-count")[0]?.textContent).toBe("1");
    await click(q("nav-notifications")[0]);
    expect(document.body.textContent).toContain("Your playlist change was not saved");
  });
});

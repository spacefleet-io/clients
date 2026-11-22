// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-UP-NEXT-ONCE-001
 * @level integration (real Library shell, album page, player bar and Now playing queue tab; `window.parrot` mocked)
 * @why Chris, 2026-11-21: "I can add a whole album to the up next queue, but not a single song, and currently I can add
 *   a song multiple times to the queue." Every song row gets Add to queue, and a song is in Up next at most once
 *   (PAR-CARD-02).
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@space/ui";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import type { ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-UP-NEXT-ONCE-001]";
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
  albumId: "alb-met",
  albumTitle: "Meltway",
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
  artists: [{ id: "art-lp", name: "Linnet Park", albumCount: 1, trackCount: 3 }],
  albums: [{ id: "alb-met", title: "Meltway", artistId: "art-lp", artistName: "Linnet Park", year: 2003, trackCount: 3, coverUrl: null, coverThumbUrl: null }],
  tracks: [track("t-without", "Without You", 1), track("t-some", "Somewhere I Wander", 2), track("t-nook", "Nook", 3)],
};

describe("Parrot desktop: Add to queue on a song, and a song in Up next at most once (PAR-CARD-02)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let notices: string[];
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const q = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const press = async (el: HTMLElement | undefined, what: string) => {
    console.info(SUITE, "click", what, JSON.stringify(el?.getAttribute("aria-label") ?? el?.textContent ?? null));
    expect(el, what).toBeTruthy();
    await act(async () => el!.click());
    await flush();
  };
  const row = (title: string) => q("library-track").find((el) => el.textContent?.includes(title));
  // From home its tile; once a Meltway song plays, the player bar's album name (PAR-NAV-05).
  const openMeltway = async () => {
    const tile = q("home-album").find((el) => el.textContent?.includes("Meltway"));
    await press(tile ?? q("player-album-link")[0], tile ? "Meltway tile" : "player album link");
    expect(q("album-title")[0]?.textContent).toBe("Meltway");
  };
  /** The Now playing queue tab: the playing song first, then Up next, by title. */
  const queueTab = async () => {
    await press(q("player-queue")[0], "player queue");
    await press(q("now-playing-tab-queue")[0], "queue tab");
    const rows = q("now-playing-queue-row").map((el) => el.getAttribute("aria-label") ?? "");
    console.info(SUITE, "queue tab", JSON.stringify(rows));
    return rows;
  };

  beforeEach(async () => {
    localStorage.clear();
    notices = [];
    Element.prototype.scrollIntoView = () => undefined;
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...exportBridgeStub(),
        getLibrary: vi.fn(async () => ({ ok: true, library })),
        getImportStatus: vi.fn(async () => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0 })),
        getImportScan: vi.fn(async () => null),
        getLyrics: vi.fn(async () => null),
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
    vi.spyOn(toast, "info").mockImplementation((message) => {
      console.info(SUITE, "toast.info", JSON.stringify(message));
      notices.push(String(message));
      return 0;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Library t={translator("en")} state={state} onState={() => undefined} />));
    await flush();
    await openMeltway();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req PAR-CARD-02
  it("each song row on the album page has Add to queue, labelled like the album's", async () => {
    const buttons = q("song-add-to-queue");
    console.info(SUITE, "row buttons", buttons.length, buttons.map((b) => b.getAttribute("aria-label")));
    expect(buttons).toHaveLength(3);
    expect(buttons.every((b) => b.getAttribute("aria-label") === "Add to queue")).toBe(true);
  });

  // @req PAR-CARD-02
  it("a single song goes to the end of Up next; added again it stays one row and the notice says so", async () => {
    // Playing Nook (the last song) leaves Up next empty.
    await press(row("Nook")?.querySelector<HTMLElement>("button") ?? undefined, "Nook row play");
    expect(q("player-title")[0]?.textContent).toContain("Nook");
    await press(row("Somewhere I Wander")?.querySelector<HTMLElement>('[data-testid="song-add-to-queue"]') ?? undefined, "Somewhere add to queue");
    expect(notices).toEqual([]);
    expect(await queueTab()).toEqual(["Nook", "Somewhere I Wander"]);

    await openMeltway();
    await press(row("Somewhere I Wander")?.querySelector<HTMLElement>('[data-testid="song-add-to-queue"]') ?? undefined, "Somewhere add to queue again");
    expect(notices).toEqual(["Already in Up next"]);
    expect(await queueTab()).toEqual(["Nook", "Somewhere I Wander"]);

    // The playing song counts too: adding Nook adds nothing.
    await openMeltway();
    await press(row("Nook")?.querySelector<HTMLElement>('[data-testid="song-add-to-queue"]') ?? undefined, "Nook add to queue");
    expect(notices).toEqual(["Already in Up next", "Already in Up next"]);
    expect(await queueTab()).toEqual(["Nook", "Somewhere I Wander"]);
  });

  // @req PAR-CARD-02
  it("adding the album while 'Without You' plays leaves out the songs already playing or up next", async () => {
    await press(row("Nook")?.querySelector<HTMLElement>("button") ?? undefined, "Nook row play");
    await press(row("Without You")?.querySelector<HTMLElement>('[data-testid="song-add-to-queue"]') ?? undefined, "Without You add to queue");
    // Jump to Without You: Nook was played, Without You plays.
    await press(q("player-queue")[0], "player queue");
    await press(q("now-playing-tab-queue")[0], "queue tab");
    await press(q("now-playing-queue-row").find((el) => el.getAttribute("aria-label") === "Without You"), "jump to Without You");
    expect(q("player-title")[0]?.textContent).toContain("Without You");

    await openMeltway();
    await press(q("album-menu")[0], "album menu");
    await press(q("album-menu-add-to-queue")[0], "album Add to queue");
    expect(notices).toEqual([]);
    // Nook was already played, so it may come again; Without You is playing, so it does not.
    expect(await queueTab()).toEqual(["Without You", "Somewhere I Wander", "Nook"]);

    // The whole album again: everything is there, nothing is added, the notice says so.
    await openMeltway();
    await press(q("album-menu")[0], "album menu");
    await press(q("album-menu-add-to-queue")[0], "album Add to queue again");
    expect(notices).toEqual(["Already in Up next"]);
    expect(await queueTab()).toEqual(["Without You", "Somewhere I Wander", "Nook"]);
  });

  // @req PAR-CARD-02
  it("search: a song result's Add to queue adds it and leaves the palette open; a second press only shows the notice", async () => {
    await press(row("Nook")?.querySelector<HTMLElement>("button") ?? undefined, "Nook row play");
    await act(async () => q("parrot-top-nav-search")[0]!.click());
    const input = q("search-palette-input")[0] as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "without");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const result = () => q("search-palette-result").find((el) => el.textContent?.includes("Without You"));
    const add = () => result()?.querySelector<HTMLElement>('[data-testid="search-palette-add-to-queue"]') ?? undefined;
    expect(add()?.getAttribute("aria-label")).toBe("Add to queue");
    // Albums and artists have no such button.
    expect(q("search-palette-add-to-queue")).toHaveLength(1);
    await press(add(), "palette Without You add to queue");
    expect(q("search-palette")).toHaveLength(1);
    expect(notices).toEqual([]);
    await press(add(), "palette Without You add to queue again");
    expect(notices).toEqual(["Already in Up next"]);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    expect(await queueTab()).toEqual(["Nook", "Without You"]);
  });
});

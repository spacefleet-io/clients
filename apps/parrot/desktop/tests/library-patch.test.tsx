// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-LIBRARY-PATCH-001
 * @level integration (real Library shell; `window.parrot` mocked) + unit (the patch itself)
 * @why #2509: every song an import published made the window read the whole library back from the server (about
 *   1.2 s each on a 13-track album import). Main now sends only what the publish changed, and the window applies it.
 * @covers apps/parrot/desktop/src/shared/libraryPatch.ts
 * @covers apps/parrot/desktop/src/renderer/src/Library.tsx
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import type { ParrotImportStatus, ParrotLibrary, ParrotState } from "../src/shared/ipc";
import { applyParrotLibraryPatch, diffParrotLibrary, type ParrotLibraryPatch } from "../src/shared/libraryPatch";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-LIBRARY-PATCH-001]";
const state: ParrotState = {
  setup: { step: "errorReports", done: true, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: true,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "http://localhost:11000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
} as ParrotState;
const track = (id: string, title: string, albumId: string, albumTitle: string, number: number) => ({
  id,
  title,
  albumId,
  albumTitle,
  artistId: "art-1",
  artistName: "Linnet Park",
  disc: 1,
  number,
  durationMs: 185_000,
  fileId: `file-${id}`,
  mime: "audio/flac",
  sizeBytes: 1000,
});
const album = (id: string, title: string, year: number, trackCount: number) => ({ id, title, artistId: "art-1", artistName: "Linnet Park", year, trackCount, coverUrl: null, coverThumbUrl: null });
const v1 = {
  snapshotVersion: 1,
  artists: [{ id: "art-1", name: "Linnet Park", albumCount: 1, trackCount: 1 }],
  albums: [album("alb-meltway", "Meltway", 2003, 1)],
  tracks: [track("t-nook", "Nook", "alb-meltway", "Meltway", 13)],
  playlists: [],
} as unknown as ParrotLibrary;
// The next publish: a second album before Meltway (by year), and Meltway's count changed.
const v2 = {
  ...v1,
  snapshotVersion: 2,
  artists: [{ id: "art-1", name: "Linnet Park", albumCount: 2, trackCount: 2 }],
  albums: [album("alb-hybrid", "Hollow Signal", 2000, 1), album("alb-meltway", "Meltway", 2003, 1)],
  tracks: [track("t-nook", "Nook", "alb-meltway", "Meltway", 13), track("t-paperboat", "Paperboat", "alb-hybrid", "Hollow Signal", 1)],
} as unknown as ParrotLibrary;
const status = (change: Partial<ParrotImportStatus>): ParrotImportStatus =>
  ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0, published: 0, ...change }) as ParrotImportStatus;

describe("#2509 a publish's changes reach the window without reading the library again", () => {
  // @req PAR-UP-03
  it("carries only the rows that changed, and applying it gives the new library", () => {
    const patch = diffParrotLibrary(v1, v2);
    console.info(SUITE, "patch", JSON.stringify(patch));
    expect(patch.baseVersion).toBe(1);
    // Hollow Signal is new; Meltway is sent again only because the row before it changed.
    expect(patch.albums.rows.map(({ row, after }) => [row.id, after])).toEqual([["alb-hybrid", null], ["alb-meltway", "alb-hybrid"]]);
    expect(patch.tracks.rows.map(({ row }) => row.id)).toEqual(["t-paperboat"]);
    expect(patch.artists.rows.map(({ row }) => row.id)).toEqual(["art-1"]);
    expect(patch.playlists).toEqual({ rows: [], removed: [] });
    expect(applyParrotLibraryPatch(v1, patch)).toEqual(v2);
    // A list nothing changed in stays the same object (React redraws nothing there).
    expect(applyParrotLibraryPatch(v1, patch).playlists).toBe(v1.playlists);
    // Rows removed, and rows swapped around others that stayed, still give the new list.
    const swapped = { ...v2, snapshotVersion: 3, albums: [v2.albums[1], v2.albums[0]], tracks: [v2.tracks[1]] } as ParrotLibrary;
    expect(applyParrotLibraryPatch(v2, diffParrotLibrary(v2, swapped))).toEqual(swapped);
  });

  let container: HTMLDivElement;
  let root: Root;
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const listener = <K extends "onImportStatus" | "onLibraryPatch">(name: K) => vi.mocked(window.parrot[name]).mock.calls[0]![0] as Parameters<typeof window.parrot[K]>[0];
  const sendPatch = async (patch: ParrotLibraryPatch) => {
    await act(async () => listener("onLibraryPatch")(patch));
    await flush();
  };
  const sendStatus = async (next: ParrotImportStatus) => {
    await act(async () => listener("onImportStatus")(next));
    await flush();
  };
  const text = () => document.body.textContent ?? "";

  beforeEach(async () => {
    localStorage.clear();
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...exportBridgeStub(),
        getLibrary: vi.fn(async () => ({ ok: true, library: v1 })),
        getImportStatus: vi.fn(async () => status({})),
        getImportScan: vi.fn(async () => null),
        getLyrics: vi.fn(async () => null),
        onLyricsChanged: vi.fn(() => () => undefined),
        onLibraryChanged: vi.fn(() => () => undefined),
        onLibraryPatch: vi.fn(() => () => undefined),
        getCoversWaiting: vi.fn(async () => []),
        onCoversWaiting: vi.fn(() => () => undefined),
        getBackgroundWork: vi.fn(async () => []),
        onBackgroundWork: vi.fn(() => () => undefined),
        onImportStatus: vi.fn(() => () => undefined),
        getImportJobs: vi.fn(async () => []),
        onImportJobs: vi.fn(() => () => undefined),
        dismissImportJob: vi.fn(async () => []),
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

  // @req PAR-UP-03
  it("shows a published album from the patch alone, and reads the library only when it shows another version", async () => {
    const getLibrary = vi.mocked(window.parrot.getLibrary);
    expect(getLibrary.mock.calls).toEqual([[false]]);
    expect(text()).not.toContain("Hollow Signal");

    // A song published: the status says so, the patch carries it; nothing is read again.
    await sendStatus(status({ running: true, phase: "uploading", total: 2, done: 1, published: 1 }));
    await sendPatch(diffParrotLibrary(v1, v2));
    console.info(SUITE, "after patch", getLibrary.mock.calls);
    expect(text()).toContain("Hollow Signal");
    expect(getLibrary.mock.calls).toEqual([[false]]);

    // A patch made against a version this window does not show: the window reads main's library instead.
    await sendPatch({ ...diffParrotLibrary(v1, v2), baseVersion: 7, snapshotVersion: 8 });
    expect(getLibrary.mock.calls).toEqual([[false], [false]]);

    // The import's end shows main's library, without asking the server again.
    await sendStatus(status({ phase: "done", total: 2, done: 2, imported: 2, published: 2 }));
    console.info(SUITE, "after done", getLibrary.mock.calls);
    expect(getLibrary.mock.calls.every(([refresh]) => refresh === false)).toBe(true);
  });
});

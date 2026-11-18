// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-ALBUM-JOBS-001
 * @level integration (real Library screen, real translator; `window.parrot` mocked)
 * @why Chris 2026-11-16 (chat, via Main): an album an import touched gets a Jobs tab like a Badger title's, listing
 *   those imports with the same cards as the Jobs panel; an album no import touched has no tabs.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import type { ParrotListedTrack } from "@space/parrot-core";
import type { ParrotImportJob, ParrotImportStatus, ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-ALBUM-JOBS-001]";
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

const status = (patch: Partial<ParrotImportStatus>): ParrotImportStatus => ({
  running: false,
  phase: "done",
  total: 2,
  done: 2,
  imported: 2,
  skipped: 0,
  failed: 0,
  bytesDone: 0,
  bytesTotal: 0,
  published: 2,
  currentFile: null,
  error: null,
  ...patch,
});
const importJob: ParrotImportJob = {
  id: "job-1",
  sources: ["/home/me/Music/First Light"],
  startedAt: Date.UTC(2026, 10, 16, 10),
  finishedAt: null,
  failures: [],
  albumIds: ["alb-1"],
  status: status({ running: true, phase: "uploading", done: 1, imported: 1, bytesDone: 500, bytesTotal: 1000 }),
};

describe("Parrot desktop album page: Jobs tab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let push: (jobs: ParrotImportJob[]) => void = () => undefined;
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
  const openAlbum = (title: string) => click(q("library-album").find((tile) => tile.textContent?.includes(title)));
  const tabs = () => q("media-detail-tabs")[0]?.querySelectorAll('[role="tab"]');

  beforeEach(async () => {
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        getLibrary: vi.fn(async () => ({ ok: true, library })),
        getImportStatus: vi.fn(async () => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0 })),
        getImportScan: vi.fn(async () => null),
        getLyrics: vi.fn(async () => null),
        onLibraryChanged: vi.fn(() => () => undefined),
        onLyricsChanged: vi.fn(() => () => undefined),
        onImportStatus: vi.fn(() => () => undefined),
        getImportJobs: vi.fn(async () => [importJob]),
        onImportJobs: vi.fn((listener: (jobs: ParrotImportJob[]) => void) => {
          const before = push;
          push = (jobs) => {
            before(jobs);
            listener(jobs);
          };
          return () => undefined;
        }),
        dismissImportJob: vi.fn(async () => []),
        cancelImport: vi.fn(async () => importJob.status),
        getBackgroundWork: vi.fn(async () => []),
        onBackgroundWork: vi.fn(() => () => undefined),
        onLibraryPatch: vi.fn(() => () => undefined),
        getCoversWaiting: vi.fn(async () => []),
        onCoversWaiting: vi.fn(() => () => undefined),
        getKept: vi.fn(async () => ({ entries: [], songs: [], downloading: false })),
        onKept: vi.fn(() => () => undefined),
        playbackUrl: vi.fn(async () => "blob:none"),
      },
    });
    push = () => undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Library t={translator("en")} state={state} onSignedOut={() => undefined} />));
    await flush();
    await click(q("library-tab")[0]);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req UX-JOBS-02[parrot]
  it("an album an import touched has Songs and Jobs tabs; the Jobs tab lists that import with the panel's cards", async () => {
    await openAlbum("First Light");
    const names = [...(tabs() ?? [])].map((tab) => tab.textContent);
    console.info(SUITE, "tabs", names);
    expect(names).toEqual(["Songs", "Jobs"]);
    expect(q("library-tracks")).toHaveLength(1);
    await click(tabs()?.[1]);
    expect(q("library-tracks")).toHaveLength(0);
    const rows = q("album-jobs")[0]?.querySelectorAll('[data-testid="import-job"]');
    console.info(SUITE, "album jobs", q("album-jobs")[0]?.textContent);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.querySelector('[data-testid="import-job-status"]')?.textContent).toBe("Uploading");
    await click(rows?.[0]?.querySelector('[data-testid="import-job-cancel"]') ?? undefined);
    expect(window.parrot.cancelImport).toHaveBeenCalledTimes(1);
    // When the import ends the row reads Done, with the bin.
    await act(async () => push([{ ...importJob, finishedAt: 9, status: status({}) }]));
    const ended = q("album-jobs")[0]?.querySelector('[data-testid="import-job"]');
    expect(ended?.querySelector('[data-testid="import-job-status"]')?.textContent).toBe("Done");
    expect(ended?.querySelector('[data-testid="import-job-remove"]')).not.toBeNull();
  });

  // @req UX-JOBS-02[parrot]
  it("an album no import touched has no tabs, only its songs", async () => {
    await openAlbum("Second Wind");
    expect(q("media-detail-tabs")).toHaveLength(0);
    expect(q("library-tracks")).toHaveLength(1);
  });
});

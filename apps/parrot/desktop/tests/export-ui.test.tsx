// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-EXPORT-UI-001
 * @level integration (real Library shell, Jobs panel and Settings page, real translator; `window.parrot` mocked)
 * @why Chris 2026-11-21 (chat): Parrot desktop exports only through "Download everything" in Settings, saving the
 *   whole library as plain music files in a folder the user picks (OFFL-FILE-01, ACCT-EXPORT-01); a song or an album
 *   has one offline action, "Save offline", and no "Download file". Download everything says how many songs and how
 *   much room before asking for the folder, never which quality (OFFL-QUAL-01); the run shows in the Jobs panel with
 *   its progress, and a full disk is said in words (OFFL-SAFE-02).
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStorageUnitBase } from "@space/shared/format";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import { EXPORT_NO_SPACE, type ParrotExportJob, type ParrotLibrary, type ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { ImportJobs } from "../src/renderer/src/ImportJobs";
import { SettingsPage } from "../src/renderer/src/AccountSettings";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-EXPORT-UI-001]";
const t = translator("en");
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
const library: ParrotLibrary = {
  snapshotVersion: 1,
  artists: [{ id: "art-1", name: "Test Band", albumCount: 1, trackCount: 2 }],
  albums: [{ id: "alb-1", title: "First Light", artistId: "art-1", artistName: "Test Band", year: 2020, trackCount: 2, coverUrl: null, coverThumbUrl: null }],
  tracks: [track("t1", "Harbour", 1), track("t2", "Lantern", 2)],
  playlists: [],
};
const job = (over: Partial<ParrotExportJob>): ParrotExportJob => ({
  id: "x1",
  dest: "/home/test/Music Backup",
  startedAt: Date.UTC(2026, 10, 21, 10),
  finishedAt: null,
  phase: "running",
  doneSongs: 1,
  totalSongs: 2,
  doneBytes: 10_000_000,
  totalBytes: 20_000_000,
  current: "Lantern",
  error: null,
  failures: [],
  ...over,
});

describe("Parrot desktop: download music as plain files", () => {
  let container: HTMLDivElement;
  let root: Root;
  let bridge: ReturnType<typeof exportBridgeStub>;
  let pushJobs: ((jobs: ParrotExportJob[]) => void) | null;
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
  const render = async (node: React.ReactNode) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(node));
    await flush();
  };

  beforeEach(() => {
    localStorage.clear();
    pushJobs = null;
    bridge = exportBridgeStub();
    bridge.onExportJobs.mockImplementation((listener: (jobs: ParrotExportJob[]) => void) => {
      pushJobs = listener;
      return () => undefined;
    });
    bridge.exportMusic.mockImplementation(async () => ({ ok: true, job: job({ phase: "queued", doneSongs: 0, doneBytes: 0 }) }));
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...bridge,
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
        getKept: vi.fn(async () => ({ entries: [], songs: [], downloading: false })),
        onKept: vi.fn(() => () => undefined),
        keepChoices: vi.fn(async () => []),
        playbackUrl: vi.fn(async () => "blob:none"),
        editPlaylists: vi.fn(async () => ({ ok: true, library })),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    setStorageUnitBase(1000);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  // @req OFFL-FILE-01[parrot]
  it("gives an album and a song one offline action, Save offline, and no Download file", async () => {
    await render(<Library t={t} state={state} onState={() => undefined} />);
    await click(q("library-tab")[0]);
    await click(q("library-album")[0]);
    await click(q("album-menu")[0]);
    const items = [...document.querySelectorAll<HTMLElement>('[data-testid^="album-menu-"]')];
    console.log(SUITE, "album menu items", items.map((item) => `${item.dataset.testid}=${item.textContent}`));
    expect(q("album-menu-keep")[0]?.textContent).toBe("Save offline");
    expect(q("album-menu-download-file")).toHaveLength(0);
    expect(items.map((item) => item.textContent)).not.toContain("Download file");

    const songKeeps = q("song-keep");
    console.log(SUITE, "song keep buttons", songKeeps.map((b) => b.getAttribute("aria-label")), "download buttons", q("song-download-file").length);
    expect(songKeeps).toHaveLength(2);
    expect(songKeeps[0]?.getAttribute("aria-label")).toBe("Save offline");
    expect(q("song-download-file")).toHaveLength(0);
    expect(document.querySelector('[aria-label="Download file"]')).toBeNull();
    expect(bridge.exportMusic).not.toHaveBeenCalled();
    expect(bridge.previewExport).not.toHaveBeenCalled();
  });

  // @req ACCT-EXPORT-01[parrot]
  // @req OFFL-QUAL-01[parrot]
  it("Download everything says how many songs and how much room, then asks for the folder", async () => {
    bridge.previewExport.mockImplementation(async () => ({ songs: 2, bytes: 30_000_000 }));
    await render(
      <SettingsPage
        t={t}
        email="parrot-test@example.test"
        userId="u1"
        language="en"
        initialSection="account"
        onState={() => undefined}
        onPlan={() => undefined}
        onPair={() => undefined}
        onFeedback={() => undefined}
        onTour={() => undefined}
        onRefresh={() => undefined}
        onSignOut={() => undefined}
      />,
    );
    const button = q("export-everything")[0];
    console.log(SUITE, "settings button", button?.textContent);
    expect(button?.textContent).toBe("Download everything");
    expect(bridge.previewExport).not.toHaveBeenCalled();
    await click(button);
    const confirm = q("export-everything-confirm")[0]?.textContent;
    console.log(SUITE, "confirm line", confirm, "preview calls", JSON.stringify(bridge.previewExport.mock.calls));
    expect(bridge.previewExport).toHaveBeenCalledWith();
    expect(confirm).toBe("2 songs, 30 MB. Choose the folder to save them in.");
    expect(document.body.textContent).not.toMatch(/quality\?/i);
    expect(bridge.exportMusic).not.toHaveBeenCalled();

    await click(q("export-everything-choose")[0]);
    console.log(SUITE, "export calls", JSON.stringify(bridge.exportMusic.mock.calls), "note", q("export-everything-note")[0]?.textContent);
    expect(bridge.exportMusic).toHaveBeenCalledWith();
    expect(q("export-everything-confirm")).toHaveLength(0);
    expect(q("export-everything-note")[0]?.textContent).toContain("Follow the download in Jobs");
  });

  // @req OFFL-SAFE-02[parrot]
  it("Download everything says when the drive has no room, and an empty library has nothing to save", async () => {
    bridge.previewExport.mockImplementationOnce(async () => ({ songs: 0, bytes: 0 })).mockImplementation(async () => ({ songs: 2, bytes: 30_000_000 }));
    bridge.exportMusic.mockImplementation(async () => ({ ok: false, reason: "no-space", neededBytes: 30_000_000, freeBytes: 5_000_000 }));
    await render(
      <SettingsPage
        t={t}
        email="parrot-test@example.test"
        userId="u1"
        language="en"
        initialSection="account"
        onState={() => undefined}
        onPlan={() => undefined}
        onPair={() => undefined}
        onFeedback={() => undefined}
        onTour={() => undefined}
        onRefresh={() => undefined}
        onSignOut={() => undefined}
      />,
    );
    await click(q("export-everything")[0]);
    console.log(SUITE, "empty note", q("export-everything-note")[0]?.textContent);
    expect(q("export-everything-note")[0]?.textContent).toBe("Your library has no songs to download yet.");
    await click(q("export-everything")[0]);
    await click(q("export-everything-choose")[0]);
    console.log(SUITE, "no-space note", q("export-everything-note")[0]?.textContent);
    expect(q("export-everything-note")[0]?.textContent).toBe("Not enough room on that drive: 30 MB needed, 5 MB free.");
  });

  // @req OFFL-FILE-01[parrot]
  // @req OFFL-SAFE-02[parrot]
  it("lists exports in the Jobs panel with progress, the songs not saved, and a full disk in words", async () => {
    bridge.getExportJobs.mockImplementation(async () => [job({})]);
    await render(<ImportJobs t={t} language="en" onReview={() => undefined} />);
    await click(q("nav-jobs")[0]);
    const progress = q("export-job-progress").map((row) => row.textContent);
    console.log(SUITE, "running rows", q("export-job").map((row) => `${row.dataset.phase}: ${row.textContent}`));
    expect(q("export-job").map((row) => row.dataset.phase)).toEqual(["running"]);
    expect(progress).toEqual(["1 of 2 songs · 10 MB of 20 MB"]);
    expect(q("export-job")[0]?.textContent).toContain("Download: All your music");

    await act(async () =>
      pushJobs?.([
        job({ phase: "failed", finishedAt: Date.UTC(2026, 10, 21, 11), error: EXPORT_NO_SPACE, failures: [{ title: "Lantern", reason: "not enough free space" }] }),
        job({ id: "x2", phase: "done", doneSongs: 2, finishedAt: Date.UTC(2026, 10, 21, 12) }),
      ]),
    );
    await flush();
    console.log(SUITE, "ended rows", q("export-job").map((row) => `${row.dataset.phase}: ${row.textContent}`));
    expect(q("export-job").map((row) => row.dataset.phase)).toEqual(["failed", "done"]);
    expect(q("export-job-error")[0]?.textContent).toBe("The drive is full. The songs already saved stay; free some room and download again.");
    expect(q("export-job-failures")[0]?.textContent).toContain("Lantern");
    expect(q("export-job-done")[0]?.textContent).toBe("2 songs saved in Music Backup");
    expect(q("export-job")[1]?.textContent).toContain("Download: All your music");

    await click(q("export-job-remove")[1]);
    console.log(SUITE, "dismiss calls", JSON.stringify(bridge.dismissExportJob.mock.calls));
    await vi.waitFor(() => expect(bridge.dismissExportJob).toHaveBeenCalledWith("x2"));

    await act(async () => pushJobs?.([job({ id: "x3", phase: "done", doneSongs: 1, finishedAt: Date.UTC(2026, 10, 21, 13) })]));
    await flush();
    console.log(SUITE, "one-song row", q("export-job-done").map((row) => row.textContent));
    expect(q("export-job-done")[0]?.textContent).toBe("1 song saved in Music Backup");
  });
});

// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-IMPORT-NOTIFICATIONS-001
 * @level integration (real Library shell and notification tray, real translator; `window.parrot` mocked)
 * @why UX-JOBS-01 / UX-I18N-01 @bugfix: each import put "Import finished" in the tray twice (main sent "done" twice),
 *   the tray kept every notification in the language it was made in ("Import finished", "Added to Road trip" after
 *   switching to French), and a publish other saves kept beating showed the server's "version_conflict".
 * @covers apps/parrot/desktop/src/renderer/src/Library.tsx
 * @covers apps/parrot/desktop/src/renderer/src/notificationText.ts
 * @covers apps/parrot/desktop/src/renderer/src/ImportJobs.tsx
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import type { ParrotImportStatus, ParrotLanguage, ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-IMPORT-NOTIFICATIONS-001]";
const stateIn = (language: ParrotLanguage): ParrotState => ({
  setup: { step: "errorReports", done: true, language, folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: true,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "http://localhost:11000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
});
const library = {
  snapshotVersion: 1,
  artists: [{ id: "art-1", name: "Linnet Park", albumCount: 1, trackCount: 1 }],
  albums: [{ id: "alb-1", title: "Meltway", artistId: "art-1", artistName: "Linnet Park", year: 2003, trackCount: 1, coverUrl: null, coverThumbUrl: null }],
  tracks: [
    {
      id: "t1",
      title: "Nook",
      albumId: "alb-1",
      albumTitle: "Meltway",
      artistId: "art-1",
      artistName: "Linnet Park",
      disc: 1,
      number: 13,
      durationMs: 185_000,
      fileId: "file-t1",
      mime: "audio/flac",
      sizeBytes: 1000,
    },
  ],
};
const status = (change: Partial<ParrotImportStatus>): ParrotImportStatus => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0, published: 0, ...change }) as ParrotImportStatus;

describe("import notifications", () => {
  let container: HTMLDivElement;
  let root: Root;
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const q = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const render = async (language: ParrotLanguage) => {
    await act(async () => root.render(<Library t={translator(language)} state={stateIn(language)} onState={() => undefined} />));
    await flush();
  };
  const openTray = async () => {
    await act(async () => q("nav-notifications")[0]!.click());
    await flush();
  };
  const count = (text: string) => (document.body.textContent ?? "").split(text).length - 1;
  const send = async (next: ParrotImportStatus) => {
    const listener = vi.mocked(window.parrot.onImportStatus).mock.calls[0]![0];
    await act(async () => listener(next));
    await flush();
  };

  beforeEach(async () => {
    localStorage.clear();
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...exportBridgeStub(),
        getLibrary: vi.fn(async () => ({ ok: true, library })),
        getImportStatus: vi.fn(async () => status({})),
        getImportScan: vi.fn(async () => null),
        getLyrics: vi.fn(async () => null),
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
    await render("en");
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req UX-JOBS-01 @req UX-I18N-01
  it("puts one notification per import in the tray, and shows it in the language picked afterwards", async () => {
    // Two imports; the first one's "done" arrives twice, as main sent it before the fix.
    for (const imported of [14, 3]) {
      await send(status({ running: true, phase: "uploading", total: imported, done: 1 }));
      await send(status({ running: true, phase: "publishing", total: imported, done: imported }));
      await send(status({ phase: "done", total: imported, done: imported, imported }));
      if (imported === 14) await send(status({ phase: "done", total: imported, done: imported, imported }));
    }
    await openTray();
    console.info(SUITE, "tray (en)", document.body.textContent);
    expect(count("Import finished")).toBe(2);

    await render("fr");
    console.info(SUITE, "tray (fr)", document.body.textContent);
    expect(count("Import finished")).toBe(0);
    expect(count("Import terminé")).toBe(2);
  });

  // @req PAR-UP-03
  it("says in words that other saves kept landing first, never the server's version_conflict", async () => {
    await send(status({ running: true, phase: "publishing" }));
    await send(status({ phase: "failed", error: "version_conflict" }));
    await openTray();
    const title = [...document.body.querySelectorAll("div")].find((node) => node.textContent === "Import failed");
    await act(async () => title?.click());
    await flush();
    console.info(SUITE, "tray", document.body.textContent);
    expect(document.body.textContent).toContain("Other changes to your library kept arriving at the same time.");
    expect(document.body.textContent).not.toContain("version_conflict");
  });
});

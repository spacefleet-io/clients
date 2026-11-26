// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-IMPORT-NOTIFICATIONS-001
 * @level integration (real Library shell, toasts and notification history, real translators; `window.parrot` mocked)
 * @why UX-JOBS-01 / UX-I18N-01 @bugfix: each import put "Import finished" in the tray twice (main sent "done" twice),
 *   the tray kept every notification in the language it was made in, and a publish other saves kept beating showed the
 *   server's "version_conflict". UX-NOTICE-10/12/13: a finished import is a toast only, a failed one is kept once
 *   (same key) with "Open Jobs", the bell counts it, and the entry follows a language change.
 * @covers apps/parrot/desktop/src/renderer/src/Library.tsx
 * @covers apps/parrot/desktop/src/renderer/src/noticeText.ts
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
  // The tray and the toasts may sit in portals, outside the container.
  const q = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const render = async (language: ParrotLanguage) => {
    await act(async () => root.render(<Library t={translator(language)} state={stateIn(language)} onState={() => undefined} />));
    await flush();
  };
  const openTray = async () => {
    await act(async () => q("nav-notifications")[0]!.click());
    await flush();
  };
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

  // @req UX-JOBS-01 @req UX-I18N-01 @req UX-NOTICE-10[parrot] @req UX-NOTICE-12[parrot] @req UX-NOTICE-13[parrot]
  it("keeps a failed import once, never a finished one, counts it on the bell and shows it in the language picked afterwards", async () => {
    // Two finished imports; the first one's "done" arrives twice, as main sent it before the fix.
    for (const imported of [14, 3]) {
      await send(status({ running: true, phase: "uploading", total: imported, done: 1 }));
      await send(status({ running: true, phase: "publishing", total: imported, done: imported }));
      await send(status({ phase: "done", total: imported, done: imported, imported }));
      if (imported === 14) await send(status({ phase: "done", total: imported, done: imported, imported }));
    }
    const toasts = q("sf-notice-import");
    console.info(SUITE, "after done: toasts", toasts.map((n) => n.textContent), "badge", q("nav-notifications-count").length);
    // One toast for both imports (same key, replaced in place); it says the latest import's counts.
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.textContent).toContain("Added: 3");
    expect(q("nav-notifications-count")).toHaveLength(0);

    // Two failures of the same import: one entry, one on the bell.
    await send(status({ phase: "failed", error: "disk full" }));
    await send(status({ phase: "failed", error: "disk full" }));
    console.info(SUITE, "after failed: badge", q("nav-notifications-count")[0]?.textContent);
    expect(q("nav-notifications-count")[0]?.textContent).toBe("1");
    await openTray();
    const entries = q("notice-entry-import");
    console.info(SUITE, "tray (en)", entries.map((n) => n.textContent));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.textContent).toContain("Import failed");
    expect(q("nav-notifications-count")).toHaveLength(0);

    await render("fr");
    const fr = q("notice-entry-import");
    console.info(SUITE, "tray (fr)", fr.map((n) => n.textContent));
    expect(fr[0]!.textContent).toContain("Échec de l’import");
    expect(fr[0]!.textContent).not.toContain("Import failed");
  });

  // @req UX-NOTICE-10[parrot]
  it("a failed import's entry leads to the Jobs panel", async () => {
    await send(status({ phase: "failed", error: "disk full" }));
    await openTray();
    await act(async () => q("notice-entry-import")[0]!.click());
    await flush();
    const open = q("notice-entry-open-import");
    console.info(SUITE, "open button", open.map((n) => n.textContent));
    expect(open[0]!.textContent).toBe("Open Jobs");
    await act(async () => open[0]!.click());
    await flush();
    console.info(SUITE, "jobs panel open", q("import-jobs").length);
    expect(q("import-jobs")).toHaveLength(1);
  });

  // @req PAR-UP-03
  it("says in words that other saves kept landing first, never the server's version_conflict", async () => {
    await send(status({ running: true, phase: "publishing" }));
    await send(status({ phase: "failed", error: "version_conflict" }));
    await openTray();
    await act(async () => q("notice-entry-import")[0]!.click());
    await flush();
    console.info(SUITE, "tray", document.body.textContent);
    expect(document.body.textContent).toContain("Other changes to your library kept arriving at the same time.");
    expect(document.body.textContent).not.toContain("version_conflict");
  });
});

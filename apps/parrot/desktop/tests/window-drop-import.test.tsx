// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-WINDOW-DROP-IMPORT-001
 * @level integration (real Library shell and shared window drop; `window.parrot` mocked)
 * @why UX-ADD-01 [@bugfix][@regression-proof] (Chris 2026-11-26, KDE Plasma Wayland): dragging songs from Dolphin onto
 *   Parrot sometimes showed a forbidden cursor and releasing did nothing. The window stood aside while an import was
 *   scanning, uploading or in its review (log: "file drag not taken: the app asked it to stand aside"), and a review
 *   whose confirm dialog was gone kept refusing every drop with nothing on screen. A drop during an import now goes to
 *   main, which keeps it waiting behind the import; a review with no dialog reopens it or ends.
 * @covers apps/parrot/desktop/src/renderer/src/Library.tsx
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import type { ParrotImportStatus, ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-WINDOW-DROP-IMPORT-001]";
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
const library = { snapshotVersion: 1, artists: [], albums: [], tracks: [] };
const status = (change: Partial<ParrotImportStatus>): ParrotImportStatus => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0, published: 0, ...change }) as ParrotImportStatus;

/** jsdom has no DataTransfer: what a file manager's drag of one song carries, as the shared drop reads it. */
const songDrag = (): DataTransfer => {
  const file = new File(["x"], "song.flac", { type: "audio/flac" });
  return {
    types: ["Files"],
    files: Object.assign([file], { item: (i: number) => (i === 0 ? file : null) }),
    items: [{ kind: "file", type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false }) }],
    getData: () => "",
    dropEffect: "none",
  } as unknown as DataTransfer;
};
const dragEvent = (type: string, dataTransfer: DataTransfer) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
};

describe("window drop during an import [@bugfix][@regression-proof]", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mainStatus: ParrotImportStatus;
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const send = async (next: ParrotImportStatus) => {
    mainStatus = next;
    const listener = vi.mocked(window.parrot.onImportStatus).mock.calls[0]![0];
    await act(async () => listener(next));
    await flush();
  };

  beforeEach(async () => {
    localStorage.clear();
    mainStatus = status({});
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...exportBridgeStub(),
        getLibrary: vi.fn(async () => ({ ok: true, library })),
        getImportStatus: vi.fn(async () => mainStatus),
        getImportScan: vi.fn(async () => null),
        scanImport: vi.fn(async (paths: string[]) => ({ ...mainStatus, queuedSources: paths.length })),
        cancelImport: vi.fn(async () => (mainStatus = status({}))),
        getPathForFile: vi.fn((file: File) => `/music/${file.name}`),
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
    await act(async () => root.render(<Library t={translator("en")} state={state} onState={() => undefined} />));
    await flush();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req UX-ADD-01[parrot] @req PAR-UP-05
  it.each([
    ["uploading", status({ running: true, phase: "uploading" })],
    ["scanning", status({ running: true, phase: "scanning" })],
  ])("takes songs dropped while an import is %s and hands them to main to wait behind it", async (_label, during) => {
    await send(during);
    const warn = vi.spyOn(console, "warn");
    const drag = songDrag();
    await act(async () => {
      document.body.dispatchEvent(dragEvent("dragenter", drag));
      document.body.dispatchEvent(dragEvent("dragover", drag));
    });
    console.info(`${SUITE} ${during.phase}: dropEffect=${drag.dropEffect}`);
    expect(drag.dropEffect).toBe("copy");
    await act(async () => document.body.dispatchEvent(dragEvent("drop", drag)));
    await flush();
    const asides = warn.mock.calls.filter(([line]) => String(line).includes("stand aside"));
    console.info(`${SUITE} ${during.phase}: scanImport calls=${vi.mocked(window.parrot.scanImport).mock.calls.length}, stand-aside lines=${asides.length}`);
    expect(window.parrot.scanImport).toHaveBeenCalledWith(["/music/song.flac"]);
    expect(asides).toEqual([]);
    expect(document.body.textContent).toContain("Added once the current import is over");
  });

  // @req UX-ADD-01[parrot] @req PAR-UP-05
  it("ends a review that has no scan behind it, so it blocks nothing", async () => {
    await send(status({ phase: "review", total: 2 }));
    console.info(`${SUITE} orphan review: cancelImport calls=${vi.mocked(window.parrot.cancelImport).mock.calls.length}`);
    expect(window.parrot.cancelImport).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="import-review"]')).toBeNull();
  });

  // @req UX-ADD-01[parrot] @req PAR-UP-05
  it("reads a review's scan again when its dialog is gone but main still holds it, and never cancels it", async () => {
    vi.mocked(window.parrot.getImportScan).mockResolvedValueOnce(null).mockResolvedValue({ entries: [], unreadable: [], lyrics: [], albums: 0, totalBytes: 0 } as never);
    await send(status({ phase: "review", total: 0 }));
    console.info(`${SUITE} review re-read: getImportScan calls=${vi.mocked(window.parrot.getImportScan).mock.calls.length}`);
    expect(window.parrot.cancelImport).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="import-review"]')).not.toBeNull();
  });
});

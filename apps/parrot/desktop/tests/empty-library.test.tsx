// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-EMPTY-001
 * @level integration (real Library shell and Home, real translator; `window.parrot` mocked)
 * @why Chris, 2026-11-12: "the parrot empty library looks good but it isn't coherent with the one badger shows. the
 *   aesthetic should be the same. And here the mascot is way too big". With no songs, Home and the library show the
 *   family's shared empty-library screen (`EmptyLibrary`, Badger's layout, type scale and small mascot box; only the
 *   accent and copy differ, PAR-EMPTY-01): the parrot, "Your library", "Add your first album", "Add music" and
 *   "Add a folder", and three steps. Both buttons start an import.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import type { ParrotLanguage, ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { PARROT_STRINGS, translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-EMPTY-001]";
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
const emptyLibrary = { snapshotVersion: 1, artists: [], albums: [], tracks: [] };
const idle = { running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0 };

describe("Parrot desktop empty library (PAR-EMPTY-01)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let pickFolders: Mock<() => Promise<string[]>>;
  let scanImport: Mock<(paths: string[]) => Promise<typeof idle>>;
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  // Dialogs render in a portal on document.body, so look there rather than in the container.
  const q = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const click = async (el: HTMLElement | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => el!.click());
    await flush();
  };
  const mount = async (language: ParrotLanguage = "en") => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Library t={translator(language)} state={{ ...state, setup: { ...state.setup, language } }} onState={() => undefined} />));
    await flush();
  };

  beforeEach(() => {
    localStorage.clear();
    pickFolders = vi.fn(async () => ["/music/Albums"]);
    scanImport = vi.fn(async () => ({ ...idle, running: true, phase: "scanning" }));
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        getLibrary: vi.fn(async () => ({ ok: true, library: emptyLibrary })),
        getImportStatus: vi.fn(async () => idle),
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
        pickFiles: vi.fn(async () => []),
        pickFolders,
        scanImport,
      },
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req PAR-EMPTY-01
  // @req PAR-HOME-01
  it("Home shows the parrot, the title, both add buttons and the three steps", async () => {
    await mount();
    const screen = q("empty-library")[0];
    console.info(SUITE, "home", screen?.textContent);
    expect(screen?.textContent).toContain("Your library");
    expect(screen?.textContent).toContain("Add your first album");
    expect(q("empty-library-mascot")[0]?.tagName).toBe("IMG");
    expect(q("empty-library-add-music")[0]?.textContent).toBe("Add music");
    // Badger's look and size: the mascot sits in the same small box, with the same title scale and round buttons.
    expect(q("empty-library-mascot")[0]?.className).toContain("h-[152px] w-[152px]");
    expect(q("empty-library-mascot")[0]?.parentElement?.className).toContain("h-[222px] w-[148px]");
    expect(screen?.querySelector("h1")?.className).toContain("text-[40px]");
    expect(q("empty-library-add-music")[0]?.className).toContain("rounded-full");
    expect(q("empty-library-add-folder")[0]?.textContent).toBe("Add a folder");
    expect([...screen!.querySelectorAll("li")].map((li) => li.firstElementChild?.nextElementSibling?.firstElementChild?.textContent)).toEqual([
      "1. Pick your songs",
      "2. Parrot finds the details",
      "3. Listen anywhere",
    ]);
    expect(q("home")).toHaveLength(0);
  });

  // @req PAR-EMPTY-01
  it("Add music opens the add-music dialog", async () => {
    await mount();
    expect(q("add-music-dialog")).toHaveLength(0);
    await click(q("empty-library-add-music")[0]);
    console.info(SUITE, "dialog", q("add-music-dialog")[0]?.textContent);
    expect(q("add-music-dialog")).toHaveLength(1);
  });

  // @req PAR-EMPTY-01
  it("Add a folder opens the system folder picker and scans what was picked", async () => {
    await mount();
    await click(q("empty-library-add-folder")[0]);
    console.info(SUITE, "scan", scanImport.mock.calls);
    expect(pickFolders).toHaveBeenCalledTimes(1);
    expect(scanImport).toHaveBeenCalledWith(["/music/Albums"]);
  });

  // @req PAR-EMPTY-01
  it("a cancelled folder picker starts nothing", async () => {
    pickFolders.mockResolvedValueOnce([]);
    await mount();
    await click(q("empty-library-add-folder")[0]);
    expect(scanImport).not.toHaveBeenCalled();
  });

  // @req UX-LIBTAB-01
  // Chris, 2026-11-16: "if library is greyed out when empty, then the playlist menu should also be greyed out and
  // unaccissible": Playlists follows Library.
  it.each(["library-tab", "playlists-tab"])("the %s is greyed out and does not open while the library is empty", async (testId) => {
    await mount();
    const tab = q(testId)[0] as HTMLButtonElement | undefined;
    console.info(SUITE, testId, { disabled: tab?.disabled, className: tab?.className });
    expect(tab?.disabled).toBe(true);
    expect(tab?.className).toContain("opacity-50");
    expect(tab?.getAttribute("aria-current")).toBeNull();
    await act(async () => tab!.click());
    await flush();
    expect(q("library-heading")).toHaveLength(0);
    expect(q(testId)[0]?.getAttribute("aria-current")).toBeNull();
    expect(q("home-tab")[0]?.getAttribute("aria-current")).toBe("page");
  });

  // @req UX-LIBTAB-01
  it.each(["library-tab", "playlists-tab"])("the %s opens as soon as the first song lands, without a restart", async (testId) => {
    let libraryChanged: (() => void) | undefined;
    const getLibrary = window.parrot.getLibrary as Mock;
    (window.parrot.onLibraryChanged as Mock).mockImplementation((listener: () => void) => {
      libraryChanged = listener;
      return () => undefined;
    });
    await mount();
    expect((q(testId)[0] as HTMLButtonElement).disabled).toBe(true);
    const firstSong = {
      id: "t-nook",
      title: "Nook",
      albumId: "alb-meltway",
      albumTitle: "Meltway",
      artistId: "art-1",
      artistName: "Linnet Park",
      disc: 1,
      number: 13,
      durationMs: 185_000,
      fileId: "file-t-nook",
      mime: "audio/flac",
      sizeBytes: 1000,
    };
    getLibrary.mockResolvedValue({
      ok: true,
      library: {
        snapshotVersion: 2,
        artists: [{ id: "art-1", name: "Linnet Park", albumCount: 1, trackCount: 1 }],
        albums: [{ id: "alb-meltway", title: "Meltway", artistId: "art-1", artistName: "Linnet Park", year: 2003, trackCount: 1, coverUrl: null, coverThumbUrl: null }],
        tracks: [firstSong],
        playlists: [],
      },
    });
    expect(libraryChanged).toBeTruthy();
    await act(async () => libraryChanged!());
    await flush();
    const tab = q(testId)[0] as HTMLButtonElement;
    console.info(SUITE, testId, "after first song", { disabled: tab.disabled, className: tab.className });
    expect(tab.disabled).toBe(false);
    expect(tab.className).not.toContain("opacity-50");
    await click(tab);
    expect(tab.getAttribute("aria-current")).toBe("page");
    expect(q("empty-library")).toHaveLength(0);
  });

  // @req PAR-EMPTY-01
  it("every language has the screen's words, translated", async () => {
    const keys = (Object.keys(PARROT_STRINGS.en) as (keyof typeof PARROT_STRINGS.en)[]).filter((key) => key.startsWith("empty."));
    expect(keys).toHaveLength(11);
    for (const language of ["fr", "nl", "de", "es"] as const) {
      for (const key of keys) {
        const text = PARROT_STRINGS[language][key];
        expect(text, `${language} ${key}`).toBeTruthy();
        expect(text, `${language} ${key}`).not.toBe(PARROT_STRINGS.en[key]);
      }
    }
    await mount("fr");
    expect(q("empty-library")[0]?.textContent).toContain("Ajoutez votre premier album");
  });
});

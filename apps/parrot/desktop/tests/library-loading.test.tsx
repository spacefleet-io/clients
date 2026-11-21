// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-LIBLOAD-001
 * @level integration (real Library shell and Home, real translator; `window.parrot` mocked)
 * @bugfix library-empty-before-load @regression-proof
 * @why Chris, 2026-11-18: "When I opened Badger, it first showed me an 'empty library, upload your first media on
 *   desktop' screen before loading the library. This is confusing. If the user already has media, the app should never
 *   show this screen, but instead the same initial loading screen (floating badger) with a 'Loading library' message.
 *   This is true of all apps." While Parrot's library opens, Home and the library page show the nodding parrot above
 *   "Loading library…" in the app's language; the empty library only once the opened library holds no song; the
 *   songs as soon as there are any.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import type { ParrotLanguage, ParrotLibraryResult, ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { PARROT_STRINGS, translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOG = "[PARROT-DESKTOP-LIBLOAD-001]";
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
const idle = { running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0 };
const emptyLibrary = { snapshotVersion: 1, artists: [], albums: [], tracks: [], playlists: [] };
const fullLibrary = {
  snapshotVersion: 2,
  artists: [{ id: "art-1", name: "Linkin Park", albumCount: 1, trackCount: 1 }],
  albums: [
    { id: "alb-meteora", title: "Meteora", artistId: "art-1", artistName: "Linkin Park", year: 2003, trackCount: 1, coverUrl: null, coverThumbUrl: null },
  ],
  tracks: [
    {
      id: "t-numb",
      title: "Numb",
      albumId: "alb-meteora",
      albumTitle: "Meteora",
      artistId: "art-1",
      artistName: "Linkin Park",
      disc: 1,
      number: 13,
      durationMs: 185_000,
      fileId: "file-t-numb",
      mime: "audio/flac",
      sizeBytes: 1000,
    },
  ],
  playlists: [],
};

// @req UX-WAIT-04
describe("Parrot desktop while the library opens (UX-WAIT-04)", () => {
  let container: HTMLDivElement;
  let root: Root;
  /** Answers the pending `getLibrary` call: the library's first load ends. */
  let answer: (result: ParrotLibraryResult) => void;

  const q = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const dump = (label: string) => {
    console.info(
      `${LOG} ${label} seen=${JSON.stringify({
        loader: q("library-loading").length,
        mascot: q("mascot-loader-parrot").length,
        empty: q("empty-library").length,
        addMusic: q("empty-library-add-music").length,
        homeAlbums: q("home-album").length,
      })}`
    );
    console.info(`${LOG} ${label} loader text=${JSON.stringify(q("library-loading")[0]?.textContent ?? null)}`);
  };
  const mount = async (language: ParrotLanguage = "en") => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root.render(<Library t={translator(language)} state={{ ...state, setup: { ...state.setup, language } }} onState={() => undefined} />)
    );
    await flush();
  };
  const settle = async (result: ParrotLibraryResult, label: string) => {
    console.info(`${LOG} ${label}: getLibrary answers ${result.ok ? `${result.library.tracks.length} song(s)` : result.error}`);
    await act(async () => answer(result));
    await flush();
    dump(label);
  };

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...exportBridgeStub(),
        // The first load stays open until the test answers it.
        getLibrary: vi.fn(() => {
          const { promise, resolve } = Promise.withResolvers<ParrotLibraryResult>();
          answer = resolve;
          return promise;
        }),
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
        pickFolders: vi.fn(async () => []),
        scanImport: vi.fn(async () => idle),
      },
    });
    console.info(`${LOG} bridge ready`);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows the nodding parrot above 'Loading library…' while the first load runs, never the empty library", async () => {
    await mount();
    dump("loading");
    expect(q("empty-library")).toHaveLength(0);
    expect(q("empty-library-add-music")).toHaveLength(0);
    expect(q("library-loading")).toHaveLength(1);
    expect(q("library-loading")[0]?.querySelector('[data-testid="mascot-loader-parrot"]')).not.toBeNull();
    expect(q("library-loading")[0]?.textContent).toContain("Loading library…");
    // Chris 2026-11-19: it fills the scrolling page between the top bar and the player, the parrot centred in it.
    const loader = q("library-loading")[0];
    console.info(`${LOG} loading classes ${loader?.className} in <${loader?.parentElement?.tagName.toLowerCase()}>`);
    expect(loader?.className.split(" ")).toEqual(expect.arrayContaining(["flex", "min-h-full", "flex-col", "items-center", "justify-center"]));
    expect(loader?.parentElement?.tagName).toBe("MAIN");
  });

  it("says 'Loading library…' in the app's language (French)", async () => {
    await mount("fr");
    dump("loading-fr");
    expect(q("empty-library")).toHaveLength(0);
    expect(q("library-loading")[0]?.textContent).toContain("Chargement de la bibliothèque…");
    for (const language of ["fr", "nl", "de", "es"] as const) {
      const text = PARROT_STRINGS[language]["library.loading"];
      console.info(`${LOG} ${language} library.loading=${JSON.stringify(text)}`);
      expect(text).toBeTruthy();
      expect(text).not.toBe(PARROT_STRINGS.en["library.loading"]);
    }
  });

  it("shows the empty library once the load has finished with no song", async () => {
    await mount();
    expect(q("empty-library")).toHaveLength(0);
    await settle({ ok: true, library: emptyLibrary }, "settled-empty");
    expect(q("library-loading")).toHaveLength(0);
    expect(q("empty-library")).toHaveLength(1);
    expect(q("empty-library-add-music")).toHaveLength(1);
  });

  it("shows the songs, not the loader nor the empty library, once the library lists some", async () => {
    await mount();
    await settle({ ok: true, library: fullLibrary }, "settled-full");
    expect(q("library-loading")).toHaveLength(0);
    expect(q("empty-library")).toHaveLength(0);
    expect(q("home-album").length).toBeGreaterThan(0);
  });

  it("a failed first load shows its error, not the empty library", async () => {
    await mount();
    await settle({ ok: false, error: "network down" }, "settled-error");
    expect(q("empty-library")).toHaveLength(0);
    expect(container.textContent).toContain("network down");
  });
});

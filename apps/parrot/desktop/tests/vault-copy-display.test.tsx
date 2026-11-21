// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-VAULT-COPY-001
 * @level integration (real Library shell, Home, album and artist pages, player and now-playing page; `window.parrot` spied) + source scan
 * @why PAR-COPY-01, Chris 2026-11-16: "pictures are supposed to be fetched at media import and stored in the user's
 *   vault so they can then pull them from there when using the app". Browsing and playing show only the library's own
 *   copies (covers, artist photos, lyrics); the metadata service is asked only at import, by the paced background copy
 *   and when the user asks. Before this, playing a song never looked up called `fetchLyrics` (a metadata lookup) from
 *   the window; now it is handed to the paced pass (`wantLyrics`). The scan keeps every renderer lookup IPC inside the
 *   import review, the edit dialog (its fields' suggestions while the user types, PAR-META-18, and its Lyrics section)
 *   or the Lyrics tab's own button.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import type { ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = "[PARROT-DESKTOP-VAULT-COPY-001]";
const phase = (name: string, payload: Record<string, unknown> = {}) => console.info(T, `phase=${name}`, JSON.stringify(payload));

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
const track = (id: string, title: string, albumId: string, albumTitle: string, number: number) => ({
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
});
// One album with its vault copy (served by the app's own cover server), one with none yet: a drawn tile.
const library = {
  snapshotVersion: 1,
  artists: [{ id: "art-1", name: "Test Band", albumCount: 2, trackCount: 2, pictureUrl: "http://127.0.0.1:1/cover/artist-key", pictureThumbUrl: null }],
  albums: [
    { id: "alb-1", title: "First Light", artistId: "art-1", artistName: "Test Band", year: 2020, trackCount: 1, coverUrl: "http://127.0.0.1:1/cover/k1", coverThumbUrl: null },
    { id: "alb-2", title: "Second Wind", artistId: "art-1", artistName: "Test Band", year: 2022, trackCount: 1, coverUrl: null, coverThumbUrl: null },
  ],
  tracks: [track("t1", "Harbour", "alb-1", "First Light", 1), track("t2", "Gale", "alb-2", "Second Wind", 1)],
};

/** Every bridge call that reaches the metadata service (main's `lookupClient()`). */
const LOOKUP_IPC = ["fetchLyrics", "suggestEdit", "suggestEditCover", "importCover", "importArtistPhoto", "searchImportAlbums", "searchImportSongs", "matchImport"] as const;

describe("[parrot desktop] display reads only the library's copies (PAR-COPY-01)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const lookups: Array<{ ipc: string; args: unknown[] }> = [];
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const q = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const press = async (el: HTMLElement | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => el!.click());
    await flush();
    phase("pressed", { what, lookups: lookups.length });
  };

  beforeEach(async () => {
    lookups.length = 0;
    localStorage.clear();
    const spies = Object.fromEntries(
      LOOKUP_IPC.map((ipc) => [
        ipc,
        vi.fn(async (...args: unknown[]) => {
          lookups.push({ ipc, args });
          return { ok: false, error: "no lookup while browsing" };
        }),
      ])
    );
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...exportBridgeStub(),
        ...spies,
        wantLyrics: vi.fn(async () => undefined),
        getLibrary: vi.fn(async () => ({ ok: true, library })),
        getImportStatus: vi.fn(async () => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0 })),
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
    phase("arrange", { albums: library.albums.length, withCopy: library.albums.filter((a) => a.coverUrl).length });
    await act(async () => root.render(<Library t={translator("en")} state={state} onState={() => undefined} />));
    await flush();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req PAR-COPY-01
  it("browsing Home, an album, its artist and playing a song never asks the metadata service; the song's lyrics go to the paced pass", async () => {
    const covers = [...container.querySelectorAll<HTMLImageElement>("img")].map((img) => img.getAttribute("src") ?? "").filter((src) => src !== "./icon.png");
    phase("home", { covers, lookups });
    // Every picture shown is the app's own cover server (the vault copy, opened locally); an album with none is drawn.
    expect(covers).toEqual(["http://127.0.0.1:1/cover/k1"]);

    await press(q("home-album").find((el) => el.textContent?.includes("Second Wind")), "album with no copy yet");
    expect(q("library-album-page")).toHaveLength(1);
    await press(q("album-artist-link")[0], "album header artist");
    expect(q("library-artist-page")).toHaveLength(1);
    await press(q("home-tab")[0], "Home tab");

    await press(q("home-resume")[0], "play the first album");
    await press(q("player-lyrics")[0], "open Lyrics");
    phase("act-done", { title: q("now-playing-title")[0]?.textContent, lookups, wanted: vi.mocked(window.parrot.wantLyrics).mock.calls });

    phase("assert", { lookups });
    expect(lookups).toEqual([]);
    expect(window.parrot.wantLyrics).toHaveBeenCalledWith("t1");
    expect(window.parrot.wantLyrics).toHaveBeenCalledTimes(1);
  });

  // @req PAR-COPY-01
  it("source scan: renderer lookup calls live only in the import review, the edit dialog and the Lyrics tab's own button", () => {
    const dir = join(__dirname, "../src/renderer/src");
    const files = (function walk(at: string): string[] {
      return readdirSync(at).flatMap((name) => {
        const path = join(at, name);
        return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
      });
    })(dir);
    const pattern = new RegExp(`window\\.parrot\\.(${LOOKUP_IPC.join("|")})\\b`, "g");
    const found = files.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(pattern)].map((match) => ({ file: relative(dir, path), ipc: match[1]!, at: match.index! }))
    );
    phase("scan", { files: files.length, found: found.map((f) => `${f.file}:${f.ipc}`) });
    const allowedFiles = new Set(["ImportReview.tsx", "editLookups.ts", "editSuggest.ts"]);
    const outside = found.filter((f) => !allowedFiles.has(f.file));
    // In the Library shell the only lookup is the Lyrics tab's "Fetch lyrics" / "Search again" button handler.
    const library = readFileSync(join(dir, "Library.tsx"), "utf8");
    const button = library.indexOf("const fetchPlayingLyrics = ");
    const buttonEnd = library.indexOf("\n  };", button);
    const notInButton = outside.filter((f) => !(f.file === "Library.tsx" && f.ipc === "fetchLyrics" && f.at > button && f.at < buttonEnd));
    const buttonCallers = [...library.matchAll(/fetchPlayingLyrics\(/g)].map((m) => library.slice(Math.max(0, m.index! - 40), m.index!));
    phase("assert", { notInButton, buttonCallers });
    expect(notInButton).toEqual([]);
    // Called only from the button (`onFetch`), never from an effect.
    expect(buttonCallers).toHaveLength(1);
    expect(buttonCallers[0]).toContain("onFetch");
  });
});

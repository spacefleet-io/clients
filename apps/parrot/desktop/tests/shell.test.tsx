// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-SHELL-001
 * @level integration (real Library shell, Home, player bar and now-playing page, real translator; `window.parrot` mocked)
 * @why Chris, 2026-11-09: "you should build everything in the app like the demo you had showed me". The app opens on
 *   Home with "Jump back in" (Resume from where the song stopped, Shuffle), "Recently played", "Recently added" and
 *   "Your artists" (Chris 2026-11-20: "Recently added" under "Recently played", as on Badger's Home); the
 *   player bar has shuffle, repeat, lyrics and queue; the now-playing page has Lyrics / Up next / About, and Lyrics says
 *   plainly that there are none yet; Account and Settings hold what left the top bar.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import type { ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-SHELL-001]";
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
const track = (id: string, title: string, albumId: string, albumTitle: string, number: number, artistId = "art-1", artistName = "Test Band") => ({
  id,
  title,
  albumId,
  albumTitle,
  artistId,
  artistName,
  disc: 1,
  number,
  durationMs: 180_000,
  fileId: `file-${id}`,
  mime: "audio/flac",
  sizeBytes: 1000,
});
const library = {
  snapshotVersion: 1,
  artists: [
    { id: "art-1", name: "Test Band", albumCount: 1, trackCount: 2 },
    { id: "art-2", name: "Other Act", albumCount: 1, trackCount: 1 },
  ],
  albums: [
    { id: "alb-1", title: "First Light", artistId: "art-1", artistName: "Test Band", year: 2020, trackCount: 2, addedAt: 1_000, coverUrl: null, coverThumbUrl: null },
    // Added after First Light: first under "Recently added".
    { id: "alb-2", title: "Second Wind", artistId: "art-2", artistName: "Other Act", year: 2022, trackCount: 1, addedAt: 2_000, coverUrl: null, coverThumbUrl: null },
  ],
  tracks: [
    track("t1", "Harbour", "alb-1", "First Light", 1),
    track("t2", "Lantern", "alb-1", "First Light", 2),
    track("t3", "Gale", "alb-2", "Second Wind", 1, "art-2", "Other Act"),
  ],
};

describe("Parrot desktop shell", () => {
  let container: HTMLDivElement;
  let root: Root;
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const q = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const click = async (id: string, index = 0) => {
    await act(async () => q(id)[index]!.click());
    await flush();
  };
  const mount = async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Library t={translator("en")} state={state} onState={() => undefined} />));
    await flush();
  };

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...exportBridgeStub(),
        getLibrary: vi.fn(async () => ({ ok: true, library })),
        getImportStatus: vi.fn(async () => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0 })),
        getImportScan: vi.fn(async () => null),
        sourceCredits: vi.fn(async (product: "badger" | "parrot", language: string) => ({
          product,
          language,
          separator: ": ",
          entries: [{ id: "music", name: "Example Music Data", url: "https://music.example", text: "Album and artist details.", licence: null, licenceUrl: null, logo: null, notice: null }],
        })),
        getLyrics: vi.fn(async () => null),
        fetchLyrics: vi.fn(async () => ({ ok: true as const, outcome: "none" as const, lyrics: { synced: null, plain: null, fetched: true, notFound: true as const } })),
        wantLyrics: vi.fn(async () => undefined),
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
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req PAR-HOME-01
  // @req PAR-NAV-01
  it("opens on Home: with nothing played here the card offers the first album, then the album row and the artists", async () => {
    await mount();
    console.info(SUITE, "home", q("home")[0]?.textContent);
    expect(q("home-tab")[0]?.getAttribute("aria-current")).toBe("page");
    expect(q("home-jump-back-in")[0]?.textContent).toContain("Start listening");
    expect(q("home-jump-title")[0]?.textContent).toBe("First Light");
    expect(q("home-jump-back-in")[0]?.textContent).toContain("Test Band · 2020 · 2 songs");
    expect(q("home-resume")[0]?.textContent).toBe("Play");
    // Recently added shows as soon as the library has albums, before anything was played.
    expect(q("home-added")[0]?.textContent).toContain("Recently added");
    expect(q("home-recent")[0]?.textContent).toContain("Albums");
    expect(q("home-recent")[0]?.querySelectorAll('[data-testid="home-album"]')).toHaveLength(2);
    expect(q("home-artist").map((el) => el.textContent)).toEqual(["Other Act", "Test Band"]);
  });

  // @req PAR-HOME-01
  it("Recently added sits under Recently played, newest added first, and its See all opens Albums sorted Recently added", async () => {
    localStorage.setItem(
      "parrot.history.u1",
      JSON.stringify({ version: 1, albums: [{ albumId: "alb-1", trackId: "t2", positionMs: 78_000, playedAt: 1 }], artistPlays: { "art-1": 3 } })
    );
    // The user last sorted the library by title with a filter that hides every album: See all must still open all of
    // them in the row's order.
    localStorage.setItem("parrot.libraryPrefs", JSON.stringify({ albums: { sort: "title", filters: { decade: 1950 } } }));
    await mount();
    const rows = [...q("home")[0]!.querySelectorAll("section[data-testid]")].map((el) => el.getAttribute("data-testid"));
    const added = q("home-added")[0]!;
    const titles = [...added.querySelectorAll('[data-testid="home-album"]')].map((el) => el.textContent);
    console.info(SUITE, "home rows", rows, "recently added", titles);
    expect(rows).toEqual(["home-jump-back-in", "home-recent", "home-added", "home-artists"]);
    expect(added.textContent).toContain("Recently added");
    expect(titles).toHaveLength(2);
    expect(titles[0]).toContain("Second Wind");
    expect(titles[1]).toContain("First Light");
    expect(q("home-recent")[0]?.textContent).toContain("Recently played");
    await click("home-added-see-all");
    const grid = q("library-album").map((el) => el.textContent);
    console.info(SUITE, "see all: prefs", localStorage.getItem("parrot.libraryPrefs"), "grid", grid);
    expect(q("library-filter-button")[0]?.textContent).toBe("Filter");
    expect(grid[0]).toContain("Second Wind");
    expect(grid[1]).toContain("First Light");
    expect(JSON.parse(localStorage.getItem("parrot.libraryPrefs") ?? "{}").albums).toEqual({ sort: "recent", filters: {} });
  });

  // @req PAR-HOME-01
  // @req PAR-HOME-02
  it("Jump back in resumes the last song played on this computer from where it stopped", async () => {
    localStorage.setItem(
      "parrot.history.u1",
      JSON.stringify({ version: 1, albums: [{ albumId: "alb-1", trackId: "t2", positionMs: 78_000, playedAt: 1 }], artistPlays: { "art-1": 3 } })
    );
    await mount();
    expect(q("home-jump-back-in")[0]?.textContent).toContain("Jump back in");
    expect(q("home-resume")[0]?.textContent).toBe("Resume 1:18");
    expect(q("home-recent")[0]?.textContent).toContain("Recently played");
    expect(q("home-artist").map((el) => el.textContent)).toEqual(["Test Band", "Other Act"]);
    await click("home-resume");
    const audio = q("player-audio")[0] as HTMLAudioElement;
    await act(async () => audio.dispatchEvent(new Event("loadedmetadata")));
    console.info(SUITE, "resumed", q("player-title")[0]?.textContent, "at", audio.currentTime);
    expect(q("player-title")[0]?.textContent).toContain("Lantern");
    expect(audio.currentTime).toBe(78);
    // The play is written back to this computer's history, nowhere else.
    expect(JSON.parse(localStorage.getItem("parrot.history.u1")!).albums[0].trackId).toBe("t2");
  });

  // @req PAR-HOME-01
  // @bugfix @regression-proof Chris 2026-11-16: the card said "Resume 0:20" while Meltway was playing.
  it("Jump back in shows Pause while its album plays, and Resume at the live place once paused", async () => {
    localStorage.setItem(
      "parrot.history.u1",
      JSON.stringify({ version: 1, albums: [{ albumId: "alb-1", trackId: "t2", positionMs: 78_000, playedAt: 1 }], artistPlays: { "art-1": 3 } })
    );
    await mount();
    expect(q("home-resume")[0]?.textContent).toBe("Resume 1:18");
    await click("home-resume");
    const audio = q("player-audio")[0] as HTMLAudioElement;
    await act(async () => audio.dispatchEvent(new Event("loadedmetadata")));
    await flush();
    const toggle = () => q("player-toggle")[0]?.getAttribute("aria-label");
    console.info(SUITE, "after resume: bar", toggle(), "card", q("home-resume")[0]?.textContent, "at", audio.currentTime);
    expect(toggle()).toBe("Pause");
    expect(q("home-resume")[0]?.textContent).toBe("Pause");
    // The card's Pause pauses the song in place; it never restarts it.
    await click("home-resume");
    console.info(SUITE, "after card pause: bar", toggle(), "card", q("home-resume")[0]?.textContent, "at", audio.currentTime);
    expect(toggle()).toBe("Play");
    expect(q("home-resume")[0]?.textContent).toMatch(/^Resume 1:1[89]$/);
    // Resume continues the same song; the card turns back to Pause.
    await click("home-resume");
    console.info(SUITE, "after card resume: bar", toggle(), "card", q("home-resume")[0]?.textContent, "title", q("player-title")[0]?.textContent);
    expect(toggle()).toBe("Pause");
    expect(q("player-title")[0]?.textContent).toContain("Lantern");
    expect(q("home-resume")[0]?.textContent).toBe("Pause");
  });

  // @req PAR-LOOK-01
  // @req PAR-LYR-04
  // @req PAR-LYR-05
  // @req PAR-META-20
  it("the player bar's shuffle and repeat switch, and Lyrics opens the now-playing page that says there are none yet", async () => {
    await mount();
    await click("home-resume");
    expect(q("player-shuffle")[0]?.getAttribute("aria-pressed")).toBe("false");
    await click("player-shuffle");
    expect(q("player-shuffle")[0]?.getAttribute("aria-pressed")).toBe("true");
    const repeats: (string | null)[] = [q("player-repeat")[0]!.getAttribute("data-repeat")];
    for (let i = 0; i < 3; i += 1) {
      await click("player-repeat");
      repeats.push(q("player-repeat")[0]!.getAttribute("data-repeat"));
    }
    console.info(SUITE, "repeat cycle", repeats);
    expect(repeats).toEqual(["off", "all", "one", "off"]);

    await click("player-lyrics");
    console.info(SUITE, "lyrics tab", q("now-playing-lyrics")[0]?.textContent);
    expect(q("now-playing-title")[0]?.textContent).toBe("Harbour");
    // A song never looked up is handed to the automatic pass at once (PAR-COPY-01: the window never looks it up itself);
    // until the pass answers, nothing is pending here, so it says there are none yet.
    expect(window.parrot.wantLyrics).toHaveBeenCalledWith("t1");
    expect(window.parrot.fetchLyrics).not.toHaveBeenCalled();
    expect(q("now-playing-lyrics")[0]?.textContent).toContain("No lyrics");
    expect(q("now-playing-lyrics")[0]?.textContent).not.toContain("Looking for lyrics");
    await click("now-playing-tab-queue");
    expect(q("now-playing-queue-row").length).toBeGreaterThan(0);
    await click("now-playing-tab-about");
    expect(q("now-playing-about")[0]?.textContent).toContain("FLAC");
    expect(q("now-playing-about")[0]?.textContent).toContain("3:00");
  });

  // @req PAR-NAV-01
  // @req UX-SET-01
  it("Settings has Badger's category rail: General (language, Refresh), Manage offline content, Help & feedback, About & updates (version, open source, credits), and Account (Plan, Pair a device)", async () => {
    await mount();
    expect(q("nav-account")).toHaveLength(0);
    await click("nav-settings");
    const rail = Array.from(container.querySelectorAll('[data-testid^="settings-nav-"]')).map((el) => el.getAttribute("data-testid"));
    console.info(SUITE, "settings rail", rail);
    expect(rail).toEqual(["settings-nav-general", "settings-nav-offline", "settings-nav-support", "settings-nav-about", "settings-nav-account"]);
    for (const id of ["library-language", "library-refresh"]) expect(q(id)).toHaveLength(1);
    await click("library-refresh");
    expect(window.parrot.getLibrary).toHaveBeenLastCalledWith(true);
    await click("settings-nav-support");
    expect(q("library-feedback")).toHaveLength(1);
    expect(q("settings-open-source")).toHaveLength(0);
    await click("settings-nav-about");
    // @req REL-UPD-05[parrot] the section opens on the installed version; the updater itself is tested in updates.test.tsx.
    expect(q("update-section")).toHaveLength(1);
    expect(q("settings-show-tour")).toHaveLength(1);
    // @req UX-SET-03[parrot] the open-source entry opens with the app's own licence and the link to its source code,
    // then the third-party code the app ships with its licence (Apple's ALAC decoder, Apache-2.0).
    const openSource = q("settings-open-source")[0];
    console.info(SUITE, "open source entry", openSource?.textContent);
    expect(openSource?.textContent).toMatch(/^Open-source software\s*Parrot is open source, under the GPL-3\.0 licence\. View the source code/);
    expect(openSource?.querySelector('[data-testid="open-source-link"]')?.getAttribute("href")).toBe("https://github.com/spacefleet-io/clients");
    expect(openSource?.textContent).toContain("Apache License 2.0");
    // @req UX-I18N-10[parrot] the language pickers' flag artwork is credited there too.
    expect(openSource?.textContent).toContain("Language flags: Noto Emoji artwork by Google, under the Apache License 2.0.");
    // @req UX-SET-02[parrot] @req META-SRC-09[parrot] the music data credits sit in the same place, the app's one credits
    // screen, as the metadata service sends them (main asks it for the window).
    expect(q("settings-credits")[0]?.textContent).toContain("Example Music Data");
    expect(window.parrot.sourceCredits).toHaveBeenCalledWith("parrot", "en");
    await click("settings-nav-account");
    expect(q("account-email")[0]?.textContent).toBe("Signed in as parrot-test@example.test");
    expect(q("library-plan")).toHaveLength(1);
    expect(q("library-pair-device")).toHaveLength(1);
    expect(q("settings-sign-out")).toHaveLength(1);
  });

  // @req PAR-NAV-01
  it("a finished or failed import lands in the notification tray", async () => {
    await mount();
    const listener = vi.mocked(window.parrot.onImportStatus).mock.calls[0]![0];
    await act(async () => listener({ running: false, phase: "failed", done: 0, total: 0, imported: 0, skipped: 0, failed: 0, error: "disk full" }));
    expect(q("nav-notifications-unread")).toHaveLength(1);
    await click("nav-notifications");
    console.info(SUITE, "tray", document.body.textContent?.includes("Import failed"));
    expect(document.body.textContent).toContain("Import failed");
    // The reason itself ("disk full") is on the import's card in the Jobs panel (UX-JOBS-01, import-jobs.test.tsx);
    // the strip that used to repeat it under the top bar is gone.
    expect(q("import-status")).toHaveLength(0);
  });
});

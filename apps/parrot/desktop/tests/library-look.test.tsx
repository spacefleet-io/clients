// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-LOOK-001
 * @level integration (real Library screen and shared top bar, real translator; `window.parrot` mocked)
 * @why Chris approved the Parrot design on 2026-11-08: the desktop library gets the fleet top bar with the Parrot logo
 *   that giggles on hover like Badger's and a centre Library tab, then "Library" with its counts, a search, the
 *   Albums / Artists / Songs chips over an album grid (no artist sidebar, no song table on top), album pages, and the
 *   bottom bar with the album art, the controls and the waveform seek bar. The e2e test ids (library-track,
 *   player-title, ...) stay on the elements that survived.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { profilesBridgeStub, stubProfile, type ProfilesBridgeStub } from "./profilesBridge";
import type { ApiProfile } from "@space/shared/profiles";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_BRAND_WIGGLE } from "@space/ui";
import type { ParrotState } from "../src/shared/ipc";
import Library, { waveBarsFor } from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-LOOK-001]";
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
const library = {
  snapshotVersion: 1,
  artists: [{ id: "art-1", name: "Test Band", albumCount: 2, trackCount: 3 }],
  albums: [
    { id: "alb-1", title: "First Light", artistId: "art-1", artistName: "Test Band", year: 2020, trackCount: 2, coverUrl: null, coverThumbUrl: null },
    {
      id: "alb-2",
      title: "Second Wind",
      artistId: "art-1",
      artistName: "Test Band",
      year: 2022,
      trackCount: 1,
      coverUrl: "parrot-cover://alb-2/large",
      coverThumbUrl: "parrot-cover://alb-2/small",
    },
  ],
  tracks: [track("t1", "Harbour", "alb-1", "First Light", 1), track("t2", "Lantern", "alb-1", "First Light", 2), track("t3", "Gale", "alb-2", "Second Wind", 1)],
};

describe("Parrot desktop look", () => {
  let container: HTMLDivElement;
  let root: Root;
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const q = (id: string) => container.querySelectorAll(`[data-testid="${id}"]`);

  /** The profile calls of the mounted window (one main profile unless a test mounts others). */
  let profiles: ProfilesBridgeStub;
  let signOut: Mock<() => Promise<ParrotState>>;
  const mount = async (start?: ApiProfile[]) => {
    profiles = profilesBridgeStub(start);
    signOut = vi.fn(async () => ({ ...state, user: null }));
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...profiles,
        signOut,
        getLibrary: vi.fn(async () => ({ ok: true, library })),
        getImportStatus: vi.fn(async () => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0 })),
        getImportScan: vi.fn(async () => null),
        getLyrics: vi.fn(async () => null),
        // A playing song without lyrics asks main for them, once (PAR-LYR-05).
        wantLyrics: vi.fn(async () => undefined),
        fetchLyrics: vi.fn(async () => ({ ok: true as const, outcome: "none" as const, lyrics: null })),
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
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Library t={translator("en")} state={state} onState={() => undefined} />));
    await flush();
    // The app opens on Home (PAR-HOME-01, its own suite); these tests start on the Library tab.
    await act(async () => (q("library-tab")[0] as HTMLButtonElement).click());
  };
  const remount = async (start: ApiProfile[]) => {
    act(() => root.unmount());
    container.remove();
    await mount(start);
  };
  const press = async (id: string) => {
    console.info(SUITE, "phase=click", id);
    await act(async () => (q(id)[0] as HTMLButtonElement).click());
    await flush();
  };

  beforeEach(async () => {
    await mount();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req PAR-LOOK-03
  // @req PAR-LOOK-02
  // @req PAR-LOOK-04
  // @req UX-TOP-02[parrot]
  it("the top bar carries the shared brand: the Parrot logo, named Parrot, giggling on hover", () => {
    const brand = container.querySelector('[data-testid="app-brand"]');
    console.info(SUITE, "brand", brand?.outerHTML.slice(0, 200), "style has wiggle:", brand?.querySelector("style")?.textContent?.includes(APP_BRAND_WIGGLE.name));
    expect(brand).not.toBeNull();
    expect(brand?.querySelector("img.app-brand-mark")?.getAttribute("src")).toBe("./icon.png");
    expect(brand?.textContent).toContain("Parrot");
    expect(brand?.querySelector("style")?.textContent).toContain(`${APP_BRAND_WIGGLE.name} ${APP_BRAND_WIGGLE.durationMs}ms ${APP_BRAND_WIGGLE.easing}`);
    expect(container.textContent).not.toMatch(/Space\s?Parrot/i);
    for (const id of ["library-import", "nav-jobs", "nav-notifications", "nav-settings", "profile-menu"]) expect(q(id)).toHaveLength(1);
    // UX-SET-01: there is no account button any more; the account lives in Settings.
    expect(q("nav-account")).toHaveLength(0);
    // UX-TOP-02: Sign out moved into the avatar menu; the words button left the bar.
    expect(q("library-sign-out")).toHaveLength(0);
    // The right of the bar is icons, as in the design (PAR-NAV-01): "+" (UX-ADD-01), the Jobs flask (UX-JOBS-01),
    // notifications, settings, then the current profile's avatar menu (UX-TOP-02). Plan, Pair a device, Send
    // feedback, Refresh and the language left the bar.
    const iconButtons = ["library-import", "nav-jobs", "nav-notifications", "nav-settings"];
    const named = iconButtons.map((id) => q(id)[0]?.getAttribute("aria-label"));
    console.info(SUITE, "icon button names", named);
    expect(named).toEqual(["Add music", "Jobs", "Notifications", "Settings"]);
    for (const id of iconButtons) expect(q(id)[0].textContent).toBe("");
    const header = container.querySelector("header") as HTMLElement;
    for (const id of ["library-plan", "library-pair-device", "library-feedback", "library-refresh", "library-language"]) expect(header.querySelector(`[data-testid="${id}"]`)).toBeNull();
  });

  // @req UX-TOP-02[parrot]
  // @req ACCT-PROF-05[parrot]
  it("the bar ends with the current profile's avatar menu, shown with one profile too: profiles, Add, Manage, Sign out", async () => {
    console.info(SUITE, "phase=single-profile");
    const header = container.querySelector("header") as HTMLElement;
    const trigger = q("profile-menu")[0] as HTMLButtonElement;
    const lastAction = [...header.querySelectorAll("button")].at(-1);
    console.info(SUITE, "trigger", trigger.outerHTML.slice(0, 300), "last bar button", lastAction?.getAttribute("data-testid"));
    expect(lastAction).toBe(trigger);
    expect(trigger.getAttribute("aria-label")).toBe("Profile menu (Chris)");
    expect(trigger.querySelector('[data-testid="profile-avatar"]')?.getAttribute("data-avatar")).toBe("badger");
    await press("profile-menu");
    const items = [...q("profile-menu-list")[0].querySelectorAll("[role^=menuitem]")].map((el) => el.getAttribute("data-testid"));
    console.info(SUITE, "single-profile items", items);
    expect(items).toEqual(["profile-menu-p-main", "profile-menu-add", "profile-menu-manage", "profile-menu-sign-out"]);
    expect(q("profile-menu-p-main")[0].getAttribute("aria-checked")).toBe("true");
    expect(q("profile-menu-sign-out")[0].textContent).toBe("Sign out");

    console.info(SUITE, "phase=two-profiles");
    await remount([stubProfile("p-main", "Chris", "badger", true), stubProfile("p-2", "Sam", "fox")]);
    await press("profile-menu");
    const rows = ["p-main", "p-2"].map((id) => q(`profile-menu-${id}`)[0]);
    const shown = rows.map((row) => `${row.textContent}:${row.getAttribute("aria-checked")}:${row.querySelector("img")?.getAttribute("data-avatar")}`);
    console.info(SUITE, "two-profile rows", shown);
    expect(shown).toEqual(["Chris:true:badger", "Sam:false:fox"]);
  });

  // @req UX-TOP-02[parrot]
  // @req ACCT-PROF-05[parrot]
  it("Add profile opens Settings on a new profile with the avatar chooser; the pick is saved with it", async () => {
    await press("profile-menu");
    await press("profile-menu-add");
    console.info(SUITE, "after add", q("settings-page").length, q("profile-edit").length, q("avatar-chooser").length);
    expect(q("settings-page")).toHaveLength(1);
    expect(q("profile-edit")).toHaveLength(1);
    expect(q("avatar-chooser")[0].querySelectorAll('[data-testid^="avatar-option-"]')).toHaveLength(22);
    await press("avatar-option-owl");
    expect(q("profile-avatar-preview")[0].getAttribute("data-avatar")).toBe("owl");
    const input = q("profile-name-input")[0] as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Robin");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("profile-save");
    console.info(SUITE, "createProfile calls", JSON.stringify(profiles.createProfile.mock.calls));
    expect(profiles.createProfile).toHaveBeenCalledWith({ name: "Robin", avatarId: "owl", features: { avatars: "set" } });
    expect(q("profile-row-p-2")[0].querySelector('[data-testid="profile-avatar"]')?.getAttribute("data-avatar")).toBe("owl");
  });

  // @req UX-TOP-02[parrot]
  it("Manage profiles opens Settings ▸ Account on the profiles; Sign out signs out", async () => {
    await press("profile-menu");
    await press("profile-menu-manage");
    console.info(SUITE, "after manage", q("settings-profiles").length, q("profile-edit").length);
    expect(q("settings-profiles")).toHaveLength(1);
    expect(q("profile-row-p-main")).toHaveLength(1);
    expect(q("profile-edit")).toHaveLength(0);
    await press("profile-menu");
    await press("profile-menu-sign-out");
    console.info(SUITE, "signOut calls", signOut.mock.calls.length);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  // @req UX-ADD-01[parrot]
  it("the + opens the file-or-folder picker, and picked song files go to the confirm scan", async () => {
    const scanned = { running: true, phase: "scanning", done: 0, total: 1, imported: 0, skipped: 0, failed: 0 };
    const scanImport = vi.fn(async (_paths: string[]) => scanned);
    Object.assign(window.parrot, { pickFiles: vi.fn(async () => ["/tmp/one-song.mp3"]), pickFolders: vi.fn(async () => []), scanImport });
    await act(async () => (q("library-import")[0] as HTMLButtonElement).click());
    await flush();
    const picker = document.querySelector('[data-testid="import-picker"]');
    console.info(SUITE, "picker text", picker?.textContent);
    expect(picker?.textContent).toContain("Choose files");
    expect(picker?.textContent).toContain("Choose a folder");
    await act(async () => (document.querySelector('[data-testid="import-pick-files"]') as HTMLButtonElement).click());
    await flush();
    console.info(SUITE, "scanImport calls", scanImport.mock.calls);
    expect(scanImport).toHaveBeenCalledWith(["/tmp/one-song.mp3"]);
    expect(document.querySelector('[data-testid="import-picker"]')).toBeNull();
    // UX-JOBS-01: no strip under the top bar; the import shows in the Jobs panel.
    expect(q("import-status")).toHaveLength(0);
  });

  // @req PAR-LOOK-01
  // @req PAR-LOOK-04
  // @req PAR-NAV-01
  // @req PAR-PL-02
  it("the centre of the top bar holds the Home, Library and Playlists tabs, the open one marked; icon only below 1024px", () => {
    const header = container.querySelector("header") as HTMLElement;
    const tabs = [...header.querySelectorAll("nav button")];
    console.info(SUITE, "top bar tabs", tabs.map((el) => `${el.textContent}:${el.getAttribute("aria-current")}`));
    expect(tabs).toEqual([q("home-tab")[0], q("library-tab")[0], q("playlists-tab")[0]]);
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["Home", "Library", "Playlists"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-current"))).toEqual([null, "page", null]);
    for (const tab of tabs) expect(tab.querySelector("span")?.className).toBe("hidden lg:inline");
  });

  // @req PAR-LOOK-01
  // @req PAR-LIB-06
  it("opens on Library with its row of switch, quiet counts, Filter and Sort, no title or search, and the album grid", () => {
    const counts = q("library-counts")[0]?.textContent;
    console.info(SUITE, "counts", counts, "tracks shown", q("library-track").length, "row", q("library-row")[0]?.textContent);
    expect(container.querySelector('[data-testid="library-heading"]')).toBeNull();
    expect(q("library-search")).toHaveLength(0);
    expect(q("library-filter-button")).toHaveLength(1);
    expect(q("library-sort-button")).toHaveLength(1);
    expect(q("library-view-cycle")).toHaveLength(0);
    expect(counts).toBe("2 albums · 3 songs · 1 artist");
    expect(container.querySelector('nav[aria-label="Artists"]')).toBeNull();
    expect(container.textContent).not.toContain("All artists");
    expect(q("library-track")).toHaveLength(0);
    // auto-fill tiles of at least 10.5rem: 7 a row at 1440px, as in the design.
    expect(q("library-albums")[0].className).toContain("grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]");
    const tiles = [...q("library-album")];
    expect(tiles.map((tile) => tile.querySelector("p")?.textContent)).toEqual(["First Light", "Second Wind"]);
    expect(tiles[0].querySelector('[data-testid="parrot-cover"]')?.getAttribute("data-cover")).toBe("drawn");
    // Tiles show the small copy of the cover (PAR-META-04).
    expect(tiles[1].querySelector('[data-testid="parrot-cover-image"]')?.getAttribute("src")).toBe("parrot-cover://alb-2/small");
  });

  // @req PAR-LOOK-01
  // @req PAR-LIB-06
  it("the Albums / Artists / Songs switch moves between the album grid, the artist grid and the song list", async () => {
    const chips = ["library-chip-albums", "library-chip-artists", "library-chip-songs"].map((id) => q(id)[0] as HTMLButtonElement);
    console.info(SUITE, "chips", chips.map((chip) => `${chip.textContent}:${chip.getAttribute("aria-selected")}`));
    expect(chips.map((chip) => chip.textContent)).toEqual(["Albums", "Artists", "Songs"]);
    expect(chips.map((chip) => chip.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);

    await act(async () => chips[1].click());
    expect(q("library-album")).toHaveLength(0);
    expect([...q("library-artist")].map((tile) => tile.textContent)).toEqual(["Test Band2 albums · 3 songs"]);

    await act(async () => chips[2].click());
    // Songs open sorted by Title (PAR-LIB-06).
    expect([...q("library-track")].map((row) => row.querySelector(".font-medium")?.textContent)).toEqual(["Gale", "Harbour", "Lantern"]);
  });

  // @req PAR-LIB-06
  it("the row pins under the top bar: sticky, flush with the top of the scrolling <main> (minus its 32px padding)", () => {
    const row = q("library-toolbar")[0] as HTMLElement;
    console.info(SUITE, "toolbar", row.className, row.style.top, row.getAttribute("data-pinned"));
    expect(row.className).toContain("sticky");
    expect(row.style.top).toBe("-32px");
    expect(row.getAttribute("data-pinned")).toBe("false");
  });

  // @req PAR-LOOK-01
  it("an album tile opens the album; playing it rings the tile and shows art and the waveform in the bottom bar", async () => {
    await act(async () => (q("library-album")[1] as HTMLButtonElement).click());
    console.info(SUITE, "album page", [...q("library-track")].map((row) => row.textContent));
    expect(q("album-title")[0]?.textContent).toBe("Second Wind");
    expect(q("library-track")).toHaveLength(1);
    // The album page header shows the large copy.
    const header = q("album-title")[0]?.closest("section");
    console.info(SUITE, "album page cover", header?.querySelector('[data-testid="parrot-cover-image"]')?.getAttribute("src"));
    expect(header?.querySelector('[data-testid="parrot-cover-image"]')?.getAttribute("src")).toBe("parrot-cover://alb-2/large");

    await act(async () => (q("library-play-all")[0] as HTMLButtonElement).click());
    await flush();
    const player = container.querySelector('[data-testid="player"]');
    console.info(SUITE, "player", player?.textContent);
    expect(container.querySelector('[data-testid="player-title"]')?.textContent).toContain("Gale");
    expect(player?.querySelector('[data-testid="parrot-cover-image"]')?.getAttribute("src")).toBe("parrot-cover://alb-2/small");
    const seek = player?.querySelector('[data-testid="player-seek"]');
    expect(seek?.getAttribute("role")).toBe("slider");
    expect(seek?.getAttribute("aria-label")).toBe("Position in the song");
    expect(seek?.children.length).toBe(96);

    await act(async () => (q("library-back")[0] as HTMLButtonElement).click());
    const tiles = [...q("library-album")];
    expect(tiles.map((tile) => tile.getAttribute("data-playing"))).toEqual(["false", "true"]);
    expect(tiles[1].querySelector('[data-testid="parrot-cover"]')?.className).toContain("outline-primary");
    expect(tiles[1].querySelector(".parrot-eq")).not.toBeNull();
  });

  // @req PAR-LOOK-01
  it("the Library tab takes an open album back to the library", async () => {
    await act(async () => (q("library-album")[0] as HTMLButtonElement).click());
    expect(q("album-title")[0]?.textContent).toBe("First Light");
    await act(async () => (q("library-tab")[0] as HTMLButtonElement).click());
    expect(q("library-toolbar")).toHaveLength(1);
    expect(q("library-album")).toHaveLength(2);
  });

  // Chris, 2026-11-09 hand-try: the header search opens an Alfred-style palette, typo-tolerant, in Parrot as in Badger.
  // @req UX-SEARCH-01[parrot]
  it("the top-bar search opens the palette; 'secnd wind' finds the album live and Enter opens it", async () => {
    Element.prototype.scrollIntoView = () => undefined;
    await act(async () => (q("parrot-top-nav-search")[0] as HTMLButtonElement).click());
    const input = document.querySelector('[data-testid="search-palette-input"]') as HTMLInputElement;
    console.info(SUITE, "palette open", Boolean(input));
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "secnd wind");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const rows = [...document.querySelectorAll('[data-testid="search-palette-result"]')].map((row) => row.textContent);
    console.info(SUITE, "palette rows", rows);
    expect(rows[0]).toContain("Second Wind");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(q("album-title")[0]?.textContent).toBe("Second Wind");
    expect(document.querySelector('[data-testid="search-palette"]')).toBeNull();
  });

  // @req PAR-LOOK-04
  // @req UX-JOBS-01[parrot]
  it("no import strip under the top bar: a running import turns the Jobs flask into a spinner with its count", async () => {
    const statusListener = vi.mocked(window.parrot.onImportStatus).mock.calls[0]![0];
    await act(async () => statusListener({ running: false, phase: "done", done: 9, total: 9, imported: 9, skipped: 0, failed: 0 } as never));
    const jobsListener = vi.mocked(window.parrot.onImportJobs).mock.calls[0]![0];
    const running = { running: true, phase: "uploading", done: 2, total: 9, imported: 0, skipped: 0, failed: 0, bytesDone: 0, bytesTotal: 0, published: 0, currentFile: null, error: null };
    await act(async () => jobsListener([{ id: "j1", sources: ["/music/Album"], startedAt: 1, finishedAt: null, status: running, failures: [] }] as never));
    const header = container.querySelector("header");
    const jobs = q("nav-jobs")[0];
    console.info(SUITE, "strip", q("import-status").length, "jobs icon", jobs?.outerHTML.slice(0, 300));
    expect(q("import-status")).toHaveLength(0);
    expect(header?.contains(jobs ?? null)).toBe(true);
    expect(q("nav-jobs-running")).toHaveLength(1);
    expect(jobs?.textContent).toBe("1");
  });

  // @req PAR-LOOK-04
  it("the waveform still shows in an 800px window: the bar count follows the width the bar leaves it", async () => {
    // At 800px the wave gets about 140px; 96 bars with 2px gaps need 190px of gaps alone, so every bar shrank to nothing.
    const fits = (width: number) => waveBarsFor(width) * 3 + (waveBarsFor(width) - 1) * 2 <= width;
    console.info(SUITE, "bars for 100/140/300/600px", [100, 140, 300, 600].map(waveBarsFor));
    expect(waveBarsFor(140)).toBe(28);
    expect(waveBarsFor(600)).toBe(96);
    for (const width of [80, 100, 140, 200, 300, 478]) expect(fits(width)).toBe(true);

    // The bar measures its slot: give it 140px and the wave redraws with bars that fit.
    let report: ResizeObserverCallback = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          report = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    await act(async () => (q("library-album")[0] as HTMLButtonElement).click());
    await act(async () => (q("library-play-all")[0] as HTMLButtonElement).click());
    await flush();
    await act(async () => report([{ contentRect: { width: 140 } } as ResizeObserverEntry], {} as ResizeObserver));
    const seek = q("player-seek")[0];
    console.info(SUITE, "bars at 140px", seek?.children.length);
    expect(seek?.children.length).toBe(28);
    vi.unstubAllGlobals();
  });

  // @req PAR-LOOK-01
  it("the fleet fonts load through Vite (main.tsx), not through styles.css where the font files were never emitted", () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer/src");
    const main = readFileSync(resolve(src, "main.tsx"), "utf8");
    const styles = readFileSync(resolve(src, "styles.css"), "utf8");
    console.info(SUITE, "main imports fonts:", main.includes('import "@space/ui/styles/fleet-fonts.css"'), "styles imports fonts:", styles.includes("fleet-fonts.css"));
    expect(main).toContain('import "@space/ui/styles/fleet-fonts.css";');
    expect(styles).not.toContain("fleet-fonts.css");
  });
});

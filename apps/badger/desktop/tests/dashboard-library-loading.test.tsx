// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-LIBLOAD-001
 * @level integration (real Home page, real verdict; the library provider, jobs and player mocked)
 * @bugfix library-empty-before-load @regression-proof
 * @why Chris, 2026-11-18: "When I opened Badger, it first showed me an 'empty library, upload your first media on
 *   desktop' screen before loading the library. This is confusing. If the user already has media, the app should never
 *   show this screen, but instead the same initial loading screen (floating badger) with a 'Loading library' message."
 *   Home showed nothing (or, for a frame, the empty library) while the library opened, because "nothing listed yet"
 *   read as "empty": `loading` alone decided, and the list it judged was a deferred copy that could still be the
 *   empty list of before the load. Home now shows the hovering badger above "Loading library…" until the load has
 *   given its verdict, the empty library only once it says empty, and the titles as soon as there are any.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOG = "[BADGER-DESKTOP-LIBLOAD-001]";

type Row = { id: string; title: string; type: "movie" | "tv"; addedAt: string; hasFiles: boolean; year: string };
// Every hook below hands back the same object on each render, as the real providers do: a fresh `[]`, Map or
// actions object per render re-fires Dashboard's effects forever (the run spins and eats gigabytes).
const lib = vi.hoisted(() => ({
  loading: true,
  error: null as string | null,
  media: [] as Row[],
  playlists: [] as never[],
  jobs: { activeJobs: [] as never[], completedJobs: [] as never[] },
  ingestion: { openIngestion: () => undefined },
  offline: new Map(),
  playback: {
    handlePlayMedia: () => undefined,
    pendingPlayId: null,
    playPending: false,
    playSpinnerVisible: false,
    playbackMount: null,
  },
  actions: {
    listPlaylistItems: () => [],
    getSystemPlaylistId: () => null,
    getSharedSetting: () => null,
    setSharedSetting: async () => undefined,
  },
}));

vi.mock("react-i18next", () => {
  const translation = { t: (key: string) => key, i18n: { language: "en" } };
  return { useTranslation: () => translation };
});
vi.mock("@/lib/libraryContext", async () => {
  const { dedupeMediaByIdentity } = await vi.importActual<typeof import("../src/renderer/src/lib/libraryMediaDedupe")>(
    "../src/renderer/src/lib/libraryMediaDedupe"
  );
  return {
    dedupeMediaByIdentity,
    isOfflineModeFallbackMessage: () => false,
    isSyncUnavailableFallbackMessage: () => false,
    splitMedia: (items: Row[]) => ({
      movies: items.filter((item) => item.type !== "tv"),
      tv: items.filter((item) => item.type === "tv"),
    }),
    useLibraryShell: () => ({ loading: lib.loading, error: lib.error }),
    useLibraryData: () => ({ media: lib.media, playlists: lib.playlists }),
    useLibraryActions: () => lib.actions,
  };
});
vi.mock("@/lib/labJobs", () => ({ useLabJobsData: () => lib.jobs }));
vi.mock("@/lib/ingestionContext", () => ({ useIngestion: () => lib.ingestion }));
vi.mock("@/lib/offlineState", () => ({ useOfflineStateByMediaId: () => lib.offline }));
vi.mock("@/lib/useLibraryOnline", () => ({ useLibraryOnline: () => true, titleUnavailableOffline: () => false }));
vi.mock("@/lib/useInlinePlayback", () => ({ useInlinePlayback: () => lib.playback }));
vi.mock("@/components/MediaImage", () => ({ default: ({ alt }: { alt?: string }) => <img alt={alt ?? ""} /> }));
vi.mock("@/components/DashboardContinueHero", () => ({ default: () => null }));
vi.mock("../src/renderer/src/components/TopNav", () => ({ default: () => null }));
vi.mock("@space/desktop-shell/tour", () => ({ DesktopTourHost: () => null }));

import Dashboard from "../src/renderer/src/pages/Dashboard";

const row = (id: string, title: string): Row => ({
  id,
  title,
  type: "movie",
  addedAt: "2026-11-01T00:00:00.000Z",
  hasFiles: true,
  year: "2001",
});

// @req UX-WAIT-04
describe("Badger desktop Home while the library opens (UX-WAIT-04)", () => {
  let container: HTMLDivElement;
  let root: Root;

  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  const dump = (label: string) => {
    console.info(
      `${LOG} ${label} state=${JSON.stringify({ loading: lib.loading, error: lib.error, media: lib.media.map((m) => m.id) })}`
    );
    console.info(
      `${LOG} ${label} seen=${JSON.stringify({
        loader: Boolean(q("library-loading")),
        mascot: Boolean(q("mascot-loader-badger")),
        empty: Boolean(q("empty-library")),
        addMedia: Boolean(q("empty-library-add-media")),
      })}`
    );
    console.info(`${LOG} ${label} text=${JSON.stringify(container.textContent?.slice(0, 400))}`);
  };
  const render = async (label: string) => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/home"]}>
          <Dashboard />
        </MemoryRouter>
      );
    });
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    dump(label);
  };

  beforeEach(() => {
    lib.loading = true;
    lib.error = null;
    lib.media = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    console.info(`${LOG} mount`);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    console.info(`${LOG} unmount`);
  });

  it("shows the hovering badger above 'Loading library…' while the first load runs, never the empty library", async () => {
    await render("loading");
    expect(q("empty-library")).toBeNull();
    expect(q("empty-library-add-media")).toBeNull();
    expect(q("library-loading")).not.toBeNull();
    expect(q("library-loading")?.querySelector('[data-testid="mascot-loader-badger"]')).not.toBeNull();
    expect(q("library-loading")?.textContent).toContain("library.loading");
  });

  it("shows the empty library once the load has finished with no title", async () => {
    await render("loading-before-empty");
    expect(q("empty-library")).toBeNull();
    lib.loading = false;
    await render("settled-empty");
    expect(q("library-loading")).toBeNull();
    expect(q("empty-library")).not.toBeNull();
    expect(q("empty-library-add-media")).not.toBeNull();
  });

  it("never flashes the empty library on the render where the first load lands (deferred list still empty)", async () => {
    await render("loading-before-landing");
    // Every node React adds, even one a later commit removes: the urgent commit where `loading` turns false while
    // the deferred copy of the list is still the empty one of before the load.
    const flashed: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const hit = node.matches('[data-testid="empty-library"]') ? node : node.querySelector('[data-testid="empty-library"]');
          if (hit) flashed.push(hit.textContent?.slice(0, 80) ?? "");
        }
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    lib.loading = false;
    lib.media = [row("m1", "Spirited Away"), row("m2", "Paprika")];
    await render("landed-with-titles");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    observer.disconnect();
    console.info(`${LOG} landed-with-titles empty-library flashes=${JSON.stringify(flashed)}`);
    expect(flashed).toEqual([]);
    expect(container.textContent).toContain("Spirited Away");
  });

  it("shows the titles, not the loader nor the empty library, as soon as the library lists some", async () => {
    lib.media = [row("m1", "Spirited Away"), row("m2", "Paprika")];
    await render("loading-with-saved-titles");
    expect(q("library-loading")).toBeNull();
    expect(q("empty-library")).toBeNull();
    expect(container.textContent).toContain("Spirited Away");
    lib.loading = false;
    await render("settled-with-titles");
    expect(q("library-loading")).toBeNull();
    expect(q("empty-library")).toBeNull();
    expect(container.textContent).toContain("Paprika");
  });
});

// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-CONTINUE-HERO-001
 * @level integration (real Home page and its real Continue watching pick; the library provider, jobs and player mocked)
 * @why The Home hero shows the first Continue watching title (UX-HOME-01): started and under 95%, watched last first,
 *   playable titles only; offline, only a title that is on this computer (OFFL-PLAY-03). This renders the real Home
 *   page and reads which title the hero gets, instead of checking the page's source text.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOG = "[BADGER-DESKTOP-CONTINUE-HERO-001]";

type Row = {
  id: string;
  title: string;
  type: "movie" | "tv";
  addedAt: string;
  hasFiles: boolean;
  year: string;
  progressPct: number;
  lastWatchedAt: string | null;
};
// Every hook below hands back the same object on each render, as the real providers do: a fresh `[]`, Map or
// actions object per render re-fires Dashboard's effects forever.
const lib = vi.hoisted(() => ({
  media: [] as Row[],
  online: true,
  playlists: [] as never[],
  jobs: { activeJobs: [] as never[], completedJobs: [] as never[] },
  ingestion: { openIngestion: () => undefined },
  offline: new Map<string, string>(),
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
    useLibraryShell: () => ({ loading: false, error: null }),
    useLibraryData: () => ({ media: lib.media, playlists: lib.playlists }),
    useLibraryActions: () => lib.actions,
  };
});
vi.mock("@/lib/labJobs", () => ({ useLabJobsData: () => lib.jobs }));
vi.mock("@/lib/ingestionContext", () => ({ useIngestion: () => lib.ingestion }));
vi.mock("@/lib/offlineState", () => ({ useOfflineStateByMediaId: () => lib.offline }));
// Offline, a title counts as unavailable when it is not on this computer ("remote" in this stand-in).
vi.mock("@/lib/useLibraryOnline", () => ({
  useLibraryOnline: () => lib.online,
  titleUnavailableOffline: (online: boolean, state: string | undefined) => !online && state !== "local",
}));
vi.mock("@/lib/useInlinePlayback", () => ({ useInlinePlayback: () => lib.playback }));
vi.mock("@/components/MediaImage", () => ({ default: ({ alt }: { alt?: string }) => <img alt={alt ?? ""} /> }));
// The hero's own look has its tests (home-detail-visuals-source); here it shows which title Home handed it.
vi.mock("@/components/DashboardContinueHero", () => ({
  default: ({ item }: { item: Row }) => <div data-testid="continue-hero">{item.title}</div>,
}));
vi.mock("../src/renderer/src/components/TopNav", () => ({ default: () => null }));
vi.mock("@space/desktop-shell/tour", () => ({ DesktopTourHost: () => null }));

import Dashboard from "../src/renderer/src/pages/Dashboard";

const row = (id: string, progressPct: number, lastWatchedAt: string | null, hasFiles = true): Row => ({
  id,
  title: `Title ${id}`,
  type: "movie",
  addedAt: "2026-11-01T00:00:00.000Z",
  hasFiles,
  year: "1926",
  progressPct,
  lastWatchedAt,
});

describe("Home continue-watching hero (UX-HOME-01)", () => {
  let container: HTMLDivElement;
  let root: Root;

  const hero = () => container.querySelector('[data-testid="continue-hero"]');
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
    console.info(
      `${LOG} ${label} media=${JSON.stringify(lib.media.map((m) => [m.id, m.progressPct, m.lastWatchedAt, m.hasFiles]))} online=${lib.online} hero=${JSON.stringify(hero()?.textContent ?? null)}`
    );
  };

  beforeEach(() => {
    lib.media = [];
    lib.online = true;
    lib.offline = new Map();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // @req UX-HOME-01[badger-desktop]
  it("shows the in-progress playable title watched most recently", async () => {
    lib.media = [
      row("old", 40, "2026-11-01T10:00:00.000Z"),
      row("new", 30, "2026-11-08T10:00:00.000Z"),
      row("unplayable", 50, "2026-11-09T10:00:00.000Z", false),
      row("finished", 99, "2026-11-09T11:00:00.000Z"),
      row("unstarted", 0, null),
    ];
    await render("mixed");
    expect(hero()?.textContent).toBe("Title new");
  });

  // @req UX-HOME-01[badger-desktop]
  it("shows no hero when nothing is in progress", async () => {
    lib.media = [row("unstarted", 0, null), row("finished", 99, "2026-11-09T11:00:00.000Z")];
    await render("nothing-in-progress");
    expect(hero()).toBeNull();
  });

  // @req OFFL-PLAY-03[badger-desktop]
  it("offline, shows the most recent in-progress title that is on this computer", async () => {
    lib.online = false;
    lib.media = [row("on-disk", 40, "2026-11-01T10:00:00.000Z"), row("remote-only", 30, "2026-11-08T10:00:00.000Z")];
    lib.offline = new Map([["on-disk", "local"], ["remote-only", "remote"]]);
    await render("offline");
    expect(hero()?.textContent).toBe("Title on-disk");
  });
});

// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-NORATING-001
 * @level integration (real Home page; the library provider, jobs and player mocked)
 * @bugfix no-ratings @regression-proof
 * @why Chris, 2026-11-26: a rating pill sat on Peaky Blinders' poster on desktop Home. META-SRC-05: no app shows any
 *   rating or score. The synced library rows still carry the old `rating` value; Home must show none of it.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOG = "[BADGER-DESKTOP-NORATING-001]";

type Row = {
  id: string;
  title: string;
  type: "movie" | "tv";
  addedAt: string;
  hasFiles: boolean;
  year: string;
  rating: number;
  posterPath: string;
};
// Same stable-object rule as dashboard-library-loading.test.tsx: a fresh object per render re-fires Home's effects forever.
const lib = vi.hoisted(() => ({
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
  const translation = { t: (key: string) => key, i18n: { language: "fr" } };
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
vi.mock("@/lib/useLibraryOnline", () => ({ useLibraryOnline: () => true, titleUnavailableOffline: () => false }));
vi.mock("@/lib/useInlinePlayback", () => ({ useInlinePlayback: () => lib.playback }));
vi.mock("@/components/MediaImage", () => ({ default: ({ alt }: { alt?: string }) => <img alt={alt ?? ""} /> }));
vi.mock("@/components/DashboardContinueHero", () => ({ default: () => null }));
vi.mock("../src/renderer/src/components/TopNav", () => ({ default: () => null }));
vi.mock("@space/desktop-shell/tour", () => ({ DesktopTourHost: () => null }));

import Dashboard from "../src/renderer/src/pages/Dashboard";

const row = (id: string, title: string, type: "movie" | "tv", rating: number, year: string): Row => ({
  id,
  title,
  type,
  addedAt: "2026-11-01T00:00:00.000Z",
  hasFiles: true,
  year,
  rating,
  posterPath: `/${id}.jpg`,
});

describe("Badger desktop Home shows no rating (META-SRC-05)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("@req META-SRC-05[badger-desktop] a title whose synced row holds a rating shows no rating on its Home card", async () => {
    lib.media = [row("peaky", "Peaky Blinders", "tv", 8.8, "2013"), row("arrival", "Arrival", "movie", 7.94, "2016")];
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
    const text = container.textContent ?? "";
    console.info(`${LOG} rows=${JSON.stringify(lib.media.map(({ id, rating }) => ({ id, rating })))}`);
    console.info(`${LOG} text=${JSON.stringify(text.slice(0, 600))}`);
    console.info(`${LOG} html=${container.innerHTML.slice(0, 4000)}`);
    expect(text).toContain("Peaky Blinders");
    expect(text).toContain("Arrival");
    expect(text).not.toContain("★");
    expect(text).not.toMatch(/8[.,]8|7[.,]9/);
    expect(container.querySelector('[aria-label*="rating" i], [title*="rating" i], [data-testid*="rating" i]')).toBeNull();
  });
});

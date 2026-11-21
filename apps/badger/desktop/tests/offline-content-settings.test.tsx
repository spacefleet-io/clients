// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-OFFLINE-CONTENT-001
 * @level integration (real section, real offline store, real shared list + confirm dialog; offline IPC and library mocked)
 * @why OFFL-MANAGE-01: Settings › Manage offline content lists the films, shows › seasons › episodes saved on this
 *   computer with their size and the total at the top; each row removes through `badger.offline.delete_local` (whole
 *   title, one season, one file), "Remove all" asks first, and the list (and the library badges, same store) follow.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLocalizedStorage } from "@space/shared/format";
import type { BadgerOfflineTitle } from "@space/shared/offlineManage";
import { __resetOfflineStateForTests } from "../src/renderer/src/lib/offlineState";
import OfflineContentSection from "../src/renderer/src/components/settings/sections/OfflineContentSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[BADGER-DESKTOP-OFFLINE-CONTENT-001]";

const { listMock, deleteMock, toastError } = vi.hoisted(() => ({ listMock: vi.fn(), deleteMock: vi.fn(), toastError: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    i18n: { language: "en" },
  }),
}));
vi.mock("../src/renderer/src/lib/offlineIpc", () => ({
  callOfflineListLocal: (...args: unknown[]) => listMock(...args),
  callOfflineDeleteLocal: (...args: unknown[]) => deleteMock(...args),
  isOfflineIpcError: (v: unknown) => !!v && typeof v === "object" && (v as { __runtimeJobsError?: unknown }).__runtimeJobsError === true,
}));
vi.mock("../src/renderer/src/logger", () => ({
  rendererLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("../src/renderer/src/components/MediaImage", () => ({
  default: ({ path }: { path: string | null }) => <img data-testid="poster" data-path={path ?? ""} alt="" />,
}));
vi.mock("@space/ui", () => ({ toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn() }) }));

const details: Record<string, BadgerOfflineTitle & { id: string }> = {
  "m-1": { id: "m-1", type: "movie", title: "Zodiac", posterPath: "/z.jpg", files: [{ id: "f-movie", season: null, episode: null }], seasons: [], episodes: [] },
  "s-1": {
    id: "s-1",
    type: "tv",
    title: "Andor",
    posterPath: "/a.jpg",
    files: [
      { id: "f-s1e1", season: 1, episode: 1 },
      { id: "f-s1e2", season: 1, episode: 2 },
      { id: "f-s2e1", season: 2, episode: 1 },
    ],
    seasons: [
      { seasonNumber: 1, name: "Season 1", posterPath: null },
      { seasonNumber: 2, name: "Season 2", posterPath: null },
    ],
    episodes: [
      { seasonNumber: 1, episodeNumber: 1, name: "Kassa" },
      { seasonNumber: 1, episodeNumber: 2, name: "That Would Be Me" },
      { seasonNumber: 2, episodeNumber: 1, name: "One Year Later" },
    ],
  },
};
const fetchMediaDetails = vi.fn(async () => null);
// Mirrors the real context split: the media list is data, the details getters are actions (the first version read
// the getters off useLibraryData and crashed live with "getMediaDetails is not a function").
vi.mock("../src/renderer/src/lib/libraryContext", () => ({
  useLibraryData: () => ({ media: [] }),
  useLibraryActions: () => ({ getMediaDetails: (id: string) => details[id] ?? null, fetchMediaDetails }),
}));

const MB = 1_000_000;
const entry = (mediaId: string, fileId: string, totalBytes: number) => ({
  mediaId,
  fileId,
  quality: "1080p",
  container: "mkv" as const,
  totalBytes,
  downloadedAt: "2026-11-21T00:00:00Z",
  localPath: `/offline/${fileId}`,
});
let saved = [entry("m-1", "f-movie", 900 * MB), entry("s-1", "f-s1e1", 300 * MB), entry("s-1", "f-s1e2", 200 * MB), entry("s-1", "f-s2e1", 400 * MB)];

let container: HTMLDivElement;
let root: Root;
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => await Promise.resolve());
};
const q = (testId: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const rowByKey = (key: string) => document.querySelector<HTMLElement>(`[data-row-key="${key}"]`)!;
const own = (row: HTMLElement, testId: string) => row.querySelector<HTMLElement>(`:scope > div [data-testid="${testId}"]`)!;
const snapshot = () => ({
  total: q("offline-content-total")[0]?.textContent,
  rows: q("offline-content-row").map((row) => `${row.dataset.rowKey}=${own(row, "offline-content-size").textContent}`),
  empty: q("offline-content-empty")[0]?.textContent ?? null,
});
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};

beforeEach(async () => {
  __resetOfflineStateForTests();
  listMock.mockImplementation(async () => ({ entries: saved }));
  deleteMock.mockImplementation(async ({ scope }: { scope: { type: string; fileId?: string; mediaId?: string; seasonNumber?: number } }) => {
    const before = saved.length;
    saved = saved.filter((item) => {
      if (scope.type === "file") return item.fileId !== scope.fileId;
      if (scope.type === "media") return item.mediaId !== scope.mediaId;
      const season = details[item.mediaId]?.files.find((file) => file.id === item.fileId)?.season;
      return !(item.mediaId === scope.mediaId && season === scope.seasonNumber);
    });
    return { deleted: before - saved.length, freedBytes: 0, cancelledJobIds: [] };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  saved = [entry("m-1", "f-movie", 900 * MB), entry("s-1", "f-s1e1", 300 * MB), entry("s-1", "f-s1e2", 200 * MB), entry("s-1", "f-s2e1", 400 * MB)];
});

const mount = async () => {
  await act(async () => root.render(<OfflineContentSection />));
  await flush();
};

describe(SUITE, () => {
  it("lists shows › seasons › episodes and films with sizes and the total; removing an episode frees it and the total follows", async () => {
    await mount();
    console.log(`${SUITE} phase=mounted`, JSON.stringify(snapshot()));
    expect(snapshot().total).toBe(formatLocalizedStorage(1800 * MB, "en"));
    expect(snapshot().rows).toEqual([`show:s-1=${formatLocalizedStorage(900 * MB, "en")}`, `movie:m-1=${formatLocalizedStorage(900 * MB, "en")}`]);

    await click(own(rowByKey("show:s-1"), "offline-content-toggle"));
    await click(own(rowByKey("season:s-1:1"), "offline-content-toggle"));
    console.log(`${SUITE} phase=expanded`, JSON.stringify(snapshot()));
    expect(snapshot().rows).toEqual([
      `show:s-1=${formatLocalizedStorage(900 * MB, "en")}`,
      `season:s-1:1=${formatLocalizedStorage(500 * MB, "en")}`,
      `episode:f-s1e1=${formatLocalizedStorage(300 * MB, "en")}`,
      `episode:f-s1e2=${formatLocalizedStorage(200 * MB, "en")}`,
      `season:s-1:2=${formatLocalizedStorage(400 * MB, "en")}`,
      `movie:m-1=${formatLocalizedStorage(900 * MB, "en")}`,
    ]);
    expect(own(rowByKey("episode:f-s1e2"), "offline-content-name").textContent).toBe("That Would Be Me");

    await click(own(rowByKey("episode:f-s1e2"), "offline-content-remove"));
    console.log(`${SUITE} phase=removed-episode`, JSON.stringify({ calls: deleteMock.mock.calls, ...snapshot() }));
    expect(deleteMock).toHaveBeenCalledWith({ scope: { type: "file", fileId: "f-s1e2" } });
    expect(snapshot().total).toBe(formatLocalizedStorage(1600 * MB, "en"));
    expect(rowByKey("episode:f-s1e2")).toBeNull();

    await click(own(rowByKey("season:s-1:2"), "offline-content-remove"));
    console.log(`${SUITE} phase=removed-season`, JSON.stringify({ calls: deleteMock.mock.calls, ...snapshot() }));
    expect(deleteMock).toHaveBeenLastCalledWith({ scope: { type: "season", mediaId: "s-1", seasonNumber: 2 } });
    expect(snapshot().total).toBe(formatLocalizedStorage(1200 * MB, "en"));

    await click(own(rowByKey("movie:m-1"), "offline-content-remove"));
    expect(deleteMock).toHaveBeenLastCalledWith({ scope: { type: "media", mediaId: "m-1" } });
    expect(snapshot().total).toBe(formatLocalizedStorage(300 * MB, "en"));
  });

  it("Remove all asks first: cancel keeps everything, confirm removes every title and shows the empty text", async () => {
    await mount();
    await click(q("offline-content-remove-all")[0]);
    console.log(`${SUITE} phase=confirm-open`, document.querySelector('[data-testid="offline-content-confirm"]')?.textContent);
    expect(q("offline-content-confirm")).toHaveLength(1);
    await click(q("offline-content-confirm-cancel")[0]);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(q("offline-content-confirm")).toHaveLength(0);

    await click(q("offline-content-remove-all")[0]);
    await click(q("offline-content-confirm-remove")[0]);
    console.log(`${SUITE} phase=removed-all`, JSON.stringify({ calls: deleteMock.mock.calls, ...snapshot() }));
    expect(deleteMock.mock.calls.map(([payload]) => payload)).toEqual([
      { scope: { type: "media", mediaId: "s-1" } },
      { scope: { type: "media", mediaId: "m-1" } },
    ]);
    expect(snapshot()).toEqual({ total: formatLocalizedStorage(0, "en"), rows: [], empty: "settings.offlineContent.empty" });
    expect(q("offline-content-remove-all")).toHaveLength(0);
  });

  it("shows the empty text with nothing saved", async () => {
    saved = [];
    await mount();
    console.log(`${SUITE} phase=empty`, JSON.stringify(snapshot()));
    expect(snapshot()).toEqual({ total: formatLocalizedStorage(0, "en"), rows: [], empty: "settings.offlineContent.empty" });
  });

  it("a failed remove says so and keeps the row", async () => {
    deleteMock.mockResolvedValueOnce({ __runtimeJobsError: true, status: 500, errorCode: "delete_failed", message: "disk" });
    await mount();
    await click(own(rowByKey("movie:m-1"), "offline-content-remove"));
    console.log(`${SUITE} phase=remove-failed`, JSON.stringify(snapshot()));
    expect(toastError).toHaveBeenCalledWith("settings.offlineContent.removeFailed");
    expect(rowByKey("movie:m-1")).not.toBeNull();
  });
});

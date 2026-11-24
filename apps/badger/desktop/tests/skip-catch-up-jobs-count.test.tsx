// @vitest-environment jsdom
/**
 * @req MPV-PREV-07
 *
 * The Jobs icon counts the skip-detection catch-up as one running job while it works (Chris 2026-11-24: the icon
 * said nothing ran while it processed his library), and not while it waits for a playback, an import or the
 * connection, nor once it is done. The icon, the panel and the notice share one 5 s poll of the runtime.
 */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkipCatchUpStatus } from "../src/renderer/src/lib/skipCatchUp";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mockActiveGroups: unknown[] = [];

vi.mock("@/lib/labJobs", () => ({ useLabJobsData: () => ({ activeGroups: mockActiveGroups }) }));
vi.mock("@/lib/runtimeIngestJobs", () => ({ useRuntimeIngestJobs: () => ({ jobs: [] }) }));
vi.mock("@/lib/crewBackfill", () => ({ useCrewBackfillProgress: () => null }));
vi.mock("@/components/HighTrafficDownloadsNotice", () => ({ default: () => null }));
vi.mock("../src/renderer/src/components/TopNavJobsSidebarContent", () => ({ default: () => null }));

const SUITE = "skip-catch-up-jobs-count";

const status = (state: SkipCatchUpStatus["state"]): SkipCatchUpStatus => ({
  state,
  retryAt: null,
  handled: 1,
  total: 8,
  current:
    state === "done"
      ? null
      : { formatId: "f2", mediaId: "b99", season: 1, episode: 2, running: state === "running", phase: null, downloaded: 0, downloadedBytes: 0, totalBytes: 0, progress: 0 },
  failed: [],
  cancelled: [],
  videos: [],
  finishedAt: null,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  mockActiveGroups = [];
});

/** The number on the Jobs icon, or null when the icon shows nothing running. */
const badge = () =>
  container?.querySelector('[data-testid="top-nav-jobs-running"]')
    ? (container?.querySelector('[data-testid="top-nav-jobs"] span')?.textContent ?? null)
    : null;

const renderWith = async (answer: () => SkipCatchUpStatus) => {
  const getStatus = vi.fn(async () => answer());
  (window as unknown as { sf: unknown }).sf = { skipCatchUp: { getStatus } };
  const { default: TopNavJobsSidebar } = await import("../src/renderer/src/components/TopNavJobsSidebar");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<TopNavJobsSidebar />);
  });
  return getStatus;
};

describe("Jobs icon counter and the skip-detection catch-up (MPV-PREV-07)", () => {
  it("@req MPV-PREV-07 running counts as one job, beside the imports; waiting or done does not", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let current = status("running");
      mockActiveGroups = [{ id: "import" }];
      const getStatus = await renderWith(() => current);
      console.info(`[${SUITE}] running + 1 import → ${badge()}`);
      expect(badge()).toBe("2");
      for (const state of ["paused_playback", "paused_import", "offline", "done"] as const) {
        current = status(state);
        await act(async () => {
          vi.advanceTimersByTime(5_000);
        });
        console.info(`[${SUITE}] ${state} + 1 import → ${badge()}`);
        expect(badge()).toBe("1");
      }
      mockActiveGroups = [];
      current = status("running");
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      console.info(`[${SUITE}] running alone → ${badge()}`);
      expect(badge()).toBe("1");
      expect(getStatus).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("@req MPV-PREV-07 every reader shares one poll, which stops when the last one leaves", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { useSkipCatchUpStatus } = await import("../src/renderer/src/lib/skipCatchUp");
      const getStatus = vi.fn(async () => status("running"));
      (window as unknown as { sf: unknown }).sf = { skipCatchUp: { getStatus } };
      const seen: Array<string | undefined> = [];
      const Reader = ({ id }: { id: string }) => {
        seen.push(`${id}:${useSkipCatchUpStatus()?.state}`);
        return null;
      };
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root?.render(
          <>
            <Reader id="icon" />
            <Reader id="panel" />
            <Reader id="notice" />
          </>,
        );
      });
      expect(getStatus).toHaveBeenCalledTimes(1);
      expect(seen).toContain("icon:running");
      expect(seen).toContain("notice:running");
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(getStatus).toHaveBeenCalledTimes(3);
      act(() => root?.unmount());
      root = null;
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      console.info(`[${SUITE}] polls=${getStatus.mock.calls.length} after three readers and an unmount`);
      expect(getStatus).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

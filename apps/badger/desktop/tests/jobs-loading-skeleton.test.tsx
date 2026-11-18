// @vitest-environment jsdom
/**
 * @bugfix @regression-proof
 *
 * Pre-fix bug: TopNavJobsSidebarContent and MediaDetailsProcessingPanel
 * both ignored the `loading` flag returned by useRuntimeIngestJobs.
 * Sidebar rendered the "no jobs" empty-state during the in-flight
 * snapshot fetch (50-200ms HTTP roundtrip); modal Processes tab
 * returned null entirely. User symptom: "I opened the jobs side panel
 * which was empty for some reason. So I waited a while and the jobs
 * finally appeared. Same thing happened with the processes tab."
 *
 * Post-fix: both surfaces render a skeleton placeholder while
 * loading=true and there are no jobs yet. Once the snapshot resolves,
 * real data replaces the skeleton (or the empty/null state takes over
 * for genuinely empty groups).
 */

import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/ui", () => ({
  Button: ({ children, onClick, title, ...props }: any) => (
    <button onClick={onClick} aria-label={title} title={title} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", () => ({
  Trash2: () => <span data-testid="trash" />,
  X: () => <span data-testid="x" />,
  ChevronDown: () => <span data-testid="chev-down" />,
  ChevronRight: () => <span data-testid="chev-right" />,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, second?: unknown) => (typeof second === "string" ? second : key),
    i18n: { language: "en" },
  }),
}));

vi.mock("../src/renderer/src/components/LabStatusBadge", () => ({
  LabStatusBadge: ({ status }: { status: string }) => <span data-testid={`badge-${status}`}>{status}</span>,
}));

vi.mock("../src/renderer/src/components/IngestUnavailableBanner", () => ({
  default: () => null,
}));

vi.mock("../src/renderer/src/lib/uploadSpeed", () => ({ formatUploadSpeedLabel: () => "" }));

vi.mock("../src/renderer/src/lib/notify", () => ({ notifyError: vi.fn() }));

vi.mock("../src/renderer/src/components/labJobPresentation", () => ({
  buildActiveLabJobPresentation: () => ({ outputLabel: "", episodeLabel: null, uploadSpeedLabel: null, canStart: false }),
  buildCompletedLabJobPresentation: () => ({ outputSummary: "", completedMeta: null }),
}));

vi.mock("../src/renderer/src/components/MediaImage", () => ({ default: () => null }));

vi.mock("../src/renderer/src/lib/useClientConfig", () => ({
  useClientConfig: () => ({ enableCodecSelection: false, runtimeEngineV2Enabled: true }),
}));

vi.mock("../src/renderer/src/lib/libraryContext", () => ({
  useOptionalLibraryData: () => ({ media: [] }),
  useLibraryData: () => ({ media: [], playlists: [] }),
}));

const hookState = {
  jobs: [] as unknown[],
  groups: [] as unknown[],
  loading: true,
  error: null as unknown,
  runtimeError: null as unknown,
};

vi.mock("../src/renderer/src/lib/runtimeIngestJobs", () => ({
  useRuntimeIngestJobs: () => hookState,
  useRuntimeIngestActions: () => ({
    cancelJob: vi.fn(),
    cancelByGroup: vi.fn(),
    dismissJob: vi.fn(),
    retryJob: vi.fn(),
    submitSources: vi.fn(),
  }),
  findStaleOrphanGroupIds: () => [],
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = async (element: React.ReactElement) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
};

// On assertion failure, dump the hook state + rendered DOM so a failed
// skeleton/empty-state assertion is diagnosable offline without manual repro.
const dumpJobsSkeletonSnapshot = (label: string) => {
  try {
    console.error(`=== [jobs-loading-skeleton:${label}] snapshot ===`);
    console.error(`hookState=${JSON.stringify(hookState, null, 2)}`);
    console.error(
      `markers present: ${JSON.stringify({
        sidebarSkeleton: !!container?.querySelector('[data-testid="sidebar-loading-skeleton"]'),
        panelSkeleton: !!container?.querySelector('[data-testid="processing-panel-loading-skeleton"]'),
        panelEmptyState: !!container?.querySelector('[data-testid="processing-panel-empty-state"]'),
      })}`,
    );
    console.error(`container.textContent: ${container?.textContent ?? "(no container)"}`);
    console.error(`container.innerHTML:\n${container?.innerHTML ?? "(no container)"}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

beforeEach(() => {
  hookState.jobs = [];
  hookState.groups = [];
  hookState.loading = true;
  hookState.error = null;
  hookState.runtimeError = null;
});

afterEach(() => {
  if (root && container) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  if (container?.parentNode) container.parentNode.removeChild(container);
  container = null;
});

describe("TopNavJobsSidebarContent loading skeleton", () => {
  it("[@bugfix][@regression-proof] renders skeleton when loading=true and zero groups", async () => {
    console.info(`[jobs-loading-skeleton:setup] sidebar loading=true groups=0 — expect skeleton, no empty-state`);
    hookState.loading = true;
    hookState.groups = [];

    const { default: Sidebar } = await import(
      "../src/renderer/src/components/TopNavJobsSidebarContent"
    );
    await render(<Sidebar />);
    console.info(`[jobs-loading-skeleton:render] sidebar rendered; skeleton present=${!!container?.querySelector('[data-testid="sidebar-loading-skeleton"]')}`);

    try {
      expect(container?.querySelector('[data-testid="sidebar-loading-skeleton"]')).toBeTruthy();
      // Empty-state copy must NOT be present while loading.
      expect(container?.textContent ?? "").not.toContain("lab.empty.title");
    } catch (err) {
      dumpJobsSkeletonSnapshot("sidebar-loading-skeleton-assert");
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] renders empty-state when loading=false and zero groups", async () => {
    console.info(`[jobs-loading-skeleton:setup] sidebar loading=false groups=0 — expect empty-state, no skeleton`);
    hookState.loading = false;
    hookState.groups = [];

    const { default: Sidebar } = await import(
      "../src/renderer/src/components/TopNavJobsSidebarContent"
    );
    await render(<Sidebar />);
    console.info(`[jobs-loading-skeleton:render] sidebar rendered; skeleton present=${!!container?.querySelector('[data-testid="sidebar-loading-skeleton"]')}`);

    try {
      expect(container?.querySelector('[data-testid="sidebar-loading-skeleton"]')).toBeFalsy();
      expect(container?.textContent ?? "").toContain("lab.empty.title");
    } catch (err) {
      dumpJobsSkeletonSnapshot("sidebar-empty-state-assert");
      throw err;
    }
  });
});

describe("MediaDetailsProcessingPanel loading skeleton", () => {
  it("[@bugfix][@regression-proof] renders skeleton when loading=true and zero jobs (was: returned null)", async () => {
    console.info(`[jobs-loading-skeleton:setup] processing-panel loading=true jobs=0 — expect skeleton (regression: was null)`);
    hookState.loading = true;
    hookState.groups = [];

    const { default: Panel } = await import(
      "../src/renderer/src/components/MediaDetailsProcessingPanel"
    );
    await render(<Panel mediaId="media-1" />);
    console.info(`[jobs-loading-skeleton:render] panel rendered; skeleton present=${!!container?.querySelector('[data-testid="processing-panel-loading-skeleton"]')}`);

    try {
      expect(container?.querySelector('[data-testid="processing-panel-loading-skeleton"]')).toBeTruthy();
    } catch (err) {
      dumpJobsSkeletonSnapshot("panel-loading-skeleton-assert");
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] renders empty-state when loading=false and zero jobs and no runtime error (Round 5 — Jobs tab is always present)", async () => {
    // Round 5 UX change: the Jobs tab is now always visible, so the
    // panel renders a friendly empty-state message instead of null
    // when there are no jobs.
    console.info(`[jobs-loading-skeleton:setup] processing-panel loading=false jobs=0 runtimeError=null — expect empty-state, no skeleton`);
    hookState.loading = false;
    hookState.groups = [];
    hookState.runtimeError = null;

    const { default: Panel } = await import(
      "../src/renderer/src/components/MediaDetailsProcessingPanel"
    );
    await render(<Panel mediaId="media-1" />);
    console.info(`[jobs-loading-skeleton:render] panel rendered; skeleton=${!!container?.querySelector('[data-testid="processing-panel-loading-skeleton"]')} emptyState=${!!container?.querySelector('[data-testid="processing-panel-empty-state"]')}`);

    try {
      expect(container?.querySelector('[data-testid="processing-panel-loading-skeleton"]')).toBeFalsy();
      expect(container?.querySelector('[data-testid="processing-panel-empty-state"]')).toBeTruthy();
    } catch (err) {
      dumpJobsSkeletonSnapshot("panel-empty-state-assert");
      throw err;
    }
  });
});

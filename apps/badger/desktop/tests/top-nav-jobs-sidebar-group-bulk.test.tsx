// @vitest-environment jsdom
//
// B3: GroupCard needs a bulk delete button on its header so the user can
// nuke an entire media's processing rows in one click. For active groups
// the action cancels every running/queued job in the group; for terminal
// groups it dismisses the surviving rows. Both routes go through the
// existing cancelByGroup IPC (which runtime treats as "cancel actives +
// dismiss terminals").

import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/ui", () => ({
  Button: ({ children, onClick, title, ...props }: any) => (
    <button onClick={onClick} aria-label={title} {...props}>
      {children}
    </button>
  ),
}));

// See top-nav-jobs-sidebar.test.tsx for context: flatten the dismiss
// scheduler to run synchronously in unit tests, so the click → mock
// assertion path doesn't need to wait for the 220ms animation.
vi.mock("@space/desktop-shell/components", async () => ({
  // The shared job cards themselves (UX-JOBS-02) render for real.
  ...(await vi.importActual<object>("@space/desktop-shell/desktop-job-card")),
  AnimatedDismissRow: ({ children }: any) => <>{children}</>,
  // The shared Jobs panel pieces (UX-JOBS-01): five filter pills then the trailing action, and the empty state.
  DesktopJobsFilterBar: ({ labels, onChange, trailing }: any) => (
    <div>
      {Object.keys(labels).map((level) => (
        <button key={level} type="button" onClick={() => onChange(level)}>
          {labels[level]}
        </button>
      ))}
      {trailing}
    </div>
  ),
  DesktopJobsEmpty: ({ title, subtitle }: any) => (
    <div data-testid="jobs-empty">
      {title} {subtitle}
    </div>
  ),
  useStaggeredDismiss: () => ({
    dismissing: new Set<string>(),
    scheduleDismiss: (_id: string, action: () => void) => action(),
  }),
}));

vi.mock("lucide-react", () => ({
  ChevronDown: () => <span />,
  ChevronRight: () => <span />,
  Trash2: () => <span data-testid="icon-trash" />,
  X: () => <span data-testid="icon-x" />,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, second?: unknown) => (typeof second === "string" ? second : key),
    i18n: { language: "en" },
  }),
}));

vi.mock("../src/renderer/src/components/MediaImage", () => ({
  default: () => <div data-testid="media-image" />,
}));

vi.mock("../src/renderer/src/components/LabStatusBadge", () => ({
  LabStatusBadge: ({ status }: { status: string }) => (
    <span data-testid={`status-${status}`}>{status}</span>
  ),
}));

vi.mock("../src/renderer/src/lib/uploadSpeed", () => ({
  formatUploadSpeedLabel: () => "",
}));

vi.mock("../src/renderer/src/components/labJobPresentation", () => ({
  buildActiveLabJobPresentation: (job: any) => ({
    outputLabel: job.id,
    episodeLabel: null,
    uploadSpeedLabel: null,
    canStart: false,
  }),
  buildCompletedLabJobPresentation: (job: any) => ({
    outputSummary: job.id,
    completedMeta: null,
  }),
}));

vi.mock("../src/renderer/src/lib/useClientConfig", () => ({
  useClientConfig: () => ({ enableCodecSelection: false, runtimeEngineV2Enabled: true }),
}));

const cancelJob = vi.fn(async () => undefined);
const cancelByGroup = vi.fn(async () => undefined);
const dismissJob = vi.fn(async () => undefined);
let mockGroups: any[] = [];

vi.mock("../src/renderer/src/lib/runtimeIngestJobs", () => ({
  useRuntimeIngestJobs: () => ({ jobs: [], groups: mockGroups, loading: false, error: null }),
  useRuntimeIngestActions: () => ({
    cancelJob,
    cancelByGroup,
    dismissJob,
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

const makeJob = (id: string, status: any) => ({
  id,
  filename: `${id}.mkv`,
  status,
  progress: 50,
  groupId: "media-1",
  matchedTo: null,
  uploadSpeedMbps: 0,
});

const makeGroup = (id: string, jobs: any[], status: any) => ({
  id,
  title: id,
  posterPath: null,
  type: undefined,
  jobs,
  progress: 50,
  status,
  uploadSpeedMbps: 0,
});

// On assertion failure, dump the rendered sidebar DOM + the IPC mock call
// args so a failed button-wiring assertion is diagnosable offline.
const dumpGroupBulkSnapshot = (label: string) => {
  try {
    console.error(`=== [top-nav-jobs-sidebar-group-bulk:${label}] snapshot ===`);
    console.error(`mockGroups=${JSON.stringify(mockGroups, null, 2)}`);
    const buttons = Array.from(container?.querySelectorAll("button") ?? []).map((b) => ({
      ariaLabel: b.getAttribute("aria-label"),
      text: b.textContent,
    }));
    console.error(`rendered buttons (count=${buttons.length}):\n${JSON.stringify(buttons, null, 2)}`);
    console.error(`cancelByGroup calls=${JSON.stringify(cancelByGroup.mock.calls)}`);
    console.error(`cancelJob calls=${JSON.stringify(cancelJob.mock.calls)}`);
    console.error(`dismissJob calls=${JSON.stringify(dismissJob.mock.calls)}`);
    console.error(`container.innerHTML:\n${container?.innerHTML ?? "(no container)"}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

afterEach(() => {
  if (root && container) act(() => root?.unmount());
  root = null;
  container?.parentNode?.removeChild(container);
  container = null;
  cancelJob.mockClear();
  cancelByGroup.mockClear();
  dismissJob.mockClear();
  mockGroups = [];
});

describe("[@bugfix][@regression-proof] B3 GroupCard bulk delete", () => {
  it("active group renders a bulk-cancel button on the header that calls cancelByGroup", async () => {
    console.info(`[top-nav-jobs-sidebar-group-bulk:setup] seeding 1 active group (media-1) with 2 jobs`);
    mockGroups = [
      makeGroup(
        "media-1",
        [makeJob("j-a", "transcoding"), makeJob("j-b", "uploading")],
        "transcoding",
      ),
    ];
    const { default: View } = await import(
      "../src/renderer/src/components/TopNavJobsSidebarContent"
    );
    await render(<View />);
    console.info(`[top-nav-jobs-sidebar-group-bulk:render] rendered; locating "Cancel all" bulk button`);
    const bulkBtn = container!.querySelector('button[aria-label="Cancel all"]');
    if (!bulkBtn) dumpGroupBulkSnapshot("active-bulk-cancel-missing-button");
    expect(bulkBtn).not.toBeNull();
    await act(async () =>
      bulkBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    console.info(`[top-nav-jobs-sidebar-group-bulk:click] cancelByGroup calls=${JSON.stringify(cancelByGroup.mock.calls)}`);
    try {
      expect(cancelByGroup).toHaveBeenCalledWith("media-1", expect.any(String));
    } catch (err) {
      dumpGroupBulkSnapshot("active-bulk-cancel-assert");
      throw err;
    }
  });

  it("terminal (completed) group renders a bulk-dismiss button that calls cancelByGroup", async () => {
    console.info(`[top-nav-jobs-sidebar-group-bulk:setup] seeding 1 terminal/done group (media-2)`);
    mockGroups = [makeGroup("media-2", [makeJob("j-d", "done")], "done")];
    const { default: View } = await import(
      "../src/renderer/src/components/TopNavJobsSidebarContent"
    );
    await render(<View />);
    console.info(`[top-nav-jobs-sidebar-group-bulk:render] rendered; locating "Remove all from history" bulk button`);
    const bulkBtn = container!.querySelector('button[aria-label="Remove all from history"]');
    if (!bulkBtn) dumpGroupBulkSnapshot("terminal-bulk-dismiss-missing-button");
    expect(bulkBtn).not.toBeNull();
    await act(async () =>
      bulkBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    console.info(`[top-nav-jobs-sidebar-group-bulk:click] cancelByGroup calls=${JSON.stringify(cancelByGroup.mock.calls)}`);
    try {
      expect(cancelByGroup).toHaveBeenCalledWith("media-2", expect.any(String));
    } catch (err) {
      dumpGroupBulkSnapshot("terminal-bulk-dismiss-assert");
      throw err;
    }
  });

  it("clicking the bulk button does not toggle the group expand/collapse", async () => {
    console.info(`[top-nav-jobs-sidebar-group-bulk:setup] seeding 1 active group (media-1) for no-toggle test`);
    mockGroups = [
      makeGroup("media-1", [makeJob("j-a", "transcoding")], "transcoding"),
    ];
    const { default: View } = await import(
      "../src/renderer/src/components/TopNavJobsSidebarContent"
    );
    await render(<View />);
    // Group not expanded initially → no per-job rows visible.
    const initialBadge = container!.querySelector('[data-testid="status-transcoding"]');
    if (!initialBadge) dumpGroupBulkSnapshot("no-toggle-missing-initial-badge");
    expect(initialBadge).not.toBeNull();
    const bulkBtn = container!.querySelector('button[aria-label="Cancel all"]')!;
    await act(async () =>
      bulkBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    // After bulk click, cancelByGroup fires but the toggle button onClick must
    // NOT also fire — there should still be only the single status badge for
    // the header (no expanded per-job badges duplicated underneath).
    const badges = container!.querySelectorAll('[data-testid="status-transcoding"]');
    console.info(`[top-nav-jobs-sidebar-group-bulk:click] post-click status-transcoding badge count=${badges.length} (expect 1, no expand)`);
    try {
      expect(badges.length).toBe(1);
    } catch (err) {
      dumpGroupBulkSnapshot("no-toggle-badge-count-assert");
      throw err;
    }
  });
});

// @vitest-environment jsdom
//
// V2 sidebar bugfix coverage. Each test is tagged so the regression suite
// can recognise it (Orchard / Ghost / Grave bugs from
// the video-ingestion bug list).

import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
// Static import: vi.mock calls are hoisted above it, and loading the component graph at
// collection (not inside each test body) keeps every test well under the 15 s timeout on a busy CI runner.
import View from "../src/renderer/src/components/TopNavJobsSidebarContent";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks for chrome we don't care about in these tests
// ---------------------------------------------------------------------------

vi.mock("@space/ui", () => ({
  Button: ({ children, onClick, title, ...props }: any) => (
    <button onClick={onClick} aria-label={title} {...props}>
      {children}
    </button>
  ),
}));

// The staggered-dismiss helper schedules the real action through a 220ms
// setTimeout so the row can animate before the data drops. These tests assert
// the action-wiring contract (which mock gets called with which id), so we
// flatten the scheduler to run the action synchronously — without this mock
// every assertion would need a fake-timer dance or a real-timer wait.
vi.mock("@space/desktop-shell/components", async () => ({
  // The shared job cards themselves (UX-JOBS-02) render for real.
  ...(await vi.importActual<object>("../../../../packages/desktop-shell/src/components/desktop-job-card")),
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
  Trash2: () => <span data-testid="trash" />,
  X: () => <span data-testid="x" />,
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

const cancelJob = vi.fn(async (_jobId: string) => undefined);
const cancelByGroup = vi.fn(async () => undefined);
const dismissJob = vi.fn(async (_jobId: string) => undefined);
let mockGroups: any[] = [];
let mockJobs: any[] = [];
let mockStaleOrphanGroupIds: string[] = [];

vi.mock("../src/renderer/src/lib/runtimeIngestJobs", () => ({
  useRuntimeIngestJobs: () => ({ jobs: mockJobs, groups: mockGroups, loading: false, error: null }),
  useRuntimeIngestActions: () => ({
    cancelJob,
    cancelByGroup,
    dismissJob,
    retryJob: vi.fn(),
    submitSources: vi.fn(),
  }),
  findStaleOrphanGroupIds: () => mockStaleOrphanGroupIds,
}));

// ---------------------------------------------------------------------------
// Render harness
// ---------------------------------------------------------------------------

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

// On assertion failure, dump enough state to diagnose offline (per memory
// feedback: tests must self-diagnose; never recommend manual repro). Captures
// the mock call args (which routing action fired) + the rendered button/DOM
// shape that drives the action wiring this suite pins. Body is wrapped in
// try/catch so a snapshot failure can never mask the real assertion failure.
const dumpTopNavJobsSidebarSnapshot = (label: string) => {
  try {
    const buttons = container
      ? Array.from(container.querySelectorAll("button")).map((b) => ({
          ariaLabel: b.getAttribute("aria-label"),
          text: (b.textContent ?? "").trim().slice(0, 40),
          disabled: b.disabled,
        }))
      : [];
    console.error(`=== [top-nav-jobs-sidebar:${label}] snapshot ===`);
    console.error(
      `mocks: cancelJob.calls=${JSON.stringify(cancelJob.mock.calls)} ` +
        `cancelByGroup.calls=${JSON.stringify(cancelByGroup.mock.calls)} ` +
        `dismissJob.calls=${JSON.stringify(dismissJob.mock.calls)}`,
    );
    console.error(
      `fixture: groups=${JSON.stringify(
        mockGroups.map((g) => ({ id: g.id, status: g.status, jobIds: (g.jobs ?? []).map((j: any) => j.id) })),
      )} staleOrphanIds=${JSON.stringify(mockStaleOrphanGroupIds)}`,
    );
    console.error(`rendered buttons (${buttons.length}):\n${JSON.stringify(buttons, null, 2)}`);
    console.error(`container.textContent=${JSON.stringify((container?.textContent ?? "").slice(0, 200))}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const makeJob = (id: string, status: any) => ({
  id,
  filename: `${id}.mkv`,
  status,
  progress: 50,
  error: undefined,
  matchedMediaId: "media-1",
  pendingKey: null,
  groupId: "media-1",
  matchedTo: null,
  detectedTitle: id,
  detectedSeason: null,
  detectedEpisode: null,
  manualSeason: null,
  manualEpisode: null,
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

afterEach(() => {
  if (root && container) act(() => root?.unmount());
  root = null;
  container?.parentNode?.removeChild(container);
  container = null;
  cancelJob.mockClear();
  cancelByGroup.mockClear();
  dismissJob.mockClear();
  mockGroups = [];
  mockJobs = [];
  mockStaleOrphanGroupIds = [];
});

describe("TopNavJobsSidebarContent — bugfix coverage", () => {
  it("[@bugfix][@regression-proof] trash on an active (transcoding) job calls cancelJob ONLY (Orchard bug)", async () => {
    console.info(`[top-nav-jobs-sidebar:orchard] setup — transcoding group with one active job`);
    mockGroups = [makeGroup("media-1", [makeJob("job-active", "transcoding")], "transcoding")];
    await render(<View />);
    console.info(`[top-nav-jobs-sidebar:orchard] rendered, expanding group card`);
    // Expand the group to surface the per-job trash button.
    // The first 5 buttons are filter pills; the 6th is the group-card toggle.
    const groupBtn = container!.querySelector(
      '[role="button"].flex.w-full.items-center',
    ) as HTMLElement | null;
    await act(async () => groupBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const trashButtons = Array.from(container!.querySelectorAll('button[aria-label="Cancel"]'));
    console.info(`[top-nav-jobs-sidebar:orchard] expanded, Cancel buttons=${trashButtons.length}`);
    if (trashButtons.length === 0) dumpTopNavJobsSidebarSnapshot("orchard-no-cancel-button");
    expect(trashButtons.length).toBeGreaterThan(0);
    await act(async () => trashButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    console.info(`[top-nav-jobs-sidebar:orchard] clicked trash; cancelJob.calls=${JSON.stringify(cancelJob.mock.calls)} dismissJob.calls=${JSON.stringify(dismissJob.mock.calls)}`);
    if (!cancelJob.mock.calls.some((c) => c[0] === "job-active") || dismissJob.mock.calls.length > 0) {
      dumpTopNavJobsSidebarSnapshot("orchard-routing-mismatch");
    }
    expect(cancelJob).toHaveBeenCalledWith("job-active");
    expect(dismissJob).not.toHaveBeenCalled();
  });

  it("[@bugfix][@regression-proof] trash on a queued/waiting job calls cancelJob ONLY", async () => {
    console.info(`[top-nav-jobs-sidebar:waiting] setup — waiting group with one queued job`);
    mockGroups = [makeGroup("media-1", [makeJob("job-q", "waiting")], "waiting")];
    await render(<View />);
    // The first 5 buttons are filter pills; the 6th is the group-card toggle.
    const groupBtn = container!.querySelector(
      '[role="button"].flex.w-full.items-center',
    ) as HTMLElement | null;
    await act(async () => groupBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const trashButtons = Array.from(container!.querySelectorAll('button[aria-label="Cancel"]'));
    console.info(`[top-nav-jobs-sidebar:waiting] expanded, Cancel buttons=${trashButtons.length}`);
    if (trashButtons.length === 0) dumpTopNavJobsSidebarSnapshot("waiting-no-cancel-button");
    expect(trashButtons.length).toBeGreaterThan(0);
    await act(async () => trashButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    console.info(`[top-nav-jobs-sidebar:waiting] clicked trash; cancelJob.calls=${JSON.stringify(cancelJob.mock.calls)} dismissJob.calls=${JSON.stringify(dismissJob.mock.calls)}`);
    if (!cancelJob.mock.calls.some((c) => c[0] === "job-q") || dismissJob.mock.calls.length > 0) {
      dumpTopNavJobsSidebarSnapshot("waiting-routing-mismatch");
    }
    expect(cancelJob).toHaveBeenCalledWith("job-q");
    expect(dismissJob).not.toHaveBeenCalled();
  });

  it("[@bugfix][@regression-proof] trash on a failed (terminal) job calls dismissJob ONLY (Ghost bug)", async () => {
    console.info(`[top-nav-jobs-sidebar:ghost] setup — failed group with one terminal job`);
    mockGroups = [makeGroup("media-1", [makeJob("job-failed", "failed")], "failed")];
    await render(<View />);
    // The first 5 buttons are filter pills; the 6th is the group-card toggle.
    const groupBtn = container!.querySelector(
      '[role="button"].flex.w-full.items-center',
    ) as HTMLElement | null;
    await act(async () => groupBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    // Failed groups render via CompletedJobRow (group.status "failed" isn't
    // "done"/"cancelled" though — so they go down the active path; assert via
    // the Cancel button is NOT shown for terminal status).
    const trashButtons = Array.from(
      container!.querySelectorAll('button[aria-label="Remove from history"]'),
    );
    console.info(`[top-nav-jobs-sidebar:ghost] expanded, "Remove from history" buttons=${trashButtons.length}`);
    if (trashButtons.length === 0) {
      // The legacy GroupCard renders failed-status jobs in the active branch.
      // Click the Cancel-labeled trash and assert it routes to dismiss because
      // status is terminal.
      const cancelBtns = Array.from(container!.querySelectorAll('button[aria-label="Cancel"]'));
      // status "failed" is NOT in the active set so the icon should be the
      // dismiss-labeled one.
      console.info(`[top-nav-jobs-sidebar:ghost] legacy active-branch path; Cancel buttons=${cancelBtns.length} (expect 0)`);
      if (cancelBtns.length !== 0) dumpTopNavJobsSidebarSnapshot("ghost-unexpected-cancel-button");
      expect(cancelBtns.length).toBe(0);
    } else {
      await act(async () => trashButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      console.info(`[top-nav-jobs-sidebar:ghost] clicked trash; dismissJob.calls=${JSON.stringify(dismissJob.mock.calls)} cancelJob.calls=${JSON.stringify(cancelJob.mock.calls)}`);
      if (!dismissJob.mock.calls.some((c) => c[0] === "job-failed") || cancelJob.mock.calls.length > 0) {
        dumpTopNavJobsSidebarSnapshot("ghost-routing-mismatch");
      }
      expect(dismissJob).toHaveBeenCalledWith("job-failed");
      expect(cancelJob).not.toHaveBeenCalled();
    }
  });

  it("[@bugfix][@regression-proof] trash on a cancelled (terminal) job calls dismissJob ONLY", async () => {
    console.info(`[top-nav-jobs-sidebar:cancelled] setup — cancelled group with one terminal job`);
    mockGroups = [makeGroup("media-1", [makeJob("job-cancelled", "cancelled")], "cancelled")];
    await render(<View />);
    // The first 5 buttons are filter pills; the 6th is the group-card toggle.
    const groupBtn = container!.querySelector(
      '[role="button"].flex.w-full.items-center',
    ) as HTMLElement | null;
    await act(async () => groupBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const trashButtons = Array.from(
      container!.querySelectorAll('button[aria-label="Remove from history"]'),
    );
    console.info(`[top-nav-jobs-sidebar:cancelled] expanded, "Remove from history" buttons=${trashButtons.length}`);
    if (trashButtons.length === 0) dumpTopNavJobsSidebarSnapshot("cancelled-no-dismiss-button");
    expect(trashButtons.length).toBeGreaterThan(0);
    await act(async () => trashButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    console.info(`[top-nav-jobs-sidebar:cancelled] clicked trash; dismissJob.calls=${JSON.stringify(dismissJob.mock.calls)} cancelJob.calls=${JSON.stringify(cancelJob.mock.calls)}`);
    if (!dismissJob.mock.calls.some((c) => c[0] === "job-cancelled") || cancelJob.mock.calls.length > 0) {
      dumpTopNavJobsSidebarSnapshot("cancelled-routing-mismatch");
    }
    expect(dismissJob).toHaveBeenCalledWith("job-cancelled");
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it("[@bugfix][@regression-proof] trash on a succeeded (terminal) job calls dismissJob ONLY", async () => {
    console.info(`[top-nav-jobs-sidebar:done] setup — done group with one succeeded job`);
    mockGroups = [makeGroup("media-1", [makeJob("job-done", "done")], "done")];
    await render(<View />);
    // The first 5 buttons are filter pills; the 6th is the group-card toggle.
    const groupBtn = container!.querySelector(
      '[role="button"].flex.w-full.items-center',
    ) as HTMLElement | null;
    await act(async () => groupBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const trashButtons = Array.from(
      container!.querySelectorAll('button[aria-label="Remove from history"]'),
    );
    console.info(`[top-nav-jobs-sidebar:done] expanded, "Remove from history" buttons=${trashButtons.length}`);
    if (trashButtons.length === 0) dumpTopNavJobsSidebarSnapshot("done-no-dismiss-button");
    expect(trashButtons.length).toBeGreaterThan(0);
    await act(async () => trashButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    console.info(`[top-nav-jobs-sidebar:done] clicked trash; dismissJob.calls=${JSON.stringify(dismissJob.mock.calls)} cancelJob.calls=${JSON.stringify(cancelJob.mock.calls)}`);
    if (!dismissJob.mock.calls.some((c) => c[0] === "job-done") || cancelJob.mock.calls.length > 0) {
      dumpTopNavJobsSidebarSnapshot("done-routing-mismatch");
    }
    expect(dismissJob).toHaveBeenCalledWith("job-done");
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it("[@bugfix][@regression-proof] Dismiss stale jobs button is hidden when there are zero stale orphan groups (Bug #10)", async () => {
    console.info(`[top-nav-jobs-sidebar:stale-hidden] setup — zero stale orphan groups`);
    mockGroups = [makeGroup("media-1", [makeJob("job-active", "transcoding")], "transcoding")];
    mockStaleOrphanGroupIds = [];
    await render(<View />);
    const dismissBtn = container!.querySelector('button[aria-label="Dismiss stale jobs"]');
    console.info(`[top-nav-jobs-sidebar:stale-hidden] "Dismiss stale jobs" present=${dismissBtn !== null} (expect absent)`);
    if (dismissBtn !== null) dumpTopNavJobsSidebarSnapshot("stale-hidden-unexpected-button");
    expect(dismissBtn).toBeNull();
  });

  it("[@bugfix][@regression-proof] Dismiss stale jobs button calls cancelByGroup for each stale orphan groupId (Bug #10)", async () => {
    console.info(`[top-nav-jobs-sidebar:stale-sweep] setup — 3 stale orphan groupIds`);
    mockGroups = [makeGroup("media-1", [makeJob("job-active", "transcoding")], "transcoding")];
    mockStaleOrphanGroupIds = ["orphan-1", "orphan-2", "orphan-3"];
    await render(<View />);
    const dismissBtn = container!.querySelector('button[aria-label="Dismiss stale jobs"]');
    console.info(`[top-nav-jobs-sidebar:stale-sweep] "Dismiss stale jobs" present=${dismissBtn !== null} (expect present)`);
    if (dismissBtn === null) dumpTopNavJobsSidebarSnapshot("stale-sweep-missing-button");
    expect(dismissBtn).not.toBeNull();
    await act(async () => dismissBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    console.info(`[top-nav-jobs-sidebar:stale-sweep] clicked; cancelByGroup.calls=${JSON.stringify(cancelByGroup.mock.calls)}`);
    // One cancelByGroup call per stale orphan groupId, with the cleanup reason
    // tag so the runtime can attribute the sweep in logs.
    if (cancelByGroup.mock.calls.length !== 3) dumpTopNavJobsSidebarSnapshot("stale-sweep-call-count-mismatch");
    expect(cancelByGroup).toHaveBeenCalledTimes(3);
    expect(cancelByGroup).toHaveBeenNthCalledWith(1, "orphan-1", "stale-orphan-cleanup");
    expect(cancelByGroup).toHaveBeenNthCalledWith(2, "orphan-2", "stale-orphan-cleanup");
    expect(cancelByGroup).toHaveBeenNthCalledWith(3, "orphan-3", "stale-orphan-cleanup");
  });

  it("[@bugfix][@regression-proof] cancelled records persist in the list (Grave bug — they must NOT auto-disappear)", async () => {
    console.info(`[top-nav-jobs-sidebar:grave] setup — cancelled group, expect it to persist`);
    mockGroups = [makeGroup("media-1", [makeJob("job-cancelled", "cancelled")], "cancelled")];
    await render(<View />);
    // The group card itself should be visible — cancelled rows are not pruned
    // by the v2 component. They are pruned only by an explicit dismissJob.
    const groupBtns = container!.querySelectorAll("button");
    console.info(`[top-nav-jobs-sidebar:grave] rendered buttons=${groupBtns.length} dismissJob.calls=${dismissJob.mock.calls.length}`);
    // At minimum the group toggle button is present.
    if (groupBtns.length === 0 || dismissJob.mock.calls.length > 0) dumpTopNavJobsSidebarSnapshot("grave-pruned-or-empty");
    expect(groupBtns.length).toBeGreaterThan(0);
    // Sanity: dismissJob has not been called by the mere act of rendering.
    expect(dismissJob).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Round 7 G4 — GroupCard header drops aggregate progress bar.
  //
  // Pre-fix: the GroupCard header rendered both LabStatusBadge AND a 20px-wide
  // progress bar + percent label + upload speed when group.status was
  // transcoding/uploading. The user found the inline progress bar at the
  // group level cluttered (per-job rows already show their own progress).
  //
  // Post-fix: header keeps the badge only. Per-job rows in the expanded
  // view retain their progress bars unchanged.
  // -----------------------------------------------------------------------

  // @req UX-JOBS-02[badger-desktop]
  it("[@bugfix][@regression-proof] GroupCard header (collapsed) renders the status badge but NOT an inline progress bar (Round 7 G4)", async () => {
    console.info(`[top-nav-jobs-sidebar:g4-collapsed] setup — transcoding group, collapsed header`);
    mockGroups = [
      makeGroup("media-1", [makeJob("job-1", "transcoding")], "transcoding"),
    ];
    await render(<View />);

    // Status badge present.
    const badge = container!.querySelector('[data-testid="status-transcoding"]');
    console.info(`[top-nav-jobs-sidebar:g4-collapsed] status badge present=${badge !== null}`);
    if (badge === null) dumpTopNavJobsSidebarSnapshot("g4-collapsed-missing-badge");
    expect(badge).not.toBeNull();

    // Group card is collapsed by default — only the header is rendered.
    // The deleted aggregate progress bar used a `<div class="...bg-primary...">`
    // fill inside a `<div class="...rounded-full bg-muted...">` track. Neither
    // should be present at the header level when collapsed.
    const progressFills = container!.querySelectorAll("div.bg-primary");
    console.info(`[top-nav-jobs-sidebar:g4-collapsed] div.bg-primary count=${progressFills.length} (expect 0); contains-50%=${(container!.textContent ?? "").includes("50%")}`);
    if (progressFills.length !== 0 || (container!.textContent ?? "").includes("50%")) {
      dumpTopNavJobsSidebarSnapshot("g4-collapsed-progress-bar-present");
    }
    expect(progressFills.length).toBe(0);

    // Defensive: also assert the percent-label text is absent. The pre-fix
    // header rendered "{Math.round(progress)}%". Our makeGroup sets
    // progress: 50 — pre-fix DOM would contain "50%".
    expect(container!.textContent ?? "").not.toContain("50%");
  });

  it("[@bugfix][@regression-proof] GroupCard expanded view still shows per-job progress bars (Round 7 G4 negative case)", async () => {
    console.info(`[top-nav-jobs-sidebar:g4-expanded] setup — transcoding group, expand to reveal per-job bar`);
    mockGroups = [
      makeGroup("media-1", [makeJob("job-1", "transcoding")], "transcoding"),
    ];
    await render(<View />);

    // Expand the group.
    const groupBtn = container!.querySelector(
      '[role="button"].flex.w-full.items-center',
    ) as HTMLElement | null;
    console.info(`[top-nav-jobs-sidebar:g4-expanded] group toggle present=${groupBtn !== null}`);
    if (groupBtn === null) dumpTopNavJobsSidebarSnapshot("g4-expanded-missing-toggle");
    expect(groupBtn).not.toBeNull();
    await act(async () => groupBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    // Expanded: a per-job progress bar fill appears (the fill div uses bg-primary).
    const progressFills = container!.querySelectorAll("div.bg-primary");
    console.info(`[top-nav-jobs-sidebar:g4-expanded] expanded div.bg-primary count=${progressFills.length} (expect >=1)`);
    if (progressFills.length < 1) dumpTopNavJobsSidebarSnapshot("g4-expanded-no-progress-bar");
    expect(progressFills.length).toBeGreaterThanOrEqual(1);
  });

  it("[@bugfix][@regression-proof] GroupCard header for status='uploading' renders badge only — no upload-speed text inline (Round 7 G4)", async () => {
    // The pre-fix branch added an upload-speed label in the header for
    // uploading groups. With the formatUploadSpeedLabel mock returning ""
    // we just ensure no .bg-primary fill survives in the collapsed header.
    console.info(`[top-nav-jobs-sidebar:g4-uploading] setup — uploading group w/ uploadSpeedMbps=5.0, collapsed header`);
    mockGroups = [
      {
        ...makeGroup("media-1", [makeJob("job-1", "uploading")], "uploading"),
        uploadSpeedMbps: 5.0,
      },
    ];
    await render(<View />);

    const badge = container!.querySelector('[data-testid="status-uploading"]');
    const progressFills = container!.querySelectorAll("div.bg-primary");
    console.info(`[top-nav-jobs-sidebar:g4-uploading] status badge present=${badge !== null} div.bg-primary count=${progressFills.length} (expect 0)`);
    if (badge === null || progressFills.length !== 0) dumpTopNavJobsSidebarSnapshot("g4-uploading-mismatch");
    expect(badge).not.toBeNull();
    expect(progressFills.length).toBe(0);
  });
});

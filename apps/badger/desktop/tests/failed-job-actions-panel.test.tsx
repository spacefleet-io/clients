// @vitest-environment jsdom
/**
 * UX-JOBS-03 in Badger's Jobs panel: a failed import says what happened, what it means, and offers the ONE action
 * the runtime says fits what is still on this computer — and that button runs exactly that action.
 */
import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { FailedJobAvailability, RuntimeJobsRetryResult } from "@space/runtime-contracts/runtime/jobs";
import View from "../src/renderer/src/components/TopNavJobsSidebarContent";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "failed-job-actions-panel";

vi.mock("@space/ui", () => ({
  Button: ({ children, onClick, title, variant: _v, size: _s, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button onClick={onClick} aria-label={title} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@space/desktop-shell/components", async () => ({
  ...(await vi.importActual<object>("@space/desktop-shell/desktop-job-card")),
  AnimatedDismissRow: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DesktopJobsFilterBar: () => <div />,
  DesktopJobsEmpty: () => <div data-testid="jobs-empty" />,
  useStaggeredDismiss: () => ({ dismissing: new Set<string>(), scheduleDismiss: (_id: string, action: () => void) => action() }),
}));

vi.mock("lucide-react", () => ({
  ChevronDown: () => <span />,
  ChevronRight: () => <span />,
  Trash2: () => <span data-testid="trash" />,
  X: () => <span data-testid="x" />,
}));

// Keys come back with their values so the test reads which line was chosen.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, second?: unknown) =>
      typeof second === "string" ? second : second ? `${key}${JSON.stringify(second)}` : key,
    i18n: { language: "en" },
  }),
}));

vi.mock("../src/renderer/src/components/MediaImage", () => ({ default: () => <div /> }));
vi.mock("../src/renderer/src/components/LabStatusBadge", () => ({
  LabStatusBadge: ({ status }: { status: string }) => <span data-testid={`status-${status}`}>{status}</span>,
}));
vi.mock("../src/renderer/src/components/labJobPresentation", () => ({
  buildActiveLabJobPresentation: (job: { id: string }) => ({ outputLabel: job.id, episodeLabel: null, uploadSpeedLabel: null }),
  buildCompletedLabJobPresentation: (job: { id: string }) => ({ outputSummary: job.id, completedMeta: null }),
}));
vi.mock("../src/renderer/src/lib/useClientConfig", () => ({
  useClientConfig: () => ({ enableCodecSelection: false, runtimeEngineV2Enabled: true }),
}));

// The plan-upgrade notice is its own suite (quota-uploads-notice); here it only reports "the plan has room now".
vi.mock("../src/renderer/src/components/QuotaUploadsNotice", () => ({
  isUploadQuotaExceededJobError: (e: string | null | undefined) => typeof e === "string" && e.includes("upload_quota_exceeded"),
  default: ({ onRoomChange }: { onRoomChange?: (hasRoom: boolean) => void }) => (
    <div data-testid="quota-uploads-notice">
      <button type="button" data-testid="quota-uploads-notice-upgrade" onClick={() => onRoomChange?.(true)}>
        upgrade
      </button>
    </div>
  ),
}));

const dismissJob = vi.fn(async (_jobId: string) => undefined);
let mockGroups: Record<string, unknown>[] = [];
let mockJobs: Record<string, unknown>[] = [];
vi.mock("../src/renderer/src/lib/runtimeIngestJobs", () => ({
  useRuntimeIngestJobs: () => ({ jobs: mockJobs, groups: mockGroups, loading: false, error: null }),
  useRuntimeIngestActions: () => ({ cancelJob: vi.fn(), cancelByGroup: vi.fn(), dismissJob, retryJob: vi.fn(), submitSources: vi.fn() }),
  findStaleOrphanGroupIds: () => [],
  pickMostActiveJob: () => null,
}));

const availability = vi.fn(async (_payload: { jobIds: string[] }) => ({ jobs: [] as FailedJobAvailability[], keptBytesTotal: 0 }));
const retry = vi.fn(async (_payload: { jobId: string; mode?: "upload" | "process" }): Promise<RuntimeJobsRetryResult> => ({ retried: true }));
const findFile = vi.fn(async (_payload: { jobId: string }): Promise<RuntimeJobsRetryResult | { cancelled: true }> => ({ cancelled: true }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const entry = (jobId: string, over: Partial<FailedJobAvailability>): FailedJobAvailability => ({
  jobId,
  action: "process_again",
  reason: "source_unchanged",
  nextAction: null,
  keptBytes: null,
  keptUntil: null,
  ...over,
});

const setup = async (jobId: string, answer: FailedJobAvailability, errorMessage = "handler-error") => {
  mockJobs = [{ jobId, status: "failed", errorMessage, errorCode: "handler-error" }];
  mockGroups = [
    {
      id: "media-1",
      title: "Film",
      posterPath: null,
      type: undefined,
      progress: 0,
      status: "failed",
      uploadSpeedMbps: 0,
      jobs: [{ id: jobId, filename: `${jobId}.mkv`, status: "failed", progress: 0, groupId: "media-1" }],
    },
  ];
  availability.mockResolvedValue({ jobs: [answer], keptBytesTotal: answer.keptBytes ?? 0 });
  Object.assign(window, { sf: { runtimeJobs: { availability, retry, findFile } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<View />));
  // No click: a group holding a failed job is open already, so its detail is in sight.
  console.info(`[${SUITE}:setup] ${jobId} detail shown without a click=${byTestId(`failed-job-detail-${jobId}`) !== null}`);
};

const groupToggle = () => container?.querySelector<HTMLElement>('[role="button"].flex.w-full.items-center') ?? null;

const byTestId = (id: string) => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const detailText = (jobId: string) => byTestId(`failed-job-detail-${jobId}`)?.textContent ?? "(no detail)";
const click = async (el: HTMLElement | null) => {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  availability.mockClear();
  retry.mockClear();
  findFile.mockClear();
  dismissJob.mockClear();
  Reflect.deleteProperty(window, "sf");
});

describe("Badger Jobs panel, failed imports (UX-JOBS-03)", () => {
  it("@req UX-JOBS-03[badger-desktop] @req INGS-KEEP-01[badger-desktop] a kept processed copy offers Upload again, which resumes only the upload, and the panel says the space it takes", async () => {
    await setup("job-kept", entry("job-kept", { action: "upload_again", reason: "kept_outputs", keptBytes: 3 * 1024 ** 3, keptUntil: "2026-12-08T10:00:00.000Z" }));
    console.info(`[${SUITE}:kept] availability calls=${JSON.stringify(availability.mock.calls)} detail=${detailText("job-kept")}`);
    console.info(`[${SUITE}:kept] kept line=${byTestId("failed-jobs-kept-copies")?.textContent ?? "(none)"}`);
    expect(availability).toHaveBeenCalledWith({ jobIds: ["job-kept"] });
    expect(detailText("job-kept")).toContain("nav.jobs.failed.whatUploadStopped");
    expect(detailText("job-kept")).toContain("nav.jobs.failed.meaningKeptOutputs");
    expect(detailText("job-kept")).toContain("December");
    expect(byTestId("failed-jobs-kept-copies")?.textContent).toContain("nav.jobs.failed.keptCopies");
    const button = byTestId("failed-job-action-job-kept");
    expect(button?.textContent).toBe("nav.jobs.failed.actionUploadAgain");
    await click(button);
    console.info(`[${SUITE}:kept] retry calls=${JSON.stringify(retry.mock.calls)}`);
    expect(retry).toHaveBeenCalledWith({ jobId: "job-kept", mode: "upload" });
    expect(findFile).not.toHaveBeenCalled();
    // The bin stays: removing is always there, beside the one action.
    expect(container?.querySelector('button[aria-label="Remove from history"]')).not.toBeNull();
  });

  it("@req UX-JOBS-03[badger-desktop] a group with a failed job is open without a click, and its toggle still closes it", async () => {
    await setup("job-open", entry("job-open", { action: "process_again", reason: "source_unchanged" }));
    expect(byTestId("failed-job-detail-job-open")).not.toBeNull();
    await click(groupToggle());
    console.info(`[${SUITE}:open] after one toggle click detail shown=${byTestId("failed-job-detail-job-open") !== null}`);
    expect(byTestId("failed-job-detail-job-open")).toBeNull();
    await click(groupToggle());
    expect(byTestId("failed-job-detail-job-open")).not.toBeNull();
  });

  it("@req UX-JOBS-03[badger-desktop] a moved file offers Find the file; a picked file that is another video says so", async () => {
    await setup("job-moved", entry("job-moved", { action: "find_file", reason: "source_missing" }));
    findFile.mockResolvedValueOnce({ retried: false, action: "find_file", reason: "picked_mismatch" });
    const button = byTestId("failed-job-action-job-moved");
    expect(button?.textContent).toBe("nav.jobs.failed.actionFindFile");
    await click(button);
    console.info(`[${SUITE}:moved] findFile calls=${JSON.stringify(findFile.mock.calls)} detail=${detailText("job-moved")}`);
    expect(findFile).toHaveBeenCalledWith({ jobId: "job-moved" });
    expect(retry).not.toHaveBeenCalled();
    expect(detailText("job-moved")).toContain("nav.jobs.failed.meaningPickedMismatch");
  });

  it("@req UX-JOBS-03[badger-desktop] a deleted file, a re-imported video and a full disk offer no button besides the bin", async () => {
    for (const [jobId, answer] of [
      ["job-deleted", entry("job-deleted", { action: "remove_only", reason: "source_deleted" })],
      ["job-again", entry("job-again", { action: "already_in_library", reason: "reimported" })],
      ["job-disk", entry("job-disk", { action: "free_space", reason: "disk_full", nextAction: "process_again" })],
    ] as const) {
      await setup(jobId, answer);
      console.info(`[${SUITE}:no-button] ${jobId} detail=${detailText(jobId)}`);
      expect(detailText(jobId)).not.toBe("(no detail)");
      expect(byTestId(`failed-job-action-${jobId}`)).toBeNull();
      expect(container?.querySelector('button[aria-label="Remove from history"]')).not.toBeNull();
      act(() => root?.unmount());
      root = null;
      container?.remove();
    }
  });

  it("@req UX-JOBS-03[badger-desktop] a full plan offers Upgrade plan, then Upload again once the plan has room", async () => {
    await setup(
      "job-quota",
      entry("job-quota", { action: "upgrade_plan", reason: "upload_quota", nextAction: "upload_again", keptBytes: 1024, keptUntil: "2026-12-08T10:00:00.000Z" }),
      "storage API 413: upload_quota_exceeded",
    );
    const before = byTestId("failed-job-action-job-quota")?.textContent;
    console.info(`[${SUITE}:quota] before=${before} detail=${detailText("job-quota")}`);
    expect(before).toBe("nav.jobs.failed.actionUpgradePlan");
    // jsdom has no layout, so scrolling is a stub; the plan's own upgrade button must get the focus.
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    await click(byTestId("failed-job-action-job-quota"));
    console.info(`[${SUITE}:quota] scroll calls=${scrollIntoView.mock.calls.length} focused=${document.activeElement?.getAttribute("data-testid")}`);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("quota-uploads-notice-upgrade");
    expect(retry).not.toHaveBeenCalled();
    await click(byTestId("quota-uploads-notice-upgrade"));
    const after = byTestId("failed-job-action-job-quota");
    console.info(`[${SUITE}:quota] after=${after?.textContent} detail=${detailText("job-quota")}`);
    expect(after?.textContent).toBe("nav.jobs.failed.actionUploadAgain");
    expect(detailText("job-quota")).toContain("nav.jobs.failed.meaningPlanHasRoom");
    await click(after);
    expect(retry).toHaveBeenCalledWith({ jobId: "job-quota", mode: "upload" });
  });
});

// @vitest-environment jsdom
//
// V2 Media-Details Processes tab visual-parity coverage.
//
// @bugfix @regression-proof
//
// Pre-fix bug: the V2 Processes tab rendered raw kind labels ("source",
// "format · 360p"), printed unresolved i18n keys
// ("library.processingStatus.cancel" / ".dismiss"), and showed a stale
// "SHARED PROCESSING JOBS" header borrowed from V1's worker-jobs concept.
// Post-fix: the panel reuses the same `buildActiveLabJobPresentation` /
// `buildCompletedLabJobPresentation` helpers that the polished sidebar
// uses, so the same IngestJobRecord renders identically in both surfaces.

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
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, second?: unknown) => (typeof second === "string" ? second : key),
  }),
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
    outputLabel: job.jobType === "source" ? "Source ingest" : `Transcode · ${job.selectedFormats?.[0]?.quality ?? ""}`,
    episodeLabel: null,
    uploadSpeedLabel: null,
    canStart: false,
  }),
  buildCompletedLabJobPresentation: (job: any) => ({
    outputSummary: job.jobType === "source" ? "Source ingest" : `Transcode · ${job.selectedFormats?.[0]?.quality ?? ""}`,
    completedMeta: null,
  }),
}));

vi.mock("../src/renderer/src/lib/useClientConfig", () => ({
  useClientConfig: () => ({ enableCodecSelection: false, runtimeEngineV2Enabled: true }),
}));

vi.mock("../src/renderer/src/lib/notify", () => ({
  notifyError: vi.fn(),
}));

const cancelJob = vi.fn(async () => undefined);
const dismissJob = vi.fn(async () => undefined);
let mockGroups: any[] = [];
const useRuntimeIngestJobsSpy = vi.fn();
let mockLibraryMedia: any[] = [];

vi.mock("../src/renderer/src/lib/runtimeIngestJobs", () => ({
  useRuntimeIngestJobs: (filter?: unknown) => {
    useRuntimeIngestJobsSpy(filter);
    return { jobs: [], groups: mockGroups, loading: false, error: null };
  },
  useRuntimeIngestActions: () => ({
    cancelJob,
    dismissJob,
    retryJob: vi.fn(),
    submitSources: vi.fn(),
  }),
}));

vi.mock("../src/renderer/src/lib/libraryContext", () => ({
  useLibraryData: () => ({ media: mockLibraryMedia, playlists: [] }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// On assertion failure, dump the rendered DOM + the mock call ledger so a CI
// failure is diagnosable offline. Body wrapped in try/catch so a dump failure
// can never mask the real assertion failure.
const dumpProcessingPanelSnapshot = (label: string) => {
  try {
    console.error(`=== [media-details-processing-panel:${label}] snapshot ===`);
    console.error(`mockGroups=${JSON.stringify(mockGroups, null, 2)}`);
    console.error(`mockLibraryMedia=${JSON.stringify(mockLibraryMedia, null, 2)}`);
    console.error(`cancelJob.calls=${JSON.stringify(cancelJob.mock.calls)}`);
    console.error(`dismissJob.calls=${JSON.stringify(dismissJob.mock.calls)}`);
    console.error(`useRuntimeIngestJobsSpy.calls=${JSON.stringify(useRuntimeIngestJobsSpy.mock.calls, null, 2)}`);
    const buttons = Array.from(container?.querySelectorAll("button") ?? []).map((b) => ({
      title: b.getAttribute("title"),
      text: b.textContent,
    }));
    console.error(`buttons=${JSON.stringify(buttons, null, 2)}`);
    console.error(`container.textContent=${JSON.stringify(container?.textContent ?? null)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const render = async (element: React.ReactElement) => {
  console.info("[media-details-processing-panel:render] mounting panel");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  console.info(`[media-details-processing-panel:render] mounted; textContent.length=${container?.textContent?.length ?? 0}`);
};

const makeJob = (id: string, overrides: any = {}) => ({
  id,
  filename: `${id}.mkv`,
  status: "transcoding",
  progress: 50,
  error: undefined,
  matchedMediaId: "media-1",
  groupId: "media-1",
  matchedTo: null,
  detectedTitle: id,
  detectedSeason: null,
  detectedEpisode: null,
  uploadSpeedMbps: 0,
  jobType: "transcode",
  selectedFormats: [{ quality: "360p", codec: "h264" }],
  createdAt: new Date().toISOString(),
  ...overrides,
});

const makeGroup = (id: string, jobs: any[], status: any = "transcoding") => ({
  id,
  title: id,
  posterPath: null,
  jobs,
  progress: 50,
  status,
  uploadSpeedMbps: 0,
});

beforeEach(() => {
  cancelJob.mockClear();
  dismissJob.mockClear();
  useRuntimeIngestJobsSpy.mockClear();
  mockGroups = [];
  mockLibraryMedia = [];
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

describe("MediaDetailsProcessingPanel", () => {
  it("[@bugfix][@regression-proof] renders the same outputLabel as the sidebar (no raw kind/variant)", async () => {
    console.info("[media-details-processing-panel:output-label] seeding 1 source job + 1 transcode job for media-1");
    const sourceJob = makeJob("job-source", { jobType: "source", selectedFormats: undefined });
    const transcodeJob = makeJob("job-360p", { jobType: "transcode" });
    mockGroups = [makeGroup("media-1", [sourceJob, transcodeJob])];

    const { default: Panel } = await import(
      "../src/renderer/src/components/MediaDetailsProcessingPanel"
    );
    await render(<Panel mediaId="media-1" />);

    try {
      expect(container?.textContent).toContain("Source ingest");
      expect(container?.textContent).toContain("Transcode · 360p");
      // Should NOT contain the V1-style raw "format · 360p" kind label.
      expect(container?.textContent).not.toContain("format · 360p");
      // Should NOT contain the V1-borrowed shared-jobs header.
      expect(container?.textContent?.toLowerCase()).not.toContain("shared processing jobs");
      expect(container?.textContent).not.toContain("library.processingStatus.sharedJobsTitle");
    } catch (err) {
      dumpProcessingPanelSnapshot("output-label");
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] resolves i18n keys (no raw key strings rendered)", async () => {
    console.info("[media-details-processing-panel:i18n-keys] seeding 1 transcoding job for media-1");
    mockGroups = [makeGroup("media-1", [makeJob("job-1")])];

    const { default: Panel } = await import(
      "../src/renderer/src/components/MediaDetailsProcessingPanel"
    );
    await render(<Panel mediaId="media-1" />);

    const cancelButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (b) => b.getAttribute("title") === "Cancel",
    );
    console.info(`[media-details-processing-panel:i18n-keys] cancelButton-present=${Boolean(cancelButton)}`);
    try {
      // The polished panel uses an icon button with a title; the title resolves via t(key, fallback).
      expect(container?.textContent).not.toContain("library.processingStatus.cancel");
      expect(container?.textContent).not.toContain("library.processingStatus.dismiss");
      expect(cancelButton).toBeTruthy();
    } catch (err) {
      dumpProcessingPanelSnapshot("i18n-keys");
      throw err;
    }
  });

  it("cancel button calls cancelJob for active rows", async () => {
    console.info("[media-details-processing-panel:cancel-active] seeding 1 active (transcoding) job for media-1");
    mockGroups = [makeGroup("media-1", [makeJob("job-active", { status: "transcoding" })])];

    const { default: Panel } = await import(
      "../src/renderer/src/components/MediaDetailsProcessingPanel"
    );
    await render(<Panel mediaId="media-1" />);

    const cancelButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (b) => b.getAttribute("title") === "Cancel",
    );
    console.info(`[media-details-processing-panel:cancel-active] cancelButton-present=${Boolean(cancelButton)}; clicking`);
    await act(async () => {
      cancelButton?.click();
    });
    console.info(`[media-details-processing-panel:cancel-active] cancelJob.calls=${JSON.stringify(cancelJob.mock.calls)} dismissJob.calls=${JSON.stringify(dismissJob.mock.calls)}`);
    try {
      expect(cancelJob).toHaveBeenCalledWith("job-active");
      expect(dismissJob).not.toHaveBeenCalled();
    } catch (err) {
      dumpProcessingPanelSnapshot("cancel-active");
      throw err;
    }
  });

  it("dismiss button calls dismissJob for terminal rows", async () => {
    console.info("[media-details-processing-panel:dismiss-terminal] seeding 1 failed (terminal) job for media-1");
    mockGroups = [
      makeGroup(
        "media-1",
        [makeJob("job-failed", { status: "failed" })],
        "failed",
      ),
    ];

    const { default: Panel } = await import(
      "../src/renderer/src/components/MediaDetailsProcessingPanel"
    );
    await render(<Panel mediaId="media-1" />);

    const dismissButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (b) => b.getAttribute("title") === "Remove from history",
    );
    console.info(`[media-details-processing-panel:dismiss-terminal] dismissButton-present=${Boolean(dismissButton)}`);
    if (!dismissButton) dumpProcessingPanelSnapshot("dismiss-terminal-no-button");
    expect(dismissButton).toBeTruthy();
    await act(async () => {
      dismissButton?.click();
    });
    console.info(`[media-details-processing-panel:dismiss-terminal] dismissJob.calls=${JSON.stringify(dismissJob.mock.calls)} cancelJob.calls=${JSON.stringify(cancelJob.mock.calls)}`);
    try {
      expect(dismissJob).toHaveBeenCalledWith("job-failed");
      expect(cancelJob).not.toHaveBeenCalled();
    } catch (err) {
      dumpProcessingPanelSnapshot("dismiss-terminal");
      throw err;
    }
  });

  it("renders friendly empty-state when there are no jobs for the media (Round 5 — tab is always present)", async () => {
    // Round 5 UX change: the Jobs tab is now always visible, so the
    // panel must render a message when empty rather than returning null
    // (which would leave the user staring at a blank tab).
    console.info("[media-details-processing-panel:empty-state] seeding ZERO groups for media-1 (expect friendly empty-state, not null)");
    mockGroups = [];
    const { default: Panel } = await import(
      "../src/renderer/src/components/MediaDetailsProcessingPanel"
    );
    await render(<Panel mediaId="media-1" />);
    const empty = container?.querySelector('[data-testid="processing-panel-empty-state"]');
    console.info(`[media-details-processing-panel:empty-state] empty-state-present=${Boolean(empty)}`);
    try {
      expect(empty).toBeTruthy();
      // The mock t() returns fallback when given as second arg; the panel
      // calls t("library.jobs.emptyTitle", "All caught up") so the DOM
      // shows "All caught up". Either fallback or i18n-key match is valid
      // evidence the empty-state rendered.
      expect(container?.textContent ?? "").toContain("All caught up");
    } catch (err) {
      dumpProcessingPanelSnapshot("empty-state");
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] passes library media to useRuntimeIngestJobs so the orphan filter can see the media row (Round 4 D3 — Orchard terminal-only group went blank)", async () => {
    // Pre-fix: the panel called useRuntimeIngestJobs({ mediaId }) without
    // forwarding media, so buildIngestJobGroups built an empty mediaById
    // index, declared every terminal-only group a stale orphan, and the
    // tab rendered empty. Fix: panel pulls useLibraryData().media and
    // threads it through. Asserting on the call args is the right
    // contract — without media, the inner orphan filter trips.
    console.info("[media-details-processing-panel:media-threading] seeding library media (Orchard) + 1 done source group; expect useRuntimeIngestJobs to receive { mediaId, media }");
    mockLibraryMedia = [
      { id: "media-1", title: "Orchard", type: "movie", posterPath: "/orchard.jpg" } as any,
    ];
    mockGroups = [makeGroup("media-1", [makeJob("job-source", { jobType: "source", status: "done" })], "done")];
    const { default: Panel } = await import(
      "../src/renderer/src/components/MediaDetailsProcessingPanel"
    );
    await render(<Panel mediaId="media-1" />);
    const lastCall = useRuntimeIngestJobsSpy.mock.calls.at(-1)?.[0];
    console.info(`[media-details-processing-panel:media-threading] useRuntimeIngestJobs.callCount=${useRuntimeIngestJobsSpy.mock.calls.length} lastCall=${JSON.stringify(lastCall)} mediaIsSameRef=${lastCall?.media === mockLibraryMedia}`);
    try {
      expect(useRuntimeIngestJobsSpy).toHaveBeenCalled();
      expect(lastCall).toMatchObject({ mediaId: "media-1" });
      expect(lastCall?.media).toBe(mockLibraryMedia);
    } catch (err) {
      dumpProcessingPanelSnapshot("media-threading");
      throw err;
    }
  });
});

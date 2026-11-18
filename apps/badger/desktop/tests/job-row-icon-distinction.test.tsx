// @vitest-environment jsdom
//
// B4: Cancel-active and dismiss-terminal both use Trash2 today, which makes
// the destructive intent ambiguous. Use X for cancel-active (interrupt
// in-flight work) and keep Trash2 for dismiss-terminal (sweep history).
// Coverage: the sidebar GroupCard active row, the sidebar CompletedJobRow,
// AND the media modal Processes tab (MediaDetailsProcessingPanel).

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

vi.mock("lucide-react", () => ({
  ChevronDown: () => <span />,
  ChevronRight: () => <span />,
  Trash2: () => <span data-testid="icon-trash" />,
  X: () => <span data-testid="icon-x" />,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, second?: unknown) => (typeof second === "string" ? second : key),
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

vi.mock("../src/renderer/src/components/IngestUnavailableBanner", () => ({
  default: () => null,
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

vi.mock("../src/renderer/src/lib/notify", () => ({
  notifyError: vi.fn(),
}));

vi.mock("../src/renderer/src/lib/libraryContext", () => ({
  useLibraryData: () => ({ media: [], playlists: [] }),
  useOptionalLibraryData: () => ({ media: [] }),
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

const expandFirstGroup = async () => {
  const groupBtn = container!.querySelector(
    '[role="button"].flex.w-full.items-center',
  );
  console.info(
    `[job-row-icon-distinction:expand] group toggle found=${groupBtn !== null}`,
  );
  await act(async () =>
    groupBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
};

// On assertion failure, dump every button (aria-label + the icon testids it
// contains) so an icon-routing regression is diagnosable from the CI log.
// Wrapped so a dump failure can't mask the real assertion failure.
const dumpIconSnapshot = (label: string) => {
  try {
    console.error(`=== [job-row-icon-distinction:${label}] snapshot ===`);
    if (!container) {
      console.error(`container is null`);
      return;
    }
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => ({
      ariaLabel: b.getAttribute("aria-label"),
      hasTrash: b.querySelector('[data-testid="icon-trash"]') !== null,
      hasX: b.querySelector('[data-testid="icon-x"]') !== null,
      text: b.textContent ?? "",
    }));
    console.error(`buttons (${buttons.length}):\n${JSON.stringify(buttons, null, 2)}`);
    console.error(
      `icon counts: trash=${container.querySelectorAll('[data-testid="icon-trash"]').length} x=${container.querySelectorAll('[data-testid="icon-x"]').length}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("[@bugfix][@regression-proof] B4 cancel vs dismiss icons", () => {
  describe("sidebar — TopNavJobsSidebarContent", () => {
    it("active job row uses X icon (cancel)", async () => {
      console.info(`[job-row-icon-distinction:setup] sidebar active (transcoding) group`);
      mockGroups = [
        makeGroup("media-1", [makeJob("j-a", "transcoding")], "transcoding"),
      ];
      const { default: View } = await import(
        "../src/renderer/src/components/TopNavJobsSidebarContent"
      );
      await render(<View />);
      await expandFirstGroup();
      const cancelBtn = container!.querySelector('button[aria-label="Cancel"]');
      if (
        !cancelBtn ||
        cancelBtn.querySelector('[data-testid="icon-x"]') === null ||
        cancelBtn.querySelector('[data-testid="icon-trash"]') !== null
      ) {
        dumpIconSnapshot("sidebar-active");
      }
      expect(cancelBtn).not.toBeNull();
      expect(cancelBtn!.querySelector('[data-testid="icon-x"]')).not.toBeNull();
      expect(cancelBtn!.querySelector('[data-testid="icon-trash"]')).toBeNull();
    });

    it("completed job row uses Trash2 icon (dismiss)", async () => {
      console.info(`[job-row-icon-distinction:setup] sidebar completed (done) group`);
      mockGroups = [makeGroup("media-1", [makeJob("j-d", "done")], "done")];
      const { default: View } = await import(
        "../src/renderer/src/components/TopNavJobsSidebarContent"
      );
      await render(<View />);
      await expandFirstGroup();
      const dismissBtn = container!.querySelector(
        'button[aria-label="Remove from history"]',
      );
      if (
        !dismissBtn ||
        dismissBtn.querySelector('[data-testid="icon-trash"]') === null ||
        dismissBtn.querySelector('[data-testid="icon-x"]') !== null
      ) {
        dumpIconSnapshot("sidebar-completed");
      }
      expect(dismissBtn).not.toBeNull();
      expect(dismissBtn!.querySelector('[data-testid="icon-trash"]')).not.toBeNull();
      expect(dismissBtn!.querySelector('[data-testid="icon-x"]')).toBeNull();
    });
  });

  describe("media modal Processes tab — MediaDetailsProcessingPanel", () => {
    it("active job row uses X icon (cancel)", async () => {
      console.info(`[job-row-icon-distinction:setup] modal active (uploading) group`);
      mockGroups = [
        makeGroup("media-1", [makeJob("j-a", "uploading")], "uploading"),
      ];
      const { default: Panel } = await import(
        "../src/renderer/src/components/MediaDetailsProcessingPanel"
      );
      await render(<Panel mediaId="media-1" />);
      const cancelBtn = container!.querySelector('button[aria-label="Cancel"]');
      if (
        !cancelBtn ||
        cancelBtn.querySelector('[data-testid="icon-x"]') === null ||
        cancelBtn.querySelector('[data-testid="icon-trash"]') !== null
      ) {
        dumpIconSnapshot("modal-active");
      }
      expect(cancelBtn).not.toBeNull();
      expect(cancelBtn!.querySelector('[data-testid="icon-x"]')).not.toBeNull();
      expect(cancelBtn!.querySelector('[data-testid="icon-trash"]')).toBeNull();
    });

    it("completed job row uses Trash2 icon (dismiss)", async () => {
      console.info(`[job-row-icon-distinction:setup] modal completed (done) group`);
      mockGroups = [makeGroup("media-1", [makeJob("j-d", "done")], "done")];
      const { default: Panel } = await import(
        "../src/renderer/src/components/MediaDetailsProcessingPanel"
      );
      await render(<Panel mediaId="media-1" />);
      const dismissBtn = container!.querySelector(
        'button[aria-label="Remove from history"]',
      );
      if (
        !dismissBtn ||
        dismissBtn.querySelector('[data-testid="icon-trash"]') === null ||
        dismissBtn.querySelector('[data-testid="icon-x"]') !== null
      ) {
        dumpIconSnapshot("modal-completed");
      }
      expect(dismissBtn).not.toBeNull();
      expect(dismissBtn!.querySelector('[data-testid="icon-trash"]')).not.toBeNull();
      expect(dismissBtn!.querySelector('[data-testid="icon-x"]')).toBeNull();
    });
  });
});

// @vitest-environment jsdom
/**
 * Badger's Jobs panel counts each title's jobs in the right plural form: "1 job" / "2 jobs", "1 tâche" / "2 tâches".
 * The real English and French bundles go through the real i18next, so a key without its `_one`/`_other` forms fails here.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance, type i18n as I18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import View from "../src/renderer/src/components/TopNavJobsSidebarContent";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "job-count-plural";

vi.mock("@space/ui", () => ({
  Button: ({ children, onClick, title, variant: _v, size: _s, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button onClick={onClick} aria-label={title} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@space/desktop-shell/components", async () => ({
  ...(await vi.importActual<object>("../../../../packages/desktop-shell/src/components/desktop-job-card")),
  AnimatedDismissRow: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DesktopJobsFilterBar: () => <div />,
  DesktopJobsEmpty: () => <div data-testid="jobs-empty" />,
  useStaggeredDismiss: () => ({ dismissing: new Set<string>(), scheduleDismiss: (_id: string, action: () => void) => action() }),
}));

vi.mock("lucide-react", () => ({
  ChevronDown: () => <span />,
  ChevronRight: () => <span />,
  Trash2: () => <span />,
  X: () => <span />,
}));

vi.mock("../src/renderer/src/components/MediaImage", () => ({ default: () => <div /> }));
vi.mock("../src/renderer/src/components/LabStatusBadge", () => ({
  LabStatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));
vi.mock("../src/renderer/src/components/labJobPresentation", () => ({
  buildActiveLabJobPresentation: (job: { id: string }) => ({ outputLabel: job.id, episodeLabel: null, uploadSpeedLabel: null }),
  buildCompletedLabJobPresentation: (job: { id: string }) => ({ outputSummary: job.id, completedMeta: null }),
}));
vi.mock("../src/renderer/src/lib/useClientConfig", () => ({
  useClientConfig: () => ({ enableCodecSelection: false, runtimeEngineV2Enabled: true }),
}));
vi.mock("../src/renderer/src/components/QuotaUploadsNotice", () => ({
  isUploadQuotaExceededJobError: () => false,
  default: () => null,
}));

const job = (id: string, groupId: string) => ({ id, filename: `${id}.mkv`, status: "running", progress: 10, groupId });
const group = (id: string, title: string, jobIds: string[]) => ({
  id,
  title,
  posterPath: null,
  type: undefined,
  progress: 10,
  status: "running",
  uploadSpeedMbps: 0,
  jobs: jobIds.map((jobId) => job(jobId, id)),
});

// One title with one job, one with two.
const mockGroups = [group("media-1", "One Film", ["a"]), group("media-2", "Two Films", ["b", "c"])];
vi.mock("../src/renderer/src/lib/runtimeIngestJobs", () => ({
  useRuntimeIngestJobs: () => ({ jobs: [], groups: mockGroups, loading: false, error: null }),
  useRuntimeIngestActions: () => ({ cancelJob: vi.fn(), cancelByGroup: vi.fn(), dismissJob: vi.fn(), retryJob: vi.fn(), submitSources: vi.fn() }),
  findStaleOrphanGroupIds: () => [],
  pickMostActiveJob: () => null,
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const makeI18n = async (lng: "en" | "fr"): Promise<I18n> => {
  const instance = createInstance();
  await instance.init({
    lng,
    fallbackLng: "en",
    resources: { en: { translation: en }, fr: { translation: fr } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return instance;
};

/** The count line under each title, in panel order. */
const renderCounts = async (lng: "en" | "fr"): Promise<string[]> => {
  const instance = await makeI18n(lng);
  Object.assign(window, { sf: { runtimeJobs: { availability: vi.fn(), retry: vi.fn(), findFile: vi.fn() } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <I18nextProvider i18n={instance}>
        <View />
      </I18nextProvider>,
    ),
  );
  const counts = Array.from(container.querySelectorAll("div.text-\\[11px\\].text-muted-foreground")).map((el) => el.textContent ?? "");
  console.info(`[${SUITE}:${lng}] counts=${JSON.stringify(counts)}`);
  return counts;
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("Badger Jobs panel job count", () => {
  it("says 1 job and 2 jobs in English", async () => {
    expect(await renderCounts("en")).toEqual(["1 job", "2 jobs"]);
  });

  it("says 1 tâche and 2 tâches in French", async () => {
    expect(await renderCounts("fr")).toEqual(["1 tâche", "2 tâches"]);
  });
});

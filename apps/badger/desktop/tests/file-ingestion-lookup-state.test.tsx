// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataRequestError } from "@space/metadata-client";
import { searchFailureText } from "../src/renderer/src/lib/metadataSearchError";
import { METADATA_LOOKUP_TIMEOUT_MS, MetadataLookupTimeoutError } from "../src/renderer/src/lib/metadataRetry";
import { localizeSearchResultForLibrary, searchTmdb } from "../src/renderer/src/lib/metadata";
import type * as SpaceUi from "@space/ui";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Partial mock: the import review pieces not flattened here (match header, no-match, ...) render for real.
vi.mock("@space/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof SpaceUi>()),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  // The shared import review frame (REL-FAM-02), flattened like the Dialog pieces above.
  ImportReviewDialog: ({ children, title, open: _open, onOpenChange: _onOpenChange, ...props }: React.HTMLAttributes<HTMLDivElement> & { title?: React.ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) => (
    <div {...props}>
      <div>{title}</div>
      {children}
    </div>
  ),
  ImportReviewBody: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  ImportReviewList: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  ImportReviewDetail: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  ImportReviewFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ImportReviewSummary: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  ImportReviewActions: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  toast: vi.fn(),
}));

// Partial mock: the dialog prefetches pages/Library (`void import(...)`), whose
// module graph uses icons beyond this list (e.g. Zap in lib/genres).
vi.mock("lucide-react", async (importOriginal) => {
  const Icon = () => <span data-testid="icon" />;
  return {
    ...((await importOriginal()) as Record<string, unknown>),
    Loader2: Icon,
    Check: Icon,
    AlertCircle: Icon,
    Search: Icon,
    Film: Icon,
    Tv: Icon,
    X: Icon,
    Upload: Icon,
    Plus: Icon,
    Play: Icon,
    Square: Icon,
    Shuffle: Icon,
    ChevronDown: Icon,
    Eye: Icon,
    Pencil: Icon,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      typeof vars?.count === "number" ? `${key}:${vars.count}` : key,
    i18n: { language: "en" },
  }),
}));

vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => ({
    token: "token",
    user: { id: "user-1" },
  }),
}));

vi.mock("../src/renderer/src/lib/useClientConfig", () => ({
  useClientConfig: () => ({
    enableCodecSelection: false,
    transcodeOutputs: [],
    trailerSource: {
      provider: "youtube",
      validated: true,
      invidiousUrl: "",
    },
  }),
}));

vi.mock("../src/renderer/src/lib/libraryContext", () => ({
  useLibraryData: () => ({
    media: [],
  }),
  useLibraryActions: () => ({
    getMediaDetails: () => null,
    getSharedSetting: () => null,
    addMediaFromTmdb: vi.fn(),
    addSubtitleTrackWithObject: vi.fn(),
  }),
}));

vi.mock("../src/renderer/src/components/MediaImage", () => ({
  default: ({ alt }: { alt?: string }) => <img alt={alt ?? ""} />,
}));

vi.mock("../src/renderer/src/lib/metadata", () => ({
  getTmdbDetails: vi.fn(),
  getTmdbDetailsForLibrary: vi.fn(),
  getTmdbTrailersForLanguages: vi.fn().mockResolvedValue([]),
  localizeSearchResultForLibrary: vi.fn(async (_token: string, result: unknown) => result),
  searchTmdb: vi.fn(),
}));

// The reserve's "tickets arrived" signal, driven by the test (a refill batch landing).
const ticketListeners = new Set<() => void>();
vi.mock("../src/renderer/src/lib/metadataTickets", () => ({
  onMetadataTicketsAvailable: (listener: () => void) => {
    ticketListeners.add(listener);
    return () => ticketListeners.delete(listener);
  },
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../src/renderer/src/components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({
    showLoading: vi.fn().mockReturnValue("loading-token"),
    hideLoading: vi.fn(),
  }),
}));

// INGS-IDENT-02: the import says "No match found" only after a file's lookup has ended without a match. A real
// first user saw "No match found" next to a file whose lookup was still running (the detail pane branched on
// `match` alone, and every file of a drop waits its turn with `match: null`).

const LOG = "[file-ingestion-lookup-state]";
const FILE_NAME = "Night of the Living Dead (1968).mkv";

type SearchAnswer = Awaited<ReturnType<typeof searchTmdb>>;
const searchAnswer = (results: unknown[]) =>
  // Only the fields the dialog reads; the fixture is not a full search payload.
  ({ results, page: 1, totalPages: 1 }) as unknown as SearchAnswer;

const flush = async (rounds = 20) => {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
};

/** Every state marker the test reads, so a failing assertion shows the whole picture in the CI log. */
const snapshot = (phase: string, container: HTMLElement | null) => {
  const text = container?.textContent ?? "";
  const markers = {
    searchingTitle: text.includes("ingestion.ui.searchingTitle"),
    searchingHeading: text.includes("ingestion.ui.searchingHeading"),
    noMatch: text.includes("ingestion.errors.noMatch"),
    noMatchHint: text.includes("ingestion.ui.noMatchHint"),
    unmatchedHeading: text.includes("ingestion.ui.unmatched"),
    searchFailed: text.includes("ingestion.errors.searchFailed"),
    searchTimedOut: text.includes("ingestion.errors.searchTimedOut"),
  };
  console.info(`${LOG}:${phase} markers=${JSON.stringify(markers)} searches=${JSON.stringify(vi.mocked(searchTmdb).mock.calls.map((c) => c.slice(1)))}`);
  return { text, markers };
};

const dump = (phase: string, container: HTMLElement | null) => {
  console.error(`=== ${LOG}:${phase} dialog text ===\n${container?.textContent ?? "(no container)"}`);
};

describe("FileIngestionDialog lookup states (INGS-IDENT-02)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const renderWithDroppedFile = async (names: string[] = [FILE_NAME]) => {
    const paths = names.map((name) => `/tmp/${name}`);
    const scanFiles = vi.fn().mockResolvedValue(names.map((name, i) => ({ path: paths[i], name, size: 1, kind: "video" })));
    (window as unknown as { sf?: unknown }).sf = { scanFiles };
    const { default: FileIngestionDialog } = await import("../src/renderer/src/components/FileIngestionDialog");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    console.info(`${LOG}:setup rendering the dialog with dropped files ${JSON.stringify(paths)}`);
    await act(async () => {
      root?.render(<FileIngestionDialog open paths={paths} pathsNonce={1} onOpenChange={vi.fn()} />);
      await Promise.resolve();
    });
    await flush();
    console.info(`${LOG}:setup scanFiles calls=${JSON.stringify(scanFiles.mock.calls)}`);
  };

  afterEach(() => {
    vi.useRealTimers();
    if (root && container) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.parentNode?.removeChild(container);
    container = null;
    delete (window as unknown as { sf?: unknown }).sf;
  });

  // @req INGS-IDENT-02[badger-desktop]
  it(
    "[@bugfix][@regression-proof] INGS-IDENT-02: a slow lookup shows a searching state, never \"No match found\", and \"No match found\" only once it ends empty",
    async () => {
      const search = vi.mocked(searchTmdb);
      search.mockReset();
      const answer = Promise.withResolvers<SearchAnswer>();
      search.mockImplementation(() => answer.promise);

      await renderWithDroppedFile();
      const pending = snapshot("pending", container);
      if (!pending.markers.searchingTitle || pending.markers.noMatch) dump("pending", container);
      expect(search.mock.calls.map((c) => c.slice(1))).toEqual([["movie", "Night of the Living Dead"]]);
      expect(pending.markers.searchingTitle).toBe(true);
      expect(pending.markers.noMatch).toBe(false);
      expect(pending.markers.noMatchHint).toBe(false);

      console.info(`${LOG}:phase the lookup ends with no result`);
      answer.resolve(searchAnswer([]));
      await flush();
      const done = snapshot("ended-empty", container);
      if (!done.markers.noMatch || done.markers.searchingTitle) dump("ended-empty", container);
      expect(done.markers.noMatch).toBe(true);
      expect(done.markers.noMatchHint).toBe(true);
      expect(done.markers.searchingTitle).toBe(false);
    },
    15000
  );

  // @req INGS-IDENT-02[badger-desktop]
  it(
    "[@bugfix][@regression-proof] INGS-IDENT-02: a lookup that never answers ends in \"took too long\" after its deadline, not a spinner forever",
    async () => {
      expect(searchFailureText(new MetadataLookupTimeoutError(METADATA_LOOKUP_TIMEOUT_MS))).toEqual({
        error: "ingestion.errors.searchTimedOut",
        hint: "ingestion.ui.searchTimedOutHint",
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const search = vi.mocked(searchTmdb);
      search.mockReset();
      const late = Promise.withResolvers<SearchAnswer>();
      search.mockImplementation(() => late.promise);

      await renderWithDroppedFile();
      const before = snapshot("before-deadline", container);
      expect(search).toHaveBeenCalledTimes(1);
      expect(before.markers.searchingTitle).toBe(true);
      expect(before.markers.noMatch).toBe(false);

      console.info(`${LOG}:phase ${METADATA_LOOKUP_TIMEOUT_MS - 1} ms pass: still within the deadline`);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(METADATA_LOOKUP_TIMEOUT_MS - 1);
      });
      const almost = snapshot("just-before-deadline", container);
      expect(almost.markers.searchingTitle).toBe(true);
      expect(almost.markers.searchTimedOut).toBe(false);

      console.info(`${LOG}:phase the deadline passes`);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await flush();
      const after = snapshot("after-deadline", container);
      if (!after.markers.searchTimedOut || after.markers.searchingTitle) dump("after-deadline", container);
      expect(after.markers.searchTimedOut).toBe(true);
      expect(after.text).toContain("ingestion.ui.searchTimedOutHint");
      expect(after.markers.searchingTitle).toBe(false);
      expect(after.markers.noMatch).toBe(false);
      // A timed-out attempt is not retried: the final state stands.
      expect(search).toHaveBeenCalledTimes(1);

      console.info(`${LOG}:phase the hung search answers after the deadline: its answer is ignored`);
      late.resolve(searchAnswer([{ id: 10331, type: "movie", title: "Night of the Living Dead", year: 1968 }]));
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(METADATA_LOOKUP_TIMEOUT_MS);
      });
      const lateAnswer = snapshot("late-answer", container);
      if (!lateAnswer.markers.searchTimedOut) dump("late-answer", container);
      expect(lateAnswer.markers.searchTimedOut).toBe(true);
      expect(lateAnswer.markers.searchingTitle).toBe(false);
      expect(lateAnswer.markers.noMatch).toBe(false);
      expect(search).toHaveBeenCalledTimes(1);
    },
    15000
  );

  // @req INGS-IDENT-02[badger-desktop]
  it(
    "INGS-IDENT-02: a lookup that fails says the search failed, not \"No match found\"",
    async () => {
      const search = vi.mocked(searchTmdb);
      search.mockReset();
      // A 4xx is not retried, so the failure is final at once.
      search.mockRejectedValue(new MetadataRequestError(400));

      await renderWithDroppedFile();
      const failed = snapshot("failed", container);
      if (!failed.markers.searchFailed) dump("failed", container);
      expect(failed.markers.searchFailed).toBe(true);
      expect(failed.text).toContain("ingestion.ui.searchFailedHint");
      expect(failed.markers.noMatch).toBe(false);
      expect(failed.markers.searchingTitle).toBe(false);
    },
    15000
  );
  // @req INGS-IDENT-02[badger-desktop]
  it(
    "[@bugfix][@regression-proof] INGS-IDENT-02: next to a matched title, a file still being looked up is listed as searching, not under \"Unmatched\"",
    async () => {
      const search = vi.mocked(searchTmdb);
      search.mockReset();
      const second = Promise.withResolvers<SearchAnswer>();
      // The drop's files are looked up one after the other: the first answers at once, the second hangs.
      search
        .mockResolvedValueOnce(searchAnswer([{ id: 10331, type: "movie", title: "Night of the Living Dead", year: 1968 }]))
        .mockImplementationOnce(() => second.promise);

      await renderWithDroppedFile([FILE_NAME, "Dawn of the Dead (1978).mkv"]);
      const pending = snapshot("second-pending", container);
      if (!pending.markers.searchingHeading || pending.markers.unmatchedHeading) dump("second-pending", container);
      expect(search.mock.calls.map((c) => c.slice(1))).toEqual([
        ["movie", "Night of the Living Dead"],
        ["movie", "Dawn of the Dead"],
      ]);
      expect(pending.text).toContain("Night of the Living Dead");
      expect(pending.markers.searchingHeading).toBe(true);
      expect(pending.markers.unmatchedHeading).toBe(false);
      expect(pending.markers.noMatch).toBe(false);
      // Add stays blocked while a file is being looked up.
      const add = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("ingestion.ui.addToLibrary"));
      console.info(`${LOG}:second-pending add button found=${Boolean(add)} disabled=${add?.disabled}`);
      expect(add?.disabled).toBe(true);

      console.info(`${LOG}:phase the second lookup ends with no result`);
      second.resolve(searchAnswer([]));
      await flush();
      const done = snapshot("second-ended-empty", container);
      if (!done.markers.unmatchedHeading || done.markers.searchingHeading) dump("second-ended-empty", container);
      expect(done.markers.unmatchedHeading).toBe(true);
      expect(done.markers.searchingHeading).toBe(false);
    },
    15000
  );
  // @req INGS-IDENT-02[badger-desktop]
  it(
    "INGS-IDENT-02: a found match is kept when localizing it hangs past the deadline (the raw hit is shown)",
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const search = vi.mocked(searchTmdb);
      const localize = vi.mocked(localizeSearchResultForLibrary);
      search.mockReset();
      search.mockResolvedValue(searchAnswer([{ id: 10331, type: "movie", title: "Night of the Living Dead", year: 1968 }]));
      localize.mockImplementation(() => new Promise(() => {}));
      try {
        await renderWithDroppedFile();
        const localizing = snapshot("localizing", container);
        console.info(`${LOG}:localizing localize calls=${localize.mock.calls.length}`);
        expect(localize).toHaveBeenCalledTimes(1);
        expect(localizing.markers.searchingTitle).toBe(true);
        expect(localizing.markers.noMatch).toBe(false);

        console.info(`${LOG}:phase localize passes its deadline`);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(METADATA_LOOKUP_TIMEOUT_MS);
        });
        await flush();
        const done = snapshot("localize-timed-out", container);
        if (!done.text.includes("Night of the Living Dead (1968)") || done.markers.searchTimedOut) dump("localize-timed-out", container);
        // The file ends matched with the raw hit: the match header (its only <h2>) names it.
        const headers = [...(container?.querySelectorAll("h2") ?? [])].map((h) => h.textContent);
        console.info(`${LOG}:localize-timed-out match headers=${JSON.stringify(headers)}`);
        expect(headers).toEqual(["Night of the Living Dead"]);
        expect(done.markers.searchingTitle).toBe(false);
        expect(done.markers.searchTimedOut).toBe(false);
        expect(done.markers.noMatch).toBe(false);
        expect(done.markers.searchFailed).toBe(false);
        const add = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("ingestion.ui.addToLibrary"));
        console.info(`${LOG}:localize-timed-out add button found=${Boolean(add)} disabled=${add?.disabled}`);
      } finally {
        localize.mockImplementation(async (_token: string, result: unknown) => result as never);
      }
    },
    15000
  );
});

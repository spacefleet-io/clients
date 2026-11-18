// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataRequestError, NoTicketError } from "@space/metadata-client";
import { searchFailureText } from "../src/renderer/src/lib/metadataSearchError";
import { searchTmdb } from "../src/renderer/src/lib/metadata";
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

// On assertion failure, dump the rendered dialog text (the seeded groups the
// test expects to see) so a seed/render-loop regression is diagnosable from
// the CI log. Wrapped so a dump failure can't mask the real assertion failure.
const dumpDialogSnapshot = (label: string, container: HTMLElement | null) => {
  try {
    console.error(`=== [file-ingestion-dialog:${label}] snapshot ===`);
    if (!container) {
      console.error(`container is null`);
      return;
    }
    const text = container.textContent ?? "";
    console.error(`container.textContent (len=${text.length}):\n${text}`);
    console.error(
      `expectations present: BetterCallSaul=${text.includes("Better Call Saul")} S1E01=${text.includes("S1E01")} S1E03=${text.includes("S1E03")}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("FileIngestionDialog", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const renderDialog = async () => {
    console.info(`[file-ingestion-dialog:setup] importing + rendering FileIngestionDialog`);
    const { default: FileIngestionDialog } = await import(
      "../src/renderer/src/components/FileIngestionDialog"
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <FileIngestionDialog open paths={[]} pathsNonce={0} onOpenChange={vi.fn()} />
      );
      await Promise.resolve();
    });
    console.info(`[file-ingestion-dialog:setup] dialog mounted`);
  };

  afterEach(() => {
    if (root && container) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
  });

  it(
    "[@bugfix][@regression-proof] opens seeded tv ingestion groups without entering an update loop",
    async () => {
      await renderDialog();

      console.info(`[file-ingestion-dialog:seed] dispatching sf:e2e-seed-ingestion with 2 tv candidates (ep1, ep3)`);
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent("sf:e2e-seed-ingestion", {
            detail: {
              candidates: [
                {
                  id: "ep1",
                  path: "/tmp/Better Call Saul - S01E01.mkv",
                  name: "Better Call Saul - S01E01.mkv",
                  kind: "video",
                  status: "ready",
                  match: { id: 60059, type: "tv", title: "Better Call Saul", year: 2015 } as any,
                  parsed: { title: "Better Call Saul", season: 1, episode: 1, year: 2015 },
                  probe: {
                    video: { codec: "h264", width: 1920, height: 1080 },
                    audio: { count: 1, languages: ["en"] },
                    subtitles: { count: 0, languages: [] },
                    chapters: { count: 0 },
                    durationSeconds: 3000,
                    audioTracks: [{ index: 1, language: "en", label: "English", codec: "aac", channels: 2 }],
                    subtitleTracks: [],
                  },
                },
                {
                  id: "ep3",
                  path: "/tmp/Better Call Saul - S01E03.mkv",
                  name: "Better Call Saul - S01E03.mkv",
                  kind: "video",
                  status: "ready",
                  match: { id: 60059, type: "tv", title: "Better Call Saul", year: 2015 } as any,
                  parsed: { title: "Better Call Saul", season: 1, episode: 3, year: 2015 },
                  probe: {
                    video: { codec: "h264", width: 1920, height: 1080 },
                    audio: { count: 1, languages: ["en"] },
                    subtitles: { count: 0, languages: [] },
                    chapters: { count: 0 },
                    durationSeconds: 3000,
                    audioTracks: [{ index: 1, language: "en", label: "English", codec: "aac", channels: 2 }],
                    subtitleTracks: [],
                  },
                },
              ],
            },
          })
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      const text = container?.textContent ?? "";
      console.info(
        `[file-ingestion-dialog:assert] seeded render text len=${text.length} (expect Better Call Saul + S1E01 + S1E03)`,
      );
      if (!text.includes("Better Call Saul") || !text.includes("S1E01") || !text.includes("S1E03")) {
        dumpDialogSnapshot("seeded-tv-groups", container);
      }
      expect(container?.textContent).toContain("Better Call Saul");
      expect(container?.textContent).toContain("S1E01");
      expect(container?.textContent).toContain("S1E03");
    },
    15000
  );

  it(
    "[@bugfix][@regression-proof] META-ANON-07: a search that failed because no ticket was available says metadata is unavailable, not \"No match found\"",
    async () => {
      const unavailable = searchFailureText(new NoTicketError());
      console.info(`[file-ingestion-dialog:no-ticket] NoTicketError -> ${JSON.stringify(unavailable)}; MetadataRequestError(500) -> ${JSON.stringify(searchFailureText(new MetadataRequestError(500)))}`);
      expect(unavailable).toEqual({ error: "ingestion.errors.metadataUnavailable", hint: "ingestion.ui.metadataUnavailableHint" });
      expect(searchFailureText(new MetadataRequestError(500))).toEqual({ error: "ingestion.errors.searchFailed", hint: "ingestion.ui.searchFailedHint" });

      await renderDialog();
      console.info(`[file-ingestion-dialog:no-ticket] seeding one movie whose search failed for want of a ticket`);
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent("sf:e2e-seed-ingestion", {
            detail: {
              candidates: [
                {
                  id: "notld",
                  path: "C:\\Users\\qa\\Videos\\Night of the Living Dead (1968).mkv",
                  name: "Night of the Living Dead (1968).mkv",
                  kind: "video",
                  status: "error",
                  error: unavailable.error,
                  errorHint: unavailable.hint,
                  match: null,
                  parsed: { title: "Night of the Living Dead", year: 1968 },
                  probe: null,
                },
              ],
            },
          })
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      const text = container?.textContent ?? "";
      console.info(`[file-ingestion-dialog:no-ticket] render text len=${text.length}`);
      if (!text.includes("ingestion.errors.metadataUnavailable") || text.includes("ingestion.errors.noMatch")) {
        dumpDialogSnapshot("no-ticket", container);
      }
      expect(text).toContain("ingestion.errors.metadataUnavailable");
      expect(text).toContain("ingestion.ui.metadataUnavailableHint");
      expect(text).not.toContain("ingestion.errors.noMatch");
    },
    15000
  );

  // @req META-ANON-10[badger-desktop]
  it(
    "[@bugfix][@regression-proof] META-ANON-10: a title search that found no ticket right after sign-in runs again on its own when tickets arrive",
    async () => {
      const search = vi.mocked(searchTmdb);
      search.mockReset();
      const unavailable = searchFailureText(new NoTicketError());

      await renderDialog();
      console.info(`[file-ingestion-dialog:tickets-arrive] phase: seeding one movie whose first search found no ticket`);
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent("sf:e2e-seed-ingestion", {
            detail: {
              candidates: [
                {
                  id: "notld",
                  path: "/tmp/Night of the Living Dead (1968).mkv",
                  name: "Night of the Living Dead (1968).mkv",
                  kind: "video",
                  status: "error",
                  error: unavailable.error,
                  errorHint: unavailable.hint,
                  searchUnavailable: true,
                  match: null,
                  parsed: { title: "Night of the Living Dead", year: 1968 },
                },
              ],
            },
          })
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      const before = container?.textContent ?? "";
      console.info(`[file-ingestion-dialog:tickets-arrive] before: listeners=${ticketListeners.size} unavailable=${before.includes("ingestion.errors.metadataUnavailable")} searches=${search.mock.calls.length}`);
      if (ticketListeners.size !== 1) dumpDialogSnapshot("tickets-arrive-before", container);
      expect(before).toContain("ingestion.errors.metadataUnavailable");
      expect(ticketListeners.size).toBe(1);
      expect(search).not.toHaveBeenCalled();

      console.info(`[file-ingestion-dialog:tickets-arrive] phase: a refill batch lands`);
      search.mockResolvedValue({
        results: [{ id: 10331, type: "movie", title: "Night of the Living Dead", year: 1968 }],
        page: 1,
        totalPages: 1,
        // Only the fields the dialog reads; the fixture is not a full search payload.
      } as unknown as Awaited<ReturnType<typeof searchTmdb>>);
      await act(async () => {
        for (const listener of [...ticketListeners]) listener();
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      const after = container?.textContent ?? "";
      console.info(`[file-ingestion-dialog:tickets-arrive] after: listeners=${ticketListeners.size} unavailable=${after.includes("ingestion.errors.metadataUnavailable")} searches=${JSON.stringify(search.mock.calls.map((c) => c.slice(1)))}`);
      if (after.includes("ingestion.errors.metadataUnavailable")) dumpDialogSnapshot("tickets-arrive-after", container);
      expect(search.mock.calls.map((c) => c.slice(1))).toEqual([["movie", "Night of the Living Dead"]]);
      expect(after).not.toContain("ingestion.errors.metadataUnavailable");
      expect(after).not.toContain("ingestion.errors.noMatch");
      // Nothing is waiting any more, so the dialog stops listening.
      expect(ticketListeners.size).toBe(0);
    },
    15000
  );

});

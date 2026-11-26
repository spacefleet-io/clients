// @vitest-environment jsdom
//
// Reproduces the per-candidate metadata-match pipeline for three drag-drop
// shapes that fail at e2e.  The hypothesis: searchTitles silently drops
// candidates when its mock returns empty results for a query the fixture
// doesn't recognise (default branch → { results: [] } → status "error").
//
// Approach: render FileIngestionDialog with open=true, pass synthetic paths,
// mock window.sf.scanFiles to return file stubs, mock searchTitles to branch
// by query keyword, then wait for the async identification loop to settle
// and assert on the rendered group titles in the left panel.
//
// If a candidate is matched: its match.title appears in the DOM left panel.
// If a candidate is dropped: the "ingestion.errors.noMatch" key appears and
// the group title is absent.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// vi.mock calls are hoisted above this import. Importing the dialog per test transformed its whole module graph
// inside the first test: on a loaded CI runner that alone overran the 15 s timeout (run 34609), and the timed-out
// test kept rendering into the next one and skewed its searchTitles counts.
import FileIngestionDialog from "../src/renderer/src/components/FileIngestionDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// =========================================================================
// Diagnostic logging helpers — per "Tests log generously" rule.
// =========================================================================

const SUITE = "file-ingestion-match-pipeline";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  if (value instanceof Element) {
    return `<Element ${(value as Element).tagName}>`;
  }
  return value;
};

const dumpFileIngestionMatchSnapshot = (
  label: string,
  ctx: {
    fileNames?: string[];
    domTextSnippet?: string;
    domTextLength?: number;
    saltmarshVisible?: boolean;
    lodgersVisible?: boolean;
    orchardVisible?: boolean;
    noMatchErrorCount?: number;
    s1Marker?: boolean;
    searchTitlesCallCount?: number;
    searchTitlesCalls?: unknown[];
    movieCallsCount?: number;
    tvCallsCount?: number;
    expected?: unknown;
    actual?: unknown;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] file-ingestion-match-pipeline snapshot ===`);
    if (ctx.fileNames !== undefined) {
      console.error(`fileNames:\n${JSON.stringify(ctx.fileNames, jsonReplacer, 2)}`);
    }
    if (ctx.domTextSnippet !== undefined) console.error(`domTextSnippet: ${ctx.domTextSnippet}`);
    if (ctx.domTextLength !== undefined) console.error(`domTextLength: ${ctx.domTextLength}`);
    if (ctx.saltmarshVisible !== undefined) console.error(`saltmarshVisible: ${ctx.saltmarshVisible}`);
    if (ctx.lodgersVisible !== undefined) console.error(`lodgersVisible: ${ctx.lodgersVisible}`);
    if (ctx.orchardVisible !== undefined) console.error(`orchardVisible: ${ctx.orchardVisible}`);
    if (ctx.noMatchErrorCount !== undefined) console.error(`noMatchErrorCount: ${ctx.noMatchErrorCount}`);
    if (ctx.s1Marker !== undefined) console.error(`s1Marker: ${ctx.s1Marker}`);
    if (ctx.searchTitlesCallCount !== undefined) console.error(`searchTitlesCallCount: ${ctx.searchTitlesCallCount}`);
    if (ctx.searchTitlesCalls !== undefined) {
      console.error(`searchTitlesCalls:\n${JSON.stringify(ctx.searchTitlesCalls, jsonReplacer, 2)}`);
    }
    if (ctx.movieCallsCount !== undefined) console.error(`movieCallsCount: ${ctx.movieCallsCount}`);
    if (ctx.tvCallsCount !== undefined) console.error(`tvCallsCount: ${ctx.tvCallsCount}`);
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, jsonReplacer, 2)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual:\n${JSON.stringify(ctx.actual, jsonReplacer, 2)}`);
    }
    if (ctx.extra !== undefined) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, jsonReplacer, 2)}`);
    }
    if (ctx.error !== undefined) {
      const e = ctx.error;
      console.error(`error: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e)}`);
    }
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// searchTitles mock — hoisted so vi.mock can reference it
// ---------------------------------------------------------------------------
const mockSearchTitles = vi.hoisted(() =>
  vi.fn(async (_token: string, type: string, query: string) => {
    const q = (query ?? "").toLowerCase();
    if (q.includes("saltmarsh")) {
      return {
        results: [
          {
            id: 100,
            type: "tv",
            title: "Saltmarsh",
            originalTitle: "Saltmarsh",
            originalLanguage: "en",
            overview: "The Marsh family.",
            year: "2018",
            rating: 8.9,
            posterPath: null,
            backdropPath: null,
          },
        ],
        page: 1,
        totalPages: 1,
      };
    }
    if (q.includes("lodgers")) {
      return {
        results: [
          {
            id: 200,
            type: "tv",
            title: "Lodgers",
            originalTitle: "Lodgers",
            originalLanguage: "en",
            overview: "Housemates share a flat.",
            year: "1994",
            rating: 8.9,
            posterPath: null,
            backdropPath: null,
          },
        ],
        page: 1,
        totalPages: 1,
      };
    }
    if (q.includes("orchard")) {
      return {
        results: [
          {
            id: 300,
            type: "movie",
            title: "Orchard",
            originalTitle: "Orchard",
            originalLanguage: "en",
            overview: "A boy enters the land of the dead.",
            year: "2017",
            rating: 8.4,
            posterPath: null,
            backdropPath: null,
          },
        ],
        page: 1,
        totalPages: 1,
      };
    }
    // @known-gap: unknown query → empty results → candidate status becomes
    // "error" and match stays null.  This is the silent-drop behaviour under
    // investigation.
    return { results: [], page: 1, totalPages: 1 };
  })
);

// ---------------------------------------------------------------------------
// Module mocks — must be at top level, before any imports of the mocked mods
// ---------------------------------------------------------------------------

vi.mock("@space/ui", async (importOriginal) => ({
  // The real exports the dialog grew since (ImportReviewPicker); the stubs below stay in charge of what they replace.
  ...(await importOriginal<Record<string, unknown>>()),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", props, children),
  Dialog: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props, children),
  DialogFooter: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogHeader: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogTitle: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  // The shared import review frame (REL-FAM-02), flattened like the Dialog pieces above.
  ImportReviewDialog: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
    React.createElement("div", null, React.createElement("div", null, title), children),
  ImportReviewBody: (props: React.HTMLAttributes<HTMLDivElement>) => React.createElement("div", props),
  ImportReviewList: (props: React.HTMLAttributes<HTMLDivElement>) => React.createElement("div", props),
  ImportReviewDetail: (props: React.HTMLAttributes<HTMLDivElement>) => React.createElement("div", props),
  ImportReviewFooter: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
  ImportReviewSummary: (props: React.HTMLAttributes<HTMLDivElement>) => React.createElement("div", props),
  ImportReviewActions: (props: React.HTMLAttributes<HTMLDivElement>) => React.createElement("div", props),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
  toast: vi.fn(),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const Icon = () => React.createElement("span");
  // Pass through the real module so lazy-loaded sub-pages (Library.tsx, etc.)
  // that reference icons we don't enumerate don't throw "No X export defined".
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Loader2: Icon, Check: Icon, AlertCircle: Icon, Search: Icon,
    Film: Icon, Tv: Icon, X: Icon, Upload: Icon, Plus: Icon,
    Play: Icon, Square: Icon, Shuffle: Icon, ChevronDown: Icon,
    Eye: Icon, Pencil: Icon,
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
  useAuth: () => ({ token: "test-token", user: { id: "user-1" } }),
}));

vi.mock("../src/renderer/src/lib/useClientConfig", () => ({
  useClientConfig: () => ({
    enableCodecSelection: false,
    transcodeOutputs: [],
    trailerSource: { provider: "youtube", validated: true, invidiousUrl: "" },
  }),
}));

vi.mock("../src/renderer/src/lib/libraryContext", () => ({
  useLibraryData: () => ({ media: [] }),
  useLibraryActions: () => ({
    getMediaDetails: () => null,
    getSharedSetting: () => null,
    addMediaFromCatalog: vi.fn(),
    addSubtitleTrackWithObject: vi.fn(),
  }),
}));

vi.mock("../src/renderer/src/components/MediaImage", () => ({
  default: ({ alt }: { alt?: string }) => React.createElement("img", { alt: alt ?? "" }),
}));

vi.mock("../src/renderer/src/lib/metadata", () => ({
  getTitleDetails: vi.fn(),
  getTitleDetailsForLibrary: vi.fn(),
  getTitleTrailersForLanguages: vi.fn().mockResolvedValue([]),
  searchTitles: mockSearchTitles,
  // Mock the localization helper as an identity pass-through. The test fixtures
  // already mark hits as English (originalLanguage="en"), so production code
  // would early-return the input; mocking it keeps the test framework-agnostic
  // and avoids hitting the catalog.
  localizeSearchResultForLibrary: vi.fn(async (_token: unknown, hit: unknown) => hit),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal scanned-file stub understood by processPaths. */
const makeScannedFile = (name: string, kind: "video" | "subtitle" = "video") => ({
  path: `/tmp/${name}`,
  name,
  size: 1_000_000,
  kind,
});

/** Settle all pending microtasks several times — the pipeline awaits
 *  searchTitles once per candidate, so we need multiple flush rounds. */
const flushAsync = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("FileIngestionDialog — per-candidate auto-match pipeline", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  // Install window.sf.scanFiles before each test
  beforeEach(() => {
    window.sf = {
      scanFiles: vi.fn(),
      probeMedia: vi.fn().mockResolvedValue(null),
    };
  });

  afterEach(() => {
    if (root && container) {
      act(() => { root?.unmount(); });
    }
    root = null;
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    delete window.sf;
  });

  /**
   * Renders the dialog with the given files as the initial drop payload.
   * Each name in `fileNames` becomes a scanned file stub.
   */
  const renderWithFiles = async (fileNames: string[]) => {
    console.info(`[${SUITE}:render] preparing scanned files for ${JSON.stringify(fileNames)}`);
    const scannedFiles = fileNames.map((n) => makeScannedFile(n));
    // @ts-expect-error mock IPC bridge typed loosely in tests
    (window.sf.scanFiles as ReturnType<typeof vi.fn>).mockResolvedValue(scannedFiles);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    console.info(`[${SUITE}:render] mounting dialog with open=true paths=${JSON.stringify(fileNames.map((n) => `/tmp/${n}`))}`);
    await act(async () => {
      root?.render(
        React.createElement(FileIngestionDialog, {
          open: true,
          paths: fileNames.map((n) => `/tmp/${n}`),
          pathsNonce: 1,
          onOpenChange: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    // Wait for the async identification loop to complete (one searchTitles call
    // per candidate, each awaited sequentially inside processPaths).
    console.info(`[${SUITE}:render] flushing async pipeline (40 rounds × 10ms)`);
    await flushAsync(40);
    console.info(`[${SUITE}:render] post-flush mockSearchTitles.calls=${mockSearchTitles.mock.calls.length}`);

    return container;
  };

  // -------------------------------------------------------------------------
  // Shape 1 — Multi-show: Saltmarsh S01E01 + Lodgers S01E01
  // Expected: 2 separate ready candidates with distinct matched catalogIds (100, 200)
  // -------------------------------------------------------------------------
  it("multi-show drop: Saltmarsh + Lodgers → 2 matched groups with distinct catalogIds", async () => {
    const label = "multi-show";
    const fileNames = ["Saltmarsh.S01E01.mkv", "Lodgers.S01E01.mkv"];
    console.info(`[${SUITE}:${label}] rendering with files: ${JSON.stringify(fileNames)}`);
    const dom = await renderWithFiles(fileNames);

    const text = dom?.textContent ?? "";

    console.log("[multi-show] rendered text snippet:", text.slice(0, 800));

    // Diagnostics: capture which groups appeared
    const saltmarshVisible = text.includes("Saltmarsh");
    const lodgersVisible = text.includes("Lodgers");
    const noMatchError = (text.match(/ingestion\.errors\.noMatch/g) ?? []).length;

    console.log("[multi-show] Saltmarsh visible:", saltmarshVisible);
    console.log("[multi-show] Lodgers visible:", lodgersVisible);
    console.log("[multi-show] noMatch error count:", noMatchError);
    console.info(
      `[${SUITE}:${label}] post-render summary: saltmarshVisible=${saltmarshVisible} lodgersVisible=${lodgersVisible} noMatchError=${noMatchError} searchTitles.calls=${mockSearchTitles.mock.calls.length}`
    );

    // @known-gap: if either show is missing, the silent-drop bug is active
    expect.soft(saltmarshVisible, "Saltmarsh candidate (catalogId=100) should be matched and visible").toBe(true);
    expect.soft(lodgersVisible, "Lodgers candidate (catalogId=200) should be matched and visible").toBe(true);
    expect.soft(noMatchError, "no candidates should fall through to error state").toBe(0);

    // Hard assertion: at least one group was matched (confirms pipeline runs at all)
    try {
      expect(
        saltmarshVisible || lodgersVisible,
        `pipeline produced no matched groups — text: ${text.slice(0, 400)}`
      ).toBe(true);
    } catch (err) {
      dumpFileIngestionMatchSnapshot(label, {
        fileNames,
        domTextSnippet: text.slice(0, 800),
        domTextLength: text.length,
        saltmarshVisible,
        lodgersVisible,
        noMatchErrorCount: noMatchError,
        searchTitlesCallCount: mockSearchTitles.mock.calls.length,
        searchTitlesCalls: mockSearchTitles.mock.calls.map((c) => ({ type: c[1], query: c[2] })),
        expected: { saltmarshVisible: true, lodgersVisible: true, noMatchErrorCount: 0 },
        actual: { saltmarshVisible, lodgersVisible, noMatchErrorCount: noMatchError },
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done`);
  });

  // -------------------------------------------------------------------------
  // Shape 2 — Multi-season: Saltmarsh S01E01 + Saltmarsh S02E01
  // Expected: 1 merged group (same show) with 2 distinct episode entries
  // -------------------------------------------------------------------------
  it("multi-season drop: Saltmarsh S01E01 + S02E01 → 1 group with both seasons matched", async () => {
    const label = "multi-season";
    const fileNames = ["Saltmarsh.S01E01.mkv", "Saltmarsh.S02E01.mkv"];
    console.info(`[${SUITE}:${label}] rendering with files: ${JSON.stringify(fileNames)}`);
    const dom = await renderWithFiles(fileNames);

    const text = dom?.textContent ?? "";

    console.log("[multi-season] rendered text snippet:", text.slice(0, 800));

    const saltmarshVisible = text.includes("Saltmarsh");
    // Episode markers rendered by t("ingestion.ui.seasonEpisode") — in our t()
    // mock that key is returned verbatim, so look for "S1E01" / "S2E01" or the key
    const s1Marker = text.includes("S1E01") || text.includes("ingestion.ui.seasonEpisode");
    const noMatchError = (text.match(/ingestion\.errors\.noMatch/g) ?? []).length;
    const saltmarshSearchCalls = mockSearchTitles.mock.calls.filter((c) =>
      c[2]?.toLowerCase().includes("saltmarsh")
    ).length;

    console.log("[multi-season] Saltmarsh group visible:", saltmarshVisible);
    console.log("[multi-season] season marker present:", s1Marker);
    console.log("[multi-season] noMatch error count:", noMatchError);
    console.info(
      `[${SUITE}:${label}] post-render summary: saltmarshVisible=${saltmarshVisible} s1Marker=${s1Marker} noMatchError=${noMatchError} saltmarshSearchCalls=${saltmarshSearchCalls} totalSearchTitlesCalls=${mockSearchTitles.mock.calls.length}`
    );

    // searchTitles is called TWICE (once per candidate) — both should return
    // the Saltmarsh result.  The grouping layer merges them into one group.
    expect.soft(saltmarshVisible, "Saltmarsh group should be visible after both seasons match").toBe(true);
    expect.soft(
      saltmarshSearchCalls,
      "searchTitles should be called twice for Saltmarsh (once per candidate)"
    ).toBe(2);
    expect.soft(noMatchError, "no candidates should fall through to error state").toBe(0);

    try {
      expect(
        saltmarshVisible,
        `multi-season: Saltmarsh group absent — text: ${text.slice(0, 400)}`
      ).toBe(true);
    } catch (err) {
      dumpFileIngestionMatchSnapshot(label, {
        fileNames,
        domTextSnippet: text.slice(0, 800),
        domTextLength: text.length,
        saltmarshVisible,
        s1Marker,
        noMatchErrorCount: noMatchError,
        searchTitlesCallCount: mockSearchTitles.mock.calls.length,
        searchTitlesCalls: mockSearchTitles.mock.calls.map((c) => ({ type: c[1], query: c[2] })),
        expected: { saltmarshVisible: true, saltmarshSearchCalls: 2, noMatchErrorCount: 0 },
        actual: { saltmarshVisible, saltmarshSearchCalls, noMatchErrorCount: noMatchError },
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done`);
  });

  // -------------------------------------------------------------------------
  // Shape 3 — Movie + TV combo: Orchard (movie) + Saltmarsh S01E01 (TV)
  // Expected: 1 movie group (Orchard, catalogId=300) + 1 TV group (Saltmarsh, catalogId=100)
  // -------------------------------------------------------------------------
  it("movie+TV combo drop: Orchard + Saltmarsh S01E01 → distinct movie and TV groups, no type cross-bleed", async () => {
    const label = "movie-tv-combo";
    const fileNames = ["Orchard.2017.mkv", "Saltmarsh.S01E01.mkv"];
    console.info(`[${SUITE}:${label}] rendering with files: ${JSON.stringify(fileNames)}`);
    const dom = await renderWithFiles(fileNames);

    const text = dom?.textContent ?? "";

    console.log("[movie+tv] rendered text snippet:", text.slice(0, 800));

    const orchardVisible = text.includes("Orchard");
    const saltmarshVisible = text.includes("Saltmarsh");
    const noMatchError = (text.match(/ingestion\.errors\.noMatch/g) ?? []).length;

    // Verify type discrimination: searchTitles should be called with type="movie"
    // for Orchard and type="tv" for Saltmarsh.
    const movieCalls = mockSearchTitles.mock.calls.filter((c) => c[1] === "movie");
    const tvCalls = mockSearchTitles.mock.calls.filter((c) => c[1] === "tv");

    console.log("[movie+tv] Orchard visible:", orchardVisible);
    console.log("[movie+tv] Saltmarsh visible:", saltmarshVisible);
    console.log("[movie+tv] noMatch error count:", noMatchError);
    console.log("[movie+tv] searchTitles movie calls:", movieCalls.length, "tv calls:", tvCalls.length);
    console.info(
      `[${SUITE}:${label}] post-render summary: orchardVisible=${orchardVisible} saltmarshVisible=${saltmarshVisible} noMatchError=${noMatchError} movieCalls=${movieCalls.length} tvCalls=${tvCalls.length} totalSearchTitlesCalls=${mockSearchTitles.mock.calls.length}`
    );

    // @known-gap: if Orchard is absent, the movie type-detection or the "orchard"
    // query branch failed to match — silent drop confirmed.
    expect.soft(orchardVisible, "Orchard (movie, catalogId=300) should be matched and visible").toBe(true);
    expect.soft(saltmarshVisible, "Saltmarsh (tv, catalogId=100) should be matched and visible").toBe(true);
    expect.soft(noMatchError, "no candidates should fall through to error state").toBe(0);

    // Type cross-bleed check: Orchard should have been searched as "movie",
    // Saltmarsh as "tv".
    expect.soft(
      movieCalls.some((c) => c[2]?.toLowerCase().includes("orchard")),
      "Orchard should be searched with type=movie"
    ).toBe(true);
    expect.soft(
      tvCalls.some((c) => c[2]?.toLowerCase().includes("saltmarsh")),
      "Saltmarsh should be searched with type=tv"
    ).toBe(true);

    // Hard assertion: both groups must be present for the bug NOT to be
    // reproduced.  If either is absent → pipeline bug confirmed.
    try {
      expect(
        orchardVisible || saltmarshVisible,
        `pipeline produced no matched groups — text: ${text.slice(0, 400)}`
      ).toBe(true);
    } catch (err) {
      dumpFileIngestionMatchSnapshot(label, {
        fileNames,
        domTextSnippet: text.slice(0, 800),
        domTextLength: text.length,
        orchardVisible,
        saltmarshVisible,
        noMatchErrorCount: noMatchError,
        searchTitlesCallCount: mockSearchTitles.mock.calls.length,
        searchTitlesCalls: mockSearchTitles.mock.calls.map((c) => ({ type: c[1], query: c[2] })),
        movieCallsCount: movieCalls.length,
        tvCallsCount: tvCalls.length,
        expected: { orchardVisible: true, saltmarshVisible: true, noMatchErrorCount: 0 },
        actual: { orchardVisible, saltmarshVisible, noMatchErrorCount: noMatchError },
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done`);
  });
});

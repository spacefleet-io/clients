// @vitest-environment jsdom
/**
 * @bugfix @regression-proof PLAY-NEXT-02 (Chris 2026-10-28, "Lodgers has no TIDB
 * data? more likely an error"): the import window fetches service markers for
 * every TV episode it matched, so each file is added with its intro/credits.
 *
 * Before the fix the resolver ran straight after `setCandidates`, read
 * `candidatesRef` before React applied the new match, and reused the in-flight
 * fetch of the show, so a drop of 4 Lodgers episodes fetched only S01E01 and a
 * drop of 22 Brooklyn Nine-Nine episodes only E01-E13.
 *
 * Drives the real FileIngestionDialog drop path (scanFiles → probeMedia → the catalog
 * match → skip markers → Add) and asserts on the skip-marker lookups sent through
 * the metadata client (META-SKIP-01: never a source itself) and on the sources
 * handed to `window.sf.runtimeJobs.submitSources`.
 */
// @req PLAY-NEXT-02[badger-desktop] @req META-SKIP-03[badger-desktop]
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { BadgerIngestSubmitSourceItem } from "@space/runtime-contracts/badger/ingest";
import FileIngestionDialog from "../src/renderer/src/components/FileIngestionDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P = "[file-ingestion-skip-markers-all-episodes]";

vi.mock("@space/ui", async (importOriginal) => ({
  // The real exports the dialog grew since (ImportReviewPicker); the stubs below stay in charge of what they replace.
  ...(await importOriginal<Record<string, unknown>>()),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => {
    const { variant: _variant, size: _size, ...rest } = props;
    return <button {...rest}>{children}</button>;
  },
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "type"> & {
    onCheckedChange?: (checked: boolean) => void;
  }) => <input type="checkbox" checked={checked} onChange={(e) => onCheckedChange?.(e.target.checked)} {...props} />,
  Dialog: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => <p {...props}>{children}</p>,
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

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      typeof vars?.count === "number" ? `${key}:${vars.count}` : key,
    i18n: { language: "en" },
  }),
}));

vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => ({ token: "token", user: { id: "user-1" }, setUser: vi.fn() }),
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
    fetchMediaDetails: async () => null,
    getSharedSetting: () => null,
    addMediaFromCatalog: async () => "media-show",
    addSubtitleTrackWithObject: vi.fn(),
    listSkipAnalysis: async () => [],
    upsertSkipAnalysis: async () => undefined,
  }),
}));

vi.mock("../src/renderer/src/components/MediaImage", () => ({
  default: ({ alt }: { alt?: string }) => <img alt={alt ?? ""} />,
}));

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const show = vi.hoisted(() => ({ catalogId: 901668, title: "Lodgers" }));

// The anonymous metadata client: every skipMarkers lookup is handed to the current test's mock.
const skipLookup = vi.hoisted(() => ({ current: null as null | ((req: SkipRequest) => Promise<unknown>) }));
vi.mock("../src/renderer/src/lib/metadataTickets", () => ({
  metadataClient: {
    skipMarkers: (request: { type: string; id: number; season: number; episode: number; durationSeconds?: number }) => {
      if (request.type !== "tv" || !skipLookup.current) throw new Error(`unexpected skipMarkers lookup ${JSON.stringify(request)}`);
      return skipLookup.current({
        catalogId: request.id,
        seasonNumber: request.season,
        episodeNumber: request.episode,
        ...(request.durationSeconds !== undefined ? { durationSeconds: request.durationSeconds } : {}),
      });
    },
  },
}));

vi.mock("../src/renderer/src/lib/metadata", () => ({
  getTitleDetails: vi.fn(),
  getTitleDetailsForLibrary: async () => ({
    id: show.catalogId,
    type: "tv",
    title: show.title,
    originalTitle: show.title,
    genres: [],
    totalEpisodes: 236,
  }),
  getTitleTrailersForLanguages: async () => [],
  localizeSearchResultForLibrary: async (_token: unknown, result: unknown) => result,
  searchTitles: async (_token: unknown, type: string) => {
    // A search slower than nothing lets each match land after the previous
    // episode's skip fetch started: the timing that lost episodes.
    await sleep(15);
    return {
      results: [{ type, id: show.catalogId, title: show.title, originalTitle: show.title, overview: "", year: 1994 }],
    };
  },
}));

vi.mock("../src/renderer/src/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAccountStorage: async () => ({
    plan: "x",
    storageAddonCount: 0,
    limitBytes: 1e15,
    usedBytes: 0,
    reservedBytes: 0,
    usageRatio: 0,
    warningLevel: "ok",
    apps: [],
    lastReconciledAt: null,
  }),
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../src/renderer/src/components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({ showLoading: vi.fn().mockReturnValue("loading-token"), hideLoading: vi.fn() }),
}));

const probe = {
  video: { codec: "h264", width: 1920, height: 1080 },
  audio: { count: 1, languages: ["en"] },
  subtitles: { count: 0, languages: [] },
  chapters: { count: 0 },
  durationSeconds: 1370,
  audioTracks: [{ index: 1, language: "en", label: "English", codec: "aac", channels: 2 }],
  subtitleTracks: [],
};

type SkipRequest = { catalogId: number; seasonNumber: number; episodeNumber: number; durationSeconds?: number };
type SubmitPayload = { userId: string; sources: BadgerIngestSubmitSourceItem[] };

const intro = { type: "intro" as const, startSeconds: 0, endSeconds: 46, source: "metadata", confidence: null };

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let logs: string[] = [];
const originalInfo = console.info;

const episodePaths = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `/videos/${show.title}/Season 01/${show.title} - S01E${String(i + 1).padStart(2, "0")} - Title [1080p].mkv`,
  );

const addButton = () =>
  Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) =>
    (button.textContent ?? "").includes("ingestion.ui.addToLibrary"),
  ) ?? null;

const setup = (opts: { hit: (req: SkipRequest) => boolean }): SkipMocks => {
  const getSkipMarkers = vi.fn(async (req: SkipRequest) => {
    await sleep(40);
    const hit = opts.hit(req);
    return {
      fetchedAt: new Date().toISOString(),
      markers: hit ? [intro] : [],
      coverage: [{ seasonNumber: req.seasonNumber, episodeNumber: req.episodeNumber, status: hit ? "hit" : "miss" }],
    };
  });
  const submitSources = vi.fn(async (_payload: SubmitPayload) => ({ submitted: [] }));
  Object.assign(window, {
    sf: {
      scanFiles: async (paths: string[]) =>
        paths.map((path) => ({ path, name: path.split("/").pop() ?? path, size: 7e8, kind: "video" })),
      probeMedia: async () => probe,
      runtimeJobs: { submitSources },
    },
  });
  skipLookup.current = getSkipMarkers;
  return { getSkipMarkers, submitSources };
};

const dump = (label: string, ctx: Record<string, unknown>) => {
  console.error(`=== ${P}:${label} ===`);
  console.error(`[skip-markers] log lines:\n${logs.join("\n")}`);
  console.error(JSON.stringify(ctx, null, 2));
  console.error(`add button=${addButton() ? (addButton()?.disabled ? "disabled" : "enabled") : "missing"}`);
  console.error(`=== ${P}:${label} end ===`);
};

type SkipMocks = {
  getSkipMarkers: Mock<(req: SkipRequest) => Promise<unknown>>;
  submitSources: Mock<(payload: SubmitPayload) => Promise<{ submitted: never[] }>>;
};

const dropAndAdd = async (paths: string[], mocks: SkipMocks) => {
  originalInfo(`${P}:drop count=${paths.length} first=${paths[0]}`);
  await act(async () => {
    root?.render(<FileIngestionDialog open paths={paths} pathsNonce={1} onOpenChange={vi.fn()} />);
  });
  const fetched = () => mocks.getSkipMarkers.mock.calls.map(([req]) => `${req.seasonNumber}:${req.episodeNumber}`);
  try {
    await vi.waitFor(() => expect(addButton()?.disabled).toBe(false), { timeout: 10_000 });
    // Let every queued skip pass settle; Add is also blocked while one is "fetching".
    await vi.waitFor(() => expect(new Set(fetched()).size).toBe(paths.length), { timeout: 10_000 });
    await vi.waitFor(() => expect(addButton()?.disabled).toBe(false), { timeout: 10_000 });
  } catch (err) {
    dump("drop", { fetched: fetched() });
    throw err;
  }
  originalInfo(`${P}:fetched=${JSON.stringify(fetched())}`);
  await act(async () => {
    addButton()?.click();
  });
  try {
    await vi.waitFor(() => expect(mocks.submitSources).toHaveBeenCalled(), { timeout: 10_000 });
  } catch (err) {
    dump("submit", { fetched: fetched() });
    throw err;
  }
  const sources = mocks.submitSources.mock.calls[0]?.[0].sources ?? [];
  originalInfo(
    `${P}:submitted\n${sources
      .map(
        (s) =>
          `${s.hints?.season}x${s.hints?.episode} skipMarkers=${JSON.stringify(s.skipMarkers)} cache=${
            s.showSkipCache ? Object.keys(s.showSkipCache.markersByEpisode).join(",") : "none"
          } coverage=${s.showSkipCache?.coverage.length ?? 0}`,
      )
      .join("\n")}`,
  );
  return { fetched: fetched(), sources };
};

beforeEach(() => {
  logs = [];
  console.info = (...args: unknown[]) => {
    if (String(args[0]).startsWith("[skip-markers]")) logs.push(`${String(args[0])} ${JSON.stringify(args[1] ?? null)}`);
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  console.info = originalInfo;
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("import window fetches skip markers for every matched episode", () => {
  it("4 Lodgers episodes: each fetched once and added with its intro", async () => {
    show.catalogId = 901668;
    show.title = "Lodgers";
    const mocks = setup({ hit: () => true });
    const { fetched, sources } = await dropAndAdd(episodePaths(4), mocks);
    if (fetched.length !== 4) dump("lodgers-fetch-count", { fetched });
    expect([...fetched].sort()).toEqual(["1:1", "1:2", "1:3", "1:4"]);
    expect(sources).toHaveLength(4);
    for (const source of sources) {
      expect(source.skipMarkers, `${source.filename}`).toEqual([intro]);
      expect(Object.keys(source.showSkipCache?.markersByEpisode ?? {}).sort()).toEqual(["1:1", "1:2", "1:3", "1:4"]);
    }
  }, 30_000);

  it("22 Brooklyn Nine-Nine episodes: all 22 fetched, none twice", async () => {
    show.catalogId = 48891;
    show.title = "Brooklyn Nine-Nine";
    const mocks = setup({ hit: () => true });
    const { fetched, sources } = await dropAndAdd(episodePaths(22), mocks);
    if (fetched.length !== 22) dump("b99-fetch-count", { fetched });
    expect(fetched).toHaveLength(22);
    expect(new Set(fetched).size).toBe(22);
    expect(sources.filter((s) => (s.skipMarkers ?? []).length === 1)).toHaveLength(22);
  }, 30_000);

  it("episodes the metadata service has nothing for still travel as recorded misses", async () => {
    show.catalogId = 901668;
    show.title = "Lodgers";
    const mocks = setup({ hit: () => false });
    const { sources } = await dropAndAdd(episodePaths(2), mocks);
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source.skipMarkers).toEqual([]);
      expect(source.showSkipCache?.coverage.map((c) => `${c.seasonNumber}:${c.episodeNumber}:${c.status}`).sort()).toEqual([
        "1:1:miss",
        "1:2:miss",
      ]);
    }
  }, 30_000);
});

// @vitest-environment jsdom
//
// Tests for OfflineDownloadConfirmDialog — covers:
//   - on open, dispatches `badger.offline.estimate_size` with the right args
//     and renders the resolved quality / size / filename
//   - surfaces the MP4 skipped-subs warning when items report skippedSubsForContainer
//   - surfaces the disk-warning when sufficientSpace=false; disables Confirm
//   - on confirm, dispatches `badger.offline.download_submit` with the right args
//   - on success, calls onSubmitted with the submitted jobIds + closes
//
// Phase 3 of the offline-mode plan (Layer C, item 11).
//
// Test logging follows the "tests log generously" convention — phase
// markers + state dumps on every assertion.
import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { setStorageUnitBase } from "@space/shared/format";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock @space/ui primitives so we don't pull in real Radix portals.
vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? <div data-testid="dialog-root">{children}</div> : null,
  DialogContent: ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...rest}>{children}</div>
  ),
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  toast: vi.fn(),
}));

vi.mock("lucide-react", () => ({
  AlertTriangle: () => <span data-testid="alert-icon" />,
  Download: () => <span data-testid="download-icon" />,
  Loader2: () => <span data-testid="loader-icon" />,
}));

// Mock @space/runtime-contracts to provide minimal Zod shapes the IPC validator can re-parse.
// Vite cant resolve @space/* through workspaces in jsdom test? actually it can via tsconfig paths.

// Mock the offline IPC helpers. The dialog calls callOfflineEstimate +
// callOfflineDownloadSubmit; we intercept those and return canned results.
const estimateMock = vi.fn();
const submitMock = vi.fn();
vi.mock("@/lib/offlineIpc", () => ({
  callOfflineEstimate: (...args: unknown[]) => estimateMock(...args),
  callOfflineDownloadSubmit: (...args: unknown[]) => submitMock(...args),
  isOfflineIpcError: (v: unknown) =>
    !!v && typeof v === "object" && (v as { __runtimeJobsError?: unknown }).__runtimeJobsError === true,
}));

// Mock the logger because the dialog uses rendererLogger.child().
vi.mock("@/logger", () => ({
  rendererLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

// Translation passthrough that includes the interpolations.
const t = (key: string, opts?: Record<string, unknown>) => {
  if (!opts) return key;
  let out = key;
  Object.entries(opts).forEach(([k, v]) => {
    out += ` ${k}=${String(v)}`;
  });
  return out;
};
// The interface language the dialog writes sizes in (STOR-UNIT-02); a test switches it, afterEach puts English back.
const i18n = { language: "en" };
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t, i18n }),
  // Stub initReactI18next when imported anywhere.
  initReactI18next: { type: "3rdParty", init: () => undefined },
}));

// Now import after mocks are wired.
let OfflineDownloadConfirmDialog: typeof import(
  "../src/renderer/src/components/OfflineDownloadConfirmDialog"
).default;

let container: HTMLDivElement;
let root: Root;

const makeDetails = () =>
  ({
    id: "movie-1",
    type: "movie",
    tmdbId: 1,
    externalIds: null,
    title: "The Matrix",
    originalTitle: null,
    originalLanguage: null,
    overview: null,
    year: "1999",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    addedAt: "2024-01-01",
    updatedAt: "2024-01-01",
    hasFiles: true,
    progressPct: 0,
    lastWatchedAt: null,
    totalEpisodes: null,
    episodeCount: 0,
    cast: [],
    playlistIds: [],
    seasons: [],
    episodes: [],
    trailers: [],
    files: [{ id: "movie-file-1", filename: "matrix.mkv", season: null, episode: null, desiredFormats: [] }],
    formats: [],
    audioTracks: [],
    subtitleTracks: [],
    subtitles: [],
    chapters: [],
    skipMarkers: [],
    hasLocalFiles: false,
  } as unknown as Parameters<typeof OfflineDownloadConfirmDialog>[0]["details"]);

// TV show fixture with 2 seasons × 2 episodes, used by the fileIds narrow-
// scope test (season/episode scopes must pass precise fileIds, not parent
// mediaIds alone).
const makeShowDetails = () =>
  ({
    id: "show-1",
    type: "tv",
    tmdbId: 2,
    externalIds: null,
    title: "Test Show",
    originalTitle: null,
    originalLanguage: null,
    overview: null,
    year: "2020",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    addedAt: "2024-01-01",
    updatedAt: "2024-01-01",
    hasFiles: true,
    progressPct: 0,
    lastWatchedAt: null,
    totalEpisodes: 4,
    episodeCount: 4,
    cast: [],
    playlistIds: [],
    seasons: [
      { id: "s1", seasonNumber: 1, name: "S1", overview: null, posterPath: null, episodeCount: 2, airDate: null },
      { id: "s2", seasonNumber: 2, name: "S2", overview: null, posterPath: null, episodeCount: 2, airDate: null },
    ],
    episodes: [
      { id: "ep-1-1", seasonNumber: 1, episodeNumber: 1, name: "S1E1", overview: null, stillPath: null, airDate: null },
      { id: "ep-1-2", seasonNumber: 1, episodeNumber: 2, name: "S1E2", overview: null, stillPath: null, airDate: null },
      { id: "ep-2-1", seasonNumber: 2, episodeNumber: 1, name: "S2E1", overview: null, stillPath: null, airDate: null },
      { id: "ep-2-2", seasonNumber: 2, episodeNumber: 2, name: "S2E2", overview: null, stillPath: null, airDate: null },
    ],
    trailers: [],
    files: [
      { id: "file-1-1", filename: "s1e1.mkv", season: 1, episode: 1, desiredFormats: [] },
      { id: "file-1-2", filename: "s1e2.mkv", season: 1, episode: 2, desiredFormats: [] },
      { id: "file-2-1", filename: "s2e1.mkv", season: 2, episode: 1, desiredFormats: [] },
      { id: "file-2-2", filename: "s2e2.mkv", season: 2, episode: 2, desiredFormats: [] },
    ],
    formats: [],
    audioTracks: [],
    subtitleTracks: [],
    subtitles: [],
    chapters: [],
    skipMarkers: [],
    hasLocalFiles: false,
  } as unknown as Parameters<typeof OfflineDownloadConfirmDialog>[0]["details"]);

const makeClientConfig = () =>
  ({
    configured: true,
    playbackQuality: "1080p",
    forcePlaybackQuality: false,
    transcodeOutputs: [],
    enableCodecSelection: false,
    maxParallelTranscodes: 1,
    maxParallelExtractions: 1,
    enableWatchDirectories: false,
    enableMetadataTools: false,
    uiLanguage: "en",
    uiMode: "dark",
    uiTheme: "space",
    trailerSource: { provider: "youtube", invidiousUrl: "", validated: false },
    trailerLanguages: { extras: [] },
    autoplayNextEpisode: true,
    introSkipEnabled: true,
    creditsSkipEnabled: true,
    skipMode: "auto",
    watchedDirectories: [],
    runtimeEngineV2Enabled: true,
    autoUpdate: false,
    offlineExportFormat: "mkv",
  } as unknown as Parameters<typeof OfflineDownloadConfirmDialog>[0]["clientConfig"]);

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  estimateMock.mockReset();
  submitMock.mockReset();
  // Dynamic import AFTER mocks are in place so the module's internal
  // bindings to those mocks are correctly captured.
  const mod = await import("../src/renderer/src/components/OfflineDownloadConfirmDialog");
  OfflineDownloadConfirmDialog = mod.default;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  setStorageUnitBase(1000);
  i18n.language = "en";
});

const renderDialog = async (overrides: {
  open?: boolean;
  exportFormat?: "mkv" | "mp4";
  onOpenChange?: (v: boolean) => void;
  onSubmitted?: (r: { submittedJobIds: string[] }) => void;
  scope?: Parameters<typeof OfflineDownloadConfirmDialog>[0]["scope"];
  details?: Parameters<typeof OfflineDownloadConfirmDialog>[0]["details"];
} = {}) => {
  const clientConfig = makeClientConfig();
  if (overrides.exportFormat) {
    (clientConfig as { offlineExportFormat: string }).offlineExportFormat = overrides.exportFormat;
  }
  await act(async () => {
    root.render(
      <OfflineDownloadConfirmDialog
        open={overrides.open ?? true}
        onOpenChange={overrides.onOpenChange ?? (() => undefined)}
        scope={overrides.scope ?? { kind: "movie" }}
        details={overrides.details ?? makeDetails()}
        clientConfig={clientConfig}
        onSubmitted={overrides.onSubmitted}
      />,
    );
    // Flush microtasks (estimate fetch is async)
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("OfflineDownloadConfirmDialog", () => {
  it("dispatches estimate_size with the scope payload on open", async () => {
    console.info("[offline-confirm-test] estimate returns successful result");
    estimateMock.mockResolvedValue({
      items: [
        {
          mediaId: "movie-1",
          fileId: "movie-file-1",
          selectedQuality: "1080p",
          videoBytes: 5_000_000_000,
          audioBytes: 500_000_000,
          subtitleBytes: 50_000,
          totalBytes: 5_500_050_000,
          alreadyLocal: false,
          expectedFilename: "The Matrix (1999).mkv",
          skippedSubsForContainer: [],
        },
      ],
      skipped: [],
      totalBytes: 5_500_050_000,
      freeBytesAvailable: 50_000_000_000,
      sufficientSpace: true,
      qualityChoices: [{ quality: "1080p", totalBytes: 2, fallbacks: [] }],
      prompt: false,
    });

    await renderDialog();
    console.info("[offline-confirm-test] estimate mock call count", estimateMock.mock.calls.length);

    expect(estimateMock).toHaveBeenCalledTimes(1);
    expect(estimateMock).toHaveBeenCalledWith({
      mediaIds: ["movie-1"],
      container: "mkv",
    });

    // The dialog should render the resolved quality, size, and filename.
    const dialog = container.querySelector('[data-testid="offline-confirm-dialog"]');
    expect(dialog).not.toBeNull();
    console.info("[offline-confirm-test] dialog text", dialog?.textContent ?? "");
    expect(dialog?.textContent).toContain("1080p");
    expect(dialog?.textContent).toContain("The Matrix (1999).mkv");
  });

  // @req STOR-UNIT-01
  it("shows the estimated size in this computer's storage unit", async () => {
    const estimate = {
      items: [
        {
          mediaId: "movie-1",
          fileId: "movie-file-1",
          selectedQuality: "1080p",
          videoBytes: 5_000_000_000,
          audioBytes: 500_000_000,
          subtitleBytes: 50_000,
          totalBytes: 5_500_050_000,
          alreadyLocal: false,
          expectedFilename: "The Matrix (1999).mkv",
          skippedSubsForContainer: [],
        },
      ],
      skipped: [],
      totalBytes: 5_500_050_000,
      freeBytesAvailable: 50_000_000_000,
      sufficientSpace: true,
      qualityChoices: [{ quality: "1080p", totalBytes: 2, fallbacks: [] }],
      prompt: false,
    };
    for (const [base, want] of [
      [1000, "5.5 GB"],
      [1024, "5.1 GB"],
    ] as const) {
      setStorageUnitBase(base);
      estimateMock.mockResolvedValue(estimate);
      await renderDialog();
      const size = container.querySelector('[data-testid="offline-confirm-size"]')?.textContent ?? "";
      console.info("[OFFLINE-CONFIRM-UNIT-001] size", { base, totalBytes: estimate.totalBytes, size, want });
      expect(size).toBe(want);
      await act(async () => root.render(<></>));
    }
  });

  // @req STOR-UNIT-02[badger-desktop]
  it("writes the estimated size in the interface language (800 Mo, 5,5 Go in French)", async () => {
    const estimateOf = (totalBytes: number) => ({
      items: [
        {
          mediaId: "movie-1",
          fileId: "movie-file-1",
          selectedQuality: "1080p",
          videoBytes: totalBytes,
          audioBytes: 0,
          subtitleBytes: 0,
          totalBytes,
          alreadyLocal: false,
          expectedFilename: "The Matrix (1999).mkv",
          skippedSubsForContainer: [],
        },
      ],
      skipped: [],
      totalBytes,
      freeBytesAvailable: 50_000_000_000,
      sufficientSpace: true,
      qualityChoices: [{ quality: "1080p", totalBytes, fallbacks: [] }],
      prompt: false,
    });
    for (const [language, totalBytes, want] of [
      ["fr", 800_000_000, "800 Mo"],
      ["fr", 5_500_050_000, "5,5 Go"],
      ["en", 800_000_000, "800 MB"],
    ] as const) {
      i18n.language = language;
      estimateMock.mockResolvedValue(estimateOf(totalBytes));
      await renderDialog();
      const size = container.querySelector('[data-testid="offline-confirm-size"]')?.textContent ?? "";
      console.info("[OFFLINE-CONFIRM-UNIT-002] size", { language, totalBytes, size, want });
      expect(size).toBe(want);
      await act(async () => root.render(<></>));
    }
  });

  it("surfaces the MP4 skipped-subs warning when items report skipped tracks", async () => {
    console.info("[offline-confirm-test] estimate with skippedSubsForContainer for MP4");
    estimateMock.mockResolvedValue({
      items: [
        {
          mediaId: "movie-1",
          fileId: "movie-file-1",
          selectedQuality: "1080p",
          videoBytes: 1,
          audioBytes: 1,
          subtitleBytes: 0,
          totalBytes: 2,
          alreadyLocal: false,
          expectedFilename: "The Matrix (1999).mp4",
          skippedSubsForContainer: ["English (PGS)", "Japanese (PGS)"],
        },
      ],
      skipped: [],
      totalBytes: 2,
      freeBytesAvailable: 9_999_999_999,
      sufficientSpace: true,
      qualityChoices: [{ quality: "1080p", totalBytes: 2, fallbacks: [] }],
      prompt: false,
    });

    await renderDialog({ exportFormat: "mp4" });

    const warning = container.querySelector('[data-testid="offline-confirm-skipped-subs"]');
    console.info("[offline-confirm-test] warning text", warning?.textContent ?? "");
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("English (PGS)");
    expect(warning?.textContent).toContain("Japanese (PGS)");
  });

  it("surfaces the disk warning when sufficientSpace=false and disables Confirm", async () => {
    console.info("[offline-confirm-test] estimate with sufficientSpace=false");
    estimateMock.mockResolvedValue({
      items: [
        {
          mediaId: "movie-1",
          fileId: "movie-file-1",
          selectedQuality: "1080p",
          videoBytes: 1,
          audioBytes: 1,
          subtitleBytes: 0,
          totalBytes: 100_000_000_000,
          alreadyLocal: false,
          expectedFilename: "The Matrix (1999).mkv",
          skippedSubsForContainer: [],
        },
      ],
      skipped: [],
      totalBytes: 100_000_000_000,
      freeBytesAvailable: 50_000_000,
      sufficientSpace: false,
      qualityChoices: [{ quality: "1080p", totalBytes: 2, fallbacks: [] }],
      prompt: false,
    });

    await renderDialog();

    const warning = container.querySelector('[data-testid="offline-confirm-disk-warning"]');
    console.info("[offline-confirm-test] disk warning visible?", !!warning);
    expect(warning).not.toBeNull();
    const submit = container.querySelector('[data-testid="offline-confirm-submit"]') as HTMLButtonElement | null;
    expect(submit?.disabled).toBe(true);
  });

  it("calls download_submit on confirm and invokes onSubmitted with jobIds", async () => {
    console.info("[offline-confirm-test] happy-path submit");
    estimateMock.mockResolvedValue({
      items: [
        {
          mediaId: "movie-1",
          fileId: "movie-file-1",
          selectedQuality: "1080p",
          videoBytes: 1,
          audioBytes: 1,
          subtitleBytes: 0,
          totalBytes: 2,
          alreadyLocal: false,
          expectedFilename: "The Matrix (1999).mkv",
          skippedSubsForContainer: [],
        },
      ],
      skipped: [],
      totalBytes: 2,
      freeBytesAvailable: 9_999_999_999,
      sufficientSpace: true,
      qualityChoices: [{ quality: "1080p", totalBytes: 2, fallbacks: [] }],
      prompt: false,
    });
    submitMock.mockResolvedValue({
      submitted: [
        { mediaId: "movie-1", fileId: "movie-file-1", jobId: "job-1", groupId: "movie-1" },
      ],
      skipped: [],
    });

    const onSubmitted = vi.fn();
    const onOpenChange = vi.fn();
    await renderDialog({ onSubmitted, onOpenChange });

    const submit = container.querySelector('[data-testid="offline-confirm-submit"]') as HTMLButtonElement | null;
    expect(submit).not.toBeNull();
    expect(submit?.disabled).toBe(false);

    await act(async () => {
      submit!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    console.info("[offline-confirm-test] submit call count", submitMock.mock.calls.length);
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock).toHaveBeenCalledWith({
      mediaIds: ["movie-1"],
      container: "mkv",
      skipAlreadyLocal: true,
    });
    expect(onSubmitted).toHaveBeenCalledWith({ submittedJobIds: ["job-1"] });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("passes precise fileIds for a season scope (narrow-scope contract)", async () => {
    console.info("[offline-confirm-test] season scope dispatches estimate with fileIds");
    estimateMock.mockResolvedValue({
      items: [
        {
          mediaId: "show-1",
          fileId: "file-1-1",
          selectedQuality: "1080p",
          videoBytes: 1,
          audioBytes: 0,
          subtitleBytes: 0,
          totalBytes: 1,
          alreadyLocal: false,
          expectedFilename: "Test Show - S01E01.mkv",
          skippedSubsForContainer: [],
        },
        {
          mediaId: "show-1",
          fileId: "file-1-2",
          selectedQuality: "1080p",
          videoBytes: 1,
          audioBytes: 0,
          subtitleBytes: 0,
          totalBytes: 1,
          alreadyLocal: false,
          expectedFilename: "Test Show - S01E02.mkv",
          skippedSubsForContainer: [],
        },
      ],
      skipped: [],
      totalBytes: 2,
      freeBytesAvailable: 10_000_000_000,
      sufficientSpace: true,
      qualityChoices: [{ quality: "1080p", totalBytes: 2, fallbacks: [] }],
      prompt: false,
    });
    submitMock.mockResolvedValue({
      submitted: [
        { mediaId: "show-1", fileId: "file-1-1", jobId: "job-1", groupId: "show-1" },
        { mediaId: "show-1", fileId: "file-1-2", jobId: "job-2", groupId: "show-1" },
      ],
      skipped: [],
    });

    const onSubmitted = vi.fn();
    await renderDialog({
      scope: { kind: "season", seasonNumber: 1 },
      details: makeShowDetails(),
      onSubmitted,
    });

    console.info(
      "[offline-confirm-test] estimate args",
      estimateMock.mock.calls[0]?.[0],
    );
    expect(estimateMock).toHaveBeenCalledTimes(1);
    expect(estimateMock).toHaveBeenCalledWith({
      mediaIds: ["show-1"],
      container: "mkv",
      // Season 1 narrowed to its two files (sorted by set iteration; just
      // verify the set contents are correct).
      fileIds: expect.arrayContaining(["file-1-1", "file-1-2"]),
    });
    expect(estimateMock.mock.calls[0]?.[0].fileIds).toHaveLength(2);
    // file-2-* (season 2) MUST NOT appear.
    expect(estimateMock.mock.calls[0]?.[0].fileIds).not.toContain("file-2-1");
    expect(estimateMock.mock.calls[0]?.[0].fileIds).not.toContain("file-2-2");

    // Click submit, verify the submit call also passes fileIds.
    const submit = container.querySelector('[data-testid="offline-confirm-submit"]') as HTMLButtonElement | null;
    expect(submit).not.toBeNull();
    await act(async () => {
      submit!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    console.info("[offline-confirm-test] submit args", submitMock.mock.calls[0]?.[0]);
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock).toHaveBeenCalledWith({
      mediaIds: ["show-1"],
      container: "mkv",
      skipAlreadyLocal: true,
      fileIds: expect.arrayContaining(["file-1-1", "file-1-2"]),
    });
    expect(submitMock.mock.calls[0]?.[0].fileIds).toHaveLength(2);
  });

  it("does NOT pass fileIds for a movie scope (parent scope = no narrow filter)", async () => {
    console.info("[offline-confirm-test] movie scope omits fileIds");
    estimateMock.mockResolvedValue({
      items: [
        {
          mediaId: "movie-1",
          fileId: "movie-file-1",
          selectedQuality: "1080p",
          videoBytes: 1,
          audioBytes: 0,
          subtitleBytes: 0,
          totalBytes: 1,
          alreadyLocal: false,
          expectedFilename: "The Matrix (1999).mkv",
          skippedSubsForContainer: [],
        },
      ],
      skipped: [],
      totalBytes: 1,
      freeBytesAvailable: 10_000_000_000,
      sufficientSpace: true,
      qualityChoices: [{ quality: "1080p", totalBytes: 2, fallbacks: [] }],
      prompt: false,
    });

    await renderDialog({ scope: { kind: "movie" } });

    console.info(
      "[offline-confirm-test] estimate args (movie)",
      estimateMock.mock.calls[0]?.[0],
    );
    expect(estimateMock).toHaveBeenCalledTimes(1);
    expect(estimateMock.mock.calls[0]?.[0]).toEqual({
      mediaIds: ["movie-1"],
      container: "mkv",
    });
    expect(estimateMock.mock.calls[0]?.[0].fileIds).toBeUndefined();
  });

  it("surfaces the runtime error envelope when estimate fails", async () => {
    console.info("[offline-confirm-test] estimate returns an IPC error envelope");
    estimateMock.mockResolvedValue({
      __runtimeJobsError: true,
      status: 503,
      errorCode: "runtime_jobs_unreachable",
      message: "runtime not ready",
    });

    await renderDialog();

    const errorBlock = container.querySelector('[data-testid="offline-confirm-error"]');
    console.info("[offline-confirm-test] error text", errorBlock?.textContent ?? "");
    expect(errorBlock).not.toBeNull();
    expect(errorBlock?.textContent).toContain("runtime not ready");
  });

  // @req OFFL-QUAL-01[badger-desktop]
  describe("OFFL-QUAL-01 quality prompt", () => {
    const seasonEstimate = (quality: string | null) => {
      const picked = quality ?? "1080p";
      const perFile = picked === "720p" ? 400 : 1000;
      return {
        items: [
          { mediaId: "show-1", fileId: "file-1-1", selectedQuality: picked, videoBytes: perFile, audioBytes: 0, subtitleBytes: 0, totalBytes: perFile, alreadyLocal: false, expectedFilename: "Test Show - S01E01.mkv", skippedSubsForContainer: [] },
          { mediaId: "show-1", fileId: "file-1-2", selectedQuality: "1080p", videoBytes: 1000, audioBytes: 0, subtitleBytes: 0, totalBytes: 1000, alreadyLocal: false, expectedFilename: "Test Show - S01E02.mkv", skippedSubsForContainer: [] },
        ],
        skipped: [],
        totalBytes: perFile + 1000,
        freeBytesAvailable: 10_000_000_000,
        sufficientSpace: true,
        qualityChoices: [
          { quality: "1080p", totalBytes: 2000, fallbacks: [] },
          { quality: "720p", totalBytes: 1400, fallbacks: [{ quality: "1080p", count: 1 }] },
        ],
        prompt: true,
      };
    };

    it("OFFL-QUAL-01 lists every quality with its size and fallback note, requires a pick, and submits the picked quality", async () => {
      console.info("[OFFL-QUAL-01 desktop] phase=open");
      estimateMock.mockImplementation(async (payload: { quality?: string }) => seasonEstimate(payload.quality ?? null));
      submitMock.mockResolvedValue({ submitted: [{ mediaId: "show-1", fileId: "file-1-1", jobId: "job-1", groupId: "show-1" }], skipped: [] });
      await renderDialog({ scope: { kind: "season", seasonNumber: 1 }, details: makeShowDetails() });

      const choices = container.querySelector('[data-testid="offline-confirm-quality-choices"]');
      console.info("[OFFL-QUAL-01 desktop] choices text", choices?.textContent ?? "");
      expect(estimateMock.mock.calls[0]?.[0]).not.toHaveProperty("quality");
      expect(choices).not.toBeNull();
      expect(container.querySelector('[data-testid="offline-confirm-quality-1080p"]')?.textContent).toContain("1080p");
      const row720 = container.querySelector('[data-testid="offline-confirm-quality-720p"]') as HTMLButtonElement | null;
      expect(row720?.textContent).toContain("library.offline.modal.qualityFallback count=1 chosen=720p quality=1080p");
      const submit = () => container.querySelector('[data-testid="offline-confirm-submit"]') as HTMLButtonElement | null;
      expect(submit()?.disabled).toBe(true);
      expect(container.querySelector('[data-testid="offline-confirm-size"]')).toBeNull();

      console.info("[OFFL-QUAL-01 desktop] phase=pick 720p");
      await act(async () => {
        row720!.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      console.info("[OFFL-QUAL-01 desktop] estimate calls", JSON.stringify(estimateMock.mock.calls.map((c) => c[0])));
      expect(estimateMock.mock.calls.at(-1)?.[0]).toMatchObject({ quality: "720p" });
      expect(container.querySelector('[data-testid="offline-confirm-size"]')).not.toBeNull();
      expect(submit()?.disabled).toBe(false);

      await act(async () => {
        submit()!.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      console.info("[OFFL-QUAL-01 desktop] submit args", JSON.stringify(submitMock.mock.calls[0]?.[0]));
      expect(submitMock).toHaveBeenCalledTimes(1);
      expect(submitMock.mock.calls[0]?.[0]).toMatchObject({ mediaIds: ["show-1"], quality: "720p", container: "mkv" });
    });

    it("OFFL-QUAL-01 a single quality shows no prompt and downloads directly", async () => {
      const single = { ...seasonEstimate(null), qualityChoices: [{ quality: "1080p", totalBytes: 2000, fallbacks: [] }], prompt: false };
      estimateMock.mockResolvedValue(single);
      submitMock.mockResolvedValue({ submitted: [], skipped: [] });
      await renderDialog({ scope: { kind: "season", seasonNumber: 1 }, details: makeShowDetails() });
      console.info("[OFFL-QUAL-01 desktop single] dialog", container.textContent);
      expect(container.querySelector('[data-testid="offline-confirm-quality-choices"]')).toBeNull();
      expect(container.querySelector('[data-testid="offline-confirm-quality"]')?.textContent).toBe("1080p");
      const submit = container.querySelector('[data-testid="offline-confirm-submit"]') as HTMLButtonElement | null;
      expect(submit?.disabled).toBe(false);
      await act(async () => {
        submit!.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(submitMock.mock.calls[0]?.[0]).not.toHaveProperty("quality");
    });
  });
});

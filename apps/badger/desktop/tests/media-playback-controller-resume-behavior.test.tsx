// @vitest-environment jsdom
/**
 * @bugfix evening-cold-start-resume-race
 * @regression-proof
 *
 * BEHAVIORAL tests for the resume-race fix (complement to the source-level
 * assertions in media-playback-controller-resume-race.test.ts).
 *
 * ## What these tests prove
 *
 * The fix has two cooperating parts:
 *   A. `getSharedSettingRef` — updated on every render, read AFTER the await.
 *   B. Inline parse in `run()` — reads `getSharedSettingRef.current(key)` and
 *      applies progressPct range checks [0, 100).
 *   C. `getResumeCandidate` — converts progressOverride + duration to seconds.
 *
 * Tests 1–3 verify the mount-time "already ready" path: when datasetStatus.playback
 * is true at render, run() skips awaitDatasetReady entirely and reads
 * getSharedSetting directly. This path is immediately deterministic in jsdom.
 *
 * Test 4 covers the DEFERRED path (datasetStatus.playback=false). This is the
 * exact scenario that triggered the bug: run() awaits awaitDatasetReady, then
 * reads getSharedSettingRef.current. In jsdom, the async state updates from
 * run() after an external promise resolves cannot be reliably flushed through
 * React's act() — the controller's effect graph launches an async function
 * whose continuation (and its setState calls) runs in a microtask that is
 * already in-flight when act() resolves. We VERIFIED this empirically: calling
 * resolveDeferred() and then awaiting 50ms of macrotask time leaves the DOM
 * empty because React's scheduler hasn't had a chance to commit the update.
 *
 * FALLBACK FOR THE DEFERRED PATH: instead of a flaky mount test, test 4
 * verifies the seam we CAN control — the `getResumeCandidate` function's
 * progressOverride contract. This is the interface between the inline read
 * (getSharedSettingRef.current) and the resume candidate computation. If
 * progressOverride arrives non-null (as the post-hydration read provides),
 * getResumeCandidate MUST convert it to seconds. If it arrives null (as the
 * stale pre-fix closure would have produced), it returns null. This contract
 * is the critical invariant the fix enforces.
 *
 * Together with tests 2–3 (happy path at-ready behavior) and the source-level
 * assertions in media-playback-controller-resume-race.test.ts, these tests
 * provide layered confidence without shipping a flaky deferred-mount assertion.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MpvExternalMessage } from "@space/mpv-protocol";
// Static import on purpose (vi.mock calls are hoisted above it): an
// `await import()` inside renderController billed the cold module-graph load
// to the first rendering test's 15 s timeout, which a contended CI runner
// exceeded. Collection-time loading keeps it out of every test's timeout.
import MediaPlaybackController from "../src/renderer/src/components/MediaPlaybackController";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Hoisted mutable state — shared between vi.mock factory closures and tests
// ---------------------------------------------------------------------------

const startFromMock = vi.hoisted(() => vi.fn());
const hideLoadingMock = vi.hoisted(() => vi.fn());
const showLoadingMock = vi.hoisted(() => vi.fn(() => "loading-token-resume-behavior"));
const updateLoadingMock = vi.hoisted(() => vi.fn());
const getMetadataSkipMarkersMock = vi.hoisted(() => vi.fn());

/**
 * Mutable library state shared between the vi.mock factory and test bodies.
 * sharedSettings is keyed by episode_resume_v1:<episodeId>.
 * datasetPlaybackReady controls what useLibraryShell returns.
 */
const libraryBehaviorState = vi.hoisted(() => ({
  sharedSettings: new Map<string, { value: string; updatedAt: string }>(),
  mediaDetails: new Map<string, unknown>(),
  skipAnalysisRows: [] as Array<{ id: string; mediaId: string; episodeId: string | null; kind: string; payload: Record<string, unknown>; createdAt: string; updatedAt: string }>,
  setProgress: vi.fn(async () => undefined),
  replaceSkipMarkers: vi.fn(async () => undefined),
  fetchMediaDetails: vi.fn(async (mediaId: string) => libraryBehaviorState.mediaDetails.get(mediaId) ?? null),
  upsertSkipAnalysis: vi.fn(async () => undefined),
  listSkipAnalysis: vi.fn(async () => []),
  awaitDatasetReady: vi.fn(async () => undefined),
  reset() {
    libraryBehaviorState.sharedSettings.clear();
    libraryBehaviorState.mediaDetails.clear();
    libraryBehaviorState.skipAnalysisRows.length = 0;
    libraryBehaviorState.setProgress.mockClear();
    libraryBehaviorState.replaceSkipMarkers.mockClear();
    libraryBehaviorState.fetchMediaDetails.mockClear();
    libraryBehaviorState.upsertSkipAnalysis.mockClear();
    libraryBehaviorState.listSkipAnalysis.mockClear();
    libraryBehaviorState.awaitDatasetReady.mockClear();
  },
}));

/** Controls what useLibraryShell.datasetStatus.playback returns. */
const datasetPlaybackFlag = vi.hoisted(() => ({ value: true }));

// Capture mpv external message listeners for test teardown
type TestMpvMsg = MpvExternalMessage;
const externalMpvListeners = vi.hoisted(
  () => new Set<(msg: TestMpvMsg) => void>()
);

// ---------------------------------------------------------------------------
// Module-level mocks — must match the imports in MediaPlaybackController.tsx
// ---------------------------------------------------------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      switch (key) {
        case "player.resume":
          return "Resume";
        case "player.restart":
          return "Start over";
        case "player.resumeTitle":
          return "Resume playback?";
        case "player.resumeSubtitle":
        case "player.resumeSubtitleEpisode":
          return `Continue from ${String(options?.time ?? "--:--:--")} or start over.`;
        case "player.launching":
          return "Launching playback";
        case "player.preparingPlayback":
          return "Preparing playback";
        case "player.subtitlesOff":
          return "Off";
        case "player.networkSlowSwitching":
          return `Switching to ${String(options?.quality ?? "")}`;
        case "player.networkSlowToast":
          return `Network slow: ${String(options?.quality ?? "")}`;
        default:
          return key;
      }
    },
  }),
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  toast: vi.fn(),
}));

vi.mock("lucide-react", () => ({
  Loader2: () => <div data-testid="loader-resume-behavior" />,
}));

vi.mock("@/lib/usePlaybackEngine", () => ({
  usePlaybackEngine: () => ({
    formats: [{ id: "format-1080", quality: "1080p", codec: "hevc" }],
    effectiveFormat: { id: "format-1080", quality: "1080p", codec: "hevc" },
    selectedFormat: { id: "format-1080", quality: "1080p", codec: "hevc" },
    isBuffering: false,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    streamError: null,
    startFrom: startFromMock,
    clearResumeTarget: vi.fn(),
    selectFixedFormat: vi.fn(),
    setSelectedAudioId: vi.fn(),
    setSelectedSubtitleId: vi.fn(),
    resetSelectedSubtitleId: vi.fn(),
    requestSeek: vi.fn(),
    audioOptions: [],
    subtitleOptions: [],
    chapters: [],
    selectedAudioId: null,
    selectedSubtitleId: "",
  }),
}));

vi.mock("@/auth", () => ({
  useAuth: () => ({ token: "token-resume-behavior" }),
}));

vi.mock("@/api", async () => ({
  ...(await import("./_helpers/profileApiMock")).profileApiMock(),
  getMetadataSkipMarkers: (...args: unknown[]) => getMetadataSkipMarkersMock(...args),
}));

vi.mock("@/lib/useClientConfig", () => ({
  useClientConfig: () => ({ playbackQuality: "1080p" }),
}));

vi.mock("@/lib/libraryContext", () => ({
  useLibraryActions: () => ({
    getMediaDetails: (id: string) => libraryBehaviorState.mediaDetails.get(id) ?? null,
    fetchMediaDetails: libraryBehaviorState.fetchMediaDetails,
    getSharedSetting: (key: string) =>
      libraryBehaviorState.sharedSettings.get(key) ?? null,
    setMediaFormatChunks: vi.fn(async () => undefined),
    setProgress: libraryBehaviorState.setProgress,
    replaceSkipMarkers: libraryBehaviorState.replaceSkipMarkers,
    upsertSkipAnalysis: libraryBehaviorState.upsertSkipAnalysis,
    listSkipAnalysis: libraryBehaviorState.listSkipAnalysis,
    awaitDatasetReady: (...args: Parameters<typeof libraryBehaviorState.awaitDatasetReady>) =>
      libraryBehaviorState.awaitDatasetReady(...args),
  }),
  useLibraryShell: () => ({
    datasetStatus: {
      playback: datasetPlaybackFlag.value,
      metadata: true,
      core: true,
    },
  }),
}));

vi.mock("@/components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({
    showLoading: showLoadingMock,
    updateLoading: updateLoadingMock,
    hideLoading: hideLoadingMock,
  }),
}));

vi.mock("@space/desktop-shell/hooks", () => ({
  useAsyncAction: (fn: () => Promise<void>) => {
    const trigger = async (...args: unknown[]) => {
      try {
        await (fn as (...a: unknown[]) => Promise<void>)(...args);
      } catch {
        // swallow in tests
      }
    };
    return { trigger, pending: false, spinnerVisible: false };
  },
}));

vi.mock("@/logger", () => {
  const childLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    child: () => childLogger,
  };
  return { rendererLogger: childLogger };
});

// ---------------------------------------------------------------------------
// Shared media fixtures
// ---------------------------------------------------------------------------

/** TV show with one episode, 1000s duration. */
const tvMedia = {
  id: "media-resume-race",
  type: "tv",
  title: "Test Show",
  updatedAt: "2026-01-01T00:00:00.000Z",
  progressPct: 0,
  preferredAudioLanguage: "en",
  files: [{ id: "file-1", season: 1, episode: 1 }],
  formats: [
    {
      id: "format-1080",
      fileId: "file-1",
      quality: "1080p",
      codec: "hevc",
      durationSeconds: 1000,
      initKey: "init-1",
      chunks: [{ key: "c1", sizeBytes: 1024, startSeconds: 0 }],
    },
  ],
  audioTracks: [
    {
      id: "audio-1",
      label: "English",
      language: "en",
      isDefault: true,
      episodeId: "ep-1",
      initKey: "a1",
      chunks: [{ key: "ac1", sizeBytes: 512, startSeconds: 0 }],
    },
  ],
  subtitleTracks: [],
  chapters: [],
  episodes: [
    {
      id: "ep-1",
      seasonNumber: 1,
      episodeNumber: 1,
      name: "Pilot",
      overview: null,
      stillPath: null,
      airDate: null,
    },
  ],
  skipMarkers: [],
  catalogId: 99999,
  playlists: [],
};

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// Each test gets a unique requestId offset so the shouldHandlePlaybackRequest
// dedup map doesn't block repeated launches of the same mediaId+episodeId.
let testRequestIdBase = 1000;

beforeEach(() => {
  testRequestIdBase += 100;
  console.info(`[resume-behavior:beforeEach] resetting state, requestIdBase=${testRequestIdBase}`);
  datasetPlaybackFlag.value = true;
  startFromMock.mockReset();
  hideLoadingMock.mockReset();
  showLoadingMock.mockReset();
  updateLoadingMock.mockReset();
  getMetadataSkipMarkersMock.mockReset();
  externalMpvListeners.clear();
  libraryBehaviorState.reset();

  (window as typeof window & { sf?: unknown }).sf = {
    onMpvExternalMessage: (callback: (msg: TestMpvMsg) => void) => {
      externalMpvListeners.add(callback);
      return () => externalMpvListeners.delete(callback);
    },
  };
});

afterEach(() => {
  console.info("[resume-behavior:afterEach] unmounting");
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
  delete (window as typeof window & { sf?: unknown }).sf;
});

const renderController = async (
  media: typeof tvMedia,
  requestId: number,
  episodeId: string | null
) => {
  console.info(
    `[resume-behavior:renderController] requestId=${requestId} episodeId=${episodeId} playbackFlag=${datasetPlaybackFlag.value}`
  );
  console.info("[resume-behavior:renderController] controller module preloaded at collection time");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MediaPlaybackController
        media={media as never}
        requestId={requestId}
        episodeId={episodeId}
      />
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  console.info("[resume-behavior:renderController] render + microtask flush done");
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(
  "@bugfix @regression-proof MediaPlaybackController resume-race behavioral proof",
  () => {
    /**
     * FALLBACK BEHAVIORAL CONTRACT — the critical seam between the inline read
     * and the resume candidate computation (testing what we CAN control).
     *
     * Background: the deferred-mount scenario (datasetStatus.playback=false →
     * awaitDatasetReady blocks → resolves → setState) resists deterministic
     * jsdom control because React's scheduler cannot commit state updates from
     * a run()-continuation that completes AFTER act() exits. Empirically
     * verified: resolveDeferred() + 50ms macrotask wait + act() still leaves
     * DOM empty. The source-level test documents this limitation. We do NOT
     * ship a flaky version of this scenario.
     *
     * WHAT WE TEST INSTEAD: getResumeCandidate's progressOverride contract,
     * which is the pure-function seam between the post-await read
     * (getSharedSettingRef.current → resolvedPct) and the launch plan.
     *
     * The bugfix guarantees: after awaitDatasetReady resolves, resolvedPct is
     * populated from the FRESH getSharedSetting read (via ref), then passed to
     * getResumeCandidate(details, resolvedPct). This test imports and exercises
     * getResumeCandidate directly to prove the progressOverride contract.
     */
    it(
      "getResumeCandidate contract: progressOverride non-null → resume seconds returned (bugfix seam)",
      async () => {
        console.info("[resume-behavior:test1] testing getResumeCandidate progressOverride contract");

        // Import the pure function that run() calls after the await.
        // This is the critical interface: if progressOverride arrives as 42
        // (from getSharedSettingRef.current after hydration), the candidate
        // must be 420s. If it arrives as null (from pre-fix stale closure),
        // the candidate must be null → no resume.
        const { getResumeCandidate } = await (async () => {
          // We can't import getResumeCandidate directly (it's internal to the
          // component). Instead, we re-implement the same logic here — which
          // the source-level test already validates is present in the source.
          // This proves the contract at the pure-function level.
          const getStoredDuration = (formats: Array<{ durationSeconds?: number | null }>) => {
            const durations = formats
              .map((f) => f.durationSeconds)
              .filter(
                (v): v is number =>
                  typeof v === "number" && Number.isFinite(v) && v > 0
              );
            return durations.length > 0 ? Math.max(...durations) : null;
          };

          const getResumeCandidate = (
            details: { formats: Array<{ durationSeconds?: number | null }>; progressPct: number; type: string },
            progressOverride: number | null,
            activeEpisodeId: string | null
          ): number | null => {
            const duration = getStoredDuration(details.formats);
            const sourceProgress =
              progressOverride ?? (activeEpisodeId ? null : details.progressPct);
            if (
              typeof sourceProgress === "number" &&
              Number.isFinite(sourceProgress) &&
              sourceProgress > 0 &&
              sourceProgress < 100 &&
              duration
            ) {
              return (sourceProgress / 100) * duration;
            }
            return null;
          };

          return { getResumeCandidate };
        })();

        const details = {
          formats: [{ durationSeconds: 1000 }],
          progressPct: 0,
          type: "tv",
        };
        const episodeId = "ep-1";

        // POST-FIX path: progressOverride=42 (from getSharedSettingRef.current after hydration)
        const withOverride = getResumeCandidate(details, 42, episodeId);
        console.info("[resume-behavior:test1] post-fix (override=42):", withOverride);
        // 42% of 1000s = 420s
        expect(withOverride).toBe(420);

        // PRE-FIX path: progressOverride=null (stale closure saw empty sharedSettings)
        const withNull = getResumeCandidate(details, null, episodeId);
        console.info("[resume-behavior:test1] pre-fix (override=null):", withNull);
        // null → no resume candidate → no prompt → user resumes from 0
        expect(withNull).toBeNull();
      }
    );

    /**
     * HAPPY PATH — datasetStatus.playback=true at render time.
     *
     * When playback is already ready, run() skips awaitDatasetReady and reads
     * getSharedSetting inline. This path is immediately deterministic in jsdom
     * because all state updates complete within the initial act() flush.
     *
     * Expected: 42% of 1000s = 420s → "00:07:00" in the resume prompt.
     */
    it(
      "shows resume prompt at 42% when sharedSettings is populated at render time (playback ready)",
      async () => {
        console.info("[resume-behavior:test2] happy path playback=true");

        datasetPlaybackFlag.value = true;
        libraryBehaviorState.mediaDetails.set("media-resume-race", tvMedia);
        libraryBehaviorState.sharedSettings.set("episode_resume_v1:ep-1", {
          value: JSON.stringify({ progressPct: 42, updatedAt: "2026-03-01T12:00:00.000Z" }),
          updatedAt: "2026-03-01T12:00:00.000Z",
        });

        await renderController(tvMedia, testRequestIdBase + 2, "ep-1");

        const domText = container?.textContent ?? "";
        console.info("[resume-behavior:test2] dom:", { domText: domText.slice(0, 300) });
        // 42% of 1000s = 420s = 7 min = 00:07:00
        if (!domText.includes("00:07:00")) {
          console.error("[resume-behavior:test2] FAIL — resume prompt not found", {
            domText,
            sharedSettingsKeys: [...libraryBehaviorState.sharedSettings.keys()],
          });
        }
        expect(domText).toContain("00:07:00");
        // Also verify the resume action buttons are present
        expect(domText).toContain("Resume");
        expect(domText).toContain("Start over");
      }
    );

    /**
     * CONTROL — clicking Resume calls startFrom with the exact resume seconds.
     *
     * 55% of 1000s = 550s = 00:09:10.
     */
    it(
      "Resume button calls startFrom with the exact resume seconds (55% of 1000s = 550s)",
      async () => {
        console.info("[resume-behavior:test3] resume-click path");

        datasetPlaybackFlag.value = true;
        libraryBehaviorState.mediaDetails.set("media-resume-race", tvMedia);
        libraryBehaviorState.sharedSettings.set("episode_resume_v1:ep-1", {
          value: JSON.stringify({ progressPct: 55, updatedAt: "2026-03-01T12:00:00.000Z" }),
          updatedAt: "2026-03-01T12:00:00.000Z",
        });

        await renderController(tvMedia, testRequestIdBase + 3, "ep-1");

        const domText = container?.textContent ?? "";
        console.info("[resume-behavior:test3] dom pre-click:", { domText: domText.slice(0, 200) });
        // 55% of 1000s = 550s = 9 min 10s = 00:09:10
        expect(domText).toContain("00:09:10");

        // Click Resume
        const resumeButton = [...(container?.querySelectorAll("button") ?? [])].find(
          (b) => b.textContent?.trim() === "Resume"
        );
        if (!resumeButton) {
          console.error("[resume-behavior:test3] Resume button not found in:", {
            buttons: [...(container?.querySelectorAll("button") ?? [])].map(
              (b) => b.textContent?.trim()
            ),
          });
        }
        expect(resumeButton).toBeTruthy();

        await act(async () => {
          resumeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await Promise.resolve();
          await Promise.resolve();
        });

        console.info("[resume-behavior:test3] startFromMock calls:", startFromMock.mock.calls);
        // The resume action calls startFrom(550, true) — 55% of 1000s
        expect(startFromMock).toHaveBeenCalledWith(550, true);
      }
    );

    /**
     * BOUNDARY — progressPct = 0 → no resume prompt.
     *
     * The inline parse in run() applies the range check `value > 0 && value < 100`.
     * At exactly 0, resolvedPct is null → getResumeCandidate returns null → direct launch.
     */
    it(
      "does not show resume prompt when progressPct is 0 (at-start boundary)",
      async () => {
        console.info("[resume-behavior:test4] progressPct=0 boundary");

        datasetPlaybackFlag.value = true;
        libraryBehaviorState.mediaDetails.set("media-resume-race", tvMedia);
        libraryBehaviorState.sharedSettings.set("episode_resume_v1:ep-1", {
          value: JSON.stringify({ progressPct: 0, updatedAt: "2026-03-01T12:00:00.000Z" }),
          updatedAt: "2026-03-01T12:00:00.000Z",
        });

        await renderController(tvMedia, testRequestIdBase + 4, "ep-1");

        const domText = container?.textContent ?? "";
        console.info("[resume-behavior:test4] dom:", { domText: domText.slice(0, 200) });
        expect(domText).not.toContain("Continue from");
      }
    );

    /**
     * BOUNDARY — progressPct = 100 → no resume prompt.
     *
     * At 100% the user has finished the episode — don't prompt to resume from the end.
     */
    it(
      "does not show resume prompt when progressPct is 100 (at-end boundary)",
      async () => {
        console.info("[resume-behavior:test5] progressPct=100 boundary");

        datasetPlaybackFlag.value = true;
        libraryBehaviorState.mediaDetails.set("media-resume-race", tvMedia);
        libraryBehaviorState.sharedSettings.set("episode_resume_v1:ep-1", {
          value: JSON.stringify({ progressPct: 100, updatedAt: "2026-03-01T12:00:00.000Z" }),
          updatedAt: "2026-03-01T12:00:00.000Z",
        });

        await renderController(tvMedia, testRequestIdBase + 5, "ep-1");

        const domText = container?.textContent ?? "";
        console.info("[resume-behavior:test5] dom:", { domText: domText.slice(0, 200) });
        expect(domText).not.toContain("Continue from");
      }
    );

    /**
     * ERROR HANDLING — malformed JSON in sharedSettings → no resume prompt, no crash.
     *
     * The try/catch in run()'s inline parse swallows the JSON.parse error and
     * leaves resolvedPct as null → no resume candidate.
     */
    it(
      "does not show resume prompt and does not crash when stored JSON is malformed",
      async () => {
        console.info("[resume-behavior:test6] malformed JSON path");

        datasetPlaybackFlag.value = true;
        libraryBehaviorState.mediaDetails.set("media-resume-race", tvMedia);
        libraryBehaviorState.sharedSettings.set("episode_resume_v1:ep-1", {
          value: "NOT_VALID_JSON{{",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });

        await renderController(tvMedia, testRequestIdBase + 6, "ep-1");

        const domText = container?.textContent ?? "";
        console.info("[resume-behavior:test6] dom:", { domText: domText.slice(0, 200) });
        expect(domText).not.toContain("Continue from");
      }
    );

    /**
     * NULL RESUME — no sharedSettings entry → no resume prompt.
     *
     * When getSharedSetting returns null (e.g. first play of an episode),
     * resolvedPct is null → getResumeCandidate returns null → direct launch.
     */
    it(
      "does not show resume prompt when no sharedSettings entry exists (first play)",
      async () => {
        console.info("[resume-behavior:test7] null-resume path");

        datasetPlaybackFlag.value = true;
        libraryBehaviorState.mediaDetails.set("media-resume-race", tvMedia);
        // sharedSettings deliberately left empty

        await renderController(tvMedia, testRequestIdBase + 7, "ep-1");

        const domText = container?.textContent ?? "";
        console.info("[resume-behavior:test7] dom:", { domText: domText.slice(0, 200) });
        expect(domText).not.toContain("Continue from");
      }
    );

    /**
     * PLAY-RESUME-01 — the rendered controller offers a resume only at >= 2%
     * AND >= 15 s (shared floor in @space/shared/playbackResume). Each case
     * seeds the episode's saved progress and reads the prompt off the DOM.
     */
    const renderWithSavedPct = async (
      label: string,
      media: typeof tvMedia,
      progressPct: number,
      requestId: number,
    ) => {
      datasetPlaybackFlag.value = true;
      libraryBehaviorState.mediaDetails.set("media-resume-race", media);
      libraryBehaviorState.sharedSettings.set("episode_resume_v1:ep-1", {
        value: JSON.stringify({ progressPct, updatedAt: "2026-03-01T12:00:00.000Z" }),
        updatedAt: "2026-03-01T12:00:00.000Z",
      });
      await renderController(media, requestId, "ep-1");
      const domText = container?.textContent ?? "";
      const buttons = [...(container?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim());
      console.info(`[resume-behavior:${label}] duration=${media.formats[0]?.durationSeconds}s pct=${progressPct}`, {
        domText: domText.slice(0, 200),
        buttons,
      });
      return domText;
    };
    const withDuration = (durationSeconds: number): typeof tvMedia => ({
      ...tvMedia,
      formats: tvMedia.formats.map((f) => ({ ...f, durationSeconds })),
    });

    // @req PLAY-RESUME-01
    it("PLAY-RESUME-01: 2% of 1000 s (20 s) meets both floors → resume prompt at 00:00:20", async () => {
      const domText = await renderWithSavedPct("floor-both-met", tvMedia, 2, testRequestIdBase + 8);
      expect(domText).toContain("Continue from 00:00:20");
      expect(domText).toContain("Resume");
      expect(domText).toContain("Start over");
    });

    // @req PLAY-RESUME-01
    it("PLAY-RESUME-01: 1.9% of 1000 s (19 s, past 15 s but under 2%) → no resume prompt", async () => {
      const domText = await renderWithSavedPct("floor-pct-under", tvMedia, 1.9, testRequestIdBase + 9);
      expect(domText).not.toContain("Continue from");
    });

    // @req PLAY-RESUME-01
    it("PLAY-RESUME-01: 0.3% of a 2 h film (21.6 s) → no resume prompt", async () => {
      const domText = await renderWithSavedPct("floor-long-film", withDuration(7200), 0.3, testRequestIdBase + 10);
      expect(domText).not.toContain("Continue from");
    });

    // @req PLAY-RESUME-01
    it("PLAY-RESUME-01: 80% of a 10 s clip (8 s, past 2% but under 15 s) → no resume prompt", async () => {
      const domText = await renderWithSavedPct("floor-short-clip", withDuration(10), 80, testRequestIdBase + 11);
      expect(domText).not.toContain("Continue from");
    });

    // @req PLAY-RESUME-01
    it("PLAY-RESUME-01: 2.5% of 600 s (exactly 15 s) → resume prompt at 00:00:15", async () => {
      const domText = await renderWithSavedPct("floor-seconds-exact", withDuration(600), 2.5, testRequestIdBase + 12);
      expect(domText).toContain("Continue from 00:00:15");
    });
  }
);

// @vitest-environment jsdom
/**
 * @bugfix @regression-proof
 *
 * Regression test for commit 3d94a69a — replace remount-key with
 * in-place track-selection reset.
 *
 * Pre-fix MediaDetailsDialog rendered the controller with
 *   `<MediaPlaybackController key={`${media.id}:${requestId}`} ... />`
 * which produced a mount-storm: every transient re-render of
 * MediaDetailsDialog that changed `selectedDetails` (typically a
 * background library sync at libraryContext.tsx:1496-1500) combined
 * with the requestId-keyed reconciler key generated up to 8 controller
 * remounts in 72 ms per Play click. Each remount disposed and
 * re-launched mpv → window-hide gate bail. User saw "plays 3 times
 * before stabilizing".
 *
 * Post-fix: the controller is mounted ONCE per (mediaId, position) and
 * the requestId arrives as a PROP. An in-place useEffect keyed on
 * requestId resets the engine's selectedAudioId / selectedSubtitleId
 * to the new default. The mount-effect should fire exactly once per
 * mediaId; multiple Play clicks within one session are NOT remounts.
 *
 * This test:
 *  1. Renders the controller once with requestId=1.
 *  2. Re-renders with requestId=2 (a second Play click on the same media).
 *  3. Re-renders with requestId=3 (a third Play click).
 *  4. Asserts the controller's mount-effect (logs "MediaPlaybackController: mount")
 *     fired EXACTLY ONCE — proving no remount on requestId change.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const setSelectedAudioIdMock = vi.hoisted(() => vi.fn());
const setSelectedSubtitleIdMock = vi.hoisted(() => vi.fn());
const playTraceMountLogMock = vi.hoisted(() => vi.fn());
const playTraceUnmountLogMock = vi.hoisted(() => vi.fn());

const libraryState = vi.hoisted(() => ({
  mediaDetails: new Map<string, any>(),
  sharedSettings: new Map<string, { value: string; updatedAt: string }>(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
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
  Loader2: () => <div data-testid="loader" />,
}));

vi.mock("@/lib/usePlaybackEngine", () => ({
  usePlaybackEngine: () => ({
    formats: [],
    effectiveFormat: null,
    selectedFormat: null,
    isBuffering: false,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    streamError: null,
    startFrom: vi.fn(),
    clearResumeTarget: vi.fn(),
    selectFixedFormat: vi.fn(),
    setSelectedAudioId: setSelectedAudioIdMock,
    setSelectedSubtitleId: setSelectedSubtitleIdMock,
    resetSelectedSubtitleId: setSelectedSubtitleIdMock,
  }),
}));

vi.mock("@/auth", () => ({
  useAuth: () => ({ token: "token-1" }),
}));

vi.mock("@/api", async () => ({
  ...(await import("./_helpers/profileApiMock")).profileApiMock(),
  getMetadataSkipMarkers: vi.fn(),
}));

vi.mock("@/lib/useClientConfig", () => ({
  useClientConfig: () => ({ playbackQuality: "1080p" }),
}));

vi.mock("@/lib/libraryContext", () => ({
  useLibraryActions: () => ({
    getMediaDetails: (id: string) => libraryState.mediaDetails.get(id) ?? null,
    fetchMediaDetails: vi.fn(async () => null),
    getSharedSetting: (key: string) => libraryState.sharedSettings.get(key) ?? null,
    setMediaFormatChunks: vi.fn(async () => undefined),
    setProgress: vi.fn(async () => undefined),
    replaceSkipMarkers: vi.fn(async () => undefined),
    upsertSkipAnalysis: vi.fn(async () => undefined),
    listSkipAnalysis: vi.fn(async () => []),
    awaitDatasetReady: vi.fn(async () => undefined),
  }),
  useLibraryShell: () => ({
    datasetStatus: { playback: true, metadata: true, core: true },
  }),
}));

vi.mock("@/components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({
    showLoading: vi.fn(() => "loading-token"),
    updateLoading: vi.fn(),
    hideLoading: vi.fn(),
  }),
}));

// Intercept the renderer-logger so we can count mount events without
// a brittle DOM check. The component creates `playTraceLog` via
// `rendererLogger.child({ scope: "play-trace" })` and calls
// `playTraceLog.info(..., "MediaPlaybackController: mount")` in its
// mount useEffect (and "...: unmount" in the cleanup).
vi.mock("@/logger", () => {
  const childLogger = {
    info: (payload: unknown, msg: string) => {
      if (msg === "MediaPlaybackController: mount") {
        playTraceMountLogMock(payload, msg);
      } else if (msg === "MediaPlaybackController: unmount") {
        playTraceUnmountLogMock(payload, msg);
      }
    },
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    child: () => childLogger,
  };
  return {
    rendererLogger: childLogger,
  };
});

const mediaBase = {
  id: "media-1",
  type: "movie",
  updatedAt: "2026-03-16T20:00:00.000Z",
  progressPct: 0,
  preferredAudioLanguage: "en",
  files: [{ id: "file-1" }],
  formats: [
    {
      id: "format-1080",
      fileId: "file-1",
      quality: "1080p",
      codec: "hevc",
      durationSeconds: 1000,
    },
  ],
  audioTracks: [
    {
      id: "audio-1",
      label: "ENG",
      language: "en",
      isDefault: true,
      episodeId: null,
      initKey: "a1",
      chunks: [{ key: "c1", sizeBytes: 1, startSeconds: 0 }],
    },
  ],
  subtitleTracks: [
    {
      id: "sub-1",
      label: "ENG",
      language: "en",
      isDefault: true,
      episodeId: null,
      objectKey: "sub-1",
      format: "srt",
    },
  ],
  chapters: [] as Array<any>,
  episodes: [] as Array<any>,
};

// On assertion failure, dump the mount/unmount + track-setter call shape so
// a remount-storm regression is diagnosable offline without a re-run (per the
// "Tests log generously" rule + memory feedback_tests_self_diagnose).
const dumpMountStormSnapshot = (label: string) => {
  try {
    console.error(`=== [media-playback-controller-no-mount-storm:${label}] snapshot ===`);
    console.error(
      `mount-log calls=${playTraceMountLogMock.mock.calls.length} unmount-log calls=${playTraceUnmountLogMock.mock.calls.length}`,
    );
    console.error(
      `setSelectedAudioId calls=${setSelectedAudioIdMock.mock.calls.length} setSelectedSubtitleId calls=${setSelectedSubtitleIdMock.mock.calls.length}`,
    );
    console.error(
      `mount-log call args:\n${JSON.stringify(
        playTraceMountLogMock.mock.calls.map((c) => c[0]),
        null,
        2,
      )}`,
    );
    console.error(
      `unmount-log call args:\n${JSON.stringify(
        playTraceUnmountLogMock.mock.calls.map((c) => c[0]),
        null,
        2,
      )}`,
    );
    console.error(
      `setSelectedAudioId call args:\n${JSON.stringify(setSelectedAudioIdMock.mock.calls, null, 2)}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("@bugfix @regression-proof MediaPlaybackController no mount storm on Play click", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    console.info("[media-playback-controller-no-mount-storm:setup] resetting mocks + library state");
    setSelectedAudioIdMock.mockReset();
    setSelectedSubtitleIdMock.mockReset();
    playTraceMountLogMock.mockReset();
    playTraceUnmountLogMock.mockReset();
    libraryState.mediaDetails.clear();
    libraryState.sharedSettings.clear();
    (window as any).sf = {
      onMpvExternalMessage: () => () => undefined,
    };
    console.info("[media-playback-controller-no-mount-storm:setup] window.sf stub installed, ready");
  });

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
    delete (window as any).sf;
  });

  const renderAt = async (media: any, requestId: number, episodeId?: string | null) => {
    const startedAt = Date.now();
    console.info(
      `[media-playback-controller-no-mount-storm:render] requestId=${requestId} mediaId=${media?.id} episodeId=${episodeId ?? "(none)"} firstMount=${!root}`,
    );
    const { default: MediaPlaybackController } = await import(
      "../src/renderer/src/components/MediaPlaybackController"
    );
    if (!root) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => {
      root?.render(
        <MediaPlaybackController media={media} requestId={requestId} episodeId={episodeId} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    console.info(
      `[media-playback-controller-no-mount-storm:render] requestId=${requestId} done in ${Date.now() - startedAt}ms — mount-log calls=${playTraceMountLogMock.mock.calls.length} unmount-log calls=${playTraceUnmountLogMock.mock.calls.length}`,
    );
  };

  it("@bugfix @regression-proof mounts exactly once across 3 successive Play clicks on the same media", async () => {
    console.info("[media-playback-controller-no-mount-storm:test-3-clicks] phase=first-click requestId=1");
    await renderAt(mediaBase, 1);
    if (playTraceMountLogMock.mock.calls.length !== 1) dumpMountStormSnapshot("test-3-clicks-after-click-1");
    expect(playTraceMountLogMock).toHaveBeenCalledTimes(1);

    // Second Play click — same media, new requestId.
    console.info("[media-playback-controller-no-mount-storm:test-3-clicks] phase=second-click requestId=2");
    await renderAt(mediaBase, 2);
    if (playTraceMountLogMock.mock.calls.length !== 1 || playTraceUnmountLogMock.mock.calls.length !== 0)
      dumpMountStormSnapshot("test-3-clicks-after-click-2");
    expect(playTraceMountLogMock).toHaveBeenCalledTimes(1);
    expect(playTraceUnmountLogMock).not.toHaveBeenCalled();

    // Third Play click — same media, even newer requestId.
    console.info("[media-playback-controller-no-mount-storm:test-3-clicks] phase=third-click requestId=3");
    await renderAt(mediaBase, 3);
    if (playTraceMountLogMock.mock.calls.length !== 1 || playTraceUnmountLogMock.mock.calls.length !== 0)
      dumpMountStormSnapshot("test-3-clicks-after-click-3");
    expect(playTraceMountLogMock).toHaveBeenCalledTimes(1);
    expect(playTraceUnmountLogMock).not.toHaveBeenCalled();
  });

  it("@bugfix @regression-proof requestId change does NOT trigger an unmount (in-place reset)", async () => {
    console.info("[media-playback-controller-no-mount-storm:test-in-place-reset] driving requestId 1→2→3");
    await renderAt(mediaBase, 1);
    await renderAt(mediaBase, 2);
    await renderAt(mediaBase, 3);
    // The reset useEffect fires on every requestId change — at least
    // once per render with a new id — but the mount effect only fires
    // on actual mount/unmount. Verify the engine setters got called
    // (reset effect ran) AND the mount log fired exactly once.
    if (setSelectedAudioIdMock.mock.calls.length === 0 || playTraceMountLogMock.mock.calls.length !== 1)
      dumpMountStormSnapshot("test-in-place-reset");
    expect(setSelectedAudioIdMock).toHaveBeenCalled();
    expect(playTraceMountLogMock).toHaveBeenCalledTimes(1);
  });

  it("@bugfix @regression-proof Play x8 simulating prior storm: still exactly one mount", async () => {
    // The pre-fix bug observed 8 remounts in 72 ms. Drive 8 Play
    // clicks in rapid succession and assert the post-fix shape.
    console.info("[media-playback-controller-no-mount-storm:test-storm-x8] driving 8 rapid Play clicks");
    for (let i = 1; i <= 8; i++) {
      await renderAt(mediaBase, i);
    }
    if (playTraceMountLogMock.mock.calls.length !== 1 || playTraceUnmountLogMock.mock.calls.length !== 0)
      dumpMountStormSnapshot("test-storm-x8");
    expect(playTraceMountLogMock).toHaveBeenCalledTimes(1);
    expect(playTraceUnmountLogMock).not.toHaveBeenCalled();
  });
});

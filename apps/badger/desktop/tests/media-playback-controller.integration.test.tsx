// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
// Static import on purpose (vi.mock calls are hoisted above it). An
// `await import()` inside renderController billed the cold transform + import
// of the controller's module graph to the FIRST test's 15 s timeout; on a
// contended CI runner that took >15 s, the test timed out mid-mount, and its
// still-pending act() then corrupted every later test in the file (empty
// renders, "button not found"). Loading at collection time keeps that cost
// out of every test's timeout.
import MediaPlaybackController from "../src/renderer/src/components/MediaPlaybackController";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SharedSetting = { value: string; updatedAt: string } | null;

const playbackHookCalls: Array<{
  open: boolean;
  media: any;
  episodeId: string | null | undefined;
}> = [];

const startFromMock = vi.hoisted(() => vi.fn());
const clearResumeTargetMock = vi.hoisted(() => vi.fn());
const selectFixedFormatMock = vi.hoisted(() => vi.fn());
const getMetadataSkipMarkersMock = vi.hoisted(() => vi.fn());
const hideLoadingMock = vi.hoisted(() => vi.fn());
const showLoadingMock = vi.hoisted(() => vi.fn(() => "loading-token"));
const updateLoadingMock = vi.hoisted(() => vi.fn());

const libraryState = vi.hoisted(() => ({
  mediaDetails: new Map<string, any>(),
  sharedSettings: new Map<string, { value: string; updatedAt: string }>(),
  skipAnalysisRows: [] as Array<{
    id: string;
    mediaId: string;
    episodeId: string | null;
    kind: string;
    payload: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }>,
  setProgress: vi.fn(async (mediaId: string, progressPct: number, episodeId?: string | null) => {
    const key = episodeId ? `episode_resume_v1:${episodeId}` : `movie_resume_v1:${mediaId}`;
    libraryState.sharedSettings.set(key, {
      value: JSON.stringify({
        progressPct,
        updatedAt: "2026-03-16T22:00:00.000Z",
      }),
      updatedAt: "2026-03-16T22:00:00.000Z",
    });
  }),
  replaceSkipMarkers: vi.fn(async () => undefined),
  fetchMediaDetails: vi.fn(async (mediaId: string) => libraryState.mediaDetails.get(mediaId) ?? null),
  upsertSkipAnalysis: vi.fn(async (mediaId: string, episodeId: string | null, kind: string, payload: Record<string, unknown>) => {
    const next = {
      id: `${kind}:${episodeId ?? "media"}`,
      mediaId,
      episodeId,
      kind,
      payload,
      createdAt: "2026-03-20T12:00:00.000Z",
      updatedAt: "2026-03-20T12:00:00.000Z",
    };
    const index = libraryState.skipAnalysisRows.findIndex((row) => row.mediaId === mediaId && row.episodeId === episodeId && row.kind === kind);
    if (index >= 0) {
      libraryState.skipAnalysisRows[index] = next;
      return;
    }
    libraryState.skipAnalysisRows.push(next);
  }),
  listSkipAnalysis: vi.fn(async (mediaId: string, kind?: string) =>
    libraryState.skipAnalysisRows.filter((row) => row.mediaId === mediaId && (!kind || row.kind === kind))
  ),
}));

// Tier-4 channel multiplex: renderer consumers subscribe via
// onMpvExternalMessage and switch on `msg.type`. The hoisted set keeps
// the same name for diff-friendliness but the listener signature now
// takes an MpvExternalMessage payload.
type _TestMpvExternalMessage = { type: "exit" } | { type: "osc_action"; action: { type: "next_episode"; requestedAt: number } } | { type: "property_change"; name: string; value: unknown };
const externalExitListeners = vi.hoisted(() => new Set<(msg: _TestMpvExternalMessage) => void>());

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
          return `Continue from ${String(options?.time ?? "--:--:--")} or start over.`;
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
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  toast: vi.fn(),
}));

vi.mock("lucide-react", () => ({
  Loader2: () => <div data-testid="loader" />,
}));

vi.mock("@/lib/usePlaybackEngine", () => ({
  usePlaybackEngine: (params: any) => {
    playbackHookCalls.push({
      open: params.open,
      media: params.media,
      episodeId: params.episodeId,
    });
    return {
      formats: [
        { id: "format-1080", quality: "1080p", codec: "hevc" },
        { id: "format-360", quality: "360p", codec: "h264" },
      ],
      effectiveFormat: { id: "format-1080", quality: "1080p", codec: "hevc" },
      selectedFormat: { id: "format-1080", quality: "1080p", codec: "hevc" },
      isBuffering: false,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      streamError: null,
      startFrom: startFromMock,
      clearResumeTarget: clearResumeTargetMock,
      selectFixedFormat: selectFixedFormatMock,
      // Track-selection setters consumed by MediaPlaybackController's
      // requestId-reset useEffect (the replacement for the prior keyed
      // remount approach). The real engine returns the React useState
      // setters from useMpvPlaybackEngine; for this mock we just need
      // them to be callable.
      setSelectedAudioId: () => {},
      setSelectedSubtitleId: () => {},
      resetSelectedSubtitleId: () => {},
    };
  },
}));

vi.mock("@/auth", () => ({
  useAuth: () => ({
    token: "token-1",
  }),
}));

vi.mock("@/api", async () => ({
  ...(await import("./_helpers/profileApiMock")).profileApiMock(),
  getMetadataSkipMarkers: (...args: unknown[]) => getMetadataSkipMarkersMock(...args),
}));

vi.mock("@/lib/useClientConfig", () => ({
  useClientConfig: () => ({
    playbackQuality: "1080p",
  }),
}));

vi.mock("@/lib/libraryContext", () => ({
  useLibraryActions: () => ({
    getMediaDetails: (id: string) => libraryState.mediaDetails.get(id) ?? null,
    fetchMediaDetails: libraryState.fetchMediaDetails,
    getSharedSetting: (key: string): SharedSetting => libraryState.sharedSettings.get(key) ?? null,
    setMediaFormatChunks: vi.fn(async () => undefined),
    setProgress: libraryState.setProgress,
    replaceSkipMarkers: libraryState.replaceSkipMarkers,
    upsertSkipAnalysis: libraryState.upsertSkipAnalysis,
    listSkipAnalysis: libraryState.listSkipAnalysis,
    awaitDatasetReady: vi.fn(async () => undefined),
  }),
  useLibraryShell: () => ({
    datasetStatus: { playback: true, metadata: true, core: true },
  }),
}));

vi.mock("@/components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({
    showLoading: showLoadingMock,
    updateLoading: updateLoadingMock,
    hideLoading: hideLoadingMock,
  }),
}));

const dispatchExternalMpvExit = async () => {
  console.info(
    `[media-playback-controller-integration:mpv-exit] dispatching external mpv exit to ${externalExitListeners.size} listener(s)`,
  );
  await act(async () => {
    for (const listener of [...externalExitListeners]) {
      listener({ type: "exit" });
    }
    await Promise.resolve();
    await Promise.resolve();
  });
};

const mediaBase = {
  id: "media-1",
  type: "movie",
  updatedAt: "2026-03-16T20:00:00.000Z",
  progressPct: 0,
  preferredAudioLanguage: "ja",
  files: [{ id: "file-1" }],
  formats: [{ id: "format-1080", fileId: "file-1", quality: "1080p", codec: "hevc", durationSeconds: 1000 }],
  audioTracks: [] as Array<any>,
  subtitleTracks: [] as Array<any>,
  chapters: [] as Array<any>,
  episodes: [] as Array<any>,
};

const staleMedia = {
  ...mediaBase,
  audioTracks: [
    { id: "audio-1", label: "audio", language: "und", isDefault: true, episodeId: null, initKey: "a1", chunks: [{ key: "c1", sizeBytes: 1, startSeconds: 0 }] },
    { id: "audio-2", label: "audio", language: "und", isDefault: false, episodeId: null, initKey: "a2", chunks: [{ key: "c2", sizeBytes: 1, startSeconds: 0 }] },
  ],
  subtitleTracks: [],
  chapters: [],
};

const freshMedia = {
  ...mediaBase,
  updatedAt: "2026-03-16T21:00:00.000Z",
  audioTracks: [
    { id: "audio-1", label: "JPN", language: "ja", isDefault: true, episodeId: null, initKey: "a1", chunks: [{ key: "c1", sizeBytes: 1, startSeconds: 0 }] },
    { id: "audio-2", label: "Dubbed", language: "en", isDefault: false, episodeId: null, initKey: "a2", chunks: [{ key: "c2", sizeBytes: 1, startSeconds: 0 }] },
  ],
  subtitleTracks: [
    { id: "sub-1", label: "ENG", language: "en", isDefault: true, episodeId: null, objectKey: "sub-1", format: "srt" },
    { id: "sub-2", label: "JPN", language: "ja", isDefault: false, episodeId: null, objectKey: "sub-2", format: "srt" },
  ],
  chapters: [
    { id: "chapter-1", formatId: "format-1080", title: "Chapter 1", startSeconds: 0 },
    { id: "chapter-2", formatId: "format-1080", title: "Chapter 2", startSeconds: 120 },
  ],
};

// On assertion failure, dump enough domain state to diagnose offline: the
// rendered DOM text, the mock call args the assertions inspect, and the
// in-memory library store rows. Body is wrapped in try/catch so a dump
// failure can never mask the real assertion failure (per tests-log-generously
// style guide, modelled on dumpNextEpisodeSnapshot).
const dumpControllerSnapshot = (label: string, container: HTMLDivElement | null) => {
  try {
    console.error(`=== [media-playback-controller-integration:${label}] state snapshot ===`);
    console.error(`container.textContent=${JSON.stringify(container?.textContent ?? null)}`);
    console.error(`playbackHookCalls (count=${playbackHookCalls.length}):`);
    console.error(
      JSON.stringify(
        playbackHookCalls.map((c) => ({
          open: c.open,
          episodeId: c.episodeId,
          mediaId: c.media?.id ?? null,
          mediaUpdatedAt: c.media?.updatedAt ?? null,
          audioTracks: Array.isArray(c.media?.audioTracks)
            ? c.media.audioTracks.map((t: any) => t.label)
            : null,
          subtitleTracks: Array.isArray(c.media?.subtitleTracks)
            ? c.media.subtitleTracks.map((t: any) => t.label)
            : null,
          chapters: Array.isArray(c.media?.chapters) ? c.media.chapters.map((ch: any) => ch.title) : null,
        })),
        null,
        2,
      ),
    );
    console.error(`startFrom.calls=${JSON.stringify(startFromMock.mock.calls)}`);
    console.error(`setProgress.calls=${JSON.stringify(libraryState.setProgress.mock.calls)}`);
    console.error(`replaceSkipMarkers.calls=${JSON.stringify(libraryState.replaceSkipMarkers.mock.calls)}`);
    console.error(`upsertSkipAnalysis.calls=${JSON.stringify(libraryState.upsertSkipAnalysis.mock.calls)}`);
    console.error(`getMetadataSkipMarkers.calls=${JSON.stringify(getMetadataSkipMarkersMock.mock.calls)}`);
    console.error(`skipAnalysisRows=${JSON.stringify(libraryState.skipAnalysisRows, null, 2)}`);
    console.error(
      `sharedSettings=${JSON.stringify([...libraryState.sharedSettings.entries()], null, 2)}`,
    );
    console.error(`externalExitListeners.size=${externalExitListeners.size}`);
    console.error(`=== [media-playback-controller-integration:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("MediaPlaybackController", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    playbackHookCalls.length = 0;
    startFromMock.mockReset();
    clearResumeTargetMock.mockReset();
    selectFixedFormatMock.mockReset();
    hideLoadingMock.mockReset();
    showLoadingMock.mockReset();
    updateLoadingMock.mockReset();
    libraryState.mediaDetails.clear();
    libraryState.sharedSettings.clear();
    libraryState.skipAnalysisRows.length = 0;
    libraryState.setProgress.mockClear();
    libraryState.replaceSkipMarkers.mockClear();
    libraryState.fetchMediaDetails.mockClear();
    libraryState.upsertSkipAnalysis.mockClear();
    libraryState.listSkipAnalysis.mockClear();
    getMetadataSkipMarkersMock.mockReset();
    externalExitListeners.clear();
    (window as any).sf = {
      onMpvExternalMessage: (callback: (msg: _TestMpvExternalMessage) => void) => {
        externalExitListeners.add(callback);
        return () => {
          externalExitListeners.delete(callback);
        };
      },
    };
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

  const renderController = async (media: any, requestId = 1, episodeId?: string | null) => {
    console.info(
      `[media-playback-controller-integration:render] mounting controller mediaId=${media?.id} type=${media?.type} requestId=${requestId} episodeId=${String(episodeId)}`,
    );
    console.info("[media-playback-controller-integration:render] controller module preloaded at collection time");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<MediaPlaybackController media={media} requestId={requestId} episodeId={episodeId} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    console.info(
      `[media-playback-controller-integration:render] mounted; playbackHookCalls=${playbackHookCalls.length} textContent=${JSON.stringify(container?.textContent ?? null)}`,
    );
  };

  const rerenderController = async (media: any, requestId: number, episodeId?: string | null) => {
    console.info(
      `[media-playback-controller-integration:rerender] re-rendering controller mediaId=${media?.id} requestId=${requestId} episodeId=${String(episodeId)}`,
    );
    console.info("[media-playback-controller-integration:rerender] reusing statically imported controller");
    await act(async () => {
      root?.render(<MediaPlaybackController media={media} requestId={requestId} episodeId={episodeId} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    console.info(
      `[media-playback-controller-integration:rerender] re-rendered; playbackHookCalls=${playbackHookCalls.length} textContent=${JSON.stringify(container?.textContent ?? null)}`,
    );
  };

  const clickButton = async (label: string) => {
    console.info(`[media-playback-controller-integration:click] looking for button labelled "${label}"`);
    const button = [...(container?.querySelectorAll("button") ?? [])].find((node) => node.textContent?.trim() === label);
    if (!button) {
      const labels = [...(container?.querySelectorAll("button") ?? [])].map((n) => n.textContent?.trim());
      console.error(
        `[media-playback-controller-integration:click] button "${label}" not found; available button labels=${JSON.stringify(labels)}`,
      );
      dumpControllerSnapshot(`click-button-missing-${label}`, container);
    }
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    console.info(`[media-playback-controller-integration:click] clicked "${label}"; playbackHookCalls=${playbackHookCalls.length}`);
  };

  const lastPlaybackCall = () => playbackHookCalls[playbackHookCalls.length - 1]!;

  const expectFreshPlaybackMetadata = () => {
    const call = lastPlaybackCall();
    try {
      expect(call.media.audioTracks.map((track: any) => track.label)).toEqual(["JPN", "Dubbed"]);
      expect(call.media.subtitleTracks.map((track: any) => track.label)).toEqual(["ENG", "JPN"]);
      expect(call.media.chapters.map((chapter: any) => chapter.title)).toEqual(["Chapter 1", "Chapter 2"]);
    } catch (err) {
      console.error(
        `[media-playback-controller-integration:fresh-metadata] last playback call media metadata mismatch; ` +
          `audioTracks=${JSON.stringify(call.media?.audioTracks?.map((t: any) => t.label))} ` +
          `subtitleTracks=${JSON.stringify(call.media?.subtitleTracks?.map((t: any) => t.label))} ` +
          `chapters=${JSON.stringify(call.media?.chapters?.map((ch: any) => ch.title))}`,
      );
      dumpControllerSnapshot("fresh-metadata-mismatch", container);
      throw err;
    }
  };

  it("[@bugfix][@regression-proof] dashboard resume launches with fresh metadata and exact resume time", async () => {
    console.info("[media-playback-controller-integration:dashboard-resume] seeding mediaDetails progressPct=65, rendering stale media (requestId=101)");
    libraryState.mediaDetails.set("media-1", { ...freshMedia, progressPct: 65 });

    await renderController(staleMedia, 101);
    if (!container?.textContent?.includes("Continue from 00:10:50 or start over.")) {
      dumpControllerSnapshot("dashboard-resume-missing-resume-prompt", container);
    }
    expect(container?.textContent).toContain("Continue from 00:10:50 or start over.");

    await clickButton("Resume");

    if (!startFromMock.mock.calls.some(([t, b]) => t === 650 && b === true)) {
      dumpControllerSnapshot("dashboard-resume-wrong-startFrom", container);
    }
    expect(startFromMock).toHaveBeenCalledWith(650, true);
    expectFreshPlaybackMetadata();
  });

  it("[@bugfix][@regression-proof] dashboard start over launches with fresh metadata and resets progress", async () => {
    console.info("[media-playback-controller-integration:dashboard-start-over] seeding mediaDetails progressPct=65, rendering stale media (requestId=102)");
    libraryState.mediaDetails.set("media-1", { ...freshMedia, progressPct: 65 });

    await renderController(staleMedia, 102);
    await clickButton("Start over");

    if (
      !libraryState.setProgress.mock.calls.some(([m, p, e]) => m === "media-1" && p === 0 && e === null) ||
      !startFromMock.mock.calls.some(([t, b]) => t === 0 && b === true)
    ) {
      dumpControllerSnapshot("dashboard-start-over-reset-mismatch", container);
    }
    expect(libraryState.setProgress).toHaveBeenCalledWith("media-1", 0, null);
    expect(startFromMock).toHaveBeenCalledWith(0, true);
    expectFreshPlaybackMetadata();
  });

  it("[@bugfix][@regression-proof] modal resume launches with correct metadata and exact resume time", async () => {
    console.info("[media-playback-controller-integration:modal-resume] seeding mediaDetails progressPct=65, rendering fresh media (requestId=103)");
    libraryState.mediaDetails.set("media-1", { ...freshMedia, progressPct: 65 });

    await renderController({ ...freshMedia, progressPct: 65 }, 103);
    if (!container?.textContent?.includes("Continue from 00:10:50 or start over.")) {
      dumpControllerSnapshot("modal-resume-missing-resume-prompt", container);
    }
    expect(container?.textContent).toContain("Continue from 00:10:50 or start over.");

    await clickButton("Resume");

    if (!startFromMock.mock.calls.some(([t, b]) => t === 650 && b === true)) {
      dumpControllerSnapshot("modal-resume-wrong-startFrom", container);
    }
    expect(startFromMock).toHaveBeenCalledWith(650, true);
    expectFreshPlaybackMetadata();
  });

  it("[@bugfix][@regression-proof] modal start over launches with correct metadata and resets progress", async () => {
    console.info("[media-playback-controller-integration:modal-start-over] seeding mediaDetails progressPct=65, rendering fresh media (requestId=104)");
    libraryState.mediaDetails.set("media-1", { ...freshMedia, progressPct: 65 });

    await renderController({ ...freshMedia, progressPct: 65 }, 104);
    await clickButton("Start over");

    if (
      !libraryState.setProgress.mock.calls.some(([m, p, e]) => m === "media-1" && p === 0 && e === null) ||
      !startFromMock.mock.calls.some(([t, b]) => t === 0 && b === true)
    ) {
      dumpControllerSnapshot("modal-start-over-reset-mismatch", container);
    }
    expect(libraryState.setProgress).toHaveBeenCalledWith("media-1", 0, null);
    expect(startFromMock).toHaveBeenCalledWith(0, true);
    expectFreshPlaybackMetadata();
  });

  it("[@bugfix][@regression-proof] dashboard resume reuses the updated timestamp after external mpv exit", async () => {
    console.info("[media-playback-controller-integration:dashboard-resume-after-exit] seeding progressPct=25, render stale (requestId=105)");
    libraryState.mediaDetails.set("media-1", { ...freshMedia, progressPct: 25 });

    await renderController(staleMedia, 105);
    await clickButton("Resume");
    await dispatchExternalMpvExit();

    console.info("[media-playback-controller-integration:dashboard-resume-after-exit] updating progressPct=78, re-render (requestId=106)");
    libraryState.mediaDetails.set("media-1", { ...freshMedia, progressPct: 78 });
    await rerenderController(staleMedia, 106);

    if (!container?.textContent?.includes("Continue from 00:13:00 or start over.")) {
      dumpControllerSnapshot("dashboard-resume-after-exit-stale-prompt", container);
    }
    expect(container?.textContent).toContain("Continue from 00:13:00 or start over.");
    await clickButton("Resume");
    if (!startFromMock.mock.calls.length || startFromMock.mock.calls.at(-1)?.[0] !== 780) {
      dumpControllerSnapshot("dashboard-resume-after-exit-wrong-startFrom", container);
    }
    expect(startFromMock).toHaveBeenLastCalledWith(780, true);
    expectFreshPlaybackMetadata();
  });

  it("[@bugfix][@regression-proof] modal resume reuses the updated timestamp after external mpv exit", async () => {
    console.info("[media-playback-controller-integration:modal-resume-after-exit] seeding progressPct=25, render fresh (requestId=107)");
    libraryState.mediaDetails.set("media-1", { ...freshMedia, progressPct: 25 });

    await renderController({ ...freshMedia, progressPct: 25 }, 107);
    await clickButton("Resume");
    await dispatchExternalMpvExit();

    console.info("[media-playback-controller-integration:modal-resume-after-exit] updating progressPct=78, re-render (requestId=108)");
    libraryState.mediaDetails.set("media-1", { ...freshMedia, progressPct: 78 });
    await rerenderController({ ...freshMedia, progressPct: 25 }, 108);

    if (!container?.textContent?.includes("Continue from 00:13:00 or start over.")) {
      dumpControllerSnapshot("modal-resume-after-exit-stale-prompt", container);
    }
    expect(container?.textContent).toContain("Continue from 00:13:00 or start over.");
    await clickButton("Resume");
    if (!startFromMock.mock.calls.length || startFromMock.mock.calls.at(-1)?.[0] !== 780) {
      dumpControllerSnapshot("modal-resume-after-exit-wrong-startFrom", container);
    }
    expect(startFromMock).toHaveBeenLastCalledWith(780, true);
    expectFreshPlaybackMetadata();
  });

  it("[@bugfix][@regression-proof] fetches proxied skip markers for older episodes without provider-backed markers", async () => {
    getMetadataSkipMarkersMock.mockResolvedValueOnce({
      fetchedAt: "2026-03-20T12:00:00.000Z",
      markers: [
        {
          type: "intro",
          startSeconds: 88.5,
          endSeconds: 108.5,
          extendsToEof: false,
          confidence: 0.94,
          source: "metadata",
          version: "metadata-v1",
          meta: { submissionCount: 4 },
        },
      ],
      coverage: [
        { seasonNumber: 1, episodeNumber: 1, status: "miss" },
        { seasonNumber: 1, episodeNumber: 2, status: "hit", markerTypes: ["intro"] },
      ],
    });
    const tvMedia = {
      ...freshMedia,
      type: "tv",
      catalogId: 48891,
      episodes: [
        { id: "ep-1", seasonNumber: 1, episodeNumber: 1, name: "Pilot", overview: null, stillPath: null, airDate: null },
        { id: "ep-2", seasonNumber: 1, episodeNumber: 2, name: "The Tagger", overview: null, stillPath: null, airDate: null },
      ],
      skipMarkers: [],
    };

    console.info("[media-playback-controller-integration:skip-markers-fetch] rendering tv media catalogId=48891 episodeId=ep-2 (requestId=109)");
    await renderController(tvMedia, 109, "ep-2");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    console.info(
      `[media-playback-controller-integration:skip-markers-fetch] post-flush: getMetadataSkipMarkers.calls=${JSON.stringify(getMetadataSkipMarkersMock.mock.calls)} replaceSkipMarkers.calls=${libraryState.replaceSkipMarkers.mock.calls.length} upsertSkipAnalysis.calls=${libraryState.upsertSkipAnalysis.mock.calls.length}`,
    );

    try {
      expect(getMetadataSkipMarkersMock).toHaveBeenCalledWith("", "tv", 48891, 1, 2, 1000);
      expect(libraryState.replaceSkipMarkers).toHaveBeenCalledWith(
        "media-1",
        "ep-2",
        expect.arrayContaining([
          expect.objectContaining({
            type: "intro",
            startSeconds: 88.5,
            endSeconds: 108.5,
            source: "metadata",
          }),
        ])
      );
      expect(libraryState.upsertSkipAnalysis).toHaveBeenCalledWith(
        "media-1",
        "ep-2",
        "external-skip-markers-v2",
        expect.objectContaining({
          provider: "metadata-v1",
          status: "hit",
          markerTypes: ["intro"],
        })
      );
      expect(libraryState.upsertSkipAnalysis).toHaveBeenCalledWith(
        "media-1",
        "ep-1",
        "external-skip-markers-v2",
        expect.objectContaining({
          provider: "metadata-v1",
          status: "miss",
        })
      );
    } catch (err) {
      dumpControllerSnapshot("skip-markers-fetch-mismatch", container);
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] skips relay fetch when local sqlite skip analysis already cached a provider miss", async () => {
    const tvMedia = {
      ...freshMedia,
      type: "tv",
      catalogId: 48891,
      episodes: [{ id: "ep-2", seasonNumber: 1, episodeNumber: 2, name: "The Tagger", overview: null, stillPath: null, airDate: null }],
      skipMarkers: [],
    };
    libraryState.skipAnalysisRows.push({
      id: "external-skip-markers-v2:ep-2",
      mediaId: "media-1",
      episodeId: "ep-2",
      kind: "external-skip-markers-v2",
      payload: {
        provider: "metadata-v1",
        status: "miss",
        fetchedAt: "2026-03-20T12:00:00.000Z",
      },
      createdAt: "2026-03-20T12:00:00.000Z",
      updatedAt: "2026-03-20T12:00:00.000Z",
    });

    console.info("[media-playback-controller-integration:skip-markers-cached-miss] seeded cached provider-miss row for ep-2; rendering (requestId=110)");
    await renderController(tvMedia, 110, "ep-2");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    console.info(
      `[media-playback-controller-integration:skip-markers-cached-miss] post-flush: getMetadataSkipMarkers.calls=${getMetadataSkipMarkersMock.mock.calls.length} replaceSkipMarkers.calls=${libraryState.replaceSkipMarkers.mock.calls.length}`,
    );

    try {
      expect(getMetadataSkipMarkersMock).not.toHaveBeenCalled();
      expect(libraryState.replaceSkipMarkers).not.toHaveBeenCalled();
    } catch (err) {
      dumpControllerSnapshot("skip-markers-cached-miss-unexpected-fetch", container);
      throw err;
    }
  });

  // Round-13 #1: launch-progress UX honesty. The renderer used to feed
  // hardcoded "10%" / "70%" subtitles into the global LoadingModalProvider
  // and to update the modal subtitle with a fake `${rounded}%` string driven
  // by a cosmetic interval. None of those numbers reflected real buffer-fill
  // progress (mpv exposes `cache-buffering-state` but it isn't wired into
  // useMpvPlaybackEngine), so the percentages were lying to the user. This
  // test pins the source of MediaPlaybackController.tsx so any reintroduction
  // of a hardcoded "%" subtitle, or a `${rounded}%` template literal in
  // syncLoadingProgress, fails immediately.
  it("[@bugfix][@regression-proof] does not render hardcoded percentage subtitles in showLoading or syncLoadingProgress", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const sourcePath = path.resolve(
      __dirname,
      "../src/renderer/src/components/MediaPlaybackController.tsx"
    );
    console.info(`[media-playback-controller-integration:source-pin] reading source for hardcoded-% audit: ${sourcePath}`);
    const source = await fs.readFile(sourcePath, "utf-8");
    console.info(`[media-playback-controller-integration:source-pin] source length=${source.length} chars`);

    // No hardcoded percent-strings inside any showLoading({...}) call.
    // We strip comments first so the explanatory comment block above the
    // cosmetic-interval effect (which legitimately references "70%" / "92%")
    // doesn't trip the assertion.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const showLoadingPercentMatches = stripped.match(
      /showLoading\([^)]*subtitle:\s*["']\d+%["']/g
    );
    if (showLoadingPercentMatches !== null) {
      console.error(`=== [media-playback-controller-integration:source-pin] hardcoded-% violation ===`);
      console.error(`showLoading hardcoded-% matches=${JSON.stringify(showLoadingPercentMatches, null, 2)}`);
      console.error(`=== [media-playback-controller-integration:source-pin] end violation ===`);
    }
    expect(showLoadingPercentMatches).toBeNull();

    // No `${rounded}%` (or similar `${...}%`) template literal in the
    // subtitle of any updateLoading call inside syncLoadingProgress.
    const syncBlockMatch = stripped.match(
      /const\s+syncLoadingProgress\s*=\s*useCallback\([\s\S]*?\),\s*\[[^\]]*\]\s*\)/
    );
    if (syncBlockMatch === null) {
      console.error(
        `=== [media-playback-controller-integration:source-pin] could not locate syncLoadingProgress useCallback block in source (regex drift?) ===`,
      );
    }
    expect(syncBlockMatch).not.toBeNull();
    const syncBlock = syncBlockMatch![0];
    if (/subtitle:[^,}]*\$\{[^}]+\}\s*%/.test(syncBlock)) {
      console.error(`=== [media-playback-controller-integration:source-pin] \${...}% subtitle violation in syncLoadingProgress ===`);
      console.error(`syncLoadingProgress block:\n${syncBlock}`);
      console.error(`=== [media-playback-controller-integration:source-pin] end violation ===`);
    }
    expect(syncBlock).not.toMatch(/subtitle:[^,}]*\$\{[^}]+\}\s*%/);
  });
});

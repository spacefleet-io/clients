// @vitest-environment jsdom
/**
 * @bugfix @regression-proof — issue #25 P15.
 *
 * Clicking Resume / Start over in the resume prompt took 46-127 ms of event
 * processing on the low-end profile. Profiled (CDP CPU profile + Event Timing,
 * headless Chromium, 4x CPU throttle, --disable-gpu, production React build):
 * the cost is the LAUNCH render itself (controller + playback engine: media
 * swap, chunk maps rebuilt for a newer library copy, open/defer flags, engine
 * effects) running inside the click task. flushSync(setCurrentMedia) only
 * added one more synchronous render in front of it; dropping flushSync alone
 * did not move the number. The fix runs the whole launch update as ONE React
 * transition, so it renders in a scheduler task after the click.
 *
 * Test 1/2 pin that contract: during the click task (synchronous dispatch +
 * microtask drain, which is what Event Timing counts as processing) the engine
 * is never rendered with the launch state; one macrotask later it is, with the
 * fresh media and the expected startFrom call.
 *
 * Test 3/4 pin the ordering race the old flushSync in the OSC next-episode
 * handler was protecting: the engine only drops isReadyToReveal in the passive
 * effects of the commit that applies the new episode, so the reveal effect in
 * that same commit still sees the previous episode's `true`. Without a guard
 * the new launch is "revealed" instantly and its 30 s / 60 s watchdog is
 * disarmed. The engine mock below reproduces that mechanism (a readiness
 * store that an effect on episodeId change flips to false, as start_load does).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import MediaPlaybackController from "../src/renderer/src/components/MediaPlaybackController";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
// Test seam: jsdom has no preload bridge; the controller reads window.sf.
const testWindow = window as unknown as { sf?: unknown };
(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const TAG = "[click-no-sync-launch-render]";

type EngineRender = {
  seq: number;
  open: boolean;
  deferPlayback: boolean;
  episodeId: string | null;
  previousEpisodeId: string | null;
  nextEpisodeId: string | null;
  mediaUpdatedAt: string | null;
  isReadyToReveal: boolean;
};

type TestMessage = { type: "osc_action"; action: { type: string; [key: string]: unknown }; seq: number } | { type: "exit" };

const engineState = vi.hoisted(() => ({
  renders: [] as EngineRender[],
  ready: false,
  readyListeners: new Set<() => void>(),
  setReady(value: boolean) {
    engineState.ready = value;
    for (const listener of engineState.readyListeners) listener();
  },
}));

const startFromMock = vi.hoisted(() => vi.fn());
const prepareEpisodeStartMock = vi.hoisted(() => vi.fn());
// Called with the episode the engine render belongs to: the place saved must be the episode LEFT's.
const flushProgressMock = vi.hoisted(() => vi.fn(async (_episodeId: string | null, _positionSeconds?: number) => undefined));
const notifyErrorMock = vi.hoisted(() => vi.fn());
const hideLoadingMock = vi.hoisted(() => vi.fn());
const showLoadingMock = vi.hoisted(() => vi.fn(() => "loading-token"));
const oscListeners = vi.hoisted(() => new Set<(msg: TestMessage) => void>());

const libraryState = vi.hoisted(() => ({
  mediaDetails: new Map<string, unknown>(),
  sharedSettings: new Map<string, { value: string; updatedAt: string }>(),
  setProgress: vi.fn(async () => undefined),
}));

vi.mock("react-i18next", () => {
  const value = { t: (key: string) => key };
  return { useTranslation: () => value };
});

vi.mock("@space/ui", () => ({
  Button: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  toast: vi.fn(),
}));

vi.mock("lucide-react", () => ({ Loader2: () => <div data-testid="loader" /> }));

vi.mock("@/lib/notify", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyError: (...args: unknown[]) => notifyErrorMock(...args),
}));

vi.mock("@/lib/usePlaybackEngine", async () => {
  // vi.mock factories are hoisted above the static imports, so React must be
  // loaded inside the factory.
  const { useEffect, useRef, useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    engineState.readyListeners.add(listener);
    return () => {
      engineState.readyListeners.delete(listener);
    };
  };
  const stable = {
    setSelectedAudioId: () => undefined,
    setSelectedSubtitleId: () => undefined,
    resetSelectedSubtitleId: () => undefined,
  };
  return {
    usePlaybackEngine: (params: {
      open: boolean;
      deferPlayback: boolean;
      episodeId?: string | null;
      previousEpisode?: { id: string } | null;
      nextEpisode?: { id: string } | null;
      media: { updatedAt?: string };
    }) => {
      const isReadyToReveal = useSyncExternalStore(subscribe, () => engineState.ready);
      engineState.renders.push({
        seq: engineState.renders.length,
        open: params.open,
        deferPlayback: params.deferPlayback,
        episodeId: params.episodeId ?? null,
        previousEpisodeId: params.previousEpisode?.id ?? null,
        nextEpisodeId: params.nextEpisode?.id ?? null,
        mediaUpdatedAt: params.media?.updatedAt ?? null,
        isReadyToReveal,
      });
      // Mirrors the real engine: the init effect of the commit that applies a
      // new episode dispatches start_load (playing → reloading), which drops
      // isReadyToReveal — in a PASSIVE effect, i.e. after that commit rendered.
      const lastEpisodeRef = useRef(params.episodeId ?? null);
      useEffect(() => {
        const next = params.episodeId ?? null;
        if (lastEpisodeRef.current === next) return;
        lastEpisodeRef.current = next;
        if (params.open && !params.deferPlayback) engineState.setReady(false);
      }, [params.episodeId, params.open, params.deferPlayback]);
      return {
        formats: [],
        effectiveFormat: null,
        selectedFormat: null,
        isBuffering: false,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        streamError: null,
        isReadyToReveal,
        startFrom: startFromMock,
        prepareEpisodeStart: prepareEpisodeStartMock,
        flushProgress: (positionSeconds?: number) => flushProgressMock(params.episodeId ?? null, positionSeconds),
        clearResumeTarget: () => undefined,
        selectFixedFormat: () => undefined,
        requestSeek: () => undefined,
        audioOptions: [],
        subtitleOptions: [],
        chapters: [],
        selectedAudioId: null,
        selectedSubtitleId: "off",
        ...stable,
      };
    },
  };
});

vi.mock("@/auth", () => {
  const value = { token: "token-p15" };
  return { useAuth: () => value };
});

vi.mock("@/api", async () => ({
  ...(await import("./_helpers/profileApiMock")).profileApiMock(),
  getMetadataSkipMarkers: vi.fn(async () => ({ markers: [] })),
}));

vi.mock("@/lib/useClientConfig", () => {
  const value = { playbackQuality: "1080p" };
  return { useClientConfig: () => value };
});

vi.mock("@/lib/libraryContext", () => {
  const actions = {
    getMediaDetails: (id: string) => libraryState.mediaDetails.get(id) ?? null,
    fetchMediaDetails: async (id: string) => libraryState.mediaDetails.get(id) ?? null,
    getSharedSetting: (key: string) => libraryState.sharedSettings.get(key) ?? null,
    setMediaFormatChunks: async () => undefined,
    setProgress: (...args: unknown[]) => libraryState.setProgress(...(args as [])),
    replaceSkipMarkers: async () => undefined,
    upsertSkipAnalysis: async () => undefined,
    listSkipAnalysis: async () => [],
    awaitDatasetReady: async () => undefined,
  };
  const shell = { datasetStatus: { playback: true, metadata: true, core: true } };
  return { useLibraryActions: () => actions, useLibraryShell: () => shell };
});

vi.mock("@/components/LoadingModalProvider", () => {
  const value = {
    showLoading: (...args: unknown[]) => showLoadingMock(...(args as [])),
    updateLoading: () => undefined,
    hideLoading: (...args: unknown[]) => hideLoadingMock(...(args as [])),
  };
  return { useLoadingModal: () => value };
});

vi.mock("@/logger", () => {
  const logger: Record<string, unknown> = { info() {}, debug() {}, warn() {}, error() {}, trace() {} };
  logger.child = () => logger;
  return { rendererLogger: logger };
});

const movieBase = {
  id: "media-p15",
  type: "movie",
  title: "P15 Movie",
  catalogId: null,
  progressPct: 65,
  preferredAudioLanguage: "en",
  files: [{ id: "file-1" }],
  formats: [{ id: "format-1080", fileId: "file-1", quality: "1080p", codec: "hevc", durationSeconds: 1000, initKey: "i", chunks: [{ key: "c", sizeBytes: 1, startSeconds: 0 }] }],
  audioTracks: [],
  subtitleTracks: [],
  chapters: [],
  episodes: [],
  skipMarkers: [],
};
const STALE = "2026-03-16T20:00:00.000Z";
const MOUNTED = "2026-03-16T20:30:00.000Z";
const FRESH = "2026-03-16T21:00:00.000Z";

const showMedia = {
  id: "show-p15",
  type: "tv",
  title: "P15 Show",
  catalogId: null,
  updatedAt: STALE,
  progressPct: 0,
  preferredAudioLanguage: "en",
  files: [
    { id: "file-e1", season: 1, episode: 1 },
    { id: "file-e2", season: 1, episode: 2 },
  ],
  formats: ["file-e1", "file-e2"].map((fileId) => ({
    id: `format-${fileId}`, fileId, quality: "1080p", codec: "hevc", durationSeconds: 1000, initKey: "i", chunks: [{ key: "c", sizeBytes: 1, startSeconds: 0 }],
  })),
  audioTracks: ["ep-1", "ep-2"].map((episodeId) => ({
    id: `audio-${episodeId}`, label: "EN", language: "en", isDefault: true, episodeId, initKey: "a", chunks: [{ key: "a", sizeBytes: 1, startSeconds: 0 }],
  })),
  subtitleTracks: [],
  chapters: [],
  episodes: [1, 2].map((n) => ({ id: `ep-${n}`, seasonNumber: 1, episodeNumber: n, name: `E${n}`, overview: null, stillPath: null, airDate: null })),
  skipMarkers: [],
};

const dumpState = (label: string, container: HTMLElement | null) => {
  try {
    console.error(`=== ${TAG}:${label} snapshot ===`);
    console.error(`container.textContent=${JSON.stringify(container?.textContent ?? null)}`);
    console.error(`engine renders (count=${engineState.renders.length}):\n${JSON.stringify(engineState.renders, null, 1)}`);
    console.error(`engine ready=${engineState.ready}`);
    console.error(`startFrom.calls=${JSON.stringify(startFromMock.mock.calls)}`);
    console.error(`prepareEpisodeStart.calls=${JSON.stringify(prepareEpisodeStartMock.mock.calls)}`);
    console.error(`flushProgress.calls=${JSON.stringify(flushProgressMock.mock.calls)}`);
    console.error(`setProgress.calls=${JSON.stringify(libraryState.setProgress.mock.calls)}`);
    console.error(`hideLoading.calls=${JSON.stringify(hideLoadingMock.mock.calls)}`);
    console.error(`notifyError.calls=${JSON.stringify(notifyErrorMock.mock.calls)}`);
    console.error(`=== ${TAG}:${label} end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const isLaunchRender = (render: EngineRender) => render.open && !render.deferPlayback;

describe("MediaPlaybackController — click / OSC launch rendering (#25 P15)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    engineState.renders.length = 0;
    engineState.ready = false;
    engineState.readyListeners.clear();
    startFromMock.mockReset();
    prepareEpisodeStartMock.mockReset();
    flushProgressMock.mockClear();
    notifyErrorMock.mockReset();
    hideLoadingMock.mockReset();
    showLoadingMock.mockReset();
    showLoadingMock.mockImplementation(() => "loading-token");
    libraryState.mediaDetails.clear();
    libraryState.sharedSettings.clear();
    libraryState.setProgress.mockReset();
    libraryState.setProgress.mockImplementation(async () => undefined);
    oscListeners.clear();
    testWindow.sf = {
      onMpvExternalMessage: (listener: (msg: TestMessage) => void) => {
        oscListeners.add(listener);
        return () => {
          oscListeners.delete(listener);
        };
      },
      getPendingOscAction: async () => null,
      ackOscAction: () => undefined,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    delete testWindow.sf;
  });

  const mount = async (media: unknown, requestId: number, episodeId?: string) => {
    console.info(`${TAG} mount requestId=${requestId} episodeId=${String(episodeId)}`);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <MediaPlaybackController media={media as never} requestId={requestId} episodeId={episodeId} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    console.info(`${TAG} mounted; engine renders=${engineState.renders.length} text=${JSON.stringify(container.textContent)}`);
  };

  // Click OUTSIDE act(), like a real user event: React flushes the click's
  // sync-lane work in a microtask of the same task, and transition work in a
  // later scheduler task. Returns the engine renders that happened inside the
  // click task (dispatch + microtask drain).
  const clickOutsideAct = async (label: string) => {
    const button = [...(container?.querySelectorAll("button") ?? [])].find((node) => node.textContent?.trim() === label);
    if (!button) dumpState(`missing-button-${label}`, container);
    expect(button, `${TAG} button "${label}"`).toBeTruthy();
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = false;
    const before = engineState.renders.length;
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const afterDispatch = engineState.renders.length;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const inClickTask = engineState.renders.slice(before);
    console.info(
      `${TAG} clicked "${label}": engine renders during dispatch=${afterDispatch - before}, in click task=${inClickTask.length} ${JSON.stringify(inClickTask)}`,
    );
    return inClickTask;
  };

  const settleOutsideAct = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      await Promise.resolve();
    });
  };

  const seedResumableMovie = () => {
    // The launch run swaps in the library copy (MOUNTED) when the prompt opens.
    libraryState.mediaDetails.set(movieBase.id, { ...movieBase, updatedAt: MOUNTED });
  };
  const refreshLibraryCopy = () => {
    // A library sync lands while the prompt is open: the click must swap it in.
    libraryState.mediaDetails.set(movieBase.id, { ...movieBase, updatedAt: FRESH });
  };

  it("[@bugfix][@regression-proof] Resume click does not render the launch inside the click task", async () => {
    seedResumableMovie();
    await mount({ ...movieBase, updatedAt: STALE }, 11);
    expect(container?.textContent).toContain("player.resume");
    refreshLibraryCopy();

    const inClickTask = await clickOutsideAct("player.resume");
    const launchInClick = inClickTask.filter((r) => isLaunchRender(r) || r.mediaUpdatedAt === FRESH);
    if (launchInClick.length > 0) dumpState("resume-launch-in-click-task", container);
    expect(launchInClick, `${TAG} launch/media-swap renders inside the Resume click task`).toEqual([]);

    await settleOutsideAct();
    const launched = engineState.renders.filter(isLaunchRender);
    if (launched.length === 0 || launched[0]!.mediaUpdatedAt !== FRESH) dumpState("resume-launch-after-click", container);
    expect(launched.length, `${TAG} launch render after the click task`).toBeGreaterThan(0);
    // Fresh metadata lands in the SAME commit as the launch flags (no stale launch).
    expect(launched[0]!.mediaUpdatedAt).toBe(FRESH);
    expect(startFromMock).toHaveBeenCalledWith(650, true);
  });

  it("[@bugfix][@regression-proof] Start over click does not render the launch inside the click task", async () => {
    seedResumableMovie();
    await mount({ ...movieBase, updatedAt: STALE }, 21);
    expect(container?.textContent).toContain("player.restart");
    refreshLibraryCopy();

    const inClickTask = await clickOutsideAct("player.restart");
    const launchInClick = inClickTask.filter((r) => isLaunchRender(r) || r.mediaUpdatedAt === FRESH);
    if (launchInClick.length > 0) dumpState("restart-launch-in-click-task", container);
    expect(launchInClick, `${TAG} launch/media-swap renders inside the Start over click task`).toEqual([]);

    await settleOutsideAct();
    const launched = engineState.renders.filter(isLaunchRender);
    if (launched.length === 0 || launched[0]!.mediaUpdatedAt !== FRESH) dumpState("restart-launch-after-click", container);
    expect(launched.length, `${TAG} launch render after the click task`).toBeGreaterThan(0);
    expect(launched[0]!.mediaUpdatedAt).toBe(FRESH);
    expect(libraryState.setProgress).toHaveBeenCalledWith(movieBase.id, 0, null);
    expect(startFromMock).toHaveBeenCalledWith(0, true);
  });

  // Distinct requestIds per test: the controller dedupes (media, request) pairs
  // across mounts (mount-storm protection).
  const playFirstEpisodeToReady = async (requestId: number) => {
    libraryState.mediaDetails.set(showMedia.id, showMedia);
    await mount(showMedia, requestId, "ep-1");
    // Direct launch (no resume progress): episode 1 launches, then the engine reports ready.
    await act(async () => {
      engineState.setReady(true);
      await Promise.resolve();
    });
    const last = engineState.renders.at(-1);
    console.info(`${TAG} episode 1 ready: last engine render=${JSON.stringify(last)} hideLoading.calls=${hideLoadingMock.mock.calls.length}`);
    if (last?.episodeId !== "ep-1" || !last.isReadyToReveal || hideLoadingMock.mock.calls.length !== 1) dumpState("ep1-not-ready", container);
    expect(showLoadingMock).toHaveBeenCalledTimes(1);
    expect(last?.episodeId).toBe("ep-1");
    expect(hideLoadingMock).toHaveBeenCalledTimes(1);
    expect(oscListeners.size, `${TAG} mpv message listeners subscribed`).toBeGreaterThan(0);
  };

  const fireNextEpisode = async () => {
    console.info(`${TAG} delivering osc_action next_episode to ${oscListeners.size} listener(s)`);
    await act(async () => {
      for (const listener of [...oscListeners]) listener({ type: "osc_action", action: { type: "next_episode" }, seq: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    const last = engineState.renders.at(-1);
    console.info(`${TAG} after next_episode: last engine render=${JSON.stringify(last)}`);
    if (last?.episodeId !== "ep-2") dumpState("next-episode-not-applied", container);
    expect(last?.episodeId).toBe("ep-2");
    expect(prepareEpisodeStartMock).toHaveBeenCalledWith(0, true);
  };

  it("[@bugfix][@regression-proof] OSC next episode stays launching until the NEW episode is ready (stale readiness ignored)", async () => {
    await playFirstEpisodeToReady(31);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await fireNextEpisode();
    // Episode 2 never becomes ready: the launch watchdog must still be armed,
    // which proves the launch was NOT revealed off episode 1's readiness.
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    const failed = notifyErrorMock.mock.calls.some(([message]) => message === "player.abrLaunchFailed");
    if (!failed) dumpState("next-episode-revealed-by-stale-readiness", container);
    expect(failed, `${TAG} hard launch watchdog fired for the stuck next-episode launch`).toBe(true);
  });

  it("[@bugfix][@regression-proof] OSC next episode completes once the NEW episode reports ready", async () => {
    await playFirstEpisodeToReady(41);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await fireNextEpisode();
    await act(async () => {
      engineState.setReady(true);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    if (notifyErrorMock.mock.calls.length > 0) dumpState("next-episode-watchdog-after-ready", container);
    expect(notifyErrorMock, `${TAG} no watchdog error once episode 2 revealed`).not.toHaveBeenCalled();
  });

  // @req PLAY-RESUME-02[badger-desktop]
  // @req PLAY-OVL-03[badger-desktop]
  // @bugfix @regression-proof #2473 #2487 #2488 (ultimate c016/c034/c035, replay c021): next
  // pressed at 630.04 s, credits start 630 s. Only the 500 ms poll saved the episode left, last
  // at 629.75 s, so it was not watched and Play reopened it instead of the next one.
  it("[@bugfix][@regression-proof] OSC next episode saves the episode left at mpv's time-pos, before the swap", async () => {
    await playFirstEpisodeToReady(71);
    // The launch of episode 1 already called prepareEpisodeStart: only the switch's calls count.
    prepareEpisodeStartMock.mockClear();
    flushProgressMock.mockClear();
    console.info(`${TAG} delivering osc_action next_episode timePos=630.04 to ${oscListeners.size} listener(s)`);
    await act(async () => {
      for (const listener of [...oscListeners]) {
        listener({ type: "osc_action", action: { type: "next_episode", requestedAt: 1, timePos: 630.04 }, seq: 3 });
      }
      await Promise.resolve();
      await Promise.resolve();
    });
    const last = engineState.renders.at(-1);
    const flushOrder = flushProgressMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const prepareOrder = prepareEpisodeStartMock.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
    console.info(`${TAG} flushProgress.calls=${JSON.stringify(flushProgressMock.mock.calls)} flushOrder=${flushOrder} prepareOrder=${prepareOrder} last=${JSON.stringify(last)}`);
    if (flushProgressMock.mock.calls.length !== 1 || flushOrder > prepareOrder) dumpState("next-episode-left-place", container);
    expect(flushProgressMock.mock.calls, "one save, of ep-1 at the place mpv reported").toEqual([["ep-1", 630.04]]);
    expect(flushOrder, "saved before prepareEpisodeStart resets the engine's position").toBeLessThan(prepareOrder);
    expect(last?.episodeId).toBe("ep-2");
  });

  // @req UX-SKY-01[badger-desktop]
  it("marks the document as playing (<html data-app-playback>) from launch until mpv exits, so no shooting star flies during playback", async () => {
    await playFirstEpisodeToReady(51);
    const marked = document.documentElement.hasAttribute("data-app-playback");
    console.info(`${TAG} data-app-playback while playing: ${marked}`);
    expect(marked).toBe(true);
    await act(async () => {
      for (const listener of [...oscListeners]) listener({ type: "exit" } as TestMessage);
      await Promise.resolve();
    });
    const markedAfterExit = document.documentElement.hasAttribute("data-app-playback");
    console.info(`${TAG} data-app-playback after mpv exit: ${markedAfterExit}`);
    expect(markedAfterExit).toBe(false);
  });

  // @req PLAY-OVL-03[badger-desktop]
  it("the overlay's previous-episode button (osc_action previous_episode) plays the previous uploaded episode", async () => {
    libraryState.mediaDetails.set(showMedia.id, showMedia);
    await mount(showMedia, 61, "ep-2");
    await act(async () => {
      engineState.setReady(true);
      await Promise.resolve();
    });
    const onEp2 = engineState.renders.at(-1);
    console.info(`${TAG} episode 2 ready: last engine render=${JSON.stringify(onEp2)}`);
    if (onEp2?.episodeId !== "ep-2" || onEp2.previousEpisodeId !== "ep-1" || onEp2.nextEpisodeId !== null) dumpState("ep2-neighbours", container);
    expect(onEp2?.episodeId).toBe("ep-2");
    expect(onEp2?.previousEpisodeId, "engine gets ep-1 as the previous-episode button target").toBe("ep-1");
    expect(onEp2?.nextEpisodeId, "ep-2 is the last uploaded episode: no next button").toBeNull();

    libraryState.setProgress.mockClear();
    console.info(`${TAG} delivering osc_action previous_episode to ${oscListeners.size} listener(s)`);
    await act(async () => {
      for (const listener of [...oscListeners]) listener({ type: "osc_action", action: { type: "previous_episode" }, seq: 2 });
      await Promise.resolve();
      await Promise.resolve();
    });
    const last = engineState.renders.at(-1);
    console.info(`${TAG} after previous_episode: last engine render=${JSON.stringify(last)}`);
    if (last?.episodeId !== "ep-1" || last.previousEpisodeId !== null) dumpState("previous-episode-not-applied", container);
    expect(last?.episodeId).toBe("ep-1");
    expect(last?.previousEpisodeId, "ep-1 is the first uploaded episode: no previous button").toBeNull();
    expect(last?.nextEpisodeId).toBe("ep-2");
    expect(prepareEpisodeStartMock).toHaveBeenCalledWith(0, true);
    // The episode the user leaves keeps its real position (the engine's poll
    // saves): Previous never records it as watched / completed.
    const leavingSaves = libraryState.setProgress.mock.calls.filter((call) => (call as unknown[])[2] === "ep-2");
    console.info(`${TAG} setProgress calls for the episode left behind: ${JSON.stringify(leavingSaves)}`);
    expect(leavingSaves, "previous_episode writes no progress for ep-2").toEqual([]);
  });
});

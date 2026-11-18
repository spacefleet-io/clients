/**
 * Binds a `MediaSessionPlan` to the browser's `navigator.mediaSession`
 * (PLAY-OSMEDIA-01). Used by both web players and by both Electron renderers,
 * where Chromium turns the session into MPRIS (Linux), SMTC (Windows) and
 * Now Playing (macOS).
 *
 * Structural types only (the package has no DOM lib), so tests pass a fake.
 */
import {
  MEDIA_ACTIONS,
  type MediaAction,
  type MediaSessionPlan,
  type MediaSessionState,
  type PlannedMetadata,
  planMediaSession,
  SEEK_STEP_S,
  steppedSeekTarget,
} from "./plan";

export interface ActionDetailsLike {
  action: string;
  seekTime?: number | null;
  seekOffset?: number | null;
}

export interface MediaSessionLike {
  metadata: unknown;
  playbackState: string;
  setActionHandler(action: string, handler: ((details: ActionDetailsLike) => void) | null): void;
  setPositionState?(state?: { duration?: number; position?: number; playbackRate?: number }): void;
}

export interface MediaSessionHandlers {
  play(): void;
  pause(): void;
  /** Stop playback and close the player; the binder releases the session. */
  stop?(): void;
  next?(): void;
  previous?(): void;
  seekTo?(seconds: number): void;
}

export interface MediaSessionBinderOptions {
  session: MediaSessionLike;
  /** Builds the platform metadata object (`new MediaMetadata(...)` in a browser). */
  createMetadata: (metadata: PlannedMetadata) => unknown;
  /** Read at action time, so handlers always see the latest player closures. */
  handlers: () => MediaSessionHandlers;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface MediaSessionBinder {
  update(state: MediaSessionState): void;
  /** Clears metadata, position and every handler (player closed / unmounted). */
  release(): void;
}

const sameMetadata = (a: PlannedMetadata | null, b: PlannedMetadata | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.album === b.album &&
    a.artwork.length === b.artwork.length &&
    a.artwork.every((art, i) => art.src === b.artwork[i]?.src));

export const createMediaSessionBinder = (options: MediaSessionBinderOptions): MediaSessionBinder => {
  const { session, createMetadata, handlers, log } = options;
  let lastMetadata: PlannedMetadata | null = null;
  let lastState: MediaSessionState | null = null;
  const bound = new Set<MediaAction>();

  const setHandler = (action: MediaAction, handler: ((details: ActionDetailsLike) => void) | null) => {
    try {
      session.setActionHandler(action, handler);
    } catch (error) {
      // Older engines throw on actions they don't know (e.g. "stop"); the rest still work.
      log?.("media-session: action not supported", { action, error: String(error) });
    }
  };

  const handlerFor = (action: MediaAction): ((details: ActionDetailsLike) => void) => {
    switch (action) {
      case "play":
        return () => handlers().play();
      case "pause":
        return () => handlers().pause();
      case "stop":
        return () => {
          const h = handlers();
          if (h.stop) h.stop();
          else h.pause();
        };
      case "nexttrack":
        return () => handlers().next?.();
      case "previoustrack":
        return () => handlers().previous?.();
      case "seekto":
        return (details) => {
          if (typeof details.seekTime === "number" && Number.isFinite(details.seekTime)) {
            handlers().seekTo?.(Math.max(details.seekTime, 0));
          }
        };
      case "seekbackward":
      case "seekforward":
        return (details) => {
          const state = lastState;
          if (!state || typeof state.durationS !== "number") return;
          const offset =
            typeof details.seekOffset === "number" && details.seekOffset > 0 ? details.seekOffset : SEEK_STEP_S;
          handlers().seekTo?.(
            steppedSeekTarget(
              state.positionS ?? 0,
              state.durationS,
              action === "seekforward" ? "forward" : "backward",
              offset,
            ),
          );
        };
    }
  };

  const apply = (plan: MediaSessionPlan) => {
    if (!sameMetadata(plan.metadata, lastMetadata)) {
      session.metadata = plan.metadata ? createMetadata(plan.metadata) : null;
      lastMetadata = plan.metadata;
    }
    session.playbackState = plan.playbackState;
    for (const action of MEDIA_ACTIONS) {
      const wanted = plan.actions.has(action);
      if (wanted && !bound.has(action)) {
        setHandler(action, handlerFor(action));
        bound.add(action);
      } else if (!wanted && bound.has(action)) {
        setHandler(action, null);
        bound.delete(action);
      }
    }
    try {
      if (plan.position) session.setPositionState?.(plan.position);
      else session.setPositionState?.();
    } catch (error) {
      log?.("media-session: setPositionState rejected", { error: String(error), position: plan.position });
    }
  };

  return {
    update(state) {
      lastState = state;
      apply(planMediaSession(state));
    },
    release() {
      lastState = null;
      apply(planMediaSession({ status: "none", info: null, canNext: false, canPrevious: false, canSeek: false }));
      session.metadata = null;
      lastMetadata = null;
    },
  };
};

/**
 * The page's own session (`navigator.mediaSession` and `MediaMetadata`), or null where the Media Session API is
 * missing; the player then runs without OS controls. Read through `globalThis`, as the package has no DOM lib.
 */
export const browserMediaSession = (): {
  session: MediaSessionLike;
  createMetadata: (metadata: PlannedMetadata) => unknown;
} | null => {
  const nav: unknown = Reflect.get(globalThis, "navigator");
  const Metadata: unknown = Reflect.get(globalThis, "MediaMetadata");
  if (!nav || typeof nav !== "object" || !("mediaSession" in nav) || !nav.mediaSession) return null;
  if (typeof Metadata !== "function") return null;
  // The browser's own MediaSession and MediaMetadata: the structural types above are what this package reads of them.
  const session = nav.mediaSession as MediaSessionLike;
  const MetadataClass = Metadata as new (metadata: PlannedMetadata) => unknown;
  return { session, createMetadata: (metadata) => new MetadataClass(metadata) };
};

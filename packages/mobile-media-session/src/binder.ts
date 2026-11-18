/**
 * Phone binder of the operating system media session (PLAY-OSMEDIA-01): the shared plan of `@space/media-session`
 * driven into the native `SpaceMediaSession` module (Android: a Media3 MediaSessionService; iOS: Now Playing and the
 * remote command center). Pure: the native module and its event source are passed in, so tests run without React
 * Native.
 */
import {
  type MediaAction,
  MEDIA_ACTIONS,
  type MediaSessionHandlers,
  type MediaSessionPlan,
  type MediaSessionState,
  planMediaSession,
  SEEK_STEP_S,
  steppedSeekTarget,
} from "@space/media-session";

/** What `SpaceMediaSession.update` receives: the plan, flattened, in milliseconds. */
export type NativeMediaSessionPlan = {
  playbackState: "playing" | "paused" | "none";
  title: string;
  artist: string;
  album: string;
  /** `file://` URI of a decrypted image on the device; never a remote URL. */
  artworkUri: string | null;
  durationMs: number | null;
  positionMs: number | null;
  rate: number;
  actions: MediaAction[];
  /**
   * The card stands for an episode switch still loading (a next or previous press): the native side keeps its
   * foreground service and the JS keep-alive, so the locked phone goes on loading the new episode.
   */
  loading: boolean;
};

/** Payload of the `SpaceMediaSessionAction` event. */
export type NativeMediaSessionEvent = { action: MediaAction; seekTimeMs?: number; seekOffsetMs?: number };

export type NativeMediaSessionModule = {
  update: (plan: NativeMediaSessionPlan) => void;
  release: () => void;
};

export type NativeActionSource = {
  addListener: (eventName: string, listener: (event: NativeMediaSessionEvent) => void) => { remove: () => void };
};

export type NativeMediaSessionBinderOptions = {
  /** Read at action time, so handlers always see the latest player closures. */
  handlers: () => MediaSessionHandlers;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Runs `fn` after `ms`; returns its cancel. Defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => () => void;
};

export type NativeMediaSessionBinder = {
  /**
   * Every player change (status, track, position about once a second). `none` releases the session, except right
   * after a next or previous press: then the card holds as loading until the new episode's plan (or `HANDOVER_HOLD_MS`).
   */
  update: (state: MediaSessionState) => void;
  /**
   * Player closed or unmounted: removes the notification and lock-screen card. Right after a next or previous press
   * (the player remounts for the new episode) it holds the card as loading for the binder that mounts next instead.
   */
  release: () => void;
};

export const ACTION_EVENT = "SpaceMediaSessionAction";

/** How long a card holds through an episode switch whose new episode never reports in, before it is released. */
export const HANDOVER_HOLD_MS = 30_000;

/** A card held through an episode switch whose player unmounted, per native module: the next binder adopts it. */
type Handover = { adopt: () => void };
const handovers = new WeakMap<NativeMediaSessionModule, Handover>();

/** Only images already on the device reach the native side (PLAY-OSMEDIA-01 item 2). */
const nativeArtwork = (plan: MediaSessionPlan): string | null =>
  plan.metadata?.artwork.find((art) => art.src.startsWith("file:"))?.src ?? null;

export const toNativePlan = (plan: MediaSessionPlan, loading = false): NativeMediaSessionPlan => ({
  playbackState: plan.playbackState,
  title: plan.metadata?.title ?? "",
  artist: plan.metadata?.artist ?? "",
  album: plan.metadata?.album ?? "",
  artworkUri: nativeArtwork(plan),
  durationMs: plan.position ? Math.round(plan.position.duration * 1000) : null,
  positionMs: plan.position ? Math.round(plan.position.position * 1000) : null,
  rate: plan.position?.playbackRate ?? 1,
  actions: MEDIA_ACTIONS.filter((action) => plan.actions.has(action)),
  loading,
});

const finiteMs = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The binder over an injected native module. `now` is a millisecond clock used to extrapolate the position between
 * updates, so a seek-forward press lands 10 s past where the media is now, not where it was at the last update.
 */
export const createMediaSessionBinderFor = (
  native: NativeMediaSessionModule,
  events: NativeActionSource,
  options: NativeMediaSessionBinderOptions,
  now: () => number = Date.now,
): NativeMediaSessionBinder => {
  const log = options.log ?? (() => undefined);
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    });
  let subscription: { remove: () => void } | null = null;
  let plan: MediaSessionPlan | null = null;
  let planAt = 0;
  /**
   * When a next or previous press started an episode switch: the old player's `none` within `HANDOVER_HOLD_MS` of it
   * holds the card instead of releasing it (the old episode may still report a frame or two before it closes).
   */
  let switchAt: number | null = null;
  /** Cancels the hold timer while the card is held as loading. */
  let cancelHold: (() => void) | null = null;
  /** This binder's card, parked for the next binder after its player unmounted mid-switch. */
  let parked: Handover | null = null;

  const switching = () => switchAt !== null && now() - switchAt < HANDOVER_HOLD_MS;

  const positionNow = (): number | null => {
    const position = plan?.position;
    if (!position) return null;
    const elapsedS = plan?.playbackState === "playing" ? ((now() - planAt) / 1000) * position.playbackRate : 0;
    return Math.min(position.position + elapsedS, position.duration);
  };

  const onAction = (event: NativeMediaSessionEvent) => {
    const current = plan;
    if (!current || !current.actions.has(event.action)) {
      log("media_session.action_ignored", { action: event.action, offered: current ? [...current.actions] : [] });
      return;
    }
    if (parked) {
      // The player is gone: a stop or pause on the loading card gives up the switch, other presses wait for it.
      log("media_session.action_parked", { action: event.action });
      if (event.action === "stop" || event.action === "pause") releaseNow();
      return;
    }
    log("media_session.action", { action: event.action, seekTimeMs: event.seekTimeMs, seekOffsetMs: event.seekOffsetMs });
    const handlers = options.handlers();
    switch (event.action) {
      case "play":
        handlers.play();
        return;
      case "pause":
        handlers.pause();
        return;
      case "stop":
        switchAt = null;
        if (handlers.stop) handlers.stop();
        else handlers.pause();
        return;
      case "nexttrack":
        switchAt = now();
        handlers.next?.();
        return;
      case "previoustrack":
        switchAt = now();
        handlers.previous?.();
        return;
      case "seekto":
        if (finiteMs(event.seekTimeMs)) handlers.seekTo?.(Math.max(event.seekTimeMs / 1000, 0));
        return;
      case "seekbackward":
      case "seekforward": {
        const position = positionNow();
        if (position === null || !current.position) return;
        const offsetS = finiteMs(event.seekOffsetMs) && event.seekOffsetMs > 0 ? event.seekOffsetMs / 1000 : SEEK_STEP_S;
        handlers.seekTo?.(
          steppedSeekTarget(position, current.position.duration, event.action === "seekforward" ? "forward" : "backward", offsetS),
        );
        return;
      }
    }
  };

  const releaseNow = () => {
    switchAt = null;
    cancelHold?.();
    cancelHold = null;
    if (parked && handovers.get(native) === parked) handovers.delete(native);
    parked = null;
    subscription?.remove();
    subscription = null;
    if (plan) {
      plan = null;
      native.release();
      log("media_session.release");
    }
  };

  const release = () => {
    if (!switching() || !plan) {
      releaseNow();
      return;
    }
    hold(plan);
    parked = {
      adopt: () => {
        cancelHold?.();
        cancelHold = null;
        switchAt = null;
        parked = null;
        subscription?.remove();
        subscription = null;
        plan = null;
      },
    };
    handovers.set(native, parked);
    log("media_session.handover_parked", { title: plan.metadata?.title ?? "" });
  };

  /** Keeps the last card, paused at its position, as loading: the native side keeps its service and JS alive. */
  const hold = (current: MediaSessionPlan) => {
    if (cancelHold) return;
    const position = positionNow();
    plan = {
      ...current,
      playbackState: "paused",
      position: current.position && position !== null ? { ...current.position, position } : current.position,
    };
    planAt = now();
    cancelHold = schedule(() => {
      cancelHold = null;
      log("media_session.handover_expired", { holdMs: HANDOVER_HOLD_MS });
      releaseNow();
    }, HANDOVER_HOLD_MS);
    log("media_session.handover_hold", { title: current.metadata?.title ?? "" });
    native.update(toNativePlan(plan, true));
  };

  return {
    update(state) {
      const next = planMediaSession(state);
      if (next.playbackState === "none") {
        if (switching() && plan) hold(plan);
        else if (!parked) releaseNow();
        return;
      }
      const inherited = handovers.get(native);
      if (inherited && inherited !== parked) {
        handovers.delete(native);
        inherited.adopt();
        log("media_session.handover_done", { title: next.metadata?.title ?? "", adopted: true });
      } else if (!plan) log("media_session.claim", { title: next.metadata?.title ?? "" });
      if (cancelHold) {
        log("media_session.handover_done", { title: next.metadata?.title ?? "" });
        cancelHold();
        cancelHold = null;
        switchAt = null;
      }
      subscription ??= events.addListener(ACTION_EVENT, onAction);
      plan = next;
      planAt = now();
      native.update(toNativePlan(next));
    },
    release,
  };
};

/** Platforms without the native module (tests, a build without it linked): a binder that does nothing. */
export const createNoopBinder = (): NativeMediaSessionBinder => ({ update: () => undefined, release: () => undefined });

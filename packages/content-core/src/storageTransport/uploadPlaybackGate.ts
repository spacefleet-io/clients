/**
 * Upload policy while a video plays (#25, Chris 2026-10-13).
 *
 * Chunk framing, encryption and hashing run in the runtime process, at normal
 * priority on purpose (the runtime is never reniced). On a 4-core i5 that work
 * is about a quarter of the runtime's CPU and starves mpv. The user picks, per
 * computer, what uploads do while mpv plays:
 *
 *   full     - nothing changes
 *   throttle - at most {@link THROTTLE_MAX_CONCURRENCY} chunks in flight, and a
 *              short pause ({@link THROTTLE_PACING_MS}) before a slot takes its
 *              next chunk
 *   pause    - no new chunk starts; chunks already in flight finish
 *
 * The gate never stores "paused": it stores a LEASE. The desktop re-sends
 * `playbackActive: true` every few seconds while mpv is alive; when the
 * renewals stop (mpv crashed, the app died, the runtime restarted) the lease
 * runs out and uploads return to full by themselves. There is no state that
 * can stay stuck.
 *
 * Transcode ffmpegs follow the same decision (one core under `throttle`, frozen
 * under `pause`): the runtime subscribes `encodePlaybackGate`
 * (`@space/ffmpeg/playbackGate`) to this gate's effective policy, so there is
 * one lease and one source of truth.
 *
 * The pool owns the effect (AdaptivePool `gate` option); this module owns the
 * decision. Nothing here touches chunk data, so an upload can be neither lost
 * nor corrupted by a mode change: a chunk either has not started (it waits in
 * the queue) or runs to the end, and the per-chunk ledger in job_state.json
 * already makes a restart resume from the last finished chunk.
 */
import { scopeLogger } from "../logger";

const logger = scopeLogger("upload-playback");

export type UploadsDuringPlayback = "full" | "throttle" | "pause";

export const UPLOADS_DURING_PLAYBACK_MODES: readonly UploadsDuringPlayback[] = ["full", "throttle", "pause"];

export const isUploadsDuringPlayback = (value: unknown): value is UploadsDuringPlayback =>
  value === "full" || value === "throttle" || value === "pause";

/** Chunks in flight at once while playing in `throttle`. */
export const THROTTLE_MAX_CONCURRENCY = 2;
/** `throttle`: a slot waits this long after a finished chunk before it takes the next one. */
export const THROTTLE_PACING_MS = 250;
/** How long one `playbackActive: true` message keeps the policy in force. */
export const PLAYBACK_LEASE_MS_DEFAULT = 15_000;
/** Upper bound on a requested lease: a confused caller can never park uploads for long. */
export const PLAYBACK_LEASE_MS_MAX = 60_000;

export type UploadPlaybackGateUpdate = {
  mode: UploadsDuringPlayback;
  /** mpv is playing on this computer right now. Renewed by the desktop while it stays true. */
  playbackActive: boolean;
  leaseMs?: number;
};

export type UploadPlaybackGateState = {
  mode: UploadsDuringPlayback;
  playbackActive: boolean;
  /** What the pool applies now: `full` unless playback is active (and the lease is alive). */
  effective: UploadsDuringPlayback;
  leaseMs: number;
  /** Epoch ms the lease ends; null when playback is not active. */
  expiresAt: number | null;
};

export type UploadPlaybackGate = {
  update: (next: UploadPlaybackGateUpdate) => void;
  getState: () => UploadPlaybackGateState;
  /** Most chunks the pool may have in flight right now (Infinity = no limit, 0 = start nothing). */
  maxConcurrency: () => number;
  /** Delay a slot waits after a finished chunk before taking the next one. */
  pacingMs: () => number;
  /**
   * Called whenever the effective policy or `playbackActive` changes (a lease running out included), so a
   * listener also hears a video starting and ending in `full` mode (the preview catch-up, MPV-PREV-03, starts a
   * pass when the player closes). Returns an unsubscribe.
   */
  subscribe: (listener: () => void) => () => void;
};

export const createUploadPlaybackGate = (): UploadPlaybackGate => {
  let mode: UploadsDuringPlayback = "full";
  let expiresAt: number | null = null;
  let leaseMs = PLAYBACK_LEASE_MS_DEFAULT;
  let timer: NodeJS.Timeout | null = null;
  let lastEffective: UploadsDuringPlayback = "full";
  let lastActive = false;
  const listeners = new Set<() => void>();

  const isActive = () => expiresAt !== null && Date.now() < expiresAt;
  const effective = (): UploadsDuringPlayback => (isActive() ? mode : "full");

  const settle = (reason: string) => {
    const next = effective();
    const active = isActive();
    if (next === lastEffective && active === lastActive) return;
    if (next !== lastEffective) logger.info({ from: lastEffective, to: next, mode, reason }, "[upload-playback] effective upload policy changed");
    if (active !== lastActive) logger.info({ playbackActive: active, mode, reason }, "[upload-playback] playback active changed");
    lastEffective = next;
    lastActive = active;
    for (const listener of [...listeners]) listener();
  };

  const armExpiry = () => {
    clearTimeout(timer ?? undefined);
    timer = null;
    if (expiresAt === null) return;
    timer = setTimeout(() => {
      timer = null;
      if (expiresAt !== null && Date.now() >= expiresAt) {
        expiresAt = null;
        settle("lease-expired");
      }
    }, Math.max(0, expiresAt - Date.now()) + 1);
    // A pending expiry must never keep the runtime alive.
    timer.unref();
  };

  return {
    update: (next) => {
      mode = next.mode;
      const requested = next.leaseMs ?? PLAYBACK_LEASE_MS_DEFAULT;
      leaseMs = Math.min(PLAYBACK_LEASE_MS_MAX, requested);
      expiresAt = next.playbackActive && leaseMs > 0 ? Date.now() + leaseMs : null;
      armExpiry();
      settle(next.playbackActive ? "playback-active" : "playback-inactive");
    },
    getState: () => ({
      mode,
      playbackActive: isActive(),
      effective: effective(),
      leaseMs,
      expiresAt: isActive() ? expiresAt : null,
    }),
    maxConcurrency: () => {
      const policy = effective();
      if (policy === "pause") return 0;
      return policy === "throttle" ? THROTTLE_MAX_CONCURRENCY : Number.POSITIVE_INFINITY;
    },
    pacingMs: () => (effective() === "throttle" ? THROTTLE_PACING_MS : 0),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** The runtime's one gate: the desktop sets it (`badger.playback.set_upload_policy`), the ingest upload pool obeys it. */
export const uploadPlaybackGate: UploadPlaybackGate = createUploadPlaybackGate();

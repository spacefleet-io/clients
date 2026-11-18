/**
 * Desktop → runtime half of "uploads while a video plays" (#25, Chris 2026-10-13).
 *
 * The runtime does the pausing/throttling (content-core upload-playback-gate);
 * it only needs to know, at every moment, which mode this computer chose and
 * whether a video is playing. "A video is playing" = the external mpv process is
 * alive. That is deliberately NOT the playback-session release signal (a session
 * can leak); mpv's own lifetime cannot.
 *
 * Messages are LEASES: `playbackActive: true` expires in `leaseMs` unless renewed,
 * so if this app or mpv dies without saying goodbye the runtime goes back to full
 * speed by itself — uploads can never stay paused by accident. A runtime that was
 * restarted has no lease at all; the next heartbeat re-arms it.
 */
import type { UploadsDuringPlayback } from "../shared/uploadPlaybackDefault";

export type UploadPolicyMessage = {
  mode: UploadsDuringPlayback;
  playbackActive: boolean;
  leaseMs: number;
};

/** How often mpv's liveness is checked: the delay before a pause starts / ends. */
export const UPLOAD_POLICY_TICK_MS = 1_000;
/** Renewal period while a video plays. Must stay well below the lease. */
export const UPLOAD_POLICY_HEARTBEAT_MS = 5_000;
/** How long the runtime keeps honouring "a video is playing" without a renewal. */
export const UPLOAD_POLICY_LEASE_MS = 15_000;

export type UploadPlaybackPolicyOptions = {
  isMpvAlive: () => boolean;
  /** Resolves true when the runtime accepted the message; false (or a rejection) means "try again next tick". */
  send: (message: UploadPolicyMessage) => Promise<boolean>;
  mode: UploadsDuringPlayback;
  log: (line: string) => void;
};

export type UploadPlaybackPolicy = {
  start: () => void;
  /** Releases the pause (best effort) if a video was open, and stops the timers. */
  stop: () => Promise<void>;
  /** Settings change: sent immediately while a video plays; the next video picks it up otherwise. */
  setMode: (mode: UploadsDuringPlayback) => void;
};

export const createUploadPlaybackPolicy = (opts: UploadPlaybackPolicyOptions): UploadPlaybackPolicy => {
  const { log } = opts;
  let mode = opts.mode;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  /** What the runtime was last told successfully. */
  let confirmed: { mode: UploadsDuringPlayback; active: boolean; at: number } | null = null;
  let failing = false;

  const deliver = async (message: UploadPolicyMessage): Promise<void> => {
    inFlight = true;
    try {
      const ok = await opts.send(message).catch(() => false);
      if (ok) {
        if (failing) log(`[upload-playback] send recovered mode=${message.mode} active=${message.playbackActive}`);
        failing = false;
        confirmed = { mode: message.mode, active: message.playbackActive, at: Date.now() };
        return;
      }
      // Log the first failure of a streak only: the runtime may simply not be up yet.
      if (!failing) log(`[upload-playback] send failed mode=${message.mode} active=${message.playbackActive} — retrying every ${UPLOAD_POLICY_TICK_MS}ms`);
      failing = true;
    } finally {
      inFlight = false;
    }
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    const alive = opts.isMpvAlive();
    const wasActive = confirmed?.active ?? false;
    if (!alive) {
      // Nothing to release unless the runtime still believes a video plays.
      if (wasActive) await deliver({ mode, playbackActive: false, leaseMs: UPLOAD_POLICY_LEASE_MS });
      return;
    }
    const due = !wasActive || confirmed?.mode !== mode || Date.now() - (confirmed?.at ?? 0) >= UPLOAD_POLICY_HEARTBEAT_MS;
    if (due) await deliver({ mode, playbackActive: true, leaseMs: UPLOAD_POLICY_LEASE_MS });
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(() => void tick(), UPLOAD_POLICY_TICK_MS);
    // A pending tick must never keep the app alive.
    timer.unref();
  };

  const stop = async () => {
    clearInterval(timer ?? undefined);
    timer = null;
    if (confirmed?.active) await deliver({ mode, playbackActive: false, leaseMs: 0 });
  };

  const setMode = (next: UploadsDuringPlayback) => {
    if (next === mode) return;
    log(`[upload-playback] mode ${mode} -> ${next}`);
    mode = next;
    // While a video plays the runtime must hear it now, not at the next heartbeat.
    if (timer) void tick();
  };

  return { start, stop, setMode };
};

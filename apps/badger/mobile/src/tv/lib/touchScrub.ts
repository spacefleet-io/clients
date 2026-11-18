/**
 * Scrubbing with the Siri Remote's touch surface (UX-TV-01, Chris 2026-11-08): sliding a finger left / right moves a
 * pending target on the progress bar, further the faster the finger moves, while the video keeps playing; one seek
 * goes to the target once the finger has been off the surface for `SCRUB_COMMIT_WINDOW_MS` (several swipes in a row
 * add up), OK seeks at once, Back drops it. Pure: no React, no native module, time passed in, so every gesture is
 * unit-testable.
 *
 * Input: react-native-tvos sends `pan` events only after `TVEventControl.enableTVPanGesture()` (tvOS only;
 * `RCTTVRemoteHandler panned:`), body = the recogniser state ("Began" | "Changed" | "Ended" | "Cancelled" ...), `x` / `y`
 * = translation in root-view points since the gesture began, `velocityX` / `velocityY` in points per second.
 */
import type { RemoteEvent } from "./playerRemote";

/** Seconds per point of finger travel at rest speed (fine control: 200 points of slow travel ≈ 10 s). */
export const SCRUB_BASE_SECONDS_PER_POINT = 0.05;
/** Finger speed (points/s) at which the rate has doubled. */
export const SCRUB_VELOCITY_KNEE = 1500;
/** How sharply the rate grows past the knee: 2 = quadratic. */
export const SCRUB_VELOCITY_EXPONENT = 2;
/** Upper bound of the rate (48 × the base): one very fast full swipe ≈ one hour, never more. */
export const SCRUB_MAX_SECONDS_PER_POINT = 2.4;
/** Finger travel before the gesture's axis is decided: a tap or a ring click never scrubs. */
export const SCRUB_START_POINTS = 24;
/** Finger off the surface this long after the last scrubbing gesture: the seek goes. A new swipe sooner adds up. */
export const SCRUB_COMMIT_WINDOW_MS = 700;
/** A gesture with no event for this long (its end lost) is taken as ended. */
export const SCRUB_GESTURE_STALE_MS = 8000;
/** Below this many seconds between where the scrub started and its target, nothing is seeked. */
export const SCRUB_MIN_SEEK_SECONDS = 0.5;

/**
 * Seconds of film per point of finger travel at `speed` points/s:
 * `min(MAX, BASE × (1 + (|speed| / KNEE)^EXPONENT))` — smooth, monotonic, the base rate at rest.
 */
export const scrubSecondsPerPoint = (speed: number): number => {
  const v = Math.abs(speed);
  if (!Number.isFinite(v)) return SCRUB_BASE_SECONDS_PER_POINT;
  return Math.min(SCRUB_MAX_SECONDS_PER_POINT, SCRUB_BASE_SECONDS_PER_POINT * (1 + (v / SCRUB_VELOCITY_KNEE) ** SCRUB_VELOCITY_EXPONENT));
};

/** One tvOS pan event. */
export type Pan = { state: string; x: number; y: number; velocityX: number; velocityY: number };

const finiteOr = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** The pan of a `useTVEventHandler` event, or null for anything else (every Android TV event, keys, swipes). */
export const panFromEvent = (event: RemoteEvent | null | undefined): Pan | null => {
  if (!event || event.eventType !== "pan") return null;
  const body = event.body as { state?: unknown; x?: unknown; y?: unknown; velocityX?: unknown; velocityY?: unknown } | null | undefined;
  if (!body || typeof body.state !== "string") return null;
  if (typeof body.x !== "number" || typeof body.y !== "number" || !Number.isFinite(body.x) || !Number.isFinite(body.y)) return null;
  return { state: body.state, x: body.x, y: body.y, velocityX: finiteOr(body.velocityX, 0), velocityY: finiteOr(body.velocityY, 0) };
};

/** The finger's gesture in progress: its axis (decided after `SCRUB_START_POINTS`), where it started and last was. */
export type ScrubGesture = {
  axis: "undecided" | "horizontal" | "vertical" | "ignored";
  startX: number;
  startY: number;
  lastX: number;
  /** Time of the gesture's last event (ms). */
  at: number;
};

export type TouchScrub = {
  /** The pending target (s), null while no scrub is pending. */
  target: number | null;
  /** Where the pending scrub started (the playing position then, s). */
  origin: number;
  gesture: ScrubGesture | null;
  /** When the last gesture of the pending scrub ended (ms). */
  endedAt: number;
  /** Scrubbing gestures that ended in the pending scrub. */
  gestures: number;
};

export const IDLE_SCRUB: TouchScrub = { target: null, origin: 0, gesture: null, endedAt: 0, gestures: 0 };

/** What the screen is at the moment of a pan. */
export type ScrubEnv = {
  now: number;
  /** The playing position (s). */
  position: number;
  /** The progress bar's length (s); 0 = unknown, only the start clamps. */
  duration: number;
  /** Left / right jump here (`remoteScrubContext`): a horizontal pan scrubs. */
  canScrub: boolean;
};

export type ScrubEffect =
  /** A horizontal gesture took the scrub: a new one (`resumed` false) or one adding to the pending target. */
  | { type: "begin"; origin: number; target: number; resumed: boolean }
  | { type: "step"; dx: number; speed: number; secondsPerPoint: number; deltaSeconds: number; target: number }
  | { type: "gesture-end"; target: number; gestures: number }
  /** Seek to `target` now. */
  | { type: "commit"; target: number; origin: number }
  /** The scrub came back to where it started: nothing to seek. */
  | { type: "drop"; target: number; origin: number }
  /** Back: the pending scrub is dropped, no seek. */
  | { type: "cancel"; target: number; origin: number }
  | { type: "ignored"; reason: "vertical" | "context" | "tap" };

export type ScrubResult = { state: TouchScrub; effects: ScrubEffect[] };

const clampTarget = (seconds: number, duration: number): number => Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds);

/** The pending scrub ends: a seek to its target, or a drop when it came back to its start. */
const settle = (state: TouchScrub): ScrubEffect[] => {
  if (state.target === null) return [];
  const moved = Math.abs(state.target - state.origin) >= SCRUB_MIN_SEEK_SECONDS;
  return [{ type: moved ? "commit" : "drop", target: state.target, origin: state.origin }];
};

/** A scrub is pending, or a gesture is scrubbing: OK commits, Back cancels, left / right swipes are the scrub's. */
export const scrubPending = (state: TouchScrub): boolean => state.target !== null || state.gesture?.axis === "horizontal";

const move = (state: TouchScrub, gesture: ScrubGesture, pan: Pan, env: ScrubEnv, effects: ScrubEffect[]): TouchScrub => {
  const dx = pan.x - gesture.lastX;
  const next: ScrubGesture = { ...gesture, lastX: pan.x, at: env.now };
  if (dx === 0 || state.target === null) return { ...state, gesture: next };
  const speed = Math.abs(pan.velocityX);
  const secondsPerPoint = scrubSecondsPerPoint(speed);
  const deltaSeconds = dx * secondsPerPoint;
  const target = clampTarget(state.target + deltaSeconds, env.duration);
  effects.push({ type: "step", dx, speed, secondsPerPoint, deltaSeconds, target });
  return { ...state, target, gesture: next };
};

/** One pan event. */
export const scrubPan = (start: TouchScrub, pan: Pan, env: ScrubEnv): ScrubResult => {
  const effects: ScrubEffect[] = [];
  let state = start;

  if (pan.state === "Began" || !state.gesture) {
    // The finger left the surface long enough ago (the commit timer is late): that scrub is done, this one is new.
    if (!state.gesture && state.target !== null && env.now - state.endedAt >= SCRUB_COMMIT_WINDOW_MS) {
      effects.push(...settle(state));
      state = IDLE_SCRUB;
    }
    if (pan.state === "Ended" || pan.state === "Cancelled" || pan.state === "Failed") return { state, effects };
    // A move with no Began (event lost) starts from where the finger is, so it never jumps.
    const gesture: ScrubGesture = { axis: "undecided", startX: pan.x, startY: pan.y, lastX: pan.x, at: env.now };
    return { state: { ...state, gesture }, effects };
  }

  let gesture = state.gesture;
  if (gesture.axis === "undecided") {
    const dx = pan.x - gesture.startX;
    const dy = pan.y - gesture.startY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) >= SCRUB_START_POINTS) {
      if (Math.abs(dx) <= Math.abs(dy)) {
        gesture = { ...gesture, axis: "vertical" };
        effects.push({ type: "ignored", reason: "vertical" });
      } else if (!env.canScrub && state.target === null) {
        gesture = { ...gesture, axis: "ignored" };
        effects.push({ type: "ignored", reason: "context" });
      } else {
        gesture = { ...gesture, axis: "horizontal" };
        const resumed = state.target !== null;
        const origin = resumed ? state.origin : clampTarget(env.position, env.duration);
        const target = resumed ? (state.target as number) : origin;
        state = { ...state, origin, target };
        effects.push({ type: "begin", origin, target, resumed });
      }
    }
  }

  if (gesture.axis === "horizontal") state = move(state, gesture, pan, env, effects);
  else state = { ...state, gesture: { ...gesture, at: env.now } };

  if (pan.state === "Ended" || pan.state === "Cancelled" || pan.state === "Failed") {
    const ended = state.gesture as ScrubGesture;
    if (ended.axis === "horizontal" && state.target !== null) {
      const gestures = state.gestures + 1;
      state = { ...state, gesture: null, endedAt: env.now, gestures };
      effects.push({ type: "gesture-end", target: state.target as number, gestures });
    } else {
      if (ended.axis === "undecided") effects.push({ type: "ignored", reason: "tap" });
      // A tap or a vertical slide during a pending scrub holds it open a little longer, like a swipe.
      state = { ...state, gesture: null, endedAt: state.target !== null ? env.now : state.endedAt };
    }
  }
  return { state, effects };
};

/** Time passes: the window after the last gesture closed (seek), or a gesture's end never came (taken as ended). */
export const scrubTick = (state: TouchScrub, now: number): ScrubResult => {
  if (state.gesture) {
    if (now - state.gesture.at < SCRUB_GESTURE_STALE_MS) return { state, effects: [] };
    return { state: IDLE_SCRUB, effects: settle(state) };
  }
  if (state.target === null || now - state.endedAt < SCRUB_COMMIT_WINDOW_MS) return { state, effects: [] };
  return { state: IDLE_SCRUB, effects: settle(state) };
};

/** When the next `scrubTick` is due (ms from `now`), or null when nothing is pending. */
export const scrubTickDelay = (state: TouchScrub, now: number): number | null => {
  if (state.gesture) return state.target === null ? null : Math.max(0, state.gesture.at + SCRUB_GESTURE_STALE_MS - now);
  if (state.target === null) return null;
  return Math.max(0, state.endedAt + SCRUB_COMMIT_WINDOW_MS - now);
};

/** OK during a pending scrub: seek now. */
export const scrubSelect = (state: TouchScrub): ScrubResult => ({ state: IDLE_SCRUB, effects: settle(state) });

/** Back during a pending scrub: drop it, no seek. */
export const scrubCancel = (state: TouchScrub): ScrubResult =>
  state.target === null ? { state: IDLE_SCRUB, effects: [] } : { state: IDLE_SCRUB, effects: [{ type: "cancel", target: state.target, origin: state.origin }] };

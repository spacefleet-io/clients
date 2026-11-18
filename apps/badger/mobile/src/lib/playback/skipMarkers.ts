/**
 * Skip-intro / skip-credits / next-episode pill logic.
 *
 * Port of `packages/mpv/resources/osc/sf.lua` (`current_pill_action` + the
 * auto-skip block of `refresh_pill`) so mobile behaves like desktop:
 *   - intro marker active        -> "Skip intro"   (seek to marker end)
 *   - credits marker active      -> "Next episode" when a next episode exists, else "Skip credits"
 *   - no credits marker          -> end-of-media fallback "Next episode" in the last 15 s
 *   - auto-skip: 5 s of *media time* (pause freezes it) after the marker is entered
 *     naturally; entering mid-marker (resume / seek into it) suppresses auto-skip.
 */

export type SkipMarkerLike = {
  type: "intro" | "credits";
  startSeconds: number;
  endSeconds: number;
};

export type PillKind = "skip_intro" | "skip_credits" | "next_episode";

export type PillLabelKey =
  | "player.skip.intro"
  | "player.skip.credits"
  | "player.skip.nextEpisode"
  | "player.skip.nextEpisodeStartsIn";

export type PillAction = {
  kind: PillKind;
  /** i18n key of the pill text; translated at render so a language change applies immediately. */
  labelKey: PillLabelKey;
  /** Stable identity of the marker (or synthetic end-of-media key) used for auto-skip bookkeeping. */
  key: string;
  /** Where "skip" seeks to; null for next_episode. */
  seekToSeconds: number | null;
  autoSkip: boolean;
  /** Seconds shown in the pill ("5"), null when no countdown is running. */
  countdown: number | null;
  endOfMediaFallback: boolean;
};

export type PillConfig = {
  markers: SkipMarkerLike[];
  hasNextEpisode: boolean;
  autoplayNextEpisode: boolean;
  autoSkipIntro: boolean;
  autoSkipCredits: boolean;
  fallbackCountdownSeconds?: number;
};

export const AUTO_SKIP_DELAY_SECONDS = 5;
export const FALLBACK_COUNTDOWN_SECONDS = 15;
export const END_OF_MEDIA_KEY = "end-of-media";

export const markerKey = (marker: SkipMarkerLike) =>
  `${Math.floor(marker.startSeconds * 1000)}-${Math.floor(marker.endSeconds * 1000)}-${marker.type}`;

export const findActiveMarker = (timePos: number, markers: SkipMarkerLike[]): SkipMarkerLike | null => {
  if (!Number.isFinite(timePos)) return null;
  for (const marker of markers) {
    if (timePos >= marker.startSeconds && timePos < marker.endSeconds) return marker;
  }
  return null;
};

/** Mirrors sf.lua `current_pill_action`. */
export const selectPillAction = (timePos: number, duration: number, config: PillConfig): PillAction | null => {
  const fallbackSeconds = config.fallbackCountdownSeconds ?? FALLBACK_COUNTDOWN_SECONDS;
  const marker = findActiveMarker(timePos, config.markers);
  if (marker) {
    const markerRemaining = Math.max(0, marker.endSeconds - timePos);
    if (marker.type === "intro") {
      return {
        kind: "skip_intro",
        labelKey: "player.skip.intro",
        key: markerKey(marker),
        seekToSeconds: marker.endSeconds,
        autoSkip: config.autoSkipIntro,
        countdown: markerRemaining,
        endOfMediaFallback: false,
      };
    }
    if (config.hasNextEpisode) {
      const remaining = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - timePos) : null;
      const showCountdown = config.autoplayNextEpisode && remaining !== null && remaining <= fallbackSeconds;
      return {
        kind: "next_episode",
        labelKey: "player.skip.nextEpisode",
        key: markerKey(marker),
        seekToSeconds: null,
        // Starting an episode is autoplay: with it off, the pill stays a tap target (PLAY-NEXT-01).
        autoSkip: config.autoSkipCredits && config.autoplayNextEpisode,
        countdown: showCountdown ? remaining : null,
        endOfMediaFallback: false,
      };
    }
    return {
      kind: "skip_credits",
      labelKey: "player.skip.credits",
      key: markerKey(marker),
      seekToSeconds: marker.endSeconds,
      autoSkip: config.autoSkipCredits,
      countdown: markerRemaining,
      endOfMediaFallback: false,
    };
  }
  if (config.hasNextEpisode && Number.isFinite(duration) && duration > fallbackSeconds) {
    const remaining = Math.max(0, duration - timePos);
    if (remaining <= fallbackSeconds) {
      return {
        kind: "next_episode",
        labelKey: "player.skip.nextEpisode",
        key: END_OF_MEDIA_KEY,
        seekToSeconds: null,
        autoSkip: config.autoSkipCredits && config.autoplayNextEpisode,
        countdown: config.autoplayNextEpisode ? remaining : null,
        endOfMediaFallback: true,
      };
    }
  }
  return null;
};

export type AutoSkipState = {
  /** key -> media seconds elapsed since the marker was naturally entered */
  elapsed: Record<string, number>;
  fired: Record<string, true>;
  suppressed: Record<string, true>;
  lastTimePos: number | null;
};

export const createAutoSkipState = (): AutoSkipState => ({
  elapsed: {},
  fired: {},
  suppressed: {},
  lastTimePos: null,
});

export type AutoSkipStep = {
  action: PillAction | null;
  /** True exactly once per activation, when the 5 s pre-roll has elapsed while playing. */
  fire: boolean;
};

/**
 * Advance the auto-skip state machine by one observation. Mutates `state`.
 * `boundaryOf` for the end-of-media fallback is `duration - fallbackCountdownSeconds`.
 */
export const stepAutoSkip = (
  state: AutoSkipState,
  input: { timePos: number; duration: number; paused: boolean },
  config: PillConfig,
): AutoSkipStep => {
  const { timePos, duration, paused } = input;
  const fallbackSeconds = config.fallbackCountdownSeconds ?? FALLBACK_COUNTDOWN_SECONDS;
  const base = selectPillAction(timePos, duration, config);
  const last = state.lastTimePos;
  // Media-time delta: forward, small steps only (a seek is not elapsed pre-roll).
  const delta = last !== null && timePos >= last && timePos - last <= 2 ? timePos - last : 0;
  state.lastTimePos = Number.isFinite(timePos) ? timePos : null;
  if (!base || !base.autoSkip) return { action: base, fire: false };

  const key = base.key;
  if (!state.fired[key] && state.elapsed[key] === undefined && !state.suppressed[key]) {
    const marker = base.endOfMediaFallback ? null : findActiveMarker(timePos, config.markers);
    const boundary = marker ? marker.startSeconds : duration - fallbackSeconds;
    // Natural entry = small forward step across the boundary; a seek that jumps into the marker is not.
    const crossedNaturally = last !== null && last < boundary && timePos >= last && timePos - last <= 3;
    if (!crossedNaturally) state.suppressed[key] = true;
  }
  if (state.fired[key] || state.suppressed[key]) return { action: base, fire: false };

  const elapsed = state.elapsed[key] === undefined ? 0 : state.elapsed[key] + (paused ? 0 : delta);
  state.elapsed[key] = elapsed;
  const action: PillAction = {
    ...base,
    countdown: Math.max(0, AUTO_SKIP_DELAY_SECONDS - elapsed),
    labelKey: base.kind === "next_episode" ? "player.skip.nextEpisodeStartsIn" : base.labelKey,
  };
  if (!paused && elapsed >= AUTO_SKIP_DELAY_SECONDS - 1e-6) {
    state.fired[key] = true;
    return { action, fire: true };
  }
  return { action, fire: false };
};

/** User dismissed or manually acted on the pill: never auto-fire it afterwards. */
export const suppressAutoSkip = (state: AutoSkipState, key: string) => {
  state.suppressed[key] = true;
};

/** Reset on a new file / seek-back far outside the marker is NOT needed: keys stay fired. New file => new state. */

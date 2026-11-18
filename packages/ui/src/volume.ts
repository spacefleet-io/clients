import { useCallback, useEffect, useState } from "react";

/** The player's own volume, 0..1, and whether it is muted. Muting keeps the level so unmuting restores it. */
export type VolumeState = { volume: number; muted: boolean };

/** One wheel notch or arrow key moves the volume by 5 %. */
export const VOLUME_STEP = 0.05;
/** Unmuting a control whose level was dragged to 0 brings it back to this level, so unmute is never silent. */
export const VOLUME_UNMUTE_FALLBACK = 0.5;
export const DEFAULT_VOLUME: VolumeState = { volume: 1, muted: false };

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Rounds to whole percent so repeated 5 % steps never drift (0.1 + 0.2 ≠ 0.3). */
export function stepVolume(volume: number, steps: number): number {
  return clampVolume(Math.round((volume + steps * VOLUME_STEP) * 100) / 100);
}

/** Which speaker icon to show: crossed out when muted or at 0, one wave below half, two waves from half up. */
export function volumeLevel({ volume, muted }: VolumeState): "muted" | "low" | "high" {
  if (muted || volume <= 0) return "muted";
  return volume < 0.5 ? "low" : "high";
}

/** Wheel up (negative deltaY) raises the volume one step, wheel down lowers it; a pure sideways scroll does nothing. */
export function wheelSteps(deltaY: number): number {
  if (deltaY < 0) return 1;
  if (deltaY > 0) return -1;
  return 0;
}

/**
 * What the audio element actually plays at: the user's level times the loudness-levelling gain
 * (PAR-PLAY-03, 1 when levelling is off or not measured yet). The levelling never rewrites the
 * audio; both only scale the player's own output, capped at full scale.
 */
export function effectiveVolume({ volume, muted }: VolumeState, levellingGain = 1): number {
  if (muted) return 0;
  return clampVolume(volume * levellingGain);
}

/** Moving the slider to a level above 0 unmutes; dragging it to 0 is the same as muting. */
export function setVolumeLevel(state: VolumeState, next: number): VolumeState {
  const volume = clampVolume(next);
  return { volume, muted: volume === 0 ? state.muted : false };
}

export function toggleMuted(state: VolumeState): VolumeState {
  if (state.muted || state.volume === 0) return { volume: state.volume > 0 ? state.volume : VOLUME_UNMUTE_FALLBACK, muted: false };
  return { ...state, muted: true };
}

/** Reads a saved level; anything missing or malformed falls back to full volume, unmuted. */
export function parseVolumeState(raw: string | null): VolumeState {
  if (!raw) return DEFAULT_VOLUME;
  try {
    const parsed = JSON.parse(raw) as Partial<VolumeState>;
    if (typeof parsed.volume !== "number" || !Number.isFinite(parsed.volume)) return DEFAULT_VOLUME;
    return { volume: clampVolume(parsed.volume), muted: parsed.muted === true };
  } catch {
    return DEFAULT_VOLUME;
  }
}

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The player volume, remembered on this device across restarts under `storageKey` (the app's own
 * local storage: an Electron app's profile folder, a browser's site storage). Never synced.
 */
export function usePersistedVolume(storageKey: string, storage: KeyValueStorage | null = browserStorage()) {
  const [state, setState] = useState<VolumeState>(() => parseVolumeState(storage?.getItem(storageKey) ?? null));

  useEffect(() => {
    try {
      storage?.setItem(storageKey, JSON.stringify(state));
    } catch {
      // A full or blocked storage only loses the remembered level; playback goes on.
    }
  }, [storage, storageKey, state]);

  const setVolume = useCallback((next: number) => setState((current) => setVolumeLevel(current, next)), []);
  const toggleMute = useCallback(() => setState(toggleMuted), []);
  return { ...state, setVolume, toggleMute };
}

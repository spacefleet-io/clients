/**
 * The cast screen's volume (UX-TV-03): the level of the device that plays the film (the TV), not the phone's. Pure parts
 * of the cast hook: when a reading of the device may overwrite what the user just set, and how AirPlay, which has no mute
 * of its own here, mutes.
 */
import { clampLevel } from "@space/mobile-media-volume/level";

/** After the user moves the bar or mutes, readings of the device are ignored this long: they may predate the change. */
export const VOLUME_SETTLE_MS = 1500;

export const followsDeviceVolume = (lastLocalChangeAt: number, now: number): boolean => now - lastLocalChangeAt >= VOLUME_SETTLE_MS;

/**
 * AirPlay mute: the route's volume goes to 0 and the level before it is kept, so unmuting brings it back. Unmuting a
 * route that was at 0 before the mute (or whose level is unknown) gives a quiet, audible level rather than silence.
 */
export const AIRPLAY_UNMUTE_FALLBACK = 0.3;

export const airPlayMuteLevel = (muted: boolean, current: number, remembered: number | null): { level: number; remembered: number | null } =>
  muted
    ? { level: 0, remembered: current > 0 ? clampLevel(current) : remembered }
    : { level: remembered && remembered > 0 ? clampLevel(remembered) : AIRPLAY_UNMUTE_FALLBACK, remembered: null };

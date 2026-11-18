/**
 * Loudness for "Even out volume" on the desktop (PAR-PLAY-03 item 2; off by default): songs whose file carries no
 * ReplayGain tag are measured here, from their decoded audio, once after import, and the values are kept in the library
 * so every device can even them once the user turns the setting on. A song played before the pass reached it is
 * measured from the player's own decode and evened at once. The pass reads each song from its own address beside the
 * player's (`measureUrl`), so it neither picks copies nor fills the player's chunk cache (PAR-PLAY-02).
 */
import { useSyncExternalStore } from "react";
import { measureParrotLoudness, type ParrotLoudness } from "@space/parrot-core";
import { GAPLESS_MAX_DECODED_MS } from "@space/parrot-core/gapless";
import type { ParrotLibraryTrack } from "@space/parrot-ingest";
import type { ParrotLibrary, ParrotMeasuredLoudness } from "../../shared/ipc";

/** Measured values wait this long so a batch of songs is kept in one publish. */
const SAVE_AFTER_MS = 30_000;
const SAVE_BATCH = 200;

type Decoded = { numberOfChannels: number; sampleRate: number; getChannelData: (channel: number) => Float32Array };

const measured = new Map<string, { gainDb: number; peak: number }>();
const failed = new Set<string>();
const pending: ParrotMeasuredLoudness[] = [];
const listeners = new Set<() => void>();
let version = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let onSaved: ((library: ParrotLibrary) => void) | null = null;

const notify = () => {
  version += 1;
  for (const listener of listeners) listener();
};

const save = async () => {
  clearTimeout(saveTimer ?? undefined);
  saveTimer = null;
  const batch = pending.splice(0);
  if (batch.length === 0) return;
  const result = await window.parrot.saveLoudness(batch).catch((error: unknown) => ({ ok: false as const, error: String(error) }));
  if (result.ok) {
    console.info(`[loudness] kept ${batch.length} song(s)`);
    onSaved?.(result.library);
  } else {
    // The library may be reloading (an import publishing): try again later with whatever else was measured meanwhile.
    console.warn(`[loudness] could not keep ${batch.length} song(s) yet: ${result.error}`);
    pending.unshift(...batch);
    saveTimer ??= setTimeout(() => void save(), SAVE_AFTER_MS);
  }
};

const scheduleSave = () => {
  if (pending.length >= SAVE_BATCH) void save();
  else saveTimer ??= setTimeout(() => void save(), SAVE_AFTER_MS);
};

/** Measures decoded audio and remembers the value for this song; null when it is too short to measure. */
export const measureDecodedLoudness = (trackId: string, decoded: Decoded): { gainDb: number; peak: number } | null => {
  const known = measured.get(trackId);
  if (known) return known;
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
  const value = measureParrotLoudness(channels, decoded.sampleRate);
  if (!value) {
    failed.add(trackId);
    return null;
  }
  const entry = { gainDb: value.gainDb, peak: value.peak };
  console.info(`[loudness] song ${trackId}: ${value.lufs.toFixed(2)} LUFS, gain ${value.gainDb.toFixed(2)} dB, peak ${value.peak.toFixed(4)}`);
  measured.set(trackId, entry);
  pending.push({ trackId, ...entry });
  scheduleSave();
  notify();
  return entry;
};

/** The song with what was measured here this session laid over its library row (a queue keeps the rows it started with). */
export const withMeasuredLoudness = <T extends ParrotLoudness & { id: string }>(track: T): T => {
  if (track.gainDb !== null) return track;
  const value = measured.get(track.id);
  return value ? { ...track, ...value } : track;
};

/** Re-renders when a song gets measured. */
export const useMeasuredLoudness = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version
  );

const needsMeasuring = (track: ParrotLibraryTrack) =>
  !!track.fileId && track.gainDb === null && !measured.has(track.id) && !failed.has(track.id) && (track.durationMs ?? 0) <= GAPLESS_MAX_DECODED_MS;

/**
 * Measures, one at a time in the background, every song of the library that has no loudness yet. Returns a stop
 * function; a later call with the refreshed library carries on where this one stopped.
 */
export const startLoudnessPass = (tracks: readonly ParrotLibraryTrack[], saved: (library: ParrotLibrary) => void): (() => void) => {
  onSaved = saved;
  const todo = tracks.filter(needsMeasuring);
  let stopped = false;
  if (todo.length === 0) return () => undefined;
  console.info(`[loudness] measuring ${todo.length} song(s) in the background`);
  void (async () => {
    // One decoder for the pass; decoded audio keeps its channels, resampled to this rate.
    const context = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: 48000 });
    for (const track of todo) {
      if (stopped) return;
      if (!needsMeasuring(track)) continue;
      try {
        const url = await window.parrot.measureUrl(track.fileId!);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const decoded = await context.decodeAudioData(await response.arrayBuffer());
        if (!stopped) measureDecodedLoudness(track.id, decoded);
      } catch (error) {
        failed.add(track.id);
        console.warn(`[loudness] song ${track.id} could not be measured: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Leave the renderer room between songs.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!stopped) await save();
  })();
  return () => {
    stopped = true;
  };
};

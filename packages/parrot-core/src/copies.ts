// Which stored copy of a song plays (PAR-PLAY-02, PAR-PLAY-04): the original while the connection keeps up with it,
// else the next lighter copy that does, down to the light copy (PAR-FMT-02). Every Parrot player (desktop, phone) asks
// this once per song, when the song starts loading, never in the middle of it. The throughput estimate and its margins
// are Badger's automatic quality's (PLAY-ABR-01/02, @space/playback-abr).
import { blendBps, SAFETY_FACTOR, UPSHIFT_HEADROOM } from "@space/playback-abr";
import { pickPlayableFile, type TrackFileRow } from "./catalog";

/** The light copy every song gets at import (PAR-FMT-02): Opus at 64 kbps in an Ogg file. */
export const PARROT_LIGHT_COPY = {
  codec: "opus",
  container: "ogg",
  mime: "audio/ogg; codecs=opus",
  bitrateKbps: 64,
  sampleRate: 48_000,
  /**
   * Songs up to this length get their light copy automatically on every computer; longer ones only on a computer the
   * shared hardware rule calls strong (`@space/shared/transcodeHardware`), as Badger's copies (Chris 2026-11-11:
   * "on parrot all songs get autotranscoding, but above 90min they only get it automatically if the hardware allows it").
   */
  autoMaxDurationMs: 90 * 60_000,
} as const;

/** Downloads shorter than this say more about latency than about the connection's speed: not measured. */
export const MIN_THROUGHPUT_SAMPLE_BYTES = 64 * 1024;

/** A file's bitrate: its stored one, else its size over the song's length; null when neither is known. */
export const copyBitrateKbps = (file: Pick<TrackFileRow, "bitrateKbps" | "sizeBytes">, durationMs: number | null): number | null => {
  if (file.bitrateKbps && file.bitrateKbps > 0) return file.bitrateKbps;
  if (durationMs && durationMs > 0 && file.sizeBytes > 0) return (file.sizeBytes * 8) / durationMs;
  return null;
};

/**
 * A song's copies from best to lightest: the originals and the copies the user set up, best first as
 * `pickPlayableFile` ranks them, then the light copies. `canPlay` leaves out what the player cannot decode.
 */
export const parrotCopyLadder = <T extends TrackFileRow>(files: T[], canPlay: (mime: string) => boolean = () => true): T[] => {
  const ladder: T[] = [];
  let pool = files.filter((file) => canPlay(file.mime));
  for (;;) {
    // pickPlayableFile ranks the originals and set-up copies before any light copy.
    const next = pickPlayableFile(pool);
    if (!next) return ladder;
    ladder.push(next);
    pool = pool.filter((file) => file !== next);
  }
};

/**
 * Picks the copy of one song from the measured speed (bits/s, null before anything was measured): the best copy the
 * connection keeps up with, with Badger's safety margin. A copy heavier than the one picked for the previous song
 * also needs Badger's climb headroom, so the choice does not flap from song to song. Nothing measured yet: the original
 * (PAR-PLAY-02 starts on it). Nothing keeps up: the lightest copy.
 */
export const chooseParrotCopy = <T extends TrackFileRow>(input: {
  files: T[];
  durationMs: number | null;
  throughputBps: number | null;
  /** The bitrate (kbps) of the copy the previous song played; null at the first song. */
  previousKbps: number | null;
  canPlay?: (mime: string) => boolean;
}): T | null => {
  const ladder = parrotCopyLadder(input.files, input.canPlay);
  if (ladder.length === 0) return null;
  const bps = input.throughputBps;
  if (bps === null || bps <= 0) return ladder[0]!;
  const usable = bps * SAFETY_FACTOR;
  for (const file of ladder) {
    const kbps = copyBitrateKbps(file, input.durationMs);
    // A copy of unknown weight is taken as fitting: the light copy below it always has a known one.
    if (kbps === null) return file;
    const climbing = input.previousKbps !== null && kbps > input.previousKbps;
    if (usable >= kbps * 1000 * (climbing ? UPSHIFT_HEADROOM : 1)) return file;
  }
  return ladder[ladder.length - 1]!;
};

export type ParrotCopyPicker = {
  /** One downloaded chunk: `bytes` arrived in `ms` milliseconds. Copies read from the device are not reported. */
  record: (bytes: number, ms: number) => void;
  /** The copy the next song plays (see `chooseParrotCopy`); remembers it for the song after. */
  pick: <T extends TrackFileRow>(files: T[], durationMs: number | null, canPlay?: (mime: string) => boolean) => T | null;
  /**
   * The copy `pick` would give now, without remembering it: for songs queued ahead of their turn, whose copy `pick`
   * settles when the song before them starts (one song ahead, so the gapless player can ready it).
   */
  peek: <T extends TrackFileRow>(files: T[], durationMs: number | null, canPlay?: (mime: string) => boolean) => T | null;
  /** The current speed estimate in bits/s, null before the first measured download. */
  throughputBps: () => number | null;
  /** Forget the estimate and the last choice (sign-out, a new account). */
  reset: () => void;
};

/**
 * The per-player state of `chooseParrotCopy`: the speed estimate (Badger's blend), the newest download's speed and the
 * last copy's bitrate. The choice uses the lower of the blend and the newest download: a drop shows at the next song,
 * before the player freezes (PLAY-ABR-01), while a climb waits for the blend to catch up, with Badger's headroom.
 */
export const createParrotCopyPicker = (log?: (message: string) => void): ParrotCopyPicker => {
  let estimate = 0;
  let newest = 0;
  let previousKbps: number | null = null;
  const measured = () => (estimate > 0 ? Math.min(estimate, newest) : null);
  return {
    record: (bytes, ms) => {
      if (bytes < MIN_THROUGHPUT_SAMPLE_BYTES || !(ms > 0)) return;
      newest = (bytes * 8 * 1000) / ms;
      estimate = blendBps(estimate, newest);
    },
    pick: (files, durationMs, canPlay) => {
      const throughputBps = measured();
      const chosen = chooseParrotCopy({ files, durationMs, throughputBps, previousKbps, canPlay });
      if (chosen) {
        const kbps = copyBitrateKbps(chosen, durationMs);
        log?.(
          `[parrot-copy] ${chosen.trackId}: ${chosen.lightCopy ? "light copy" : "original"} ${chosen.id} ` +
            `(${kbps === null ? "?" : Math.round(kbps)} kbps), ${throughputBps === null ? "speed not measured yet" : `${Math.round(throughputBps / 1000)} kbps measured`}`
        );
        previousKbps = kbps;
      }
      return chosen;
    },
    peek: (files, durationMs, canPlay) => chooseParrotCopy({ files, durationMs, throughputBps: measured(), previousKbps, canPlay }),
    throughputBps: () => (estimate > 0 ? estimate : null),
    reset: () => {
      estimate = 0;
      newest = 0;
      previousKbps = null;
    },
  };
};

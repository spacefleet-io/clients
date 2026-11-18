/**
 * Even out volume (PAR-PLAY-03 item 2), shared by every Parrot player: a setting, off by default (songs then play as
 * recorded). On, it copies Spotify's loudness normalization: each song (or, for an album played in order, the whole
 * album) is brought to the level the user picked, Loud −11, Normal −14 or Quiet −19 LUFS (ITU-R BS.1770 integrated
 * loudness). Normal and Quiet lift a quiet song only as far as its true peak leaves 1 dB of headroom; Loud lifts it all
 * the way and a limiter keeps the peaks at −1 dB (`./limiter`). The player turns its own volume by that gain; the file
 * is never rewritten.
 *
 * A song's loudness is measured once, at import, and stored as ReplayGain 2.0 values (the gain to −18 LUFS and its
 * peak), read from the file's own ReplayGain tags when it has them; the gain to a level is derived from that.
 */
import type { PlayQueue } from "./queue";

/** ReplayGain 2.0's reference loudness, in LUFS: the stored gains bring a song to it. */
export const PARROT_REFERENCE_LUFS = -18;

export type ParrotEvenVolumeLevel = "loud" | "normal" | "quiet";

/** The user's "Even out volume" setting: off by default; the level picked under the switch (Normal by default). */
export type ParrotEvenVolume = { on: boolean; level: ParrotEvenVolumeLevel };

export const PARROT_EVEN_VOLUME_DEFAULT: ParrotEvenVolume = { on: false, level: "normal" };

export const PARROT_EVEN_VOLUME_LEVELS: readonly ParrotEvenVolumeLevel[] = ["loud", "normal", "quiet"];

/** Spotify's three targets, in LUFS. */
export const PARROT_EVEN_VOLUME_TARGET_LUFS: Record<ParrotEvenVolumeLevel, number> = { loud: -11, normal: -14, quiet: -19 };

/** Normal and Quiet lift a song only while its true peak stays this far under full scale, in dB. */
export const PARROT_EVEN_VOLUME_HEADROOM_DB = 1;

/** Where the setting is kept on a device, per account. */
export const parrotEvenVolumeStorageKey = (userId: string) => `parrot.evenVolume.${userId}`;

/** The stored setting; anything unreadable is the default (off, Normal). */
export const parseParrotEvenVolume = (raw: string | null | undefined): ParrotEvenVolume => {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return PARROT_EVEN_VOLUME_DEFAULT;
    const { on, level } = value as Partial<ParrotEvenVolume>;
    return {
      on: on === true,
      level: PARROT_EVEN_VOLUME_LEVELS.includes(level as ParrotEvenVolumeLevel) ? (level as ParrotEvenVolumeLevel) : PARROT_EVEN_VOLUME_DEFAULT.level,
    };
  } catch {
    return PARROT_EVEN_VOLUME_DEFAULT;
  }
};

/** Whether the limiter runs: only for Loud, which lifts songs past their peaks. */
export const parrotEvenVolumeLimits = (setting: ParrotEvenVolume): boolean => setting.on && setting.level === "loud";

/** What a song carries for even volume; null when it was not measured (it then plays as recorded). */
export type ParrotLoudness = {
  /** The song's gain to the reference (−18 LUFS), in dB. */
  gainDb: number | null;
  /** The song's peak, linear (1 = full scale): true peak when Parrot measured it, the tag's value otherwise. */
  peak: number | null;
  /** The album's gain from the file's own ReplayGain album tag, when it has one. */
  albumGainDb?: number | null;
  albumPeak?: number | null;
};

export type ParrotLoudnessTrack = ParrotLoudness & { id: string; albumId: string; disc: number; number: number | null; durationMs: number | null };

export type ParrotLoudnessMode = "album" | "track";

// ITU-R BS.1770-4 K-weighting as two biquads, derived for any sample rate (the constants are libebur128's).
const biquads = (rate: number) => {
  const shelfGain = 3.99984385397;
  const shelfQ = 0.7071752369554193;
  const shelfK = Math.tan((Math.PI * 1681.9744509555319) / rate);
  const vh = 10 ** (shelfGain / 20);
  const vb = vh ** 0.499666774155;
  const shelfA0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  const passQ = 0.5003270373253953;
  const passK = Math.tan((Math.PI * 38.13547087613982) / rate);
  const passA0 = 1 + passK / passQ + passK * passK;
  return [
    {
      b: [(vh + (vb * shelfK) / shelfQ + shelfK * shelfK) / shelfA0, (2 * (shelfK * shelfK - vh)) / shelfA0, (vh - (vb * shelfK) / shelfQ + shelfK * shelfK) / shelfA0],
      a: [(2 * (shelfK * shelfK - 1)) / shelfA0, (1 - shelfK / shelfQ + shelfK * shelfK) / shelfA0],
    },
    { b: [1, -2, 1], a: [(2 * (passK * passK - 1)) / passA0, (1 - passK / passQ + passK * passK) / passA0] },
  ] as const;
};

// BS.1770-4 Annex 2 true peak: the signal oversampled 4× (below 96 kHz) by a 48-tap windowed-sinc interpolator, as
// four 12-tap phases.
const TRUE_PEAK_FACTOR = 4;
const TRUE_PEAK_TAPS = 12;
const TRUE_PEAK_PHASES: readonly Float64Array[] = (() => {
  const length = TRUE_PEAK_FACTOR * TRUE_PEAK_TAPS;
  const centre = (length - 1) / 2;
  return Array.from({ length: TRUE_PEAK_FACTOR }, (_, phase) => {
    const taps = new Float64Array(TRUE_PEAK_TAPS);
    for (let k = 0; k < TRUE_PEAK_TAPS; k += 1) {
      const n = k * TRUE_PEAK_FACTOR + phase;
      const x = (n - centre) / TRUE_PEAK_FACTOR;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * (n + 0.5)) / length);
      taps[k] = sinc * window;
    }
    return taps;
  });
})();

/**
 * The true peak of one channel whose sample peak is `samplePeak`. A value between samples can only go over the sample
 * peak next to loud samples, so only the stretches around samples above half the sample peak are oversampled.
 */
const truePeak = (samples: Float32Array, samplePeak: number, sampleRate: number): number => {
  if (sampleRate >= 96000 || samplePeak === 0) return samplePeak;
  const floor = samplePeak / 2;
  let peak = samplePeak;
  const reach = TRUE_PEAK_TAPS / 2;
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index]!) < floor) continue;
    // Every interpolated point within `reach` samples of this loud one.
    const last = Math.min(samples.length - 1, index + reach);
    for (let at = Math.max(TRUE_PEAK_TAPS - 1, index); at <= last; at += 1) {
      for (const taps of TRUE_PEAK_PHASES) {
        let sum = 0;
        for (let k = 0; k < TRUE_PEAK_TAPS; k += 1) sum += samples[at - k]! * taps[k]!;
        const magnitude = Math.abs(sum);
        if (magnitude > peak) peak = magnitude;
      }
    }
    index = last;
  }
  return peak;
};

/**
 * Measures decoded audio: integrated loudness (BS.1770-4: K-weighting, 400 ms blocks every 100 ms, the −70 LUFS
 * absolute gate and the −10 LU relative gate) and true peak (linear). Null for silence or audio shorter than one block.
 */
export const measureParrotLoudness = (channels: readonly Float32Array[], sampleRate: number): { lufs: number; gainDb: number; peak: number } | null => {
  const length = channels[0]?.length ?? 0;
  const block = Math.round(sampleRate * 0.4);
  const step = Math.round(sampleRate * 0.1);
  if (length < block) return null;
  const filters = biquads(sampleRate);
  const steps = Math.floor(length / step);
  // Sum of squares of the weighted signal per 100 ms step, all channels summed (weights 1: up to three front channels;
  // surround ones would be 1.41, Parrot keeps stereo).
  const energy = new Float64Array(steps);
  let peak = 0;
  channels.forEach((samples, channel) => {
    const weight = channel >= 3 ? 1.41 : 1;
    const state = filters.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
    let channelPeak = 0;
    for (let index = 0; index < steps * step; index += 1) {
      let value = samples[index]!;
      const magnitude = Math.abs(value);
      if (magnitude > channelPeak) channelPeak = magnitude;
      for (let stage = 0; stage < filters.length; stage += 1) {
        const { b, a } = filters[stage]!;
        const s = state[stage]!;
        const out = b[0] * value + b[1] * s.x1 + b[2] * s.x2 - a[0] * s.y1 - a[1] * s.y2;
        s.x2 = s.x1;
        s.x1 = value;
        s.y2 = s.y1;
        s.y1 = out;
        value = out;
      }
      energy[Math.floor(index / step)] += weight * value * value;
    }
    peak = Math.max(peak, truePeak(samples, channelPeak, sampleRate));
  });
  const perBlock = block / step;
  const blocks: number[] = [];
  for (let first = 0; first + perBlock <= steps; first += 1) {
    let sum = 0;
    for (let index = first; index < first + perBlock; index += 1) sum += energy[index]!;
    blocks.push(sum / block);
  }
  const loudness = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const absolute = blocks.filter((z) => z > 0 && loudness(z) > -70);
  if (absolute.length === 0) return null;
  const relativeGate = loudness(mean(absolute)) - 10;
  const gated = absolute.filter((z) => loudness(z) > relativeGate);
  const lufs = loudness(mean(gated));
  return { lufs, gainDb: PARROT_REFERENCE_LUFS - lufs, peak };
};

/**
 * Each album's value from its songs: the file's own album tag when every song has the same one, else the songs'
 * measured loudness averaged as power, weighted by length (an album measured as one long song). Only for albums whose
 * every song has a value.
 */
export const parrotAlbumLoudness = (tracks: readonly ParrotLoudnessTrack[]): Map<string, { gainDb: number; peak: number }> => {
  const byAlbum = new Map<string, ParrotLoudnessTrack[]>();
  for (const track of tracks) byAlbum.set(track.albumId, [...(byAlbum.get(track.albumId) ?? []), track]);
  const albums = new Map<string, { gainDb: number; peak: number }>();
  for (const [albumId, songs] of byAlbum) {
    const tagged = songs[0]?.albumGainDb;
    if (typeof tagged === "number" && songs.every((song) => song.albumGainDb === tagged)) {
      albums.set(albumId, { gainDb: tagged, peak: Math.max(...songs.map((song) => song.albumPeak ?? song.peak ?? 0)) });
      continue;
    }
    if (!songs.every((song) => typeof song.gainDb === "number")) continue;
    let power = 0;
    let weight = 0;
    for (const song of songs) {
      const seconds = Math.max(1, (song.durationMs ?? 1000) / 1000);
      power += seconds * 10 ** ((PARROT_REFERENCE_LUFS - song.gainDb!) / 10);
      weight += seconds;
    }
    albums.set(albumId, { gainDb: PARROT_REFERENCE_LUFS - 10 * Math.log10(power / weight), peak: Math.max(...songs.map((song) => song.peak ?? 0)) });
  }
  return albums;
};

/** Album mode when shuffle is off and the queue is one album's songs in album order; track mode otherwise. */
export const parrotLoudnessMode = <T extends Pick<ParrotLoudnessTrack, "albumId" | "disc" | "number">>(queue: Pick<PlayQueue<T>, "shuffle"> & { entries: readonly { track: T }[] }): ParrotLoudnessMode => {
  const songs = queue.entries.map((entry) => entry.track);
  if (queue.shuffle || songs.length === 0) return "track";
  const albumId = songs[0]!.albumId;
  const order = (song: T) => song.disc * 10_000 + (song.number ?? 0);
  const inOrder = songs.every((song, index) => song.albumId === albumId && (index === 0 || order(song) > order(songs[index - 1]!)));
  return inOrder ? "album" : "track";
};

/**
 * The gain the player applies to a song, in dB: 0 (as recorded) while the setting is off or the song has no value.
 * On, the album's or the song's loudness by `mode` is brought to the level's target. Normal and Quiet lift a song only
 * as far as its peak stays 1 dB under full scale (a song with no known peak is not lifted); Loud lifts it all the way.
 */
export const parrotPlaybackGainDb = (
  track: ParrotLoudness & { albumId: string },
  mode: ParrotLoudnessMode,
  albums: ReadonlyMap<string, { gainDb: number; peak: number }>,
  setting: ParrotEvenVolume
): number => {
  if (!setting.on) return 0;
  const album = mode === "album" ? albums.get(track.albumId) : undefined;
  const storedGainDb = album?.gainDb ?? track.gainDb;
  if (typeof storedGainDb !== "number") return 0;
  const lufs = PARROT_REFERENCE_LUFS - storedGainDb;
  const gainDb = PARROT_EVEN_VOLUME_TARGET_LUFS[setting.level] - lufs;
  if (setting.level === "loud" || gainDb <= 0) return gainDb;
  const peak = album ? album.peak : track.peak;
  const headroomDb = typeof peak === "number" && peak > 0 ? -PARROT_EVEN_VOLUME_HEADROOM_DB - 20 * Math.log10(peak) : 0;
  return Math.min(gainDb, Math.max(0, headroomDb));
};

/**
 * Every song's gain in a queue, by id: album values when the queue is one album in order with shuffle off, track
 * values otherwise; all 0 while the setting is off. For players that hold their own queue (the phone's Media3 service).
 */
export const parrotQueueGainsDb = (
  tracks: readonly (Omit<ParrotLoudnessTrack, "gainDb" | "peak"> & { gainDb?: number | null; peak?: number | null })[],
  shuffle: boolean,
  setting: ParrotEvenVolume
): Record<string, number> => {
  const songs = tracks.map((track) => ({ ...track, gainDb: track.gainDb ?? null, peak: track.peak ?? null }));
  const mode = parrotLoudnessMode({ entries: songs.map((track) => ({ track })), shuffle });
  const albums = parrotAlbumLoudness(songs);
  return Object.fromEntries(songs.map((track) => [track.id, parrotPlaybackGainDb(track, mode, albums, setting)]));
};

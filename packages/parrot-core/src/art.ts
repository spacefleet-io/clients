/**
 * Parrot's drawn pictures (PAR-LOOK-01), pure data so the browser apps and the React Native phone app draw the same
 * thing: the album art shown while an album has no cover of its own, and the waveform of the seek bar. Both come from
 * a seed (the album or song id), so one album always gets the same picture on every device.
 * Colours are `hsl(h, s%, l%)` strings, which both CSS and React Native read.
 */

export type ParrotCoverMotif = "sun" | "stripes" | "rings" | "horizon";

export type ParrotCoverArt = {
  /** Gradient start (top left) and end (bottom right). */
  from: string;
  to: string;
  motif: ParrotCoverMotif;
  /** The motif's own colour: the sun, the rings, the horizon's light. */
  light: string;
};

/** The mockup's cover hues: teal, copper, indigo, violet, blue, gold, green, magenta, crimson. */
const HUES = [195, 18, 238, 272, 222, 40, 135, 300, 352] as const;
const MOTIFS: readonly ParrotCoverMotif[] = ["sun", "stripes", "rings", "horizon"];

/** FNV-1a: a small stable hash, the same in every JavaScript engine. */
export const parrotSeedHash = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const hsl = (h: number, s: number, l: number) => `hsl(${((h % 360) + 360) % 360}, ${s}%, ${l}%)`;

export const parrotCoverArt = (seed: string): ParrotCoverArt => {
  const hash = parrotSeedHash(seed);
  const hue = HUES[hash % HUES.length]!;
  const motif = MOTIFS[(hash >>> 8) % MOTIFS.length]!;
  return {
    from: hsl(hue, 58, 46),
    to: hsl(hue + 22, 52, 26),
    motif,
    light: hsl(hue - 18, 72, 80),
  };
};

/** Park-Miller, as the mockup's generator: deterministic from the seed. */
const random = (seed: number) => {
  let state = (seed % 2147483646) + 1;
  return () => ((state = (state * 16807) % 2147483647) - 1) / 2147483646;
};

/**
 * Bar heights between 0.12 and 1 for the waveform seek bar, the mockup's shape (two slow sines plus a little noise).
 * It is a drawing, not the song's measured loudness.
 */
export const parrotWaveBars = (seed: string, count: number): number[] => {
  const next = random(parrotSeedHash(seed));
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = 0.28 + 0.72 * Math.abs(Math.sin(i * 0.37) * 0.6 + Math.sin(i * 0.11 + 1) * 0.3 + (next() - 0.5) * 0.35);
    bars.push(Math.max(0.12, Math.min(1, v)));
  }
  return bars;
};

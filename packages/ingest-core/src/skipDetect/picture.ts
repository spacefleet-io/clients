/**
 * Picture signature of an episode's two ends, and the picture side of skip detection (META-SKIP-04).
 *
 * The seek-bar preview pass also writes small grey frames (160x90, 4 per second) of the head window (the first
 * quarter of the episode, at most 10 min) and the tail window (the last 10 min). Each frame keeps a 64-bit
 * difference hash and three flags: busy (not a flat picture), dark (almost all black), textdark (light text on
 * black: credits). Two episodes' frames that stay near-equal for a run of seconds are shared footage: in the head,
 * the intro; in the tail, repeated end cards. The credits start where the final block of credit-like frames
 * (dark, text on dark, repeated, or flat) begins.
 *
 * Port of the SkipDetectTest picture benchmark (`vb.py`: `features`, `pair_runs`, `consensus`, `analyse`).
 */
import { runSteps, runStepsYielding } from "./cooperative";

/** Frames per second of the picture windows. */
export const SKIP_PICTURE_FPS = 4;
export const SKIP_PICTURE_WIDTH = 160;
export const SKIP_PICTURE_HEIGHT = 90;
/** Longest head and tail windows, seconds. */
export const SKIP_PICTURE_WINDOW_SECONDS = 600;

const FLAG_BUSY = 1;
const FLAG_DARK = 2;
const FLAG_TEXTDARK = 4;

/** One window of frames: hashes as (lo, hi) uint32 pairs, one flags byte per frame. */
export type SkipPictureWindow = {
  offsetSeconds: number;
  hashes: Uint32Array;
  flags: Uint8Array;
};

export type SkipEpisodePicture = {
  id: string;
  season: number;
  episode: number;
  durationSeconds: number;
  head: SkipPictureWindow;
  tail: SkipPictureWindow;
};

/** The stored form: base64 of the little-endian hash words and of the flag bytes. */
export type SkipPictureWindowPayload = { offsetSeconds: number; hashes: string; flags: string };
export type SkipPicturePayload = { fps: number; head: SkipPictureWindowPayload; tail: SkipPictureWindowPayload };

/** Head window length: the first quarter of the episode, at most 10 min. */
export const skipPictureHeadSeconds = (durationSeconds: number) =>
  Math.min(durationSeconds * 0.25, SKIP_PICTURE_WINDOW_SECONDS);
/** Tail window start: 10 min before the end (0 for a shorter episode). */
export const skipPictureTailOffset = (durationSeconds: number) => Math.max(0, durationSeconds - SKIP_PICTURE_WINDOW_SECONDS);

/**
 * Hash and flags of one 160x90 grey frame. The hash compares neighbouring cells of an 8x9 grid of 11x17-pixel cell
 * sums (the top-left 153x88 pixels).
 */
export const skipPictureFrame = (gray: Uint8Array): { lo: number; hi: number; flags: number } => {
  const W = SKIP_PICTURE_WIDTH;
  const grid = new Float64Array(72);
  for (let r = 0; r < 8; r++) {
    for (let y = r * 11; y < r * 11 + 11; y++) {
      const row = y * W;
      for (let c = 0; c < 9; c++) {
        let sum = 0;
        for (let x = c * 17, end = c * 17 + 17; x < end; x++) sum += gray[row + x]!;
        grid[r * 9 + c] = grid[r * 9 + c]! + sum;
      }
    }
  }
  let lo = 0;
  let hi = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (grid[r * 9 + c + 1]! > grid[r * 9 + c]!) {
        const bit = r * 8 + c;
        if (bit < 32) lo |= 1 << bit;
        else hi |= 1 << (bit - 32);
      }
    }
  }
  let mean = 0;
  for (const v of grid) mean += v;
  mean /= 72;
  let variance = 0;
  for (const v of grid) variance += (v - mean) ** 2;
  const busy = Math.sqrt(variance / 72) / 187 > 6;
  let darkCount = 0;
  let brightCount = 0;
  const pixels = W * SKIP_PICTURE_HEIGHT;
  for (let i = 0; i < pixels; i++) {
    const v = gray[i]!;
    if (v < 40) darkCount++;
    else if (v > 110) brightCount++;
  }
  const darkFrac = darkCount / pixels;
  const bright = brightCount / pixels;
  const dark = darkFrac > 0.97;
  const textdark = darkFrac > 0.85 && bright > 0.0005 && bright < 0.12;
  return { lo: lo >>> 0, hi: hi >>> 0, flags: (busy ? FLAG_BUSY : 0) | (dark ? FLAG_DARK : 0) | (textdark ? FLAG_TEXTDARK : 0) };
};

/** A window from its frames, in order (frame k is at `offsetSeconds + k / SKIP_PICTURE_FPS`). */
export const buildSkipPictureWindow = (offsetSeconds: number, frames: Iterable<Uint8Array>): SkipPictureWindow => {
  const hashes: number[] = [];
  const flags: number[] = [];
  for (const gray of frames) {
    const frame = skipPictureFrame(gray);
    hashes.push(frame.lo, frame.hi);
    flags.push(frame.flags);
  }
  return { offsetSeconds, hashes: Uint32Array.from(hashes), flags: Uint8Array.from(flags) };
};

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

export const skipPictureWindowToPayload = (window: SkipPictureWindow): SkipPictureWindowPayload => ({
  offsetSeconds: window.offsetSeconds,
  hashes: toBase64(new Uint8Array(window.hashes.buffer, window.hashes.byteOffset, window.hashes.byteLength)),
  flags: toBase64(window.flags),
});

const windowFromPayload = (raw: unknown): SkipPictureWindow | null => {
  if (!raw || typeof raw !== "object") return null;
  const { offsetSeconds, hashes, flags } = raw as Partial<SkipPictureWindowPayload>;
  if (typeof offsetSeconds !== "number" || typeof hashes !== "string" || typeof flags !== "string") return null;
  const hashBytes = Buffer.from(hashes, "base64");
  const flagBytes = Buffer.from(flags, "base64");
  if (hashBytes.byteLength !== flagBytes.byteLength * 8) return null;
  const words = new Uint32Array(hashBytes.byteLength / 4);
  for (let i = 0; i < words.length; i++) words[i] = hashBytes.readUInt32LE(i * 4);
  return { offsetSeconds, hashes: words, flags: new Uint8Array(flagBytes) };
};

export const skipEpisodePictureFromPayload = (
  episode: { id: string; season: number; episode: number },
  durationSeconds: number,
  raw: unknown
): SkipEpisodePicture | null => {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Partial<SkipPicturePayload>;
  if (payload.fps !== SKIP_PICTURE_FPS) return null;
  const head = windowFromPayload(payload.head);
  const tail = windowFromPayload(payload.tail);
  if (!head || !tail) return null;
  return { ...episode, durationSeconds, head, tail };
};

const popcount = (value: number) => {
  let v = value >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

type Seg = [number, number];

/**
 * Longest run of near-equal busy frames along one alignment of two windows (frames `[0, na)` of `a`, `[0, nb)` of
 * `b`). Returns both runs in seconds relative to each window's start, or null.
 */
export const skipPicturePairRuns = (
  a: SkipPictureWindow,
  na: number,
  b: SkipPictureWindow,
  nb: number,
  opts: { maxDistance?: number; gapSeconds: number; minSeconds: number; maxSeconds: number }
): [Seg, Seg] | null => {
  const step = 1 / SKIP_PICTURE_FPS;
  const T = opts.maxDistance ?? 10;
  const gap = Math.max(1, Math.round(opts.gapSeconds / step));
  const minCount = Math.max(2, Math.trunc((opts.minSeconds / step) * 0.4));
  let best: { length: number; i0: number; j0: number; frames: number } | null = null;
  const hits: number[] = [];
  // Diagonal k: frame i of a against frame i + k of b.
  for (let k = -(na - 1); k <= nb - 1; k++) {
    hits.length = 0;
    const iStart = Math.max(0, -k);
    const iEnd = Math.min(na, nb - k);
    for (let i = iStart; i < iEnd; i++) {
      const j = i + k;
      if (!(a.flags[i]! & FLAG_BUSY) || !(b.flags[j]! & FLAG_BUSY)) continue;
      const d = popcount(a.hashes[2 * i]! ^ b.hashes[2 * j]!) + popcount(a.hashes[2 * i + 1]! ^ b.hashes[2 * j + 1]!);
      if (d <= T) hits.push(i);
    }
    if (hits.length < minCount) continue;
    // Runs of hits with holes up to `gap` frames; keep this diagonal's longest (first on ties).
    let runStart = hits[0]!;
    let bestStart = runStart;
    let bestSpan = -1;
    for (let h = 1; h <= hits.length; h++) {
      if (h === hits.length || hits[h]! - hits[h - 1]! > gap) {
        const span = hits[h - 1]! - runStart;
        if (span > bestSpan) {
          bestSpan = span;
          bestStart = runStart;
        }
        if (h < hits.length) runStart = hits[h]!;
      }
    }
    const length = (bestSpan + 1) * step;
    if (length < opts.minSeconds || length > opts.maxSeconds) continue;
    if (!best || length > best.length) best = { length, i0: bestStart, j0: bestStart + k, frames: bestSpan + 1 };
  }
  if (!best) return null;
  return [
    [best.i0 * step, (best.i0 + best.frames) * step],
    [best.j0 * step, (best.j0 + best.frames) * step],
  ];
};

/** The run most others agree with (within `tol` seconds at both ends; longest on ties), as medians of its members. */
export const skipPictureConsensus = (segs: Seg[], tol = 2.5): { start: number; end: number; support: number } | null => {
  if (segs.length === 0) return null;
  const near = (s: Seg, t: Seg) => Math.abs(t[0] - s[0]) <= tol && Math.abs(t[1] - s[1]) <= tol;
  let chosen = segs[0]!;
  let chosenScore = -1;
  let chosenLength = -Infinity;
  for (const s of segs) {
    const score = segs.filter((t) => near(s, t)).length;
    const length = s[1] - s[0];
    if (score > chosenScore || (score === chosenScore && length > chosenLength)) {
      chosen = s;
      chosenScore = score;
      chosenLength = length;
    }
  }
  const members = segs.filter((t) => near(chosen, t));
  return { start: median(members.map((t) => t[0])), end: median(members.map((t) => t[1])), support: members.length };
};

const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export type SkipPictureResult = {
  /** The shared head footage (absolute seconds), with how many partners agree and how many were compared. */
  intro: { start: number; end: number; support: number; compared: number } | null;
  /** Where the final block of credit-like frames starts (absolute seconds). */
  credits: number | null;
};

/** Partners compared per episode: the nearest episodes of the same season, else of the show. */
export const SKIP_PICTURE_MAX_PARTNERS = 8;

const partnersOf = (ep: SkipEpisodePicture, eps: SkipEpisodePicture[]) => {
  const same = eps.filter((o) => o.season === ep.season && o.id !== ep.id);
  const pool = same.length ? same : eps.filter((o) => o.id !== ep.id);
  const rank = (o: SkipEpisodePicture) => Math.abs(o.season - ep.season) * 10_000 + Math.abs(o.episode - ep.episode);
  return [...pool].sort((x, y) => rank(x) - rank(y)).slice(0, SKIP_PICTURE_MAX_PARTNERS);
};

/**
 * The picture side of detection for every episode given (at least two needed; a lone episode gets nothing).
 */
export const detectSkipPicture = (episodes: SkipEpisodePicture[]): Map<string, SkipPictureResult> =>
  runSteps(detectSkipPictureSteps(episodes));

/** `detectSkipPicture` giving the event loop a turn between episode pairs (MPV-PREV-07). Same result. */
export const detectSkipPictureAsync = (episodes: SkipEpisodePicture[]): Promise<Map<string, SkipPictureResult>> =>
  runStepsYielding(detectSkipPictureSteps(episodes));

function* detectSkipPictureSteps(episodes: SkipEpisodePicture[]): Generator<void, Map<string, SkipPictureResult>, void> {
  const out = new Map<string, SkipPictureResult>();
  if (episodes.length < 2) return out;
  const step = 1 / SKIP_PICTURE_FPS;
  const introSegs = new Map<string, Seg[]>(episodes.map((ep) => [ep.id, []]));
  const tailRepeats = new Map<string, Seg[]>(episodes.map((ep) => [ep.id, []]));
  const compared = new Map<string, number>(episodes.map((ep) => [ep.id, 0]));
  const done = new Set<string>();
  const headFrames = (ep: SkipEpisodePicture) =>
    Math.min(ep.head.flags.length, Math.trunc(skipPictureHeadSeconds(ep.durationSeconds) / step));
  for (const a of episodes) {
    for (const b of partnersOf(a, episodes)) {
      const key = a.id < b.id ? `${a.id}\u0000${b.id}` : `${b.id}\u0000${a.id}`;
      if (done.has(key)) continue;
      done.add(key);
      compared.set(a.id, compared.get(a.id)! + 1);
      compared.set(b.id, compared.get(b.id)! + 1);
      const intro = skipPicturePairRuns(a.head, headFrames(a), b.head, headFrames(b), {
        gapSeconds: 2,
        minSeconds: 8,
        maxSeconds: 130,
      });
      if (intro) {
        introSegs.get(a.id)!.push(shift(intro[0], a.head.offsetSeconds));
        introSegs.get(b.id)!.push(shift(intro[1], b.head.offsetSeconds));
      }
      const tail = skipPicturePairRuns(a.tail, a.tail.flags.length, b.tail, b.tail.flags.length, {
        gapSeconds: 1,
        minSeconds: 1.5,
        maxSeconds: 600,
      });
      if (tail) {
        tailRepeats.get(a.id)!.push(shift(tail[0], a.tail.offsetSeconds));
        tailRepeats.get(b.id)!.push(shift(tail[1], b.tail.offsetSeconds));
      }
      yield;
    }
  }
  for (const ep of episodes) {
    const agreed = skipPictureConsensus(introSegs.get(ep.id)!);
    const credits = creditsStart(ep.tail, tailRepeats.get(ep.id)!);
    out.set(ep.id, {
      intro: agreed
        ? {
            ...agreed,
            start: round3(Math.max(0, agreed.start - SKIP_PICTURE_EDGE_SHIFT)),
            end: round3(agreed.end - SKIP_PICTURE_EDGE_SHIFT),
            compared: compared.get(ep.id)!,
          }
        : null,
      credits: credits === null ? null : round3(credits - SKIP_PICTURE_EDGE_SHIFT),
    });
  }
  return out;
}

/**
 * A frame sampled at 4 fps first shows a cut about 0.4 s after it happens (measured on every intro and credits
 * edge of Parks and Recreation S02E01-E06, all late by 0.06-0.48 s); edges move back by that much.
 */
export const SKIP_PICTURE_EDGE_SHIFT = 0.4;

/** Walk back from the end over credit-like frames (tolerating 1 s of others): the final block's start, or null. */
const creditsStart = (tail: SkipPictureWindow, repeats: Seg[]): number | null => {
  const step = 1 / SKIP_PICTURE_FPS;
  const n = tail.flags.length;
  const at = (i: number) => tail.offsetSeconds + i * step;
  const repeated = (i: number) => repeats.some(([s, e]) => at(i) >= s - step / 2 && at(i) < e + step / 2);
  const tol = Math.max(1, Math.round(1 / step));
  let start: number | null = null;
  let miss = 0;
  for (let i = n - 1; i >= 0; i--) {
    const f = tail.flags[i]!;
    if (f & (FLAG_DARK | FLAG_TEXTDARK) || !(f & FLAG_BUSY) || repeated(i)) {
      start = i;
      miss = 0;
    } else if (++miss > tol) break;
  }
  if (start === null || (n - start) * step < 4) return null;
  for (let i = start; i < n; i++) {
    if (tail.flags[i]! & (FLAG_DARK | FLAG_TEXTDARK) || repeated(i)) return round3(at(start));
  }
  return null;
};

const shift = (seg: Seg, offset: number): Seg => [seg[0] + offset, seg[1] + offset];
const round3 = (value: number) => Math.round(value * 1000) / 1000;

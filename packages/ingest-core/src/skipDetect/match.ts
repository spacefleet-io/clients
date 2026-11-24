/**
 * Shared-audio intro and credits detection (META-SKIP-04).
 *
 * A port of the SkipDetectTest benchmark detector (`skip-detect-test/bench/det.py`), itself a port of Jellyfin's
 * Intro Skipper matching (ConfusedPolarBear/intro-skipper, GPL-3.0): two episodes of one show are compared by their
 * Chromaprint sub-fingerprints; a long stretch of near-identical audio found in both, at any time shift, is the
 * shared intro (head of the file) or the shared credits (tail). Every number below is the benchmark's tuned value
 * (Chris 2026-11-23/24, chat, skip UX, via Main): intros `{pool:"season+show", padIn:2}` (1.0 % wrong, 86 %
 * coverage on 10 held-out shows), credits `{pool:"season+show", select:"consensus", padIn:6, gateFrac:0.25}`.
 *
 * Pure: the caller decodes the audio and fingerprints it (`analyzeSkipAudio` in audio.ts,
 * `chromaprintRaw`) and stores the result per episode, so adding one episode re-matches the show without decoding
 * the others again.
 */
import { CHROMAPRINT_ITEM_SECONDS } from "./chromaprint";
import { runSteps, runStepsYielding } from "./cooperative";

const SD = CHROMAPRINT_ITEM_SECONDS;

export type SkipDetectMode = "intro" | "credits";

export type SkipDetectParams = {
  /** Sub-fingerprints match when they differ by at most this many bits. */
  maxDiff: number;
  /** A run of matches survives gaps up to this many seconds. */
  maxSkip: number;
  /** Fingerprint values within ±shift (integer distance) seed candidate time shifts. */
  shift: number;
  minIntro: number;
  maxIntro: number;
  minCredits: number;
  maxCredits: number;
  /** Two runs are joined when the shorter is at least bridgeMin s and the gap at most bridgeGap times it. */
  bridgeMin: number;
  bridgeGap: number;
  /** A segment starting within this many seconds of the window start starts at 0. */
  snap: number;
  /** Credits: segments within mergeGap s before/after the best one are merged into it. */
  mergeGap: number;
  /** The intro is searched in the first introPct of the episode, at most introLimit s. */
  introPct: number;
  introLimit: number;
  /** End snapped to the first silence (>= 0.33 s at -50 dB) starting in [end-5, end+2]. */
  silence: boolean;
  /** "first_pair": Intro Skipper's loop; "consensus": the largest cluster of partner segments, median bounds. */
  select: "first_pair" | "consensus";
  /** Partners: "season", "show", or "season+show" (other seasons only when the season has no other episode). */
  pool: "season" | "show" | "season+show";
  /** Partner segments within agreeTol s on both bounds agree. */
  agreeTol: number;
  /** Kept (confident) when at least gateSupport partners agree, and at least gateFrac of the compared ones. */
  gateSupport: number;
  gateFrac: number;
  gateMinLen: number;
  gateMaxStart: number | null;
  /** Start the skip this much later / end it this much earlier (theme audio often overlaps the story). */
  padIn: number;
  padOut: number;
};

export const SKIP_DETECT_BASE_PARAMS: SkipDetectParams = {
  maxDiff: 6,
  maxSkip: 3.5,
  shift: 2,
  minIntro: 15,
  maxIntro: 120,
  minCredits: 15,
  maxCredits: 450,
  bridgeMin: 8,
  bridgeGap: 0.5,
  snap: 5,
  mergeGap: 20,
  introPct: 0.25,
  introLimit: 600,
  silence: true,
  select: "first_pair",
  pool: "season",
  agreeTol: 3,
  gateSupport: 1,
  gateFrac: 0,
  gateMinLen: 0,
  gateMaxStart: null,
  padIn: 0,
  padOut: 0,
};

/** The tuned intro parameters (SkipDetectTest winner). */
export const SKIP_DETECT_INTRO_PARAMS: SkipDetectParams = { ...SKIP_DETECT_BASE_PARAMS, pool: "season+show", padIn: 2 };

/** The tuned credits parameters (safe set: credits are only offered, never skipped by themselves). */
export const SKIP_DETECT_CREDITS_PARAMS: SkipDetectParams = {
  ...SKIP_DETECT_BASE_PARAMS,
  pool: "season+show",
  select: "consensus",
  padIn: 6,
  gateFrac: 0.25,
};

/** One episode's stored analysis: fingerprints of the first and last ~10 min and the silences found in them. */
export type SkipEpisodeAudio = {
  id: string;
  season: number;
  episode: number;
  durationSeconds: number;
  /** Fingerprint of the audio from 0 s. */
  head: Uint32Array;
  /** Fingerprint of the audio from `tailOffsetSeconds`. */
  tail: Uint32Array;
  tailOffsetSeconds: number;
  /** Silences (>= 0.33 s below -50 dBFS) in the head and tail windows, absolute seconds, sorted. */
  silences: Array<[number, number]>;
};

export type SkipDetectResult =
  | { found: false; support: 0; compared: number; confident: false }
  | {
      found: true;
      /** Skip bounds after snapping and padding. */
      start: number;
      end: number;
      /** The matched shared audio before snapping and padding (a user's fix is stored relative to it). */
      rawStart: number;
      rawEnd: number;
      partner: string | null;
      support: number;
      compared: number;
      confident: boolean;
    };

type Seg = [number, number];
type Pair = [Seg, Seg];

const popcount = (value: number) => {
  let v = value >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/** Fingerprint value -> last index (Python dict semantics: insertion order of first sight, value overwritten). */
const invIndex = (fp: Uint32Array) => {
  const index = new Map<number, number>();
  for (let i = 0; i < fp.length; i++) index.set(fp[i]!, i);
  return index;
};

/** Longest of runs ordered by (length, -start); the first wins a tie, as Python's max. */
const longest = <T>(items: T[], len: (item: T) => number, start: (item: T) => number): number => {
  let best = 0;
  for (let i = 1; i < items.length; i++) {
    const a = items[i]!;
    const b = items[best]!;
    if (len(a) > len(b) || (len(a) === len(b) && start(a) < start(b))) best = i;
  }
  return best;
};

const snappedLength = (P: SkipDetectParams, s: number, e: number) => e - (s <= P.snap ? 0 : s);

const findContiguous = (
  P: SkipDetectParams,
  lhs: Uint32Array,
  rhs: Uint32Array,
  shift: number,
  mode: SkipDetectMode,
  maxdur: number
): Pair | null => {
  const lo = shift < 0 ? -shift : 0;
  const ro = shift > 0 ? shift : 0;
  const n = Math.min(lhs.length - lo, rhs.length - ro);
  if (n <= 0) return null;
  const runs: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    if (popcount(lhs[lo + k]! ^ rhs[ro + k]!) > P.maxDiff) continue;
    const p = k + lo;
    const last = runs[runs.length - 1];
    if (last && (p - last[1]) * SD <= P.maxSkip) last[1] = p;
    else runs.push([p, p]);
  }
  if (runs.length === 0) return null;
  const ps = ro - lo;
  let joined = true;
  while (joined) {
    joined = false;
    let i = 0;
    while (i + 1 < runs.length) {
      const a = runs[i]!;
      const b = runs[i + 1]!;
      const shorter = Math.min(a[1] - a[0], b[1] - b[0]) * SD;
      if (
        shorter >= P.bridgeMin &&
        (b[0] - a[1]) * SD <= shorter * P.bridgeGap &&
        Math.max(snappedLength(P, a[0] * SD, b[1] * SD), snappedLength(P, (a[0] + ps) * SD, (b[1] + ps) * SD)) <= maxdur
      ) {
        runs[i] = [a[0], b[1]];
        runs.splice(i + 1, 1);
        joined = true;
      }
      i++;
    }
  }
  const [bs, be] = runs[longest(runs, (r) => r[1] - r[0], (r) => r[0])]!;
  if ((be - bs) * SD < (mode === "credits" ? P.minCredits : P.minIntro)) return null;
  return [
    [bs * SD, be * SD],
    [(bs + ps) * SD, (be + ps) * SD],
  ];
};

const compare = (
  P: SkipDetectParams,
  lfp: Uint32Array,
  rfp: Uint32Array,
  mode: SkipDetectMode,
  maxdur: number
): Pair | null => {
  const lidx = invIndex(lfp);
  const ridx = invIndex(rfp);
  const shiftSet = new Set<number>();
  for (const [p, lp] of lidx) {
    for (let k = -P.shift; k <= P.shift; k++) {
      const rp = ridx.get((p + k) >>> 0);
      if (rp !== undefined) shiftSet.add(rp - lp);
    }
  }
  // Python iterates a set of ints in hash order; ascending order only changes which of two equal-length,
  // equal-start pairs wins.
  const shifts = [...shiftSet].sort((a, b) => a - b);
  const pairs: Pair[] = [];
  for (const s of shifts) {
    const r = findContiguous(P, lfp, rfp, s, mode, maxdur);
    if (r) pairs.push(r);
  }
  if (pairs.length === 0) return null;
  const sel = longest(pairs, (p) => p[0][1] - p[0][0], (p) => p[0][0]);
  let [[ls, le], [rs, re]] = pairs[sel]!;
  if (mode === "credits") {
    const [seedL, seedR] = pairs[sel]!;
    const others = pairs
      .map((_, i) => i)
      .filter((i) => i !== sel)
      .sort((a, b) => {
        const la = pairs[a]![0][1] - pairs[a]![0][0];
        const lb = pairs[b]![0][1] - pairs[b]![0][0];
        return lb - la || pairs[a]![0][0] - pairs[b]![0][0];
      });
    let joined = true;
    while (joined) {
      joined = false;
      for (const i of [...others]) {
        const [[ol, oe], [orr, ore]] = pairs[i]!;
        const g = P.mergeGap;
        const before = ol < seedL[0] && orr < seedR[0] && ls <= oe + g && rs <= ore + g;
        const after = oe > seedL[1] && ore > seedR[1] && ol <= le + g && orr <= re + g;
        if (!before && !after) continue;
        const jl: Seg = [Math.min(ls, ol), Math.max(le, oe)];
        const jr: Seg = [Math.min(rs, orr), Math.max(re, ore)];
        if (Math.max(snappedLength(P, jl[0], jl[1]), snappedLength(P, jr[0], jr[1])) <= maxdur) {
          [ls, le] = jl;
          [rs, re] = jr;
          others.splice(others.indexOf(i), 1);
          joined = true;
        }
      }
    }
  }
  if (ls <= P.snap) ls = 0;
  if (rs <= P.snap) rs = 0;
  return [
    [ls, le],
    [rs, re],
  ];
};

/** The part of an episode's fingerprint searched in `mode`, and the time of its first item. */
const searchWindow = (P: SkipDetectParams, ep: SkipEpisodeAudio, mode: SkipDetectMode): [Uint32Array, number] => {
  const dur = ep.durationSeconds;
  if (mode === "intro") {
    const end = Math.min(dur >= 300 ? dur * P.introPct : dur, P.introLimit);
    return [ep.head.subarray(0, Math.trunc(end / SD)), 0];
  }
  const cstart = Math.max(0, dur - P.maxCredits);
  const k = Math.max(0, Math.round((cstart - ep.tailOffsetSeconds) / SD));
  return [ep.tail.subarray(k), ep.tailOffsetSeconds + k * SD];
};

/** End snapped to the first silence of at least 0.33 s that starts in [end-5, end+2] (ffmpeg silencedetect's view). */
const snapToSilence = (ep: SkipEpisodeAudio, end: number) => {
  const r0 = end - 5;
  const r1 = Math.min(ep.durationSeconds, end + 2);
  for (const [a, b] of ep.silences) {
    const start = Math.max(a, Math.max(0, r0));
    const stop = Math.min(b, r1);
    if (stop - start >= 0.33 && r0 <= start && start <= r1) return start;
  }
  return end;
};

const adjust = (P: SkipDetectParams, ep: SkipEpisodeAudio, seg: Seg): Seg => {
  const dur = ep.durationSeconds;
  let [s, e] = seg;
  if (s <= 2) s = 0;
  if (e >= dur - 2) e = dur;
  else if (P.silence) e = snapToSilence(ep, e);
  if (s > 0) s += P.padIn;
  if (e < dur) e -= P.padOut;
  return [s, Math.max(s, e)];
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const defaultParams = (mode: SkipDetectMode) => (mode === "intro" ? SKIP_DETECT_INTRO_PARAMS : SKIP_DETECT_CREDITS_PARAMS);

/**
 * Detect the intro or credits of every episode of one show from their stored analyses. Episodes are matched
 * against their partners (`P.pool`); an episode without a partner (a show with one episode) gets nothing. Callers
 * use only `confident` results.
 */
export const detectSkipSegments = (
  episodes: SkipEpisodeAudio[],
  mode: SkipDetectMode,
  P: SkipDetectParams = defaultParams(mode)
): Map<string, SkipDetectResult> => runSteps(detectSkipSegmentsSteps(episodes, mode, P));

/** {@link detectSkipSegments}, giving the event loop a turn between episode pairs: the same result. */
export const detectSkipSegmentsAsync = (
  episodes: SkipEpisodeAudio[],
  mode: SkipDetectMode,
  P: SkipDetectParams = defaultParams(mode)
): Promise<Map<string, SkipDetectResult>> => runStepsYielding(detectSkipSegmentsSteps(episodes, mode, P));

function* detectSkipSegmentsSteps(
  episodes: SkipEpisodeAudio[],
  mode: SkipDetectMode,
  P: SkipDetectParams
): Generator<void, Map<string, SkipDetectResult>, void> {
  const eps = [...episodes].sort((a, b) => a.season - b.season || a.episode - b.episode);
  const order = new Map(eps.map((ep, i) => [ep.id, i]));
  const byId = new Map(eps.map((ep) => [ep.id, ep]));
  const pool = new Map<string, string[]>();
  for (const ep of eps) {
    const same = eps.filter((o) => o.season === ep.season && o.id !== ep.id).map((o) => o.id);
    const all = eps.filter((o) => o.id !== ep.id).map((o) => o.id);
    pool.set(ep.id, P.pool === "season" ? same : P.pool === "show" ? all : same.length ? same : all);
  }

  const cache = new Map<string, Pair | null>();
  const md = (fp: Uint32Array) => (mode === "intro" ? P.maxIntro : fp.length * SD - 1);
  const pair = (a: string, b: string): Pair | null => {
    const key = `${a}\u0000${b}`;
    if (cache.has(key)) return cache.get(key)!;
    const [fa, oa] = searchWindow(P, byId.get(a)!, mode);
    const [fb, ob] = searchWindow(P, byId.get(b)!, mode);
    const maxdur = Math.min(md(fa), md(fb));
    let r: Pair | null = null;
    if (fa.length && fb.length) {
      r = compare(P, fa, fb, mode, maxdur);
      if (r && r[1][1] - r[1][0] > md(fb)) r = null;
    }
    if (r) {
      r = [
        [r[0][0] + oa, r[0][1] + oa],
        [r[1][0] + ob, r[1][1] + ob],
      ];
    }
    cache.set(key, r);
    return r;
  };
  // The earlier episode is always the left side, so a pair is computed once.
  const get = (a: string, b: string): Pair | null => {
    if (order.get(a)! <= order.get(b)!) return pair(a, b);
    const r = pair(b, a);
    return r ? [r[1], r[0]] : null;
  };

  const segs = new Map<string, Array<[string, Seg]>>();
  for (const ep of eps) {
    const list: Array<[string, Seg]> = [];
    for (const j of pool.get(ep.id)!) {
      const r = get(ep.id, j);
      if (r) list.push([j, r[0]]);
      yield;
    }
    segs.set(ep.id, list);
  }

  const best = new Map<string, [Seg, string | null]>();
  if (P.select === "first_pair") {
    for (let k = 0; k < eps.length; k++) {
      const a = eps[k]!.id;
      for (const { id: b } of eps.slice(k + 1)) {
        if (!pool.get(a)!.includes(b)) continue;
        const r = get(a, b);
        if (!r) continue;
        for (const [eid, seg, partner] of [
          [a, r[0], b],
          [b, r[1], a],
        ] as Array<[string, Seg, string]>) {
          const prev = best.get(eid);
          if (!prev || seg[1] - seg[0] > prev[0][1] - prev[0][0]) best.set(eid, [seg, partner]);
        }
        break;
      }
    }
  } else {
    const tol = P.agreeTol;
    for (const ep of eps) {
      const S = segs.get(ep.id)!.map(([, s]) => s);
      if (!S.length) continue;
      const agreeing = (s: Seg) => S.filter((t) => Math.abs(t[0] - s[0]) <= tol && Math.abs(t[1] - s[1]) <= tol);
      let cl = S[0]!;
      let clScore = agreeing(cl).length;
      for (const s of S.slice(1)) {
        const score = agreeing(s).length;
        if (score > clScore || (score === clScore && s[1] - s[0] > cl[1] - cl[0])) {
          cl = s;
          clScore = score;
        }
      }
      const mem = agreeing(cl);
      best.set(ep.id, [[median(mem.map((t) => t[0])), median(mem.map((t) => t[1]))], null]);
    }
  }

  const out = new Map<string, SkipDetectResult>();
  const tol = P.agreeTol;
  for (const ep of eps) {
    const n = pool.get(ep.id)!.length;
    const chosen = best.get(ep.id);
    if (!chosen) {
      out.set(ep.id, { found: false, support: 0, compared: n, confident: false });
      continue;
    }
    const [seg, partner] = chosen;
    const sup = segs.get(ep.id)!.filter(([, s]) => Math.abs(s[0] - seg[0]) <= tol && Math.abs(s[1] - seg[1]) <= tol).length;
    const [start, end] = adjust(P, ep, seg);
    const confident =
      sup >= P.gateSupport &&
      (n === 0 || sup / n >= P.gateFrac) &&
      end - start >= P.gateMinLen &&
      (P.gateMaxStart === null || mode !== "intro" || start <= P.gateMaxStart);
    out.set(ep.id, {
      found: true,
      start,
      end,
      rawStart: seg[0],
      rawEnd: seg[1],
      partner,
      support: sup,
      compared: n,
      confident,
    });
  }
  return out;
}

/**
 * Chromaprint raw fingerprints in TypeScript (META-SKIP-04).
 *
 * A port of the Chromaprint library's default algorithm (`CHROMAPRINT_ALGORITHM_TEST2`, what `fpcalc -raw` prints)
 * by Lukas Lalinsky (MIT licence, https://github.com/acoustid/chromaprint): 11025 Hz mono 16-bit samples, 4096-sample
 * Hamming-windowed frames every 1365 samples, power spectrum folded into 12 chroma bands (28 Hz to 3520 Hz), a 5-tap
 * filter over time, Euclidean normalisation, then 16 Haar-like classifiers over the chroma image, each quantised to
 * 2 Gray-coded bits: one 32-bit sub-fingerprint per frame (one every ~0.124 s).
 *
 * Ported rather than shelling out to `fpcalc` because the desktop ships one ffmpeg build for every OS (media-deps)
 * without Chromaprint, and the detector must run wherever Badger desktop runs. `chromaprint.test.ts` compares the
 * output with `fpcalc -raw` on the same samples: about 93 % of sub-fingerprints are identical and the rest differ by
 * one bit (floating-point rounding at a quantiser threshold), well inside the matcher's 6-bit tolerance.
 */
import { runSteps, runStepsYielding } from "./cooperative";

export const CHROMAPRINT_SAMPLE_RATE = 11025;
const FRAME_SIZE = 4096;
// Chromaprint's overlap is FRAME_SIZE - FRAME_SIZE / 3, so a frame starts every FRAME_SIZE / 3 samples (integer).
const FRAME_INCREMENT = 1365;
/** Seconds between two sub-fingerprints (the matcher's time unit). */
export const CHROMAPRINT_ITEM_SECONDS = FRAME_SIZE / CHROMAPRINT_SAMPLE_RATE / 3;
const NUM_BANDS = 12;
const MIN_FREQ = 28;
const MAX_FREQ = 3520;
const FILTER_COEFFICIENTS = [0.25, 0.75, 1.0, 0.75, 0.25];

type Classifier = { type: number; y: number; height: number; width: number; t0: number; t1: number; t2: number };
const c = (type: number, y: number, height: number, width: number, t0: number, t1: number, t2: number): Classifier => ({
  type,
  y,
  height,
  width,
  t0,
  t1,
  t2,
});
// kClassifiersTest2 (fingerprinter_configuration.cpp): Filter(type, y, height, width), Quantizer(t0, t1, t2).
const CLASSIFIERS: Classifier[] = [
  c(0, 4, 3, 15, 1.98215, 2.35817, 2.63523),
  c(4, 4, 6, 15, -1.03809, -0.651211, -0.282167),
  c(1, 0, 4, 16, -0.298702, 0.119262, 0.558497),
  c(3, 8, 2, 12, -0.105439, 0.0153946, 0.135898),
  c(3, 4, 4, 8, -0.142891, 0.0258736, 0.200632),
  c(4, 0, 3, 5, -0.826319, -0.590612, -0.368214),
  c(1, 2, 2, 9, -0.557409, -0.233035, 0.0534525),
  c(2, 7, 3, 4, -0.0646826, 0.00620476, 0.0784847),
  c(2, 6, 2, 16, -0.192387, -0.029699, 0.215855),
  c(2, 1, 3, 2, -0.0397818, -0.00568076, 0.0292026),
  c(5, 10, 1, 15, -0.53823, -0.369934, -0.190235),
  c(3, 6, 2, 10, -0.124877, 0.0296483, 0.139239),
  c(2, 1, 1, 14, -0.101475, 0.0225617, 0.231971),
  c(3, 5, 6, 4, -0.0799915, -0.00729616, 0.063262),
  c(1, 9, 2, 12, -0.272556, 0.019424, 0.302559),
  c(3, 4, 2, 14, -0.164292, -0.0321188, 0.0846339),
];
const MAX_FILTER_WIDTH = Math.max(...CLASSIFIERS.map((k) => k.width));
const GRAY_CODE = [0, 1, 3, 2];

let tables: { window: Float64Array; notes: Int8Array; minIndex: number; maxIndex: number; cos: Float64Array; sin: Float64Array; rev: Uint32Array } | null =
  null;

const prepare = () => {
  if (tables) return tables;
  const window = new Float64Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) {
    window[i] = (1 / 32767) * (0.54 - 0.46 * Math.cos((i * 2 * Math.PI) / (FRAME_SIZE - 1)));
  }
  const minIndex = Math.max(1, Math.round((FRAME_SIZE * MIN_FREQ) / CHROMAPRINT_SAMPLE_RATE));
  const maxIndex = Math.min(FRAME_SIZE / 2, Math.round((FRAME_SIZE * MAX_FREQ) / CHROMAPRINT_SAMPLE_RATE));
  const notes = new Int8Array(FRAME_SIZE);
  for (let i = minIndex; i < maxIndex; i++) {
    const freq = (i * CHROMAPRINT_SAMPLE_RATE) / FRAME_SIZE;
    const octave = Math.log(freq / (440 / 16)) / Math.log(2);
    notes[i] = Math.trunc(NUM_BANDS * (octave - Math.floor(octave)));
  }
  const cos = new Float64Array(FRAME_SIZE / 2);
  const sin = new Float64Array(FRAME_SIZE / 2);
  for (let i = 0; i < FRAME_SIZE / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / FRAME_SIZE);
    sin[i] = Math.sin((-2 * Math.PI * i) / FRAME_SIZE);
  }
  const bits = Math.log2(FRAME_SIZE);
  const rev = new Uint32Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  tables = { window, notes, minIndex, maxIndex, cos, sin, rev };
  return tables;
};

/** In-place iterative radix-2 FFT of a real frame (imaginary part zero); leaves the spectrum in re/im. */
const fft = (re: Float64Array, im: Float64Array, t: NonNullable<typeof tables>) => {
  const n = FRAME_SIZE;
  for (let i = 0; i < n; i++) {
    const j = t.rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = t.cos[k * step];
        const wi = t.sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
};

/**
 * Raw fingerprint of 11025 Hz mono signed 16-bit samples: one unsigned 32-bit value per ~0.124 s
 * (`fpcalc -raw` output for the same samples).
 */
/** The fingerprint as steps: yields every 256 frames (about 30 s of audio) so a caller can give the event loop a turn. */
function* chromaprintSteps(samples: Int16Array): Generator<void, Uint32Array, void> {
  const t = prepare();
  const frameCount = samples.length >= FRAME_SIZE ? Math.floor((samples.length - FRAME_SIZE) / FRAME_INCREMENT) + 1 : 0;
  const re = new Float64Array(FRAME_SIZE);
  const im = new Float64Array(FRAME_SIZE);
  // Ring of the last 8 chroma vectors for the 5-tap filter (ChromaFilter).
  const ring: Float64Array[] = Array.from({ length: 8 }, () => new Float64Array(NUM_BANDS));
  let ringOffset = 0;
  let ringSize = 1;
  // Integral image of the normalised chroma rows (row = time, column = band), kept whole: an episode end is ~5k rows.
  const rowsMax = Math.max(0, frameCount - FILTER_COEFFICIENTS.length + 1);
  const integral = new Float64Array((rowsMax + 1) * (NUM_BANDS + 1));
  const W = NUM_BANDS + 1;
  let rows = 0;
  const out: number[] = [];

  const area = (r1: number, c1: number, r2: number, c2: number) =>
    integral[r2 * W + c2] - integral[r1 * W + c2] - integral[r2 * W + c1] + integral[r1 * W + c1];
  const subtractLog = (a: number, b: number) => Math.log((1 + a) / (1 + b));
  const applyFilter = (k: Classifier, x: number): number => {
    const y = k.y;
    const w = k.width;
    const h = k.height;
    switch (k.type) {
      case 0:
        return subtractLog(area(x, y, x + w, y + h), 0);
      case 1: {
        const h2 = Math.floor(h / 2);
        return subtractLog(area(x, y + h2, x + w, y + h), area(x, y, x + w, y + h2));
      }
      case 2: {
        const w2 = Math.floor(w / 2);
        return subtractLog(area(x + w2, y, x + w, y + h), area(x, y, x + w2, y + h));
      }
      case 3: {
        const w2 = Math.floor(w / 2);
        const h2 = Math.floor(h / 2);
        return subtractLog(
          area(x, y + h2, x + w2, y + h) + area(x + w2, y, x + w, y + h2),
          area(x, y, x + w2, y + h2) + area(x + w2, y + h2, x + w, y + h)
        );
      }
      case 4: {
        const h3 = Math.floor(h / 3);
        return subtractLog(area(x, y + h3, x + w, y + 2 * h3), area(x, y, x + w, y + h3) + area(x, y + 2 * h3, x + w, y + h));
      }
      default: {
        const w3 = Math.floor(w / 3);
        return subtractLog(area(x + w3, y, x + 2 * w3, y + h), area(x, y, x + w3, y + h) + area(x + 2 * w3, y, x + w, y + h));
      }
    }
  };

  const chroma = new Float64Array(NUM_BANDS);
  const filtered = new Float64Array(NUM_BANDS);
  for (let f = 0; f < frameCount; f++) {
    if ((f & 255) === 255) yield;
    const base = f * FRAME_INCREMENT;
    for (let i = 0; i < FRAME_SIZE; i++) {
      re[i] = samples[base + i] * t.window[i];
      im[i] = 0;
    }
    fft(re, im, t);
    chroma.fill(0);
    for (let i = t.minIndex; i < t.maxIndex; i++) chroma[t.notes[i]] += re[i] * re[i] + im[i] * im[i];

    ring[ringOffset].set(chroma);
    ringOffset = (ringOffset + 1) % 8;
    if (ringSize < FILTER_COEFFICIENTS.length) {
      ringSize++;
      continue;
    }
    const offset = (ringOffset + 8 - FILTER_COEFFICIENTS.length) % 8;
    filtered.fill(0);
    for (let b = 0; b < NUM_BANDS; b++) {
      for (let j = 0; j < FILTER_COEFFICIENTS.length; j++) filtered[b] += ring[(offset + j) % 8][b] * FILTER_COEFFICIENTS[j];
    }
    let squares = 0;
    for (let b = 0; b < NUM_BANDS; b++) squares += filtered[b] * filtered[b];
    const norm = squares > 0 ? Math.sqrt(squares) : 0;
    for (let b = 0; b < NUM_BANDS; b++) filtered[b] = norm < 0.01 ? 0 : filtered[b] / norm;

    // Append the row to the integral image.
    rows++;
    let rowSum = 0;
    for (let b = 0; b < NUM_BANDS; b++) {
      rowSum += filtered[b];
      integral[rows * W + b + 1] = integral[(rows - 1) * W + b + 1] + rowSum;
    }
    if (rows >= MAX_FILTER_WIDTH) {
      const x = rows - MAX_FILTER_WIDTH;
      let bits = 0;
      for (const k of CLASSIFIERS) {
        const v = applyFilter(k, x);
        const q = v < k.t1 ? (v < k.t0 ? 0 : 1) : v < k.t2 ? 2 : 3;
        bits = ((bits << 2) | GRAY_CODE[q]) >>> 0;
      }
      out.push(bits);
    }
  }
  return Uint32Array.from(out);
}

export const chromaprintRaw = (samples: Int16Array): Uint32Array => runSteps(chromaprintSteps(samples));

/**
 * `chromaprintRaw` giving the event loop a turn between slices of work (MPV-PREV-07); same result. An aborted `signal`
 * stops it at the next turn (`CANCELLED`).
 */
export const chromaprintRawAsync = (samples: Int16Array, signal?: AbortSignal): Promise<Uint32Array> =>
  runStepsYielding(chromaprintSteps(samples), undefined, signal);

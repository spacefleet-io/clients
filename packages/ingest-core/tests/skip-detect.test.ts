import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHROMAPRINT_SAMPLE_RATE as RATE,
  buildSkipAudioAnalysis,
  buildSkipAudioAnalysisAsync,
  chromaprintRaw,
  chromaprintRawAsync,
  detectSkipSegments,
  detectSkipSegmentsAsync,
  runStepsYielding,
  findSilences,
  skipEpisodeAudioFromPayload,
  type SkipEpisodeAudio,
} from "../src/skipDetect";

const log = (label: string, value: unknown) => console.log(`[skip-detect.test] ${label}`, JSON.stringify(value));

/** Deterministic PRNG (mulberry32). */
const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Music-like audio: two-note chords that change every 0.4 s, pitches drawn from `seed`. The same seed gives the
 * same "theme" wherever it is placed; `seed: null` is silence.
 */
type Part = { seconds: number; seed: number | null };
const synth = (parts: Part[]): Int16Array => {
  const total = Math.round(parts.reduce((sum, p) => sum + p.seconds, 0) * RATE);
  const out = new Int16Array(total);
  let at = 0;
  for (const part of parts) {
    const n = Math.round(part.seconds * RATE);
    if (part.seed !== null) {
      const next = rng(part.seed);
      const noteLen = Math.round(0.4 * RATE);
      for (let k = 0; k < n; k += noteLen) {
        const f1 = 440 * 2 ** ((Math.floor(next() * 36) - 21) / 12);
        const f2 = 440 * 2 ** ((Math.floor(next() * 36) - 21) / 12);
        for (let i = k; i < Math.min(n, k + noteLen); i++) {
          const t = (i - k) / RATE;
          out[at + i] = Math.round(6000 * Math.sin(2 * Math.PI * f1 * t) + 4000 * Math.sin(2 * Math.PI * f2 * t));
        }
      }
    }
    at += n;
  }
  return out;
};

const THEME = 7;
const CREDITS = 11;
const DURATION = 400;
const TAIL_OFFSET = 250;

/** An episode: own story, the theme at `introAt` (then 1 s of silence), own story; credits at the end when asked. */
const episode = (id: string, season: number, number: number, introAt: number, withCredits: boolean): SkipEpisodeAudio => {
  const seed = season * 100 + number;
  const head = synth([
    { seconds: introAt, seed: seed * 7 + 1 },
    { seconds: 25, seed: THEME },
    { seconds: 1, seed: null },
    { seconds: 100 - introAt - 26, seed: seed * 7 + 2 },
  ]);
  const tail = synth(
    withCredits
      ? [
          { seconds: 100, seed: seed * 7 + 3 },
          { seconds: 40, seed: CREDITS },
          { seconds: 10, seed: seed * 7 + 4 },
        ]
      : [{ seconds: 150, seed: seed * 7 + 3 }]
  );
  const payload = buildSkipAudioAnalysis({ durationSeconds: DURATION, head, tail, tailOffsetSeconds: TAIL_OFFSET });
  // The stored form: through JSON, as media_skip_analysis keeps it.
  const audio = skipEpisodeAudioFromPayload({ id, season, episode: number }, JSON.parse(JSON.stringify(payload)));
  if (!audio) throw new Error("payload did not read back");
  return audio;
};

describe("chromaprintRaw", () => {
  it("gives the same sub-fingerprints as fpcalc -raw", () => {
    let fpcalc = "";
    try {
      fpcalc = execFileSync("which", ["fpcalc"], { encoding: "utf8" }).trim();
    } catch {
      console.log("[skip-detect.test] fpcalc not installed; comparison skipped");
      return;
    }
    const samples = synth([
      { seconds: 20, seed: 3 },
      { seconds: 10, seed: 4 },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "skip-detect-"));
    try {
      const header = Buffer.alloc(44);
      header.write("RIFF", 0);
      header.writeUInt32LE(36 + samples.byteLength, 4);
      header.write("WAVEfmt ", 8);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(RATE, 24);
      header.writeUInt32LE(RATE * 2, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write("data", 36);
      header.writeUInt32LE(samples.byteLength, 40);
      const wav = join(dir, "synth.wav");
      writeFileSync(wav, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]));
      const out = execFileSync(fpcalc, ["-raw", "-length", "60", wav], { encoding: "utf8" });
      const expected = (/FINGERPRINT=([\d,]+)/.exec(out)?.[1] ?? "").split(",").map(Number);
      const actual = Array.from(chromaprintRaw(samples));
      let same = 0;
      let maxBits = 0;
      for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
        const diff = (expected[i]! ^ actual[i]!) >>> 0;
        if (diff === 0) same++;
        maxBits = Math.max(maxBits, diff.toString(2).replace(/0/g, "").length);
      }
      log("fpcalc comparison", { fpcalc, expected: expected.length, actual: actual.length, same, maxBits });
      expect(actual.length).toBe(expected.length);
      expect(same / expected.length).toBeGreaterThan(0.9);
      expect(maxBits).toBeLessThanOrEqual(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findSilences", () => {
  it("finds runs of at least 0.33 s below -50 dBFS, in absolute seconds", () => {
    const samples = synth([
      { seconds: 2, seed: 1 },
      { seconds: 0.5, seed: null },
      { seconds: 1, seed: 2 },
      { seconds: 0.2, seed: null },
      { seconds: 1, seed: 3 },
    ]);
    const silences = findSilences(samples, 100);
    log("silences", silences);
    // Chords cross zero now and then, but never for 0.33 s: only the 0.5 s gap counts.
    expect(silences).toHaveLength(1);
    expect(silences[0]![0]).toBeCloseTo(102, 1);
    expect(silences[0]![1]).toBeCloseTo(102.5, 1);
  });
});

// @req META-SKIP-04[badger-desktop]
describe("detectSkipSegments", () => {
  it("finds the shared intro in every episode of a season, end snapped to the silence after it", () => {
    // All past the 5 s snap (a match starting within 5 s of the start skips from 0).
    const starts = [10, 30, 8, 40];
    const eps = starts.map((at, i) => episode(`s1e${i + 1}`, 1, i + 1, at, true));
    const intro = detectSkipSegments(eps, "intro");
    for (const [i, at] of starts.entries()) {
      const r = intro.get(`s1e${i + 1}`)!;
      log(`intro s1e${i + 1} (theme ${at}..${at + 25})`, r);
      expect(r.found && r.confident).toBe(true);
      if (!r.found) continue;
      expect(Math.abs(r.rawStart - at)).toBeLessThan(1.5);
      // padIn 2 s after the matched start; the end lands on the silence right after the theme.
      expect(r.start - r.rawStart).toBeCloseTo(2, 3);
      expect(Math.abs(r.end - (at + 25))).toBeLessThan(0.6);
    }
  });

  it("offers the shared credits, start padded by 6 s", () => {
    const eps = [10, 30, 5, 40].map((at, i) => episode(`s1e${i + 1}`, 1, i + 1, at, true));
    const credits = detectSkipSegments(eps, "credits");
    for (const [id, r] of credits) {
      log(`credits ${id} (credits ${TAIL_OFFSET + 100}..${TAIL_OFFSET + 140})`, r);
      expect(r.found && r.confident).toBe(true);
      if (!r.found) continue;
      expect(Math.abs(r.rawStart - (TAIL_OFFSET + 100))).toBeLessThan(1.5);
      expect(r.start - r.rawStart).toBeCloseTo(6, 3);
    }
  });

  it("a lone episode of a new season is matched against the earlier seasons", () => {
    const eps = [
      episode("s1e1", 1, 1, 10, false),
      episode("s1e2", 1, 2, 30, false),
      episode("s2e1", 2, 1, 20, false),
      episode("s3e1", 3, 1, 15, false),
    ];
    const intro = detectSkipSegments(eps, "intro");
    const lone = intro.get("s3e1")!;
    log("lone season-3 episode", lone);
    expect(lone.found && lone.confident).toBe(true);
    expect(lone.compared).toBe(3);
    if (lone.found) expect(Math.abs(lone.rawStart - 15)).toBeLessThan(1.5);
  });

  it("a single episode never gets a skip", () => {
    const intro = detectSkipSegments([episode("s1e1", 1, 1, 10, true)], "intro");
    log("single episode", intro.get("s1e1"));
    expect(intro.get("s1e1")).toEqual({ found: false, support: 0, compared: 0, confident: false });
  });

  it("episodes with nothing in common get nothing", () => {
    const a = episode("a", 1, 1, 10, false);
    const b = skipEpisodeAudioFromPayload(
      { id: "b", season: 1, episode: 2 },
      buildSkipAudioAnalysis({
        durationSeconds: DURATION,
        head: synth([{ seconds: 100, seed: 999 }]),
        tail: synth([{ seconds: 150, seed: 998 }]),
        tailOffsetSeconds: TAIL_OFFSET,
      })
    )!;
    const intro = detectSkipSegments([a, b], "intro");
    log("unrelated", [...intro]);
    expect([...intro.values()].every((r) => !r.found)).toBe(true);
  });
});

describe("skipEpisodeAudioFromPayload", () => {
  it("refuses anything but a version-1 analysis", () => {
    expect(skipEpisodeAudioFromPayload({ id: "x", season: 1, episode: 1 }, { version: 2 })).toBeNull();
    expect(skipEpisodeAudioFromPayload({ id: "x", season: 1, episode: 1 }, null)).toBeNull();
  });
});

// @req MPV-PREV-07[badger-desktop]
describe("cooperative detection", () => {
  it("the async fingerprint, analysis and matching give exactly the sync results", async () => {
    const samples = synth([
      { seconds: 30, seed: 5 },
      { seconds: 25, seed: THEME },
    ]);
    expect(await chromaprintRawAsync(samples)).toEqual(chromaprintRaw(samples));
    const input = {
      durationSeconds: DURATION,
      head: samples,
      tail: synth([{ seconds: 60, seed: CREDITS }]),
      tailOffsetSeconds: TAIL_OFFSET,
    };
    expect(await buildSkipAudioAnalysisAsync(input)).toEqual(buildSkipAudioAnalysis(input));
    const eps = [10, 30, 8, 40].map((at, i) => episode(`s1e${i + 1}`, 1, i + 1, at, true));
    for (const mode of ["intro", "credits"] as const) {
      expect([...(await detectSkipSegmentsAsync(eps, mode))]).toEqual([...detectSkipSegments(eps, mode)]);
    }
  });

  it("gives the event loop a turn after each slice of work", async () => {
    const busy = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        // spin: one unit of detector work
      }
    };
    function* work(): Generator<void, string, void> {
      for (let i = 0; i < 12; i++) {
        busy(5);
        yield;
      }
      return "done";
    }
    let turns = 0;
    let live = true;
    const tick = () => {
      if (!live) return;
      turns++;
      setImmediate(tick);
    };
    setImmediate(tick);
    const result = await runStepsYielding(work(), 10);
    live = false;
    log("turns", { turns });
    expect(result).toBe("done");
    // 60 ms of work in 10 ms slices: the loop ran in between (about 6 times), not only at the end.
    expect(turns).toBeGreaterThanOrEqual(4);
  });

  it("@req MPV-PREV-07 an aborted signal stops the work at the next turn, so a pass gives way within a slice", async () => {
    let units = 0;
    function* work(): Generator<void, string, void> {
      for (let i = 0; i < 1000; i++) {
        const end = performance.now() + 2;
        while (performance.now() < end) {
          // spin
        }
        units++;
        yield;
      }
      return "done";
    }
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 30);
    await expect(runStepsYielding(work(), 10, abort.signal)).rejects.toThrow("CANCELLED");
    log("abort.units", { units });
    expect(units).toBeLessThan(100);
    // The sound analysis checks the same signal: an already aborted one never fingerprints.
    const samples = synth([{ seconds: 30, seed: 5 }]);
    await expect(
      buildSkipAudioAnalysisAsync({ durationSeconds: DURATION, head: samples, tail: samples, tailOffsetSeconds: TAIL_OFFSET, signal: AbortSignal.abort() })
    ).rejects.toThrow("CANCELLED");
  });
});

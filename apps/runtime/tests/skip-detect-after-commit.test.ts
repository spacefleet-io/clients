/**
 * META-SKIP-04 (Chris 2026-11-24): skip times matched from the stored signatures of a show's episodes. Signatures
 * are synthetic (picture windows of random frames sharing an intro, credits as text on dark; sound fingerprinted by
 * the real Chromaprint port); the library is an in-memory fake of the calls the matcher makes.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHROMAPRINT_SAMPLE_RATE as RATE,
  SKIP_SIGNATURE_ANALYSIS_KIND,
  SKIP_SIGNATURE_VERSION,
  buildSkipAudioAnalysis,
  encodeSkipSignature,
  skipPictureWindowToPayload,
  type SkipDetectResult,
  type SkipSignature,
} from "@space/ingest-core/skipDetect";
import { SKIP_FIX_ANALYSIS_KIND, SKIP_MATCH_ANALYSIS_KIND, type SkipFixPayload } from "@space/shared/skipMarkers";
import {
  combineSkipCredits,
  combineSkipIntro,
  createSkipMatchRunner,
  writeFileDurably,
  type SkipDetectLibrary,
} from "../src/modules/badger/steps/skipDetectAfterCommit";

const log = (label: string, value: unknown) => console.log(`[skip-match.test] ${label}`, JSON.stringify(value));

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

const FPS = 4;
const BUSY = 1;
const TEXTDARK = 4;
const DURATION = 1200;
const TAIL_OFFSET = DURATION - 600;
const INTRO_SECONDS = 20;
/** Where each fake episode's intro starts and its credits start, by episode number. */
const INTRO_AT: Record<number, number> = { 1: 40, 2: 75, 3: 52, 4: 61 };
const CREDITS_AT: Record<number, number> = { 1: 1150, 2: 1162, 3: 1144, 4: 1170 };
const EDGE = 0.4;

/** A picture window: random busy frames, with `shared` spans (same seed in every episode) and `dark` spans. */
const pictureWindow = (offset: number, seconds: number, seed: number, shared: Array<[number, number]>, darkFrom?: number) => {
  const n = seconds * FPS;
  const hashes = new Uint32Array(n * 2);
  const flags = new Uint8Array(n);
  const own = rng(seed);
  for (let i = 0; i < n; i++) {
    const at = offset + i / FPS;
    const span = shared.find(([s, e]) => at >= s && at < e);
    const next = span ? rng(9_000 + Math.round((at - span[0]) * FPS)) : own;
    hashes[2 * i] = (next() * 2 ** 32) >>> 0;
    hashes[2 * i + 1] = (next() * 2 ** 32) >>> 0;
    flags[i] = darkFrom !== undefined && at >= darkFrom ? TEXTDARK : BUSY;
  }
  return skipPictureWindowToPayload({ offsetSeconds: offset, hashes, flags });
};

/** Two-note chords every 0.4 s from `seed`. */
const synth = (parts: Array<{ seconds: number; seed: number }>): Int16Array => {
  const out = new Int16Array(Math.round(parts.reduce((sum, p) => sum + p.seconds, 0) * RATE));
  let at = 0;
  for (const part of parts) {
    const n = Math.round(part.seconds * RATE);
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
    at += n;
  }
  return out;
};

const episodeSignature = (number: number, opts: { audio?: boolean } = {}): SkipSignature => {
  const introAt = INTRO_AT[number]!;
  const head = pictureWindow(0, 300, number * 11, [[introAt, introAt + INTRO_SECONDS]]);
  const tail = pictureWindow(TAIL_OFFSET, 600, number * 13, [], CREDITS_AT[number]);
  const audio = opts.audio
    ? JSON.parse(
        JSON.stringify(
          buildSkipAudioAnalysis({
            durationSeconds: DURATION,
            head: synth([
              { seconds: introAt, seed: number * 7 + 1 },
              { seconds: INTRO_SECONDS, seed: 77 },
              { seconds: 150 - introAt - INTRO_SECONDS, seed: number * 7 + 2 },
            ]),
            tail: synth([{ seconds: 150, seed: number * 7 + 3 }]),
            tailOffsetSeconds: DURATION - 150,
          })
        )
      )
    : null;
  return { version: SKIP_SIGNATURE_VERSION, durationSeconds: DURATION, audio, picture: { fps: FPS, head, tail } };
};

type Row = { mediaId: string; episodeId: string | null; kind: string; payload: Record<string, unknown> };
type Marker = { episodeId: string | null; type: string; startSeconds: number; endSeconds: number; source: string; confidence: number | null };
const RANK: Record<string, number> = { user: 3, metadata: 2, detected: 1 };

/** A library holding a show with `episodes` (season 1), each with a source format whose record names its signature. */
const fakeLibrary = (episodes: number[], opts: { movie?: boolean } = {}) => {
  const rows: Row[] = [];
  const markers: Marker[] = [];
  const calls: string[] = [];
  const signed = new Set<number>();
  const library: SkipDetectLibrary = {
    runBatch: (_label, fn) => fn(),
    call: async (method, args = []) => {
      calls.push(method);
      switch (method) {
        case "listSkipAnalysis": {
          const [mediaId, kind] = args as [string, string | undefined];
          return rows.filter((row) => row.mediaId === mediaId && (!kind || row.kind === kind));
        }
        case "upsertSkipAnalysis": {
          const [mediaId, episodeId, kind, payload] = args as [string, string | null, string, Record<string, unknown>];
          const at = rows.findIndex((row) => row.episodeId === episodeId && row.kind === kind);
          if (at >= 0) rows.splice(at, 1);
          rows.push({ mediaId, episodeId, kind, payload });
          return null;
        }
        case "getMediaDetails":
          return {
            type: opts.movie ? "movie" : "tv",
            episodes: opts.movie ? [] : episodes.map((n) => ({ id: `ep-${n}`, seasonNumber: 1, episodeNumber: n })),
            files: episodes.map((n) => ({ id: `file-${n}`, season: opts.movie ? null : 1, episode: opts.movie ? null : n })),
            formats: episodes.map((n) => ({
              id: `format-${n}`,
              fileId: `file-${n}`,
              isSource: true,
              previewSheets: signed.has(n) ? { skipSignature: { objectKey: `sig-${n}`, sizeBytes: 1, version: 1 } } : null,
            })),
            skipMarkers: markers,
          };
        case "mergeSkipMarkers": {
          const [, episodeId, incoming] = args as [string, string | null, Array<Omit<Marker, "episodeId">>];
          for (const marker of incoming) {
            const at = markers.findIndex((row) => row.episodeId === episodeId && row.type === marker.type);
            if (at >= 0 && RANK[markers[at]!.source]! > RANK[marker.source]!) continue;
            if (at >= 0) markers.splice(at, 1);
            markers.push({ ...marker, episodeId, confidence: marker.confidence ?? null });
          }
          return null;
        }
        default:
          throw new Error(`unexpected call ${method}`);
      }
    },
  };
  return { library, rows, markers, calls, signed };
};

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-skip-match-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const pendingPath = () => join(root, "user", "skip-match-pending.json");
const pendingIds = () => (existsSync(pendingPath()) ? (JSON.parse(readFileSync(pendingPath(), "utf8")) as { mediaIds: string[] }).mediaIds : []);

const matcher = (library: SkipDetectLibrary, fetchSignature: (key: string) => Promise<Uint8Array> = async (key) => {
  throw new Error(`no download expected (${key})`);
}) => createSkipMatchRunner({ libraryDb: library, fetchSignature, pendingPath, log: (line) => console.log(line) });

/** Records episode `n`'s signature as the preview pass hands it over. */
const record = (fake: ReturnType<typeof fakeLibrary>, run: ReturnType<typeof createSkipMatchRunner>, n: number, signature = episodeSignature(n)) => {
  fake.signed.add(n);
  return run.signatureRecorded({ mediaId: "show", episodeId: `ep-${n}`, objectKey: `sig-${n}`, signature });
};

const sound = (start: number, end: number): SkipDetectResult => ({
  found: true,
  start,
  end,
  rawStart: start + 1,
  rawEnd: end - 1,
  partner: null,
  support: 2,
  compared: 2,
  confident: true,
});

// @req META-SKIP-04[runtime]
describe("combining sound and picture (META-SKIP-04)", () => {
  it("intro: overlapping sound and picture give the picture's edges, sure", () => {
    const out = combineSkipIntro(sound(70, 91), { start: 70.3, end: 90.4, support: 3, compared: 3 });
    log("agree", out);
    expect(out).toMatchObject({ start: 70.3, end: 90.4, rawStart: 71, rawEnd: 90, confidence: 1 });
  });

  it("intro: a picture edge more than 3 s inside the sound's keeps the sound's edge, not sure (they disagree)", () => {
    const out = combineSkipIntro(sound(60, 94), { start: 64, end: 93.8, support: 3, compared: 3 });
    log("inside", out);
    expect(out).toMatchObject({ start: 60, end: 93.8, confidence: 0.5 });
    // Parks and Recreation S2E03 (import e2e): sound 64.35–82.72, picture 64.35–74.6, truth ends at 93.98.
    expect(combineSkipIntro(sound(64.35, 82.72), { start: 64.35, end: 74.6, support: 3, compared: 3 })).toMatchObject({
      start: 64.35,
      end: 82.72,
      confidence: 0.5,
    });
  });

  it("intro: one side alone, or the two apart, is not sure", () => {
    expect(combineSkipIntro(sound(10, 30), undefined)).toMatchObject({ start: 10, end: 30, confidence: 0.5 });
    expect(combineSkipIntro(undefined, { start: 5, end: 25, support: 2, compared: 3 })).toMatchObject({ start: 5, end: 25, confidence: 0.5 });
    expect(combineSkipIntro(sound(10, 30), { start: 200, end: 220, support: 3, compared: 3 })).toMatchObject({ start: 10, confidence: 0.5 });
    // A picture run only one partner of several agrees with is not taken.
    expect(combineSkipIntro(undefined, { start: 5, end: 25, support: 1, compared: 3 })).toBeNull();
  });

  it("credits: the picture's start to the end, sure only when the sound agrees within 5 s", () => {
    expect(combineSkipCredits(sound(1280, 1300), 1277, 1310)).toMatchObject({ start: 1277, end: 1310, confidence: 1 });
    expect(combineSkipCredits(undefined, 1277, 1310)).toMatchObject({ start: 1277, end: 1310, confidence: 0.5 });
    expect(combineSkipCredits(sound(1250, 1300), null, 1310)).toMatchObject({ start: 1250, confidence: 0.5 });
    expect(combineSkipCredits(undefined, null, 1310)).toBeNull();
  });
});

// @req META-SKIP-04[runtime] PLAY-SKIP-05[runtime] PLAY-SKIP-08[runtime]
describe("createSkipMatchRunner", () => {
  it("the first episode waits; each next signature matches the show from signatures alone", async () => {
    const fake = fakeLibrary([1, 2, 3]);
    const run = matcher(fake.library);
    await record(fake, run, 1);
    expect(fake.markers).toEqual([]);
    expect(pendingIds()).toEqual([]);
    await record(fake, run, 2);
    await record(fake, run, 3);
    log("markers", fake.markers);
    for (const n of [1, 2, 3]) {
      const intro = fake.markers.find((m) => m.episodeId === `ep-${n}` && m.type === "intro");
      const credits = fake.markers.find((m) => m.episodeId === `ep-${n}` && m.type === "credits");
      expect(intro).toMatchObject({ source: "detected", confidence: 0.5 });
      expect(Math.abs(intro!.startSeconds - (INTRO_AT[n]! - EDGE))).toBeLessThan(1);
      expect(Math.abs(intro!.endSeconds - (INTRO_AT[n]! + INTRO_SECONDS - EDGE))).toBeLessThan(1);
      expect(credits).toMatchObject({ source: "detected", endSeconds: DURATION });
      expect(Math.abs(credits!.startSeconds - (CREDITS_AT[n]! - EDGE))).toBeLessThan(1);
    }
    expect(fake.rows.filter((row) => row.kind === SKIP_MATCH_ANALYSIS_KIND)).toHaveLength(3);
    expect(fake.calls).not.toContain("fetchSignature");
    expect(pendingIds()).toEqual([]);
  });

  it("sound and picture agreeing make sure times (the player does not ask)", async () => {
    const fake = fakeLibrary([1, 2, 3]);
    const run = matcher(fake.library);
    for (const n of [1, 2, 3]) await record(fake, run, n, episodeSignature(n, { audio: true }));
    const intros = fake.markers.filter((m) => m.type === "intro");
    log("intros", intros);
    expect(intros).toHaveLength(3);
    for (const intro of intros) expect(intro.confidence).toBe(1);
  });

  it("never replaces the user's own times nor the metadata service's, and matching again writes nothing", async () => {
    const fake = fakeLibrary([1, 2, 3]);
    fake.markers.push({ episodeId: "ep-1", type: "intro", startSeconds: 3, endSeconds: 40, source: "user", confidence: null });
    fake.markers.push({ episodeId: "ep-2", type: "credits", startSeconds: 1100, endSeconds: 1200, source: "metadata", confidence: null });
    const run = matcher(fake.library);
    for (const n of [1, 2, 3]) await record(fake, run, n);
    expect(fake.markers.find((m) => m.episodeId === "ep-1" && m.type === "intro")).toMatchObject({ startSeconds: 3, source: "user" });
    expect(fake.markers.find((m) => m.episodeId === "ep-2" && m.type === "credits")).toMatchObject({ startSeconds: 1100, source: "metadata" });
    const before = fake.calls.length;
    await run.match("show");
    const again = fake.calls.slice(before);
    log("second match calls", again);
    expect(again).not.toContain("mergeSkipMarkers");
    expect(again).not.toContain("upsertSkipAnalysis");
  });

  it("places a saved season fix on a newly matched episode, as the user's times", async () => {
    const fake = fakeLibrary([1, 2, 3]);
    const fix: SkipFixPayload = { version: 1, seasons: { "1": { intro: { startOffset: -2, endOffset: 3 } } }, episodeOnly: { "ep-3": { intro: true } } };
    fake.rows.push({ mediaId: "show", episodeId: null, kind: SKIP_FIX_ANALYSIS_KIND, payload: fix });
    const run = matcher(fake.library);
    for (const n of [1, 2, 3]) await record(fake, run, n);
    log("markers", fake.markers);
    const ep1 = fake.markers.find((m) => m.episodeId === "ep-1" && m.type === "intro");
    expect(ep1?.source).toBe("user");
    expect(Math.abs(ep1!.startSeconds - (INTRO_AT[1]! - EDGE - 2))).toBeLessThan(1);
    expect(Math.abs(ep1!.endSeconds - (INTRO_AT[1]! + INTRO_SECONDS - EDGE + 3))).toBeLessThan(1);
    // An "only this episode" fix elsewhere keeps that episode out of the season fix.
    expect(fake.markers.find((m) => m.episodeId === "ep-3" && m.type === "intro")?.source).toBe("detected");
  });

  it("downloads a signature made on another computer once, then reads it from the cache", async () => {
    const fake = fakeLibrary([1, 2]);
    fake.signed.add(1);
    const fetched: string[] = [];
    const run = matcher(fake.library, async (key) => {
      fetched.push(key);
      return encodeSkipSignature(episodeSignature(Number(key.slice(4))));
    });
    await record(fake, run, 2);
    await run.match("show");
    log("fetched", fetched);
    expect(fetched).toEqual(["sig-1"]);
    expect(fake.rows.filter((row) => row.kind === SKIP_SIGNATURE_ANALYSIS_KIND).map((row) => row.episodeId).sort()).toEqual(["ep-1", "ep-2"]);
    expect(fake.markers.filter((m) => m.type === "intro")).toHaveLength(2);
  });

  it("a failed download keeps the show pending on disk; the next start matches it (RT-LIFE-04)", async () => {
    const fake = fakeLibrary([1, 2]);
    fake.signed.add(1);
    const offline = matcher(fake.library, async () => {
      throw new Error("fetch failed");
    });
    await record(fake, offline, 2);
    expect(pendingIds()).toEqual(["show"]);
    expect(fake.markers).toEqual([]);
    offline.stop();

    const restarted = matcher(fake.library, async (key) => encodeSkipSignature(episodeSignature(Number(key.slice(4)))));
    await restarted.resume();
    log("markers after resume", fake.markers);
    expect(fake.markers.filter((m) => m.type === "intro")).toHaveLength(2);
    expect(pendingIds()).toEqual([]);
    expect(readdirSync(join(root, "user"))).toEqual(["skip-match-pending.json"]);
  });

  it("a film gets no markers (Chris 2026-11-24)", async () => {
    const fake = fakeLibrary([1], { movie: true });
    const run = matcher(fake.library);
    fake.signed.add(1);
    await run.signatureRecorded({ mediaId: "show", episodeId: null, objectKey: "sig-1", signature: episodeSignature(1) });
    log("film markers", fake.markers);
    expect(fake.markers).toEqual([]);
  });

  it("stop: nothing more is matched", async () => {
    const fake = fakeLibrary([1, 2]);
    const run = matcher(fake.library);
    await record(fake, run, 1);
    run.stop();
    await record(fake, run, 2);
    expect(fake.markers).toEqual([]);
  });
});

describe("writeFileDurably", () => {
  it("replaces the file whole and leaves no temp file", () => {
    const path = join(root, "a", "state.json");
    writeFileDurably(path, "one");
    writeFileDurably(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(readdirSync(join(root, "a"))).toEqual(["state.json"]);
  });
});

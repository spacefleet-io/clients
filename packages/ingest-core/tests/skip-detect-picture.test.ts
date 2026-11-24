/**
 * Picture side of skip detection (META-SKIP-04, Chris 2026-11-24): frame features, pair runs, consensus, the
 * credits walk and the stored payload / signature round trips, on synthetic grey frames.
 *
 * @covers packages/ingest-core/src/skipDetect/picture.ts: skipPictureFrame, buildSkipPictureWindow, skipPicturePairRuns, skipPictureConsensus, detectSkipPicture, skipPictureWindowToPayload, skipEpisodePictureFromPayload
 * @covers packages/ingest-core/src/skipDetect/signature.ts: encodeSkipSignature, decodeSkipSignature, encodeSkipSignatureAsync, decodeSkipSignatureAsync
 */
import { describe, expect, it } from "vitest";
import {
  SKIP_PICTURE_EDGE_SHIFT,
  SKIP_PICTURE_FPS,
  SKIP_PICTURE_HEIGHT,
  SKIP_PICTURE_WIDTH,
  buildSkipPictureWindow,
  decodeSkipSignature,
  decodeSkipSignatureAsync,
  detectSkipPicture,
  detectSkipPictureAsync,
  encodeSkipSignature,
  encodeSkipSignatureAsync,
  skipEpisodePictureFromPayload,
  skipPictureConsensus,
  skipPictureFrame,
  skipPicturePairRuns,
  skipPictureWindowToPayload,
  type SkipEpisodePicture,
} from "../src/skipDetect";

const W = SKIP_PICTURE_WIDTH;
const H = SKIP_PICTURE_HEIGHT;

/** A busy frame: random 17x11 blocks from `seed`. */
const busyFrame = (seed: number) => {
  let s = (seed * 2654435761) >>> 0 || 1;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const cells = Array.from({ length: 10 * 9 }, () => Math.floor(rand() * 256));
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = cells[Math.min(9, Math.floor(y / 11)) * 9 + Math.min(8, Math.floor(x / 17))]!;
  return out;
};
const darkFrame = () => new Uint8Array(W * H);
/** Dark with a few bright text pixels. */
const textFrame = (seed: number) => {
  const out = new Uint8Array(W * H);
  for (let i = 0; i < 200; i++) out[(seed * 37 + i * 61) % out.length] = 220;
  return out;
};

const seconds = (n: number) => n * SKIP_PICTURE_FPS;

/** A head window of `total` seconds of unique footage with the shared intro (seeds 1_000_000+) at `introAt`. */
const head = (episode: number, total: number, introAt: number, introSeconds: number) => {
  const frames: Uint8Array[] = [];
  for (let i = 0; i < seconds(total); i++) {
    const t = i / SKIP_PICTURE_FPS;
    frames.push(t >= introAt && t < introAt + introSeconds ? busyFrame(1_000_000 + i - seconds(introAt)) : busyFrame(episode * 100_000 + i));
  }
  return buildSkipPictureWindow(0, frames);
};

/** A tail window of `total` seconds at `offset`: unique footage, then `creditsSeconds` of text on dark. */
const tail = (episode: number, offset: number, total: number, creditsSeconds: number) => {
  const frames: Uint8Array[] = [];
  for (let i = 0; i < seconds(total); i++) {
    frames.push(i >= seconds(total - creditsSeconds) ? (i % 8 < 2 ? darkFrame() : textFrame(i)) : busyFrame(episode * 100_000 + 50_000 + i));
  }
  return buildSkipPictureWindow(offset, frames);
};

const episode = (n: number, introAt: number): SkipEpisodePicture => ({
  id: `e${n}`,
  season: 1,
  episode: n,
  durationSeconds: 1300,
  head: head(n, 120, introAt, 20),
  tail: tail(n, 1300 - 60, 60, 15),
});

describe("skipPictureFrame", () => {
  it("flags busy, dark and text-on-dark frames", () => {
    expect(skipPictureFrame(busyFrame(3)).flags & 1).toBe(1);
    expect(skipPictureFrame(darkFrame()).flags).toBe(2);
    expect(skipPictureFrame(textFrame(1)).flags & 4).toBe(4);
  });

  it("gives the same hash to the same picture and a different one to another", () => {
    const a = skipPictureFrame(busyFrame(7));
    expect(skipPictureFrame(busyFrame(7))).toEqual(a);
    expect(skipPictureFrame(busyFrame(8))).not.toEqual(a);
  });
});

describe("skipPicturePairRuns", () => {
  it("finds the shared run at each window's own position", () => {
    const a = head(1, 120, 30, 20);
    const b = head(2, 120, 70, 20);
    const runs = skipPicturePairRuns(a, a.flags.length, b, b.flags.length, { gapSeconds: 2, minSeconds: 8, maxSeconds: 130 });
    expect(runs).not.toBeNull();
    const [ra, rb] = runs!;
    expect(ra[0]).toBeCloseTo(30, 0);
    expect(ra[1]).toBeCloseTo(50, 0);
    expect(rb[0]).toBeCloseTo(70, 0);
    expect(rb[1]).toBeCloseTo(90, 0);
  });

  it("finds nothing between unrelated windows", () => {
    const a = buildSkipPictureWindow(0, Array.from({ length: 200 }, (_, i) => busyFrame(10_000 + i)));
    const b = buildSkipPictureWindow(0, Array.from({ length: 200 }, (_, i) => busyFrame(20_000 + i)));
    expect(skipPicturePairRuns(a, 200, b, 200, { gapSeconds: 2, minSeconds: 8, maxSeconds: 130 })).toBeNull();
  });
});

describe("skipPictureConsensus", () => {
  it("takes the medians of the runs that agree and ignores the odd one", () => {
    expect(
      skipPictureConsensus([
        [10, 30],
        [10.5, 30.5],
        [11, 31],
        [200, 210],
      ])
    ).toEqual({ start: 10.5, end: 30.5, support: 3 });
  });
});

describe("detectSkipPicture", () => {
  it("gives a lone episode nothing", () => {
    expect(detectSkipPicture([episode(1, 30)]).size).toBe(0);
  });

  it("finds each episode's intro and credits start", () => {
    const eps = [episode(1, 30), episode(2, 55), episode(3, 12)];
    const found = detectSkipPicture(eps);
    for (const [ep, at] of [
      ["e1", 30],
      ["e2", 55],
      ["e3", 12],
    ] as const) {
      const r = found.get(ep)!;
      expect(r.intro!.start).toBeCloseTo(at - SKIP_PICTURE_EDGE_SHIFT, 0);
      expect(r.intro!.end).toBeCloseTo(at + 20 - SKIP_PICTURE_EDGE_SHIFT, 0);
      expect(r.intro!.compared).toBe(2);
      expect(r.credits).toBeCloseTo(1300 - 15 - SKIP_PICTURE_EDGE_SHIFT, 0);
    }
  });

  it("@req MPV-PREV-07 the async form, which gives the event loop turns between pairs, finds exactly the same", async () => {
    const eps = [episode(1, 30), episode(2, 55), episode(3, 12)];
    expect([...(await detectSkipPictureAsync(eps))]).toEqual([...detectSkipPicture(eps)]);
  });
});

describe("stored forms", () => {
  it("round-trips a window through the payload", () => {
    const ep = episode(1, 30);
    const payload = { fps: SKIP_PICTURE_FPS, head: skipPictureWindowToPayload(ep.head), tail: skipPictureWindowToPayload(ep.tail) };
    const back = skipEpisodePictureFromPayload({ id: "e1", season: 1, episode: 1 }, 1300, JSON.parse(JSON.stringify(payload)));
    expect(back).toEqual(ep);
    expect(skipEpisodePictureFromPayload({ id: "e1", season: 1, episode: 1 }, 1300, { ...payload, fps: 5 })).toBeNull();
  });

  it("round-trips a signature and rejects other bytes", async () => {
    const ep = episode(1, 30);
    const signature = {
      version: 1 as const,
      durationSeconds: 1300,
      audio: null,
      picture: { fps: SKIP_PICTURE_FPS, head: skipPictureWindowToPayload(ep.head), tail: skipPictureWindowToPayload(ep.tail) },
    };
    expect(decodeSkipSignature(encodeSkipSignature(signature))).toEqual(signature);
    expect(decodeSkipSignature(new Uint8Array([1, 2, 3]))).toBeNull();
    // Compressed off the event loop: the same bytes, read back the same way.
    const bytes = await encodeSkipSignatureAsync(signature);
    expect(Buffer.from(bytes).equals(Buffer.from(encodeSkipSignature(signature)))).toBe(true);
    expect(await decodeSkipSignatureAsync(bytes)).toEqual(signature);
    expect(await decodeSkipSignatureAsync(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

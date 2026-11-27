/**
 * @test-id PARROT-INGEST-COVERS-001
 * @level unit
 * @why PAR-META-04 / PAR-COPY-01: the desktop shows an album's cover from the user's own encrypted copy. The loader
 *      downloads a cover once, keeps it on disk still sealed (never the plain picture), opens it with the library key,
 *      drops a damaged kept copy so the next look downloads it again, and forgets everything on sign-out.
 * @covers packages/parrot-ingest/src/covers.ts
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { encryptBytesToBytes } from "@space/library-db-runtime/crypto";
import { PARROT_COVER_LARGE_WIDTH, PARROT_COVER_THUMB_WIDTH, parrotCoverMime, parrotCoverSquare } from "@space/parrot-core";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import {
  createParrotCoverLoader,
  makeParrotCoverCopies,
  parrotCoverProblem,
  parrotWebpGifSize,
  PARROT_COVER_KEEP_MAX_BYTES,
  PARROT_COVER_MAX_BYTES,
} from "../src/covers";
import { PARROT_APP_ID } from "../src/importer";
import { makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-COVERS-001");
const KEY = randomBytes(32).toString("base64");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(200)]);

describe("parrot covers", () => {
  let dir: string;
  let objects: Map<string, Uint8Array>;
  let downloads: Array<{ objectKey: string; options: unknown; appId: unknown }>;
  const messages: string[] = [];

  const loader = (maxBytes?: number) =>
    createParrotCoverLoader({
      maxBytes,
      token: () => "token-abc",
      libraryKeyBase64: () => KEY,
      clientType: "parrot-desktop",
      cacheDir: path.join(dir, "covers"),
      appId: PARROT_APP_ID,
      log: (message) => messages.push(message),
      download: (async (_token: string, objectKey: string, options: unknown, appId: unknown) => {
        downloads.push({ objectKey, options, appId });
        const sealed = objects.get(objectKey);
        if (!sealed) throw new Error(`404 ${objectKey}`);
        return sealed;
      }) as never,
    });

  beforeEach(async () => {
    dir = await makeTempDir("covers-loader");
    objects = new Map([["assets/one", await encryptBytesToBytes(KEY, JPEG)]]);
    downloads = [];
    messages.length = 0;
  });

  afterEach(async () => {
    log("messages", messages);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("sniffs the picture types a window can show and refuses the rest", () => {
    expect(parrotCoverMime(JPEG)).toBe("image/jpeg");
    expect(parrotCoverMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(parrotCoverMime(new TextEncoder().encode("RIFF....WEBPVP8 "))).toBe("image/webp");
    expect(parrotCoverMime(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(parrotCoverMime(new TextEncoder().encode("<svg/>"))).toBeNull();
    expect(parrotCoverProblem({ bytes: JPEG, mime: "image/jpeg" })).toBeNull();
    expect(parrotCoverProblem({ bytes: new Uint8Array(), mime: "image/jpeg" })).toBe("empty picture");
    expect(parrotCoverProblem({ bytes: new Uint8Array(PARROT_COVER_MAX_BYTES + 1).fill(0xff), mime: "image/jpeg" })).toContain("too large");
    expect(parrotCoverProblem({ bytes: new TextEncoder().encode("<svg/>"), mime: "image/svg+xml" })).toContain("not a JPEG");
  });

  it("downloads a cover once, keeps it sealed on disk and opens it with the library key", async () => {
    const covers = loader();
    const [first, again] = await Promise.all([covers.load("assets/one"), covers.load("assets/one")]);
    const later = await covers.load("assets/one");
    log("downloads", downloads);
    expect(first?.mime).toBe("image/jpeg");
    expect(Buffer.from(first!.bytes).equals(Buffer.from(JPEG))).toBe(true);
    expect(again).toBe(first);
    expect(Buffer.from(later!.bytes).equals(Buffer.from(JPEG))).toBe(true);
    expect(downloads).toEqual([{ objectKey: "assets/one", options: { clientType: "parrot-desktop", purpose: "library" }, appId: PARROT_APP_ID }]);

    const kept = await fs.readdir(path.join(dir, "covers"));
    log("kept", kept);
    expect(kept).toHaveLength(1);
    const keptBytes = await fs.readFile(path.join(dir, "covers", kept[0]!));
    expect(keptBytes.includes(Buffer.from(JPEG.subarray(4, 40)))).toBe(false);

    // A new loader (Parrot started again) uses the kept copy without downloading.
    expect((await loader().load("assets/one"))?.mime).toBe("image/jpeg");
    expect(downloads).toHaveLength(1);
  });

  it("gives null for a missing cover, drops a damaged kept copy and forgets everything on clear", async () => {
    const covers = loader();
    expect(await covers.load("assets/missing")).toBeNull();
    await covers.load("assets/one");
    const [kept] = await fs.readdir(path.join(dir, "covers"));
    await fs.writeFile(path.join(dir, "covers", kept!), "damaged");
    expect(await covers.load("assets/one")).toBeNull();
    expect(await fs.readdir(path.join(dir, "covers"))).toEqual([]);
    expect((await covers.load("assets/one"))?.mime).toBe("image/jpeg");
    expect(downloads.map((call) => call.objectKey)).toEqual(["assets/missing", "assets/one", "assets/one"]);

    await covers.clear();
    expect(await fs.stat(path.join(dir, "covers")).catch(() => null)).toBeNull();
    expect(messages.some((m) => m.includes("assets/missing"))).toBe(true);
    expect(messages.some((m) => m.includes("(kept copy)"))).toBe(true);
  });

  // @req PAR-COPY-01 @test-id PARROT-INGEST-COVERS-KEEP-001 @level integration (real files)
  // @why Chris 2026-11-16: the local copy of the vault's pictures is bounded by bytes and kept across restarts. Before
  //   this the covers folder grew with every album ever shown.
  it("keeps at most maxBytes of sealed covers, dropping the least recently shown first", async () => {
    const klog = testLog("PARROT-INGEST-COVERS-KEEP-001");
    for (const name of ["two", "three"]) objects.set(`assets/${name}`, await encryptBytesToBytes(KEY, JPEG));
    const size = objects.get("assets/one")!.byteLength;
    const covers = loader(size * 2 + 10);
    klog("phase=arrange", { size, maxBytes: size * 2 + 10 });
    await covers.load("assets/one");
    await covers.load("assets/two");
    // Shown once more: "one" is now the more recent of the two.
    const kept = await fs.readdir(path.join(dir, "covers"));
    const past = new Date(Date.now() - 60_000);
    for (const name of kept) await fs.utimes(path.join(dir, "covers", name), past, past);
    await covers.load("assets/one");
    await covers.load("assets/three");
    const after = await fs.readdir(path.join(dir, "covers"));
    klog("phase=act", { before: kept.length, after: after.length });
    expect(after).toHaveLength(2);

    // A restarted loader finds "one" and "three" kept, and must fetch "two" from storage again.
    downloads = [];
    const restarted = loader(size * 2 + 10);
    await restarted.load("assets/one");
    await restarted.load("assets/three");
    klog("phase=assert", { downloads: downloads.map((call) => call.objectKey) });
    expect(downloads).toEqual([]);
    expect((await restarted.load("assets/two"))?.mime).toBe("image/jpeg");
    expect(downloads.map((call) => call.objectKey)).toEqual(["assets/two"]);
  });
});

// @req PAR-META-04
describe("makeParrotCoverCopies", () => {
  const clog = testLog("PARROT-INGEST-COVERS-002");
  const solid = (width: number, height: number, rgba: [number, number, number, number]) => {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
    return { width, height, data };
  };
  const size = (bytes: Uint8Array) => {
    const image = jpeg.decode(bytes, { useTArray: true });
    return { width: image.width, height: image.height, mime: parrotCoverMime(bytes) };
  };

  it("shrinks a print-size JPEG to a 1200 px large copy and a 500 px small copy, both far smaller", () => {
    const original = new Uint8Array(jpeg.encode(solid(3000, 2400, [200, 40, 40, 255]), 95).data);
    const started = performance.now();
    const copies = makeParrotCoverCopies(original, (m) => clog(m))!;
    clog("copies", { ms: Math.round(performance.now() - started), original: original.length, large: copies.large.length, thumb: copies.thumb?.length });
    expect(size(copies.large)).toEqual({ width: PARROT_COVER_LARGE_WIDTH, height: 960, mime: "image/jpeg" });
    expect(size(copies.thumb!)).toEqual({ width: PARROT_COVER_THUMB_WIDTH, height: 400, mime: "image/jpeg" });
    expect(copies.large.length).toBeLessThan(original.length);
    expect(copies.thumb!.length).toBeLessThan(copies.large.length);
    // The colour survives the shrink.
    const pixel = jpeg.decode(copies.thumb!, { useTArray: true }).data;
    clog("thumb first pixel", Array.from(pixel.subarray(0, 4)));
    expect(Math.abs(pixel[0]! - 200)).toBeLessThan(8);
    expect(Math.abs(pixel[1]! - 40)).toBeLessThan(8);
  });

  it("keeps a picture no wider than 1200 px as it is and adds a small copy only when it is wider than 500 px", () => {
    const medium = new Uint8Array(jpeg.encode(solid(800, 800, [10, 200, 10, 255]), 90).data);
    const mediumCopies = makeParrotCoverCopies(medium)!;
    expect(Buffer.from(mediumCopies.large).equals(Buffer.from(medium))).toBe(true);
    expect(size(mediumCopies.thumb!)).toEqual({ width: 500, height: 500, mime: "image/jpeg" });

    const small = new Uint8Array(jpeg.encode(solid(300, 300, [10, 10, 200, 255]), 90).data);
    const smallCopies = makeParrotCoverCopies(small)!;
    clog("small", { large: smallCopies.large.length, thumb: smallCopies.thumb });
    expect(smallCopies).toEqual({ large: small, thumb: null });
  });

  it("shrinks a PNG, laying see-through parts on black", () => {
    const png = new PNG({ width: 1000, height: 1000 });
    png.data.set(solid(1000, 1000, [255, 255, 255, 0]).data);
    const bytes = new Uint8Array(PNG.sync.write(png));
    const copies = makeParrotCoverCopies(bytes)!;
    expect(Buffer.from(copies.large).equals(Buffer.from(bytes))).toBe(true);
    const thumb = jpeg.decode(copies.thumb!, { useTArray: true });
    clog("png thumb", { width: thumb.width, firstPixel: Array.from(thumb.data.subarray(0, 4)) });
    expect(thumb.width).toBe(500);
    expect(thumb.data[0]!).toBeLessThan(8);
  });

  it("keeps a damaged JPEG as it is with no small copy, and says why", () => {
    const messages: string[] = [];
    expect(makeParrotCoverCopies(JPEG, (m) => messages.push(m))).toEqual({ large: JPEG, thumb: null });
    clog("damaged", messages);
    expect(messages.some((m) => m.includes("could not be decoded"))).toBe(true);
  });

  // @bugfix @regression-proof: a user's album (2026-11-12) carries a 4000x4000 cover of 5,357,861 bytes in
  // every file; each was refused as "too large" (then 4 MiB) and the album was left with no cover at all, although the
  // picture only needed shrinking like any other print-size scan.
  // Pure-JS JPEG work on 2000 × 2000 noise: about 3 s on an idle machine, so bun's 5 s default fails it on a busy runner.
  it("shrinks a print-size JPEG over 4 MiB instead of refusing it", () => {
    const noise = { width: 2000, height: 2000, data: new Uint8Array(randomBytes(2000 * 2000 * 4)) };
    const original = new Uint8Array(jpeg.encode(noise, 98).data);
    clog("oversized original", { bytes: original.length, keepAsIsMax: PARROT_COVER_KEEP_MAX_BYTES, max: PARROT_COVER_MAX_BYTES });
    expect(original.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(parrotCoverProblem({ bytes: original, mime: "image/jpeg" })).toBeNull();
    const started = performance.now();
    const copies = makeParrotCoverCopies(original, (m) => clog(m))!;
    clog("oversized copies", { ms: Math.round(performance.now() - started), large: copies.large.length, thumb: copies.thumb?.length });
    expect(size(copies.large)).toEqual({ width: PARROT_COVER_LARGE_WIDTH, height: PARROT_COVER_LARGE_WIDTH, mime: "image/jpeg" });
    expect(size(copies.thumb!)).toEqual({ width: PARROT_COVER_THUMB_WIDTH, height: PARROT_COVER_THUMB_WIDTH, mime: "image/jpeg" });
    expect(copies.large.length).toBeLessThan(original.length);
  }, 30_000);

  it("skips a damaged picture too big to keep as it is, and says why", () => {
    const big = new Uint8Array(PARROT_COVER_KEEP_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff, 0xe0]);
    const messages: string[] = [];
    expect(makeParrotCoverCopies(big, (m) => messages.push(m))).toBeNull();
    clog("damaged and big", messages);
    expect(messages.some((m) => m.includes("could not be decoded") && m.includes("skipped"))).toBe(true);
  });

  // Headers as the formats lay them out; only the fields the size is read from are filled in.
  const gif = (width: number, height = 1) => new Uint8Array([...new TextEncoder().encode("GIF89a"), width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0]);
  const webp = (chunk: "VP8 " | "VP8L" | "VP8X", width: number, height = 1) => {
    const bytes = new Uint8Array(40);
    bytes.set(new TextEncoder().encode(`RIFF....WEBP${chunk}`));
    if (chunk === "VP8 ") bytes.set([width & 0xff, (width >> 8) & 0x3f, height & 0xff, (height >> 8) & 0x3f], 26);
    if (chunk === "VP8L") {
      const bits = (width - 1) + (height - 1) * 0x4000;
      bytes.set([bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff], 21);
    }
    if (chunk === "VP8X") {
      bytes.set([(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, ((width - 1) >> 16) & 0xff], 24);
      bytes.set([(height - 1) & 0xff, ((height - 1) >> 8) & 0xff, ((height - 1) >> 16) & 0xff], 27);
    }
    return bytes;
  };

  it("reads a WebP's or GIF's size from its header", () => {
    expect(parrotWebpGifSize(gif(640, 480))).toEqual({ width: 640, height: 480 });
    expect(parrotWebpGifSize(webp("VP8 ", 1200, 675))).toEqual({ width: 1200, height: 675 });
    expect(parrotWebpGifSize(webp("VP8L", 3000, 2000))).toEqual({ width: 3000, height: 2000 });
    expect(parrotWebpGifSize(webp("VP8X", 1201, 900))).toEqual({ width: 1201, height: 900 });
    expect(parrotWebpGifSize(new TextEncoder().encode("RIFF....WEBPVP8 "))).toBeNull();
    expect(parrotWebpGifSize(JPEG)).toBeNull();
  });

  it("keeps a WebP or GIF at most 1200 px wide as it is with no small copy, and skips a wider or unreadable one", () => {
    for (const small of [gif(1200), webp("VP8 ", 500), webp("VP8L", 1200), webp("VP8X", 800)]) {
      expect(makeParrotCoverCopies(small)).toEqual({ large: small, thumb: null });
    }
    const messages: string[] = [];
    for (const wide of [gif(1201), webp("VP8 ", 3000), webp("VP8L", 1201), webp("VP8X", 4000), new TextEncoder().encode("RIFF....WEBPVP8 ")]) {
      expect(makeParrotCoverCopies(wide, (m) => messages.push(m))).toBeNull();
    }
    clog("skipped", messages);
    expect(messages.filter((m) => m.includes("skipped"))).toHaveLength(5);
  });
});

// @req PAR-META-22
describe("album covers are square", () => {
  const clog = testLog("PARROT-INGEST-COVERS-003");
  // A 1280 × 720 picture in three upright bands: red, green, blue.
  const thirds = () => {
    const width = 1280;
    const height = 720;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const band = Math.min(2, Math.floor((x * 3) / width));
        data.set(band === 0 ? [220, 20, 20, 255] : band === 1 ? [20, 220, 20, 255] : [20, 20, 220, 255], (y * width + x) * 4);
      }
    }
    return new Uint8Array(jpeg.encode({ width, height, data }, 92).data);
  };
  const decoded = (bytes: Uint8Array) => jpeg.decode(bytes, { useTArray: true });
  const at = (image: { width: number; data: Uint8Array }, x: number, y: number) => Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));
  const near = (pixel: number[], rgb: number[]) => pixel.every((value, i) => Math.abs(value - rgb[i]!) < 24);

  it("cuts a wide album cover to its centre square by default", () => {
    const messages: string[] = [];
    const copies = makeParrotCoverCopies(thirds(), (m) => messages.push(m), { square: true })!;
    const large = decoded(copies.large);
    const thumb = decoded(copies.thumb!);
    clog("centre", { large: [large.width, large.height], thumb: [thumb.width, thumb.height], messages });
    expect([large.width, large.height]).toEqual([720, 720]);
    expect([thumb.width, thumb.height]).toEqual([500, 500]);
    // The centre square (x 280–999) starts in the red band and ends in the blue one, green in the middle.
    expect(near(at(large, 10, 360), [220, 20, 20])).toBe(true);
    expect(near(at(large, 360, 360), [20, 220, 20])).toBe(true);
    expect(near(at(large, 710, 360), [20, 20, 220])).toBe(true);
    expect(messages.some((m) => m.includes("cut to the square 720 × 720 at 280,0"))).toBe(true);
  });

  it("cuts the square the user framed", () => {
    const crop = { left: 40 / 1280, top: 100 / 720, size: 0.5 };
    const messages: string[] = [];
    const copies = makeParrotCoverCopies(thirds(), (m) => messages.push(m), { square: true, crop })!;
    const large = decoded(copies.large);
    clog("framed", { large: [large.width, large.height], thumb: copies.thumb, messages });
    expect([large.width, large.height]).toEqual([360, 360]);
    expect(copies.thumb).toBeNull();
    // x 40–399, all inside the red band (0–426).
    for (const [x, y] of [[5, 5], [180, 180], [354, 354]] as const) expect(near(at(large, x, y), [220, 20, 20])).toBe(true);
    expect(messages.some((m) => m.includes("cut to the square 360 × 360 at 40,100"))).toBe(true);
  });

  it("keeps a square picture as it is, and a framing past the edge stays inside the picture", () => {
    const square = new Uint8Array(jpeg.encode({ width: 600, height: 600, data: new Uint8Array(600 * 600 * 4).fill(128) }, 90).data);
    const copies = makeParrotCoverCopies(square, undefined, { square: true })!;
    expect(Buffer.from(copies.large).equals(Buffer.from(square))).toBe(true);
    expect(parrotCoverSquare(1280, 720, { left: 0.9, top: 0.9, size: 0.5 })).toEqual({ x: 920, y: 360, side: 360 });
    expect(parrotCoverSquare(1280, 720, { left: 0, top: 0, size: 3 })).toEqual({ x: 0, y: 0, side: 720 });
    expect(parrotCoverSquare(720, 1280)).toEqual({ x: 0, y: 280, side: 720 });
  });

  it("keeps an artist photo's shape", () => {
    const photo = new Uint8Array(jpeg.encode({ width: 1200, height: 675, data: new Uint8Array(1200 * 675 * 4).fill(90) }, 90).data);
    const copies = makeParrotCoverCopies(photo)!;
    const large = decoded(copies.large);
    expect([large.width, large.height]).toEqual([1200, 675]);
  });
});

/// <reference path="./pngjs.d.ts" />
// The reference carries the untyped pngjs declaration to the apps that compile this source (the desktop app).
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { decryptBytesToBytes, encryptBytesToBytes } from "@space/library-db-runtime/crypto";
import { downloadStorageObjectViaTunnel, type uploadStorageObjectViaTunnel } from "@space/library-db-runtime/api";
import {
  PARROT_COVER_KEEP_BYTES,
  PARROT_COVER_LARGE_WIDTH,
  PARROT_COVER_MAX_BYTES,
  PARROT_COVER_THUMB_WIDTH,
  parrotCoverMime,
  parrotCoverSquare,
  parrotCoversToDrop,
  parrotPictureSize,
  parrotPictureSizeProblem,
  type ParrotCoverCopies,
  type ParrotCoverCrop,
} from "@space/parrot-core";

/**
 * Album covers taken from the user's own music files (PAR-META-04's third source). Each cover is kept as two
 * encrypted objects in the user's storage, a small one (500 px wide) for tiles and lists and a large one (1200 px
 * wide) for the album page and the player, sealed with the library key in the AES-GCM envelope every SpaceFleet app
 * writes for library data and artwork (`IV(12) | ciphertext | tag(16)`, as Badger's artwork copies, META-ART-01),
 * under random names, so the apps show it from the user's own copy and never ask a server for it (PAR-COPY-01).
 */

/** A picture this module cannot decode or shrink is stored as it is only up to this size, and skipped above it. */
export const PARROT_COVER_KEEP_MAX_BYTES = 4 * 1024 * 1024;

export type ParrotCoverImage = { bytes: Uint8Array; mime: string };

/** Why a file's picture is not used as the album's cover, or null when it is usable. */
export const parrotCoverProblem = (cover: ParrotCoverImage): string | null => {
  if (cover.bytes.length === 0) return "empty picture";
  if (cover.bytes.length > PARROT_COVER_MAX_BYTES) return `picture too large (${cover.bytes.length} bytes, at most ${PARROT_COVER_MAX_BYTES})`;
  if (!parrotCoverMime(cover.bytes)) return `not a JPEG, PNG, WebP or GIF picture (tagged ${cover.mime || "without a type"})`;
  return null;
};

type Pixels = { width: number; height: number; data: Uint8Array };

/** Decodes a JPEG or PNG into RGBA pixels; null for any other kind. */
const decodeCover = (bytes: Uint8Array): Pixels | null => {
  const mime = parrotCoverMime(bytes);
  if (mime === "image/jpeg") {
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { width: image.width, height: image.height, data: image.data };
  }
  if (mime === "image/png") {
    const image = PNG.sync.read(Buffer.from(bytes));
    return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
  }
  return null;
};

/**
 * Shrinks `source` to `width` (height in proportion) by averaging every source pixel each output pixel covers, the
 * way a picture viewer shrinks without blur or jagged edges; see-through parts are laid on black, the apps' dark
 * background, since the copy is a JPEG.
 */
const shrinkToJpeg = (source: Pixels, width: number, quality: number): Uint8Array => {
  const scale = source.width / width;
  const height = Math.max(1, Math.round(source.height / scale));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.min(source.height, Math.max(y0 + 1, Math.floor((y + 1) * scale)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(source.width, Math.max(x0 + 1, Math.floor((x + 1) * scale)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * source.width + sx) * 4;
          const alpha = source.data[at + 3]! / 255;
          r += source.data[at]! * alpha;
          g += source.data[at + 1]! * alpha;
          b += source.data[at + 2]! * alpha;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const to = (y * width + x) * 4;
      out[to] = Math.round(r / count);
      out[to + 1] = Math.round(g / count);
      out[to + 2] = Math.round(b / count);
      out[to + 3] = 255;
    }
  }
  return new Uint8Array(jpeg.encode({ data: out, width, height }, quality).data);
};

/** Whether this module can decode, cut and shrink the picture (a JPEG or PNG); a WebP or GIF the window cuts instead. */
export const parrotCoverDecodable = (bytes: Uint8Array): boolean => {
  const mime = parrotCoverMime(bytes);
  return mime === "image/jpeg" || mime === "image/png";
};

/** The `side` × `side` square of `source` at `x`, `y`. */
const cutSquare = (source: Pixels, square: { x: number; y: number; side: number }): Pixels => {
  const data = new Uint8Array(square.side * square.side * 4);
  for (let row = 0; row < square.side; row++) {
    const from = ((square.y + row) * source.width + square.x) * 4;
    data.set(source.data.subarray(from, from + square.side * 4), row * square.side * 4);
  }
  return { width: square.side, height: square.side, data };
};

/**
 * `square`: the picture is an album cover, cut to a square (PAR-META-22): `crop`, the square the user framed, else the
 * centre one. An artist photo from a lookup keeps its shape. `reencode`: the picture is one the user gave (an edited
 * cover or artist photo, PAR-META-31): it is refused when its header declares more than the pixel cap or cannot be
 * read, and never stored as it is, the large copy always re-encoded to a JPEG of at most 1200 px.
 */
export type ParrotCoverCopyOptions = { square?: boolean; crop?: ParrotCoverCrop | null; reencode?: boolean };

/**
 * The large and small copies of a file's picture (PAR-COPY-01). A JPEG or PNG already no wider than 1200 px is kept
 * as it is for the large copy (re-encoded when it weighs over PARROT_COVER_KEEP_MAX_BYTES); a wider one is shrunk to
 * 1200 px. The small copy is the picture shrunk to 500 px, or none when it is that small already. An album cover
 * (`square`) is first cut to its square (PAR-META-22) and then re-encoded. A WebP or GIF, which neither library here
 * decodes, is kept as it is with no small copy when its header says it is at most 1200 px wide, and skipped (null)
 * otherwise, so no stored cover is wider than the large size (PAR-META-04); the desktop has its window cut such a
 * cover before it comes here. A JPEG or PNG that cannot be decoded is kept as it is with no small copy, or skipped
 * (null) when over PARROT_COVER_KEEP_MAX_BYTES. A picture the user gave (`reencode`) is checked against the caps first
 * and always re-encoded (PAR-META-31).
 */
export const makeParrotCoverCopies = (bytes: Uint8Array, log: (message: string) => void = () => {}, options: ParrotCoverCopyOptions = {}): ParrotCoverCopies | null => {
  const mime = parrotCoverMime(bytes);
  if (options.reencode) {
    const problem = parrotPictureSizeProblem(bytes);
    if (problem) {
      log(`[covers] picture refused before decoding: ${problem}`);
      return null;
    }
  }
  if (mime === "image/webp" || mime === "image/gif") {
    const size = parrotPictureSize(bytes);
    if (options.reencode || size === null || size.width > PARROT_COVER_LARGE_WIDTH) {
      log(`[covers] ${mime} picture skipped: ${options.reencode ? "a picture the user gave is re-encoded, and this kind is not decoded here" : size === null ? "its width could not be read" : `${size.width} px wide, over ${PARROT_COVER_LARGE_WIDTH}`}`);
      return null;
    }
    if (options.square && size.width !== size.height) log(`[covers] ${mime} picture ${size.width} × ${size.height} kept as it is, not cut to a square here`);
    return { large: bytes, thumb: null };
  }
  let pixels: Pixels | null = null;
  let failure = "not a JPEG or PNG";
  try {
    pixels = decodeCover(bytes);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (!pixels) {
    if (options.reencode || bytes.length > PARROT_COVER_KEEP_MAX_BYTES) {
      log(`[covers] picture skipped, it could not be decoded (${failure}) and ${options.reencode ? "a picture the user gave is never stored as it is" : `is too big to keep as it is (${bytes.length} bytes)`}`);
      return null;
    }
    log(`[covers] picture kept as it is, it could not be decoded: ${failure}`);
    return { large: bytes, thumb: null };
  }
  let cut = false;
  if (options.square) {
    const square = parrotCoverSquare(pixels.width, pixels.height, options.crop);
    if (square.side !== pixels.width || square.side !== pixels.height) {
      log(`[covers] ${pixels.width} × ${pixels.height} picture cut to the square ${square.side} × ${square.side} at ${square.x},${square.y}`);
      pixels = cutSquare(pixels, square);
      cut = true;
    }
  }
  const heavy = bytes.length > PARROT_COVER_KEEP_MAX_BYTES;
  if (options.reencode) log(`[covers] ${pixels.width} × ${pixels.height} picture re-encoded to at most ${PARROT_COVER_LARGE_WIDTH} px`);
  return {
    large: pixels.width > PARROT_COVER_LARGE_WIDTH || heavy || cut || options.reencode ? shrinkToJpeg(pixels, Math.min(pixels.width, PARROT_COVER_LARGE_WIDTH), 90) : bytes,
    thumb: pixels.width > PARROT_COVER_THUMB_WIDTH ? shrinkToJpeg(pixels, PARROT_COVER_THUMB_WIDTH, 85) : null,
  };
};

/**
 * PAR-UP-08: a picture as the import review shows it, with its own size for "Frame the cover": a JPEG or PNG shrunk
 * to the 500 px small copy (a 4000 px scan never crosses to the window whole), a WebP or GIF as it is. Null when it
 * cannot be read.
 */
export const parrotCoverPreview = (bytes: Uint8Array): { bytes: Uint8Array; mime: string; width: number; height: number } | null => {
  const mime = parrotCoverMime(bytes);
  if (!mime) return null;
  if (!parrotCoverDecodable(bytes)) {
    const size = parrotPictureSize(bytes);
    return size ? { bytes, mime, ...size } : null;
  }
  let pixels: Pixels | null = null;
  try {
    pixels = decodeCover(bytes);
  } catch {
    return null;
  }
  if (!pixels) return null;
  const small = pixels.width > PARROT_COVER_THUMB_WIDTH ? shrinkToJpeg(pixels, PARROT_COVER_THUMB_WIDTH, 85) : null;
  return { bytes: small ?? bytes, mime: small ? "image/jpeg" : mime, width: pixels.width, height: pixels.height };
};

/** Seals the picture with the library key and stores it in the user's library storage; returns its object key. */
export const uploadParrotCover = async (input: {
  token: string;
  libraryKeyBase64: string;
  bytes: Uint8Array;
  clientType: string;
  appId: Parameters<typeof uploadStorageObjectViaTunnel>[4];
  upload: typeof uploadStorageObjectViaTunnel;
}): Promise<string> => {
  const sealed = await encryptBytesToBytes(input.libraryKeyBase64, input.bytes);
  return input.upload(
    input.token,
    `assets/${crypto.randomUUID()}`,
    sealed,
    {
      objectNamespace: "library",
      contentType: "application/octet-stream",
      clientType: input.clientType,
      counting: { role: "artwork" },
    },
    input.appId
  );
};

/** Opens a stored cover with the library key; throws on a wrong key or a damaged object. */
export const openParrotCover = (sealed: Uint8Array, libraryKeyBase64: string): Promise<Uint8Array> =>
  decryptBytesToBytes(libraryKeyBase64, sealed);

export type ParrotCoverLoader = {
  /** The album cover stored under `objectKey`, opened; null when it cannot be had (logged). */
  load(objectKey: string): Promise<ParrotCoverImage | null>;
  /** Forgets every cover kept on this computer (sign-out). */
  clear(): Promise<void>;
};

/**
 * Gives the desktop its album covers from the user's own storage (PAR-COPY-01). A cover is downloaded once and kept
 * in `cacheDir` still sealed (never as a plain picture on disk); each `load` opens it with the library key. A cover's
 * key is a random name that never changes content, so a kept copy never goes stale. The folder holds at most
 * `maxBytes` (PAR-COPY-01): each look marks its file as just shown, and after each download the least recently shown
 * covers past the bound are deleted; one shown again is downloaded from the user's storage, never looked up anew.
 */
export const createParrotCoverLoader = (input: {
  token: () => string;
  libraryKeyBase64: () => string;
  clientType: string;
  cacheDir: string;
  /** Bytes of sealed covers kept on disk; defaults to `PARROT_COVER_KEEP_BYTES.desktop`. */
  maxBytes?: number;
  appId: Parameters<typeof downloadStorageObjectViaTunnel>[3];
  download?: typeof downloadStorageObjectViaTunnel;
  log?: (message: string) => void;
}): ParrotCoverLoader => {
  const download = input.download ?? downloadStorageObjectViaTunnel;
  const log = input.log ?? (() => {});
  const inFlight = new Map<string, Promise<ParrotCoverImage | null>>();
  const maxBytes = input.maxBytes ?? PARROT_COVER_KEEP_BYTES.desktop;
  const keptFile = (objectKey: string) => path.join(input.cacheDir, `${crypto.createHash("sha256").update(objectKey).digest("hex")}.sealed`);

  /** Deletes the least recently shown covers past `maxBytes`, never `justKept`. One trim runs at a time. */
  let trimming = Promise.resolve();
  const trim = (justKept: string) => {
    trimming = trimming.then(async () => {
      const names = await fs.readdir(input.cacheDir).catch(() => [] as string[]);
      const kept = (
        await Promise.all(
          names.map(async (name) => {
            const stat = await fs.stat(path.join(input.cacheDir, name)).catch(() => null);
            return stat?.isFile() ? { name, size: stat.size, usedAt: stat.mtimeMs } : null;
          })
        )
      ).filter((cover) => cover !== null);
      const drop = parrotCoversToDrop(kept, maxBytes, path.basename(justKept));
      for (const name of drop) await fs.rm(path.join(input.cacheDir, name), { force: true });
      if (drop.length) log(`[covers] kept ${kept.length} over ${maxBytes} bytes: dropped ${drop.length} least recently shown`);
    });
    return trimming;
  };

  const sealedCover = async (objectKey: string): Promise<{ sealed: Uint8Array; kept: boolean }> => {
    const file = keptFile(objectKey);
    try {
      const sealed = new Uint8Array(await fs.readFile(file));
      // Marks it as just shown, so the byte bound drops it last.
      const now = new Date();
      await fs.utimes(file, now, now).catch(() => undefined);
      return { sealed, kept: true };
    } catch {
      const sealed = await download(input.token(), objectKey, { clientType: input.clientType, purpose: "library" }, input.appId);
      await fs.mkdir(input.cacheDir, { recursive: true });
      await fs.writeFile(file, sealed);
      await trim(file);
      return { sealed, kept: false };
    }
  };

  const open = async (objectKey: string): Promise<ParrotCoverImage | null> => {
    let kept = false;
    try {
      const found = await sealedCover(objectKey);
      kept = found.kept;
      const bytes = await openParrotCover(found.sealed, input.libraryKeyBase64());
      const mime = parrotCoverMime(bytes);
      if (!mime) throw new Error("not a picture");
      return { bytes, mime };
    } catch (error) {
      log(`[covers] ${objectKey}${kept ? " (kept copy)" : ""}: ${error instanceof Error ? error.message : String(error)}`);
      // A damaged kept copy is dropped so the next look downloads it again.
      if (kept) await fs.rm(keptFile(objectKey), { force: true });
      return null;
    }
  };

  return {
    load: (objectKey) => {
      const running = inFlight.get(objectKey);
      if (running) return running;
      const loading = open(objectKey).finally(() => inFlight.delete(objectKey));
      inFlight.set(objectKey, loading);
      return loading;
    },
    clear: async () => {
      inFlight.clear();
      await fs.rm(input.cacheDir, { recursive: true, force: true });
    },
  };
};

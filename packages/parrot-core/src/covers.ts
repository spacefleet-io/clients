// Album covers in the user's own storage (PAR-META-04, PAR-COPY-01), shared by the import and every app that shows
// them. Each album keeps two encrypted copies: a small one for tiles, lists and the now-playing bar, and a large one
// for the screens that show the cover big (the album page, the full-screen player, the phone's lock-screen card and
// the computer's media panel).

/** Width of the small copy shown in album grids, song lists and the now-playing bar (the lookup's thumbnail size). */
export const PARROT_COVER_THUMB_WIDTH = 500;
/** Width of the large copy shown on the album page and the player (the size written into song files). */
export const PARROT_COVER_LARGE_WIDTH = 1200;

/**
 * A picture file larger than this is not read at all (PAR-META-31): a picture the user picks, drops or links is
 * refused before its bytes are read whole, and an import skips such a picture in a song file.
 */
export const PARROT_COVER_MAX_BYTES = 32 * 1024 * 1024;
/** A picture declaring more pixels than this is refused before it is decoded (PAR-META-31). */
export const PARROT_PICTURE_MAX_PIXELS = 50_000_000;
/** A picture declaring a side longer than this is refused before it is decoded (PAR-META-31). */
export const PARROT_PICTURE_MAX_SIDE = 12_000;

/** The image type from the picture's first bytes, or null for anything a browser or phone would not show. */
export const parrotCoverMime = (bytes: Uint8Array): string | null => {
  const at = (offset: number, ...values: number[]) => values.every((value, i) => bytes[offset + i] === value);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  return null;
};

const bigEndian = (bytes: Uint8Array, offset: number, length: number) => {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[offset + i]!;
  return value;
};

const littleEndian = (bytes: Uint8Array, offset: number, length: number) => {
  let value = 0;
  for (let i = length - 1; i >= 0; i--) value = value * 256 + bytes[offset + i]!;
  return value;
};

/**
 * The size a picture declares in its header, read without decoding it, or null when the header is cut short or of a
 * kind not read. JPEG: the first start-of-frame marker. PNG: IHDR. GIF: the logical screen. WebP: the `VP8 `, `VP8L`
 * or `VP8X` chunk's size.
 */
export const parrotPictureSize = (bytes: Uint8Array): { width: number; height: number } | null => {
  const mime = parrotCoverMime(bytes);
  if (mime === "image/png") return bytes.length >= 24 ? { width: bigEndian(bytes, 16, 4), height: bigEndian(bytes, 20, 4) } : null;
  if (mime === "image/gif") return bytes.length >= 10 ? { width: littleEndian(bytes, 6, 2), height: littleEndian(bytes, 8, 2) } : null;
  if (mime === "image/jpeg") {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bigEndian(bytes, at + 7, 2), height: bigEndian(bytes, at + 5, 2) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      at += 2 + bigEndian(bytes, at + 2, 2);
    }
    return null;
  }
  if (mime !== "image/webp") return null;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === "VP8 " && bytes.length >= 30) return { width: littleEndian(bytes, 26, 2) & 0x3fff, height: littleEndian(bytes, 28, 2) & 0x3fff };
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = littleEndian(bytes, 21, 4);
    return { width: 1 + (bits & 0x3fff), height: 1 + (Math.floor(bits / 0x4000) & 0x3fff) };
  }
  if (chunk === "VP8X" && bytes.length >= 30) return { width: 1 + littleEndian(bytes, 24, 3), height: 1 + littleEndian(bytes, 27, 3) };
  return null;
};

/**
 * PAR-META-31: why a picture the user gave is refused before it is decoded, or null when it may be decoded: over
 * PARROT_COVER_MAX_BYTES, not a JPEG, PNG, WebP or GIF, a header that does not say its size, or a size over
 * PARROT_PICTURE_MAX_SIDE or PARROT_PICTURE_MAX_PIXELS.
 */
export const parrotPictureSizeProblem = (bytes: Uint8Array): string | null => {
  if (bytes.length > PARROT_COVER_MAX_BYTES) return `picture too large (${bytes.length} bytes, at most ${PARROT_COVER_MAX_BYTES})`;
  if (!parrotCoverMime(bytes)) return "not a JPEG, PNG, WebP or GIF picture";
  const size = parrotPictureSize(bytes);
  if (!size || size.width < 1 || size.height < 1) return "the picture's size could not be read";
  if (size.width > PARROT_PICTURE_MAX_SIDE || size.height > PARROT_PICTURE_MAX_SIDE || size.width * size.height > PARROT_PICTURE_MAX_PIXELS) {
    return `picture too large (${size.width} × ${size.height} pixels, at most ${PARROT_PICTURE_MAX_SIDE} per side and ${PARROT_PICTURE_MAX_PIXELS} in all)`;
  }
  return null;
};

/** An album's two cover keys as the library stores them; an album imported before the small copy existed has none. */
export type ParrotCoverKeys = { coverObjectKey: string | null; coverThumbObjectKey: string | null };

/** The key to show in a tile or list: the small copy, else the large one. */
export const parrotCoverThumbKey = (album: ParrotCoverKeys): string | null => album.coverThumbObjectKey ?? album.coverObjectKey;

/** The two copies stored for an album: `thumb` is null when the large copy is already no wider than a thumbnail. */
export type ParrotCoverCopies = { large: Uint8Array; thumb: Uint8Array | null };

/**
 * PAR-META-22: the square of a picture an album cover keeps, in shares of the picture so it holds at any size of it
 * (the review frames the 500 px cover, the import cuts the 1200 px one): `left` of its width, `top` of its height,
 * `size` of its shorter side. Absent: the centre square.
 */
export type ParrotCoverCrop = { left: number; top: number; size: number };

/** The kept square in pixels of a `width` × `height` picture: the crop clamped inside it, or the centre square. */
export const parrotCoverSquare = (width: number, height: number, crop?: ParrotCoverCrop | null): { x: number; y: number; side: number } => {
  const shorter = Math.min(width, height);
  const share = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  const side = Math.max(1, Math.min(shorter, Math.round(share(crop?.size, 1) * shorter)));
  const x = crop ? Math.round(share(crop.left, 0) * width) : Math.floor((width - side) / 2);
  const y = crop ? Math.round(share(crop.top, 0) * height) : Math.floor((height - side) / 2);
  return { x: Math.max(0, Math.min(width - side, x)), y: Math.max(0, Math.min(height - side, y)), side };
};

/** The crop that keeps `square` (pixels of a `width` × `height` picture), in shares (ParrotCoverCrop). */
export const parrotCoverCropOf = (width: number, height: number, square: { x: number; y: number; side: number }): ParrotCoverCrop => ({
  left: square.x / width,
  top: square.y / height,
  size: square.side / Math.min(width, height),
});

/** Whether a crop the window sent is one: three finite shares, the size above nothing. */
export const isParrotCoverCrop = (value: unknown): value is ParrotCoverCrop => {
  if (typeof value !== "object" || value === null) return false;
  const { left, top, size } = value as Record<string, unknown>;
  const share = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  return share(left) && share(top) && share(size) && (size as number) > 0;
};

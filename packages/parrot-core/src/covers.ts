// Album covers in the user's own storage (PAR-META-04, PAR-COPY-01), shared by the import and every app that shows
// them. Each album keeps two encrypted copies: a small one for tiles, lists and the now-playing bar, and a large one
// for the screens that show the cover big (the album page, the full-screen player, the phone's lock-screen card and
// the computer's media panel).

/** Width of the small copy shown in album grids, song lists and the now-playing bar (the lookup's thumbnail size). */
export const PARROT_COVER_THUMB_WIDTH = 500;
/** Width of the large copy shown on the album page and the player (the size written into song files). */
export const PARROT_COVER_LARGE_WIDTH = 1200;

/** The image type from the picture's first bytes, or null for anything a browser or phone would not show. */
export const parrotCoverMime = (bytes: Uint8Array): string | null => {
  const at = (offset: number, ...values: number[]) => values.every((value, i) => bytes[offset + i] === value);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  return null;
};

/** An album's two cover keys as the library stores them; an album imported before the small copy existed has none. */
export type ParrotCoverKeys = { coverObjectKey: string | null; coverThumbObjectKey: string | null };

/** The key to show in a tile or list: the small copy, else the large one. */
export const parrotCoverThumbKey = (album: ParrotCoverKeys): string | null => album.coverThumbObjectKey ?? album.coverObjectKey;

/** The two copies stored for an album: `thumb` is null when the large copy is already no wider than a thumbnail. */
export type ParrotCoverCopies = { large: Uint8Array; thumb: Uint8Array | null };

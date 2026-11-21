/**
 * The album orders of the phone's library and of Home's "See all" (PAR-LOOK-01: the design's "Recently added"). The
 * desktop and the web player have more orders per tab (`libraryView.ts`, PAR-LIB-06).
 */
export const PARROT_ALBUM_SORTS = ["recent", "title", "artist"] as const;
export type ParrotAlbumSort = (typeof PARROT_ALBUM_SORTS)[number];

/** The design's default: the albums added last first. */
export const DEFAULT_PARROT_ALBUM_SORT: ParrotAlbumSort = "recent";

/** What the album orders read off an album. */
export type ParrotSortableAlbum = { title: string; artistName: string; year: number | null; addedAt: number };

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/**
 * A sorted copy of `albums`: "recent" newest added first (title breaks ties, as one import adds a whole folder at
 * once), "title" A to Z, "artist" by artist then year then title.
 */
export const sortParrotAlbums = <A extends ParrotSortableAlbum>(albums: readonly A[], sort: ParrotAlbumSort): A[] =>
  [...albums].sort((a, b) => {
    if (sort === "recent") return b.addedAt - a.addedAt || byText(a.title, b.title);
    if (sort === "title") return byText(a.title, b.title) || byText(a.artistName, b.artistName);
    return byText(a.artistName, b.artistName) || (a.year ?? 0) - (b.year ?? 0) || byText(a.title, b.title);
  });

/** Reads a stored pick back; anything unknown is the default. */
export const parseParrotAlbumSort = (value: string | null | undefined): ParrotAlbumSort =>
  (PARROT_ALBUM_SORTS as readonly string[]).includes(value ?? "") ? (value as ParrotAlbumSort) : DEFAULT_PARROT_ALBUM_SORT;

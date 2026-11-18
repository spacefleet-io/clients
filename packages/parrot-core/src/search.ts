/**
 * The library's search (PAR-LOOK-01, PAR-NAV-02), one for every Parrot surface (desktop, phone, web player), so the
 * same query finds the same rows everywhere: case and accents do not count, so "beyonce" finds "Beyoncé".
 */
export const foldSearch = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();

/**
 * True when every word of `query` appears in one of `fields` (folded, in any order: "daft discovery" finds Daft
 * Punk's "Discovery"); an empty query matches all.
 */
export const matchesSearch = (query: string, ...fields: Array<string | null | undefined>) => {
  const words = foldSearch(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = foldSearch(fields.filter(Boolean).join(" "));
  return words.every((word) => haystack.includes(word));
};

const filterBy = <T>(rows: readonly T[], query: string, fields: (row: T) => Array<string | null | undefined>): T[] =>
  query.trim() ? rows.filter((row) => matchesSearch(query, ...fields(row))) : [...rows];

/** The Albums view's search: an album's title and artist. */
export const filterParrotAlbums = <T extends { title: string; artistName?: string | null }>(albums: readonly T[], query: string): T[] =>
  filterBy(albums, query, (album) => [album.title, album.artistName]);

/** The Artists view's search: the artist's name. */
export const filterParrotArtists = <T extends { name: string }>(artists: readonly T[], query: string): T[] => filterBy(artists, query, (artist) => [artist.name]);

/** The Songs view's search: a song's title, artist and album. */
export const filterParrotTracks = <T extends { title: string; artistName?: string | null; albumTitle?: string | null }>(tracks: readonly T[], query: string): T[] =>
  filterBy(tracks, query, (track) => [track.title, track.artistName, track.albumTitle]);

/** The Playlists view's search: the name the playlist shows ("Liked songs" in the app's language for the fixed one). */
export const filterParrotPlaylists = <T>(playlists: readonly T[], query: string, nameOf: (playlist: T) => string): T[] =>
  filterBy(playlists, query, (playlist) => [nameOf(playlist)]);

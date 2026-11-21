// What the phone's search (UX-PHONE-12) looks through on Parrot: the whole library on the device, in three groups:
// Artists, Albums and Songs. As the desktop palette (UX-SEARCH-02): an album also matches by its artist, a song by its
// artist and its album.
import { createFuzzyIndex, type FuzzyIndex } from "@space/shared/fuzzySearch";
import type { ArtistRow, SongRow } from "@space/parrot-core";
import type { AlbumWithCover, WithCoverKeys } from "./library";

export type ParrotSearchItem =
  | { kind: "artist"; artist: ArtistRow }
  | { kind: "album"; album: AlbumWithCover }
  | { kind: "song"; song: WithCoverKeys<SongRow> };

export type ParrotSearchGroupId = "artists" | "albums" | "songs";

const fields = (item: ParrotSearchItem): string[] =>
  item.kind === "artist"
    ? [item.artist.name]
    : item.kind === "album"
      ? [item.album.title, item.album.artistName]
      : [item.song.title, item.song.artistName, item.song.albumTitle];

/** The three indexes, in the order the search shows them. Built once per library version, never per keystroke. */
export const buildParrotSearchGroups = (library: {
  artists: readonly ArtistRow[];
  albums: readonly AlbumWithCover[];
  songs: ReadonlyArray<WithCoverKeys<SongRow>>;
}): { id: ParrotSearchGroupId; index: FuzzyIndex<ParrotSearchItem> }[] => {
  const started = Date.now();
  const groups = [
    { id: "artists" as const, index: createFuzzyIndex<ParrotSearchItem>(library.artists.map((artist) => ({ kind: "artist", artist })), fields) },
    { id: "albums" as const, index: createFuzzyIndex<ParrotSearchItem>(library.albums.map((album) => ({ kind: "album", album })), fields) },
    { id: "songs" as const, index: createFuzzyIndex<ParrotSearchItem>(library.songs.map((song) => ({ kind: "song", song })), fields) },
  ];
  console.info(
    "phone-search.index",
    JSON.stringify({ artists: library.artists.length, albums: library.albums.length, songs: library.songs.length, ms: Date.now() - started }),
  );
  return groups;
};

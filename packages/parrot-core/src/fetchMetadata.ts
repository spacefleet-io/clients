/**
 * Fetching a song's or an album's details from our music library (PAR-META-18): what the anonymous lookup is asked
 * (the names and length the library holds, never the file) and how its best answer fills the edit dialog. Nothing is
 * written here: the user reviews the found values in the edit dialog and saves them like any edit (PAR-META-16).
 */
import type { MusicAlbum, MusicAlbumsQuery, MusicRecording, MusicRecordingsQuery } from "@space/shared/api";
import { parrotAlbumEditValues, parrotTrackEditValues, type ParrotAlbumEdit, type ParrotLibraryQuery, type ParrotTrackEdit } from "./manage";

export type ParrotMetadataTarget = { kind: "track" | "album"; id: string };

/** The found details next to the library's, so the dialog marks what would change. */
export type ParrotMetadataFetch =
  | { kind: "missing" }
  | { kind: "none" }
  | { kind: "track"; found: ParrotTrackEdit; current: ParrotTrackEdit }
  /** `coverId`: the album's id the cover is asked by (opaque, as the metadata gives it; PAR-META-19). */
  | { kind: "album"; found: Omit<ParrotAlbumEdit, "cover">; current: Omit<ParrotAlbumEdit, "cover">; coverId: string | null };

/** The best recording's names over the song's; what the lookup does not know (genre, a missing album) stays. */
export const parrotTrackFromRecording = (current: ParrotTrackEdit, found: MusicRecording): ParrotTrackEdit => ({
  title: found.title || current.title,
  artist: found.artist.name || current.artist,
  album: found.album?.title || current.album,
  number: found.album?.trackNumber ?? current.number,
  disc: found.album?.disc ?? current.disc,
  year: found.album?.year ?? current.year,
  genre: current.genre,
});

export const parrotAlbumFromLookup = (current: Omit<ParrotAlbumEdit, "cover">, found: MusicAlbum): Omit<ParrotAlbumEdit, "cover"> => ({
  title: found.title || current.title,
  albumArtist: found.artist.name || current.albumArtist,
  year: found.year ?? current.year,
  genre: current.genre,
});

/** Asks the lookup about one song or album; a lookup failure throws so the caller can show why. */
export const fetchParrotMetadata = async (args: {
  query: ParrotLibraryQuery;
  target: ParrotMetadataTarget;
  recordings: (question: MusicRecordingsQuery) => Promise<{ results: MusicRecording[] }>;
  albums: (question: MusicAlbumsQuery) => Promise<{ results: MusicAlbum[] }>;
}): Promise<ParrotMetadataFetch> => {
  if (args.target.kind === "track") {
    const current = await parrotTrackEditValues(args.query, args.target.id);
    if (!current?.title.trim() || !current.artist.trim()) return { kind: "missing" };
    const [length] = await args.query<{ durationMs: number | null }>("SELECT duration_ms AS durationMs FROM tracks WHERE id = ?", [args.target.id]);
    const durationMs = length?.durationMs;
    const album = current.album.trim();
    const { results } = await args.recordings({
      artist: current.artist.trim(),
      title: current.title.trim(),
      ...(album ? { album } : {}),
      ...(durationMs && durationMs > 0 ? { durationMs } : {}),
      limit: 1,
    });
    return results[0] ? { kind: "track", found: parrotTrackFromRecording(current, results[0]), current } : { kind: "none" };
  }
  const values = await parrotAlbumEditValues(args.query, args.target.id);
  if (!values?.title.trim() || !values.albumArtist.trim()) return { kind: "missing" };
  const { coverObjectKey: _cover, ...current } = values;
  const { results } = await args.albums({ artist: current.albumArtist.trim(), album: current.title.trim(), limit: 1 });
  return results[0]
    ? { kind: "album", found: parrotAlbumFromLookup(current, results[0]), current, coverId: results[0].id }
    : { kind: "none" };
};

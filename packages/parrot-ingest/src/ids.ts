import crypto from "node:crypto";
import { parrotAlbumId, parrotArtistId, parrotShortId } from "@space/parrot-core";

export const sha256Hex = (value: string | Uint8Array): string => crypto.createHash("sha256").update(value).digest("hex");

/**
 * The library IDs of one song, derived from its names and file so that importing the same file again, on any
 * device, lands on the same rows: an artist by name, an album by album artist and title, a song by album, disc,
 * number and title, a file by its content.
 */
export const parrotTrackIds = (input: {
  artist: string;
  albumArtist: string;
  album: string;
  disc: number;
  number: number;
  title: string;
  fileHash: string;
}) => {
  const artistId = parrotArtistId(input.artist);
  const albumArtistId = parrotArtistId(input.albumArtist);
  const albumId = parrotAlbumId(albumArtistId, input.album);
  const trackId = parrotShortId("tr", albumId, input.disc, input.number, input.title.toLowerCase());
  const fileId = parrotShortId("tf", input.fileHash);
  return { artistId, albumArtistId, albumId, trackId, fileId };
};

/** One song = one playable media = one placement (one silo), stable per account and file so a re-run resumes. */
export const parrotPlacementId = (userId: string, fileHash: string): string =>
  `parrot-${sha256Hex(`${userId}:${fileHash}`).slice(0, 32)}`;

export const parrotChunkKey = (fileId: string, idx: number): string => `${fileId}/chunk-${String(idx).padStart(5, "0")}`;

/** The sealed object holding a split file's own tags (PAR-FMT-01), next to its chunks. */
export const parrotTagsKey = (fileId: string): string => `${fileId}/tags`;

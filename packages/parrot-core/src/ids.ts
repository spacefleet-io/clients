/**
 * The library's name-derived IDs, shared by the importer and by every app that edits (PAR-META-16): an artist or
 * album the user types lands on the row an import of it would use, on any device. Pure JS SHA-256, so the phone
 * computes the same IDs as the desktop.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** `prefix-` + the first 24 hex digits of SHA-256 over the parts joined by NUL: stable across devices and re-runs. */
export const parrotShortId = (prefix: string, ...parts: Array<string | number>): string =>
  `${prefix}-${bytesToHex(sha256(utf8ToBytes(parts.map(String).join("\u0000")))).slice(0, 24)}`;

/** An artist's library ID, by name: the same for import and for an edit typing that name (PAR-META-16). */
export const parrotArtistId = (name: string): string => parrotShortId("ar", name.toLowerCase());

/** An album's library ID, by album artist and title: the same for import and for an edit typing them. */
export const parrotAlbumId = (albumArtistId: string, title: string): string => parrotShortId("al", albumArtistId, title.toLowerCase());

/** The import's ID scheme, as `planParrotEdit` takes it. */
export const PARROT_EDIT_IDS = { artistId: parrotArtistId, albumId: parrotAlbumId };

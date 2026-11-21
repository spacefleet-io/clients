// Where an exported song goes in the folder the user picked (OFFL-FILE-02, Chris 2026-11-21): `Artist/Album/01 Title.ext`.
// Pure, so every app that exports music names files the same way and the rules are tested without a disk.
import { sanitizeExportFolderName } from "@space/shared/exportLayout";

/** Folder names for a song with no artist or album. English on every language: folder names outlive the app's language (agent reading in OFFL-FILE-02). */
export const PARROT_EXPORT_UNKNOWN_ARTIST = "Unknown Artist";
export const PARROT_EXPORT_UNKNOWN_ALBUM = "Unknown Album";
export const PARROT_EXPORT_UNKNOWN_TITLE = "Unknown Title";

/**
 * Longest folder or file name (without extension), in characters. Two folders and a file of 80 leave room under
 * Windows' 260-character path for the folder the user picked (agent reading in OFFL-FILE-02).
 */
const MAX_NAME = 80;

export type ParrotExportNameInput = {
  /** The song's own artist; the folder uses it only when the album has no album artist. */
  artist: string | null;
  /** The album artist ("Various Artists" for a compilation): every song of one album lands in one folder. */
  albumArtist: string | null;
  album: string | null;
  title: string | null;
  trackNumber: number | null;
  discNumber?: number | null;
  /** How many discs the album's songs span: the disc shows in the name only above one. */
  discCount?: number | null;
  /** How many songs the album has: 100 or more pads numbers to three digits. */
  albumTrackCount?: number | null;
  /** The file's extension, without the dot (`flac`, `m4a`…). */
  ext: string;
};

/**
 * One folder or file name safe on Windows, macOS and Linux (`sanitizeExportFolderName`: no character a file system
 * refuses, no trailing dot or space, no Windows device name, `Vol.II` kept as written), plus no leading dot (a hidden
 * file on macOS and Linux) and at most `MAX_NAME` characters.
 */
const safeName = (raw: string | null | undefined, fallback: string): string => {
  const trimmed = Array.from((raw ?? "").replace(/^[\s.]+/, "")).slice(0, MAX_NAME).join("");
  if (trimmed.trim().length === 0) return fallback;
  const safe = sanitizeExportFolderName(trimmed);
  return safe === "untitled" && trimmed.trim().toLowerCase() !== "untitled" ? fallback : safe;
};

const positive = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;

/** `{ folders: [Artist, Album], file: "01 Title.ext" }` for one exported song (OFFL-FILE-02). */
export const parrotExportPath = (input: ParrotExportNameInput): { folders: [string, string]; file: string } => {
  const artistFolder = safeName(input.albumArtist?.trim() ? input.albumArtist : input.artist, PARROT_EXPORT_UNKNOWN_ARTIST);
  const albumFolder = safeName(input.album, PARROT_EXPORT_UNKNOWN_ALBUM);
  const number = positive(input.trackNumber);
  let prefix = "";
  if (number != null) {
    const width = Math.max(2, String(Math.max(positive(input.albumTrackCount) ?? 0, number)).length);
    const disc = positive(input.discNumber);
    // Several discs: "2-03 Title" keeps one album folder in disc order (agent reading in OFFL-FILE-02).
    prefix = `${(positive(input.discCount) ?? 1) > 1 && disc != null ? `${disc}-` : ""}${String(number).padStart(width, "0")} `;
  }
  const title = input.title?.trim() ? input.title : PARROT_EXPORT_UNKNOWN_TITLE;
  const ext = input.ext.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const file = safeName(`${prefix}${title}`, `${prefix}${PARROT_EXPORT_UNKNOWN_TITLE}`.trim());
  return { folders: [artistFolder, albumFolder], file: ext ? `${file}.${ext}` : file };
};

/**
 * The key two names compare by: Windows and macOS see `Song.flac` and `song.flac` as one file, and macOS stores
 * accents decomposed, so names compare without case on their composed form, on every system.
 */
export const parrotExportNameKey = (name: string): string => name.normalize("NFC").toLowerCase();

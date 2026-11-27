import { promises as fs } from "node:fs";
import path from "node:path";
import type { ParrotCoverCrop } from "@space/parrot-core";
import type { ParrotListedTrack } from "@space/parrot-library-db-definition";
import type { ParrotCoverImage } from "./covers";
import { findParrotAudioFiles } from "./formats";
import { readParrotTrackInfo, type ParrotTrackInfo } from "./readTrack";

/** One song of a matched album's full tracklist (PAR-LIB-05): `{ disc, number, title, durationMs }`. */
export type { ParrotListedTrack };

/**
 * The picked folder each file was found under (the deepest one when they nest), or undefined: folder names above it
 * never name an album or artist (readParrotTrackInfo).
 */
export const parrotRootFinder = (roots: string[]) => {
  const sorted = roots.map((root) => path.resolve(root)).sort((a, b) => b.length - a.length);
  return (file: string) => {
    const resolved = path.resolve(file);
    return sorted.find((root) => resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
  };
};

/**
 * The names the user can change for one song before it is imported (PAR-UP-05), plus what a matched album fills in:
 * its year and the song's track number and disc (absent: the tag's stays), and its full tracklist, stored on the album
 * so its page lists the songs the user does not have (PAR-LIB-05). `albumArtist` (and its id in the metadata) is the
 * matched release's album artist: it replaces the file's album-artist tag, so a song tagged "Various Artists" lands
 * under the album's real artist unless the match is itself a various-artists compilation. `coverId` names the matched
 * album's cover in the lookup (the album's opaque id); the import stores that cover on the album
 * (PAR-META-04). `coverPicture` instead names a picture the review got from the desktop (one built into a scanned
 * file, or an image file the user picked, PAR-UP-08); `coverCrop` is the square of that cover the user framed
 * (PAR-META-22). `unidentified`: the user kept the song as is, matched to nothing, so the library marks it to be
 * identified later.
 */
export type ParrotImportEdit = {
  artist: string;
  album: string;
  title: string;
  albumArtist?: string;
  albumArtistMusicId?: string | null;
  year?: number | null;
  number?: number;
  disc?: number;
  tracklist?: ParrotListedTrack[];
  /** The matched album's id in the metadata (PAR-COPY-01): the copy-changes refresh and the cover pass find the album by it. */
  albumMusicId?: string | null;
  /** The matched song's id in our music copy (PAR-LYR-01): its lyrics lookup reads our lyrics copy by it. */
  trackMusicId?: string | null;
  coverId?: string;
  coverPicture?: string;
  coverCrop?: ParrotCoverCrop;
  unidentified?: boolean;
};

/**
 * One song the scan found, as the confirm dialog shows it: its tags as the import would store them. `albumArtist` is
 * the file's album-artist tag here; with `compilation` it steers matching: a compilation's album is matched as a whole
 * first (PAR-META-03). The review never passes it on, the import's album artist comes from the match.
 */
export type ParrotScanEntry = ParrotImportEdit & {
  file: string;
  size: number;
  disc: number;
  number: number;
  durationMs: number | null;
  compilation?: boolean;
};

/** What a scan found in the picked folders. Nothing is uploaded by a scan (PAR-UP-05). */
export type ParrotImportScan = {
  folders: string[];
  entries: ParrotScanEntry[];
  albums: number;
  artists: number;
  totalBytes: number;
  /** Audio files whose tags could not be read: the import would fail on them too, so they are left out. */
  unreadable: Array<{ file: string; error: string }>;
};

export type ParrotScanOptions = {
  readInfo?: (file: string, root?: string) => Promise<ParrotTrackInfo>;
  log?: (message: string) => void;
  /** Files read so far, of `total`. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
};

const SCAN_LANES = 4;

/**
 * PAR-UP-05: lists the audio files under `folders` and reads each one's tags with the importer's own reader, so the
 * dialog shows exactly the artist, album and title the import would store. Uploads nothing.
 */
export const scanParrotImport = async (folders: string[], options: ParrotScanOptions = {}): Promise<ParrotImportScan> => {
  const log = options.log ?? (() => {});
  const readInfo = options.readInfo ?? readParrotTrackInfo;
  const rootOf = parrotRootFinder(folders);
  const files = await findParrotAudioFiles(folders, (entry, reason) => log(`[parrot-scan] skipped ${entry}: ${reason}`));
  log(`[parrot-scan] ${files.length} audio file(s) in ${folders.length} folder(s)`);
  const found: Array<ParrotScanEntry | null> = new Array(files.length).fill(null);
  const unreadable: ParrotImportScan["unreadable"] = [];
  let next = 0;
  let done = 0;
  options.onProgress?.(0, files.length);
  const lane = async () => {
    while (next < files.length) {
      if (options.signal?.aborted) throw new Error("scan stopped");
      const index = next++;
      const file = files[index]!;
      try {
        const [info, stat] = await Promise.all([readInfo(file, rootOf(file)), fs.stat(file)]);
        found[index] = {
          file,
          size: stat.size,
          artist: info.artist,
          albumArtist: info.albumArtist,
          compilation: info.compilation === true,
          album: info.album,
          title: info.title,
          disc: info.disc,
          number: info.number,
          // PAR-UP-08: an album taken as is shows its file's year to edit.
          year: info.year,
          durationMs: info.durationMs,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[parrot-scan] could not read ${file}: ${message}`);
        unreadable.push({ file, error: message });
      }
      options.onProgress?.(++done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_LANES, files.length) }, lane));
  const entries = found.filter((entry): entry is ParrotScanEntry => entry !== null);
  return {
    folders,
    entries,
    albums: new Set(entries.map((entry) => `${entry.artist}\u0000${entry.album}`)).size,
    artists: new Set(entries.map((entry) => entry.artist)).size,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    unreadable,
  };
};

/**
 * The song as the user confirmed it: an edited artist, album or title replaces the tag (blank keeps it); a year, track
 * number or disc from the matched album replaces the tag's, and its tracklist goes with the song to the album
 * (PAR-LIB-05). The matched album's artist replaces the album-artist tag; without one, the album artist follows an
 * edited artist when it was the same name, so the album lands under the name the user typed. `cover`, the matched
 * album's cover from the lookup, comes before the picture built into the file (PAR-META-04): the album takes it and
 * the light copy embeds it.
 */
export const applyParrotImportEdit = (info: ParrotTrackInfo, edit: ParrotImportEdit, cover?: ParrotCoverImage | null): ParrotTrackInfo => {
  const artist = edit.artist.trim() || info.artist;
  const matchedAlbumArtist = edit.albumArtist?.trim();
  const albumArtist = matchedAlbumArtist || (info.albumArtist === info.artist ? artist : info.albumArtist);
  const keptAlbumArtistMusicId = albumArtist === info.albumArtist ? info.albumArtistMusicId : null;
  return {
    ...info,
    artist,
    albumArtist,
    // The file's artist id tags name the tagged artists only: a renamed artist loses its tag's id.
    artistMusicId: artist === info.artist ? info.artistMusicId : null,
    albumArtistMusicId: (matchedAlbumArtist ? edit.albumArtistMusicId : null) ?? keptAlbumArtistMusicId ?? null,
    album: edit.album.trim() || info.album,
    title: edit.title.trim() || info.title,
    year: edit.year ?? info.year,
    number: edit.number && edit.number > 0 ? edit.number : info.number,
    disc: edit.disc && edit.disc > 0 ? edit.disc : info.disc,
    // PAR-META-22: the framing is the chosen cover's; without a chosen cover the file's picture takes its centre square.
    ...(cover ? { cover, ...(edit.coverCrop ? { coverCrop: edit.coverCrop } : {}) } : {}),
    ...(edit.tracklist?.length ? { tracklist: edit.tracklist } : {}),
    ...(edit.albumMusicId ? { albumMusicId: edit.albumMusicId } : {}),
    ...(edit.trackMusicId ? { trackMusicId: edit.trackMusicId } : {}),
    ...(edit.unidentified ? { unidentified: true } : {}),
  };
};

/**
 * A `readInfo` for importParrotFiles that applies the confirmed edits (keyed by resolved path) on top of the tags;
 * `covers` holds the covers the edits chose, by their `coverPicture`, else their `coverId` (the matched albums' covers
 * fetched from the lookup).
 */
export const parrotEditedReader =
  (
    edits: ReadonlyMap<string, ParrotImportEdit>,
    readInfo: (file: string, root?: string) => Promise<ParrotTrackInfo> = readParrotTrackInfo,
    covers: ReadonlyMap<string, ParrotCoverImage> = new Map()
  ) =>
  async (file: string, root?: string): Promise<ParrotTrackInfo> => {
    const info = await readInfo(file, root);
    const edit = edits.get(path.resolve(file));
    const coverKey = edit?.coverPicture ?? edit?.coverId;
    return edit ? applyParrotImportEdit(info, edit, coverKey ? covers.get(coverKey) : null) : info;
  };

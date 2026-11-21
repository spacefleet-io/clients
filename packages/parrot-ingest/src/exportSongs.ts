// "Download everything" in Parrot's computer app (OFFL-FILE-01, ACCT-EXPORT-01): every song of the library is written
// as a plain audio file under `Artist/Album/01 Title.ext` (OFFL-FILE-02) in the folder the user picked.
// A song is written under a hidden folder of that same disk and moved to its name in one step only when complete
// (OFFL-SAFE-01), never over another file; the free space is checked first (OFFL-SAFE-02). Exported files are the
// user's: nothing here records them.
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { decryptMediaObject } from "@space/media-crypto";
import { parrotCoverMime, parrotExportNameKey, parrotExportPath, toLrc, type ParrotCopyTags } from "@space/parrot-core";
import { resolveOfflineFilenameCollision } from "@space/shared/offlineFilename";
import { placeExportFile } from "@space/shared/exportPlacement";
import { parrotExportExtension, rebuildParrotTrackFile, type ParrotExportCover } from "./exportFile";
import { openParrotCover } from "./covers";
import { getParrotFile, getParrotLyrics, type ParrotLibraryDb } from "./library";
import type { ParrotOriginalTags } from "./splitOriginal";

/** The hidden folder in the picked folder where songs are written before their move (OFFL-SAFE-01). */
export const PARROT_EXPORT_PARTIAL_DIR = ".parrot-export-partial";
/** Room left free on the disk beyond the songs themselves (OFFL-SAFE-02). */
export const PARROT_EXPORT_SPARE_BYTES = 64 * 1024 * 1024;

export type ParrotExportSong = {
  trackId: string;
  fileId: string;
  albumId: string;
  title: string;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  number: number | null;
  disc: number | null;
  discCount: number;
  albumTrackCount: number;
  year: number | null;
  genre: string | null;
  sizeBytes: number;
  /** The album's 1200 px cover (PAR-META-04), put back into a split file's rebuilt header. */
  coverObjectKey: string | null;
};

/**
 * Every song of the library that has a stored file, in album order, each with its highest stored quality: the original
 * upload, never the light copy (OFFL-QUAL-01, PAR-FMT-02).
 */
export const listParrotExportSongs = (db: ParrotLibraryDb): ParrotExportSong[] =>
  db
    .prepare(
      `SELECT t.id AS trackId, f.id AS fileId, t.album_id AS albumId, t.title, ar.name AS artist, aar.name AS albumArtist,
              al.title AS album, t.number, t.disc,
              (SELECT COUNT(DISTINCT COALESCE(disc, 1)) FROM tracks WHERE album_id = t.album_id) AS discCount,
              (SELECT COUNT(*) FROM tracks WHERE album_id = t.album_id) AS albumTrackCount,
              CASE WHEN t.year_edited THEN t.year ELSE COALESCE(t.year, al.year) END AS year,
              CASE WHEN t.genre_edited THEN t.genre ELSE COALESCE(t.genre, al.genre) END AS genre,
              f.size_bytes AS sizeBytes, al.cover_object_key AS coverObjectKey
       FROM tracks t
       JOIN albums al ON al.id = t.album_id
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN artists aar ON aar.id = al.album_artist_id
       JOIN track_files f ON f.id = (
         SELECT id FROM track_files WHERE track_id = t.id
         ORDER BY light_copy, lossless DESC, COALESCE(bitrate_kbps, 0) DESC, created_at LIMIT 1
       )
       ORDER BY aar.sort_name COLLATE NOCASE, al.year, al.title COLLATE NOCASE, t.disc, t.number, t.title COLLATE NOCASE`
    )
    .all() as ParrotExportSong[];

/** What the library says of a song, for the rebuilt file's tags. */
const namesOf = (db: ParrotLibraryDb, song: ParrotExportSong): ParrotCopyTags => {
  const lyrics = getParrotLyrics(db, song.trackId);
  return {
    title: song.title,
    artist: song.artist,
    album: song.album,
    albumArtist: song.albumArtist,
    number: song.number,
    disc: song.disc,
    year: song.year,
    genre: song.genre,
    lyrics: lyrics?.synced || lyrics?.plain ? { synced: lyrics.synced ? toLrc(lyrics.synced) : null, plain: lyrics.plain } : null,
  };
};

export type ParrotExportProgress = {
  doneSongs: number;
  totalSongs: number;
  doneBytes: number;
  totalBytes: number;
  failed: number;
  /** The song being written, for the progress line. */
  current: string | null;
};

export type ParrotExportResult = {
  written: Array<{ trackId: string; path: string }>;
  failed: Array<{ trackId: string; title: string; reason: string }>;
  /** Stopped before the end: cancelled, or the disk filled up. */
  stopped: "cancelled" | "no-space" | null;
};

/** Refused before anything was written: the disk of `dest` has `freeBytes`, the songs need `neededBytes`. */
export class ParrotExportNoSpaceError extends Error {
  constructor(
    readonly neededBytes: number,
    readonly freeBytes: number
  ) {
    super(`not enough free space: ${neededBytes} bytes needed, ${freeBytes} free`);
  }
}

/** Bytes a program may still write on the disk holding `dir` (OFFL-SAFE-02). */
export const parrotExportFreeBytes = async (dir: string): Promise<number> => {
  const stats = await fs.statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
};

/** Names in `dir` by `parrotExportNameKey`, mapped to the name on disk; an absent folder has none. */
const listNames = async (dir: string): Promise<Map<string, { name: string; dir: boolean }>> => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return new Map(entries.map((entry) => [parrotExportNameKey(entry.name), { name: entry.name, dir: entry.isDirectory() }]));
};

/**
 * The folder `name` under `parent`, made when missing. A folder whose name differs only in letter case is the same
 * folder (an artist's songs stay together, as Windows and macOS would have it), on Linux too.
 */
const folderIn = async (parent: string, name: string): Promise<string> => {
  const names = await listNames(parent);
  const existing = names.get(parrotExportNameKey(name));
  if (existing?.dir) return path.join(parent, existing.name);
  // A file holds that name: the folder gets the next free one instead, `Name (2)`….
  const free = existing ? resolveOfflineFilenameCollision(name, new Set([...names.values()].map((entry) => entry.name))) : name;
  const folder = path.join(parent, free);
  await fs.mkdir(folder, { recursive: true });
  return folder;
};

/** Removes what an earlier stopped export left in `dest`'s hidden partial folder (OFFL-SAFE-01). */
export const clearParrotExportPartials = async (dest: string): Promise<void> => {
  await fs.rm(path.join(dest, PARROT_EXPORT_PARTIAL_DIR), { recursive: true, force: true });
};

/**
 * Writes `songs` under `dest`, each as one standard file (`rebuildParrotTrackFile`: a song stored whole as uploaded, a
 * split-stored one rebuilt with the library's names and its album's cover). A song that fails (a chunk that will not
 * download after its retries, a file the rebuild cannot read) is reported and skipped; a cancel or a full disk stops
 * the run. Nothing partial is ever left under a song's name.
 */
export const exportParrotSongs = async (input: {
  db: ParrotLibraryDb;
  songs: readonly ParrotExportSong[];
  dest: string;
  libraryKeyBase64: () => string;
  /** A chunk's sealed bytes: kept on this computer, else downloaded (the caller retries and waits). */
  readSealed: (objectKey: string, signal: AbortSignal) => Promise<Uint8Array>;
  signal: AbortSignal;
  onProgress?: (progress: ParrotExportProgress) => void;
  /** Called after each song is in place, so a resumed run skips it. */
  onSongDone?: (trackId: string) => void;
  freeBytes?: (dir: string) => Promise<number>;
  log: (line: string) => void;
}): Promise<ParrotExportResult> => {
  const freeBytes = input.freeBytes ?? parrotExportFreeBytes;
  const totalBytes = input.songs.reduce((sum, song) => sum + song.sizeBytes, 0);
  await fs.mkdir(input.dest, { recursive: true });
  const free = await freeBytes(input.dest);
  input.log(`[export] ${input.songs.length} songs, ${totalBytes} bytes into ${input.dest} (${free} bytes free)`);
  if (free < totalBytes + PARROT_EXPORT_SPARE_BYTES) throw new ParrotExportNoSpaceError(totalBytes + PARROT_EXPORT_SPARE_BYTES, free);

  const partialDir = path.join(input.dest, PARROT_EXPORT_PARTIAL_DIR);
  await fs.mkdir(partialDir, { recursive: true });
  const result: ParrotExportResult = { written: [], failed: [], stopped: null };
  const progress: ParrotExportProgress = { doneSongs: 0, totalSongs: input.songs.length, doneBytes: 0, totalBytes, failed: 0, current: null };
  const readPlain = async (objectKey: string) => new Uint8Array(decryptMediaObject(await input.readSealed(objectKey, input.signal), input.libraryKeyBase64()));
  // One download per album, and only for split files: a file stored whole keeps the cover it was uploaded with.
  const covers = new Map<string, Promise<ParrotExportCover>>();
  const coverOf = (objectKey: string) => {
    let cover = covers.get(objectKey);
    if (!cover) {
      cover = input.readSealed(objectKey, input.signal).then(async (sealed) => {
        const bytes = await openParrotCover(sealed, input.libraryKeyBase64());
        return { bytes, mime: parrotCoverMime(bytes) ?? "image/jpeg" };
      });
      covers.set(objectKey, cover);
    }
    return cover;
  };
  try {
    for (const song of input.songs) {
      if (input.signal.aborted) {
        result.stopped = "cancelled";
        break;
      }
      progress.current = song.title;
      input.onProgress?.({ ...progress });
      // The disk may have filled since the start (another program, another export).
      const freeNow = await freeBytes(input.dest);
      if (freeNow < song.sizeBytes + PARROT_EXPORT_SPARE_BYTES) {
        input.log(`[export] stopped: ${freeNow} bytes free, ${song.title} needs ${song.sizeBytes}`);
        result.stopped = "no-space";
        break;
      }
      const partial = path.join(partialDir, `${crypto.randomUUID()}.part`);
      // Progress counts the stored size: a rebuilt file carries the library's tags and cover, so it is a little larger.
      const songStart = progress.doneBytes;
      let written = 0;
      try {
        const file = getParrotFile(input.db, song.fileId);
        if (!file) throw new Error(`file ${song.fileId} is not in the library any more`);
        const { folders, file: name } = parrotExportPath({
          artist: song.artist,
          albumArtist: song.albumArtist,
          album: song.album,
          title: song.title,
          trackNumber: song.number,
          discNumber: song.disc,
          discCount: song.discCount,
          albumTrackCount: song.albumTrackCount,
          ext: parrotExportExtension(file).slice(1),
        });
        const split = file.headerBytes !== null;
        const tags = split && file.tagsObjectKey ? (JSON.parse(new TextDecoder().decode(await readPlain(file.tagsObjectKey))) as ParrotOriginalTags) : null;
        const cover = split && song.coverObjectKey ? await coverOf(song.coverObjectKey) : null;
        const handle = await fs.open(partial, "wx");
        try {
          const pieces = rebuildParrotTrackFile({
            file,
            tags,
            names: namesOf(input.db, song),
            cover,
            readChunk: (index) => readPlain(file.chunks[index]!.objectKey),
            signal: input.signal,
          });
          for await (const piece of pieces) {
            await handle.write(piece);
            written += piece.length;
            progress.doneBytes = songStart + Math.min(written, song.sizeBytes);
            input.onProgress?.({ ...progress });
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        const albumDir = await folderIn(await folderIn(input.dest, folders[0]), folders[1]);
        const placed = await placeExportFile({ sourcePath: partial, destDir: albumDir, desiredName: name, log: input.log });
        result.written.push({ trackId: song.trackId, path: placed });
        progress.doneBytes = songStart + song.sizeBytes;
        input.onSongDone?.(song.trackId);
        input.log(`[export] ${song.trackId} -> ${path.relative(input.dest, placed)}`);
      } catch (error) {
        await fs.rm(partial, { force: true });
        if (input.signal.aborted) {
          result.stopped = "cancelled";
          break;
        }
        const reason = error instanceof Error ? error.message : String(error);
        input.log(`[export] ${song.trackId} failed: ${reason}`);
        result.failed.push({ trackId: song.trackId, title: song.title, reason });
        progress.failed += 1;
      }
      progress.doneSongs += 1;
    }
  } finally {
    progress.current = null;
    input.onProgress?.({ ...progress });
    // Empty once every song moved out; a stopped run's partial files went with their song.
    await fs.rmdir(partialDir).catch(() => undefined);
  }
  input.log(`[export] done: ${result.written.length} written, ${result.failed.length} failed, stopped=${result.stopped ?? "no"}`);
  return result;
};

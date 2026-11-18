// PAR-FMT-02: every song is stored as its original plus one light copy (Opus 64 kbps in Ogg), encrypted and chunked
// exactly like the original. The import adds it right after the original; `backfillParrotLightCopies` adds it to
// songs imported before light copies existed. The encoding itself is the app's (`ParrotLightCopyMaker`): the desktop
// makes it in its hidden encoder window, with Chromium's Opus encoder.
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PARROT_LIGHT_COPY, parrotShortId, type ParrotCopyTags, type ParrotChunkLoader } from "@space/parrot-core";
import { createParrotOp, type ParrotLibraryOp, type TrackFileChunkRow } from "@space/parrot-library-db-definition";
import { PARROT_AUDIO_FORMATS } from "./formats";
import { sha256Hex } from "./ids";
import { applyParrotOps, getParrotFile, hasParrotFile, type ParrotLibraryDb } from "./library";
import { fetchParrotLibraryState, publishParrotEdits, type ParrotSnapshotTransport } from "./publish";
import { readParrotTrackInfo, type ParrotTrackInfo } from "./readTrack";

/**
 * Makes the light copy (Ogg Opus bytes) of one original, reading it through `read` (bytes `start..end` inclusive) a
 * piece at a time; rejects when the original cannot be decoded.
 */
export type ParrotLightCopyMaker = (input: {
  size: number;
  read: (start: number, end: number) => Promise<Uint8Array>;
  container: string;
  codec: string;
  durationMs: number | null;
  tags: ParrotCopyTags;
}) => Promise<Uint8Array>;

/** Seals and uploads one file as chunks (the importer's `uploadParrotFile`, bound to the account). */
export type ParrotFileUploader = (input: { fileId: string; fileHash: string; bytes: Uint8Array }) => Promise<TrackFileChunkRow[]>;

/** The light copy's file ID: one per original, so making it again (another computer, a retry) lands on the same row. */
export const parrotLightFileId = (originalFileId: string): string => parrotShortId("tf", "light", originalFileId);

/** What the light copy keeps of the original's tags: names, numbers, lyrics and the cover (PAR-FMT-02). */
export const parrotCopyTagsOf = (info: ParrotTrackInfo): ParrotCopyTags => ({
  title: info.title,
  artist: info.artist,
  album: info.album,
  albumArtist: info.albumArtist,
  number: info.number,
  disc: info.disc,
  year: info.year,
  genre: info.genre ?? null,
  lyrics: info.lyrics ?? null,
  cover: info.cover ? { bytes: info.cover.bytes, mime: info.cover.mime } : null,
});

/** The op that records an uploaded light copy of `trackId`. */
export const buildParrotLightCopyOp = (input: {
  trackId: string;
  fileId: string;
  sizeBytes: number;
  chunks: TrackFileChunkRow[];
  now: number;
}): ParrotLibraryOp =>
  createParrotOp(
    "track_file.upsert",
    {
      file: {
        id: input.fileId,
        trackId: input.trackId,
        codec: PARROT_LIGHT_COPY.codec,
        container: PARROT_LIGHT_COPY.container,
        mime: PARROT_LIGHT_COPY.mime,
        lossless: false,
        bitrateKbps: PARROT_LIGHT_COPY.bitrateKbps,
        sampleRate: PARROT_LIGHT_COPY.sampleRate,
        sizeBytes: input.sizeBytes,
        lightCopy: true,
        createdAt: input.now,
      },
      chunks: input.chunks,
    },
    { id: crypto.randomUUID(), createdAt: new Date(input.now).toISOString() }
  );

/** Whether the song already has a light copy. */
export const hasParrotLightCopy = (db: ParrotLibraryDb, trackId: string): boolean =>
  db.prepare("SELECT 1 AS found FROM track_files WHERE track_id = ? AND light_copy = 1").get(trackId) !== undefined;

/**
 * Why a song waits for a computer that makes light copies of long songs, or null when this one makes its copy now.
 * Songs up to PARROT_LIGHT_COPY.autoMaxDurationMs get theirs on every computer; longer ones only where the shared
 * hardware rule calls the computer strong (`longSongs`, `@space/shared/transcodeHardware`). A song whose length is
 * not known counts as short.
 */
export const parrotLightCopyWait = (input: { durationMs: number | null; longSongs: boolean }): string | null => {
  if (input.longSongs || input.durationMs === null || input.durationMs <= PARROT_LIGHT_COPY.autoMaxDurationMs) return null;
  return (
    `it lasts ${Math.round(input.durationMs / 60_000)} minutes, and this computer makes light copies automatically only up to ` +
    `${PARROT_LIGHT_COPY.autoMaxDurationMs / 60_000} (not enough cores and memory for longer ones)`
  );
};

/** The original a light copy is made from: its size, and a reader of bytes `start..end` (inclusive) that returns copies. */
export type ParrotLightCopyOriginal = { size: number; read: (start: number, end: number) => Promise<Uint8Array> };

/** Reads an original held in memory (each read its own copy, so only the bytes asked for cross to the encoder). */
export const parrotOriginalInMemory = (bytes: Uint8Array): ParrotLightCopyOriginal => ({
  size: bytes.length,
  read: async (start, end) => bytes.slice(start, end + 1),
});

/**
 * Makes, uploads and records the light copy of one original; returns its op (already applied to `db`). Null when the
 * song already has one, or when it waits for a computer that makes light copies of long songs (`parrotLightCopyWait`).
 */
export const addParrotLightCopy = async (input: {
  db: ParrotLibraryDb;
  trackId: string;
  originalFileId: string;
  original: ParrotLightCopyOriginal;
  info: ParrotTrackInfo;
  /** Whether this computer makes light copies of songs over 90 minutes (the shared hardware rule). */
  longSongs: boolean;
  make: ParrotLightCopyMaker;
  upload: ParrotFileUploader;
  log: (message: string) => void;
  now?: () => number;
}): Promise<ParrotLibraryOp | null> => {
  const fileId = parrotLightFileId(input.originalFileId);
  if (hasParrotLightCopy(input.db, input.trackId) || hasParrotFile(input.db, fileId)) return null;
  const wait = parrotLightCopyWait({ durationMs: input.info.durationMs, longSongs: input.longSongs });
  if (wait) {
    input.log(`[parrot-light-copy] ${input.trackId}: no light copy here, ${wait}`);
    return null;
  }
  const started = Date.now();
  const bytes = await input.make({
    size: input.original.size,
    read: input.original.read,
    container: input.info.format.container,
    codec: input.info.format.codec,
    durationMs: input.info.durationMs,
    tags: parrotCopyTagsOf(input.info),
  });
  const chunks = await input.upload({ fileId, fileHash: sha256Hex(bytes), bytes });
  const op = buildParrotLightCopyOp({ trackId: input.trackId, fileId, sizeBytes: bytes.length, chunks, now: input.now?.() ?? Date.now() });
  applyParrotOps(input.db, [op]);
  input.log(
    `[parrot-light-copy] ${input.trackId}: ${input.original.size} bytes of ${input.info.format.codec} -> ${bytes.length} bytes of Opus ` +
      `${PARROT_LIGHT_COPY.bitrateKbps} kbps as ${fileId} in ${Date.now() - started} ms`
  );
  return op;
};

/**
 * Songs with an original but no light copy, each with its best original (lossless first, then bitrate, oldest) and
 * its length.
 */
export const listParrotSongsWithoutLightCopy = (db: ParrotLibraryDb): Array<{ trackId: string; fileId: string; durationMs: number | null }> =>
  db
    .prepare(
      `SELECT t.id AS trackId,
              (SELECT f.id FROM track_files f WHERE f.track_id = t.id AND f.light_copy = 0
                ORDER BY f.lossless DESC, COALESCE(f.bitrate_kbps, 0) DESC, f.created_at LIMIT 1) AS fileId,
              t.duration_ms AS durationMs
         FROM tracks t
        WHERE EXISTS (SELECT 1 FROM track_files f WHERE f.track_id = t.id AND f.light_copy = 0)
          AND NOT EXISTS (SELECT 1 FROM track_files f WHERE f.track_id = t.id AND f.light_copy = 1)
        ORDER BY t.id`
    )
    .all() as Array<{ trackId: string; fileId: string; durationMs: number | null }>;

/** The extension the original's temporary copy gets, so the tag reader takes it (PAR-UP-01's formats). */
const parrotTempExtension = (file: { mime: string; codec?: string | null }): string => {
  const formats = Object.entries(PARROT_AUDIO_FORMATS);
  const match = formats.find(([, format]) => format.mime === file.mime && format.codec === file.codec) ?? formats.find(([, format]) => format.mime === file.mime);
  if (!match) throw new Error(`no audio format Parrot imports has the mime type ${file.mime}`);
  return match[0];
};

/** `skipped`: songs over 90 minutes on a computer that does not make light copies of long songs (`parrotLightCopyWait`); they wait for one that does. */
export type ParrotLightCopyBackfillResult = { made: number; failed: number; skipped: number; left: number; snapshotVersion: number | null };

/** Reads bytes `start..end` (inclusive) of an open file. */
export const parrotOriginalOnDisk = (handle: fs.FileHandle, size: number): ParrotLightCopyOriginal => ({
  size,
  read: async (start, end) => {
    const bytes = new Uint8Array(end + 1 - start);
    let done = 0;
    while (done < bytes.length) {
      const { bytesRead } = await handle.read(bytes, done, bytes.length - done, start + done);
      if (!bytesRead) throw new Error(`the original ends at ${start + done}, before byte ${end}`);
      done += bytesRead;
    }
    return bytes;
  },
});

/**
 * Gives every song of the library that has none its light copy (PAR-FMT-02 for songs imported before light copies):
 * downloads and decrypts the original chunk by chunk into a temporary file (never whole in memory), reads its tags,
 * makes the copy from that file and uploads it, and publishes the library every `publishEvery` copies. One song at a
 * time; a song that fails is left for the next run and does not stop the others. A song over 90 minutes on a computer
 * that does not make long copies (`longSongs` false) is skipped before anything of it is downloaded.
 */
export const backfillParrotLightCopies = async (options: {
  token: string;
  libraryKeyBase64: string;
  transport: ParrotSnapshotTransport;
  load: ParrotChunkLoader;
  make: ParrotLightCopyMaker;
  upload: ParrotFileUploader;
  /** Whether this computer makes light copies of songs over 90 minutes (the shared hardware rule). */
  longSongs: boolean;
  /** Reads the original's tags from a temporary copy of it (tests swap it). */
  readInfo?: (file: string) => Promise<ParrotTrackInfo>;
  publishEvery?: number;
  log?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<ParrotLightCopyBackfillResult> => {
  const log = options.log ?? (() => {});
  const readInfo = options.readInfo ?? ((file: string) => readParrotTrackInfo(file));
  const publishEvery = Math.max(1, options.publishEvery ?? 5);
  const publishOptions = { transport: options.transport, token: options.token, libraryKeyBase64: options.libraryKeyBase64, log };
  const state = await fetchParrotLibraryState(publishOptions);
  const result: ParrotLightCopyBackfillResult = { made: 0, failed: 0, skipped: 0, left: 0, snapshotVersion: null };
  let unpublished: ParrotLibraryOp[] = [];
  const publish = async () => {
    if (!unpublished.length) return;
    // Another device published meanwhile: replay only the copies it still lacks.
    result.snapshotVersion = await publishParrotEdits(
      state,
      (latest) => unpublished.filter((op) => op.type !== "track_file.upsert" || !hasParrotFile(latest, op.payload.file.id)),
      publishOptions
    );
    unpublished = [];
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parrot-light-copy-"));
  try {
    const songs = listParrotSongsWithoutLightCopy(state.db);
    result.left = songs.length;
    log(`[parrot-light-copy] backfill: ${songs.length} songs without a light copy`);
    for (const song of songs) {
      options.signal?.throwIfAborted();
      const file = getParrotFile(state.db, song.fileId);
      if (!file) continue;
      const wait = parrotLightCopyWait({ durationMs: song.durationMs, longSongs: options.longSongs });
      if (wait) {
        result.skipped += 1;
        result.left -= 1;
        log(`[parrot-light-copy] backfill: no light copy here for ${song.trackId}, ${wait}`);
        continue;
      }
      const temp = path.join(dir, `${song.fileId}${parrotTempExtension(file)}`);
      try {
        const writer = await fs.open(temp, "w");
        try {
          for (const chunk of file.chunks) {
            const plain = await options.load(chunk);
            await writer.write(plain, 0, plain.length, chunk.plainOffset);
          }
        } finally {
          await writer.close();
        }
        const info = await readInfo(temp);
        const reader = await fs.open(temp, "r");
        const op = await addParrotLightCopy({
          db: state.db,
          trackId: song.trackId,
          originalFileId: song.fileId,
          original: parrotOriginalOnDisk(reader, file.sizeBytes),
          info,
          longSongs: options.longSongs,
          make: options.make,
          upload: options.upload,
          log,
        }).finally(() => reader.close());
        if (op) {
          unpublished.push(op);
          result.made += 1;
        }
        result.left -= 1;
        if (unpublished.length >= publishEvery) await publish();
      } catch (error) {
        if (options.signal?.aborted) throw error;
        result.failed += 1;
        log(`[parrot-light-copy] backfill could not make the light copy of ${song.trackId}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await fs.rm(temp, { force: true });
      }
    }
    await publish();
    log(`[parrot-light-copy] backfill done: ${result.made} made, ${result.failed} failed, ${result.skipped} skipped`);
    return result;
  } finally {
    await publish().catch((error) => log(`[parrot-light-copy] backfill could not publish: ${error instanceof Error ? error.message : String(error)}`));
    state.db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
};

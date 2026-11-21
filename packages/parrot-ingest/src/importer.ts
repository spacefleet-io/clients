import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sealMediaObjectWithPadding } from "@space/media-crypto";
import { openStorageUploadSession, uploadStorageObjectViaTunnel } from "@space/library-db-runtime/api";
import { fetchLibrarySnapshot, publishLibrarySnapshot } from "@space/library-db-runtime/snapshotTransport";
import type { MusicLyrics, MusicLyricsQuery } from "@space/shared/api";
import {
  isParrotPublishConflict,
  PARROT_ARTIST_PICTURE_RETRY_MS,
  PARROT_AUTO_LYRICS_GAP_MS,
  parrotAutoLyricsOnError,
  planParrotLyrics,
  planParrotLyricsNotFound,
} from "@space/parrot-core";
import {
  createParrotOp,
  TRACK_FILE_CHUNK_SIZE_BYTES,
  type ArtistRow,
  type ParrotLibraryOp,
  type ParrotPhotoCredit,
  type TrackFileChunkRow,
} from "@space/parrot-library-db-definition";
import { makeParrotCoverCopies, parrotCoverProblem, uploadParrotCover } from "./covers";
import { parrotChunkKey, parrotPlacementId, parrotTrackIds, sha256Hex } from "./ids";
import { applyParrotOps, getParrotAlbumRow, getParrotFile, type ParrotLibraryDb, type ParrotLibraryFile } from "./library";
import { addParrotLightCopy, parrotOriginalInMemory, type ParrotLightCopyMaker } from "./lightCopy";
import { fetchParrotLibraryState, PARROT_APP_ID, publishParrotEdits, type ParrotSnapshotTransport } from "./publish";

export { PARROT_APP_ID };
import { readParrotTrackInfo, type ParrotTrackInfo } from "./readTrack";
import { parrotRootFinder } from "./scan";

/** A file read, hashed and tagged before its song joins the library; `chunks` when its original was stored now. */
type PreparedFile = {
  bytes: Uint8Array;
  fileHash: string;
  info: ParrotTrackInfo;
  ids: { fileId: string; albumId: string; trackId: string; artistId: string; albumArtistId: string };
} & (
  | { existing: ParrotLibraryFile; chunks: null; lyricsAsked: null }
  | { existing: null; chunks: TrackFileChunkRow[]; lyricsAsked: Promise<ParrotLibraryOp | null> }
);
type PreparedOutcome = { ok: true; value: PreparedFile } | { ok: false; error: unknown };

/** The network calls an import makes; tests swap them for in-memory fakes. */
export type ParrotImportTransport = ParrotSnapshotTransport & {
  upload: typeof uploadStorageObjectViaTunnel;
  /** One reused session per upload lane; without it every chunk goes through `upload` (its own session). */
  openUploadSession?: typeof openStorageUploadSession;
};

export const defaultParrotImportTransport: ParrotImportTransport = {
  upload: uploadStorageObjectViaTunnel,
  openUploadSession: openStorageUploadSession,
  fetchSnapshot: fetchLibrarySnapshot,
  publishSnapshot: publishLibrarySnapshot,
};

export type ParrotImportProgress = {
  phase: "scanning" | "uploading" | "publishing" | "done";
  total: number;
  done: number;
  imported: number;
  skipped: number;
  failed: number;
  currentFile: string | null;
  /** Bytes of the picked files already read: uploaded, already in the library or failed. */
  bytesDone: number;
  /** Bytes of all the picked files. */
  bytesTotal: number;
  /** Library snapshots published so far in this import; each one is a library with more songs to show. */
  published: number;
};

export type ParrotImportResult = {
  imported: string[];
  /** Already in the library (same file content): nothing uploaded again (INGS-RESUME-01). */
  skipped: string[];
  failed: Array<{ file: string; error: string }>;
  snapshotVersion: number | null;
};

export type ParrotImportOptions = {
  token: string;
  userId: string;
  libraryKeyBase64: string;
  /** Sent with every upload (`parrot-desktop`, `parrot-seed-script`…). */
  clientType: string;
  transport?: ParrotImportTransport;
  /** The folders (or files) the user picked, as given to findParrotAudioFiles: folder names above them are not used. */
  roots?: string[];
  /** Reads a file's tags (`root`: the picked folder it was found under); the seed script passes names given on its command line. */
  readInfo?: (file: string, root?: string) => Promise<ParrotTrackInfo>;
  /** Publishes the library after this many new songs (default 1: each song shows as soon as it is stored). */
  publishEvery?: number;
  /**
   * Makes each song's light copy (PAR-FMT-02); the desktop passes its encoder. Without it no light copy is made (the
   * seed script, tests). A song whose light copy fails is still imported; the backfill retries it.
   */
  makeLightCopy?: ParrotLightCopyMaker;
  /**
   * Whether this computer makes light copies of songs over 90 minutes (the shared hardware rule,
   * `@space/shared/transcodeHardware`); without it, only songs up to 90 minutes get theirs at import.
   */
  lightCopyLongSongs?: boolean;
  onProgress?: (progress: ParrotImportProgress) => void;
  log?: (message: string) => void;
  signal?: AbortSignal;
  /**
   * PAR-LYR-01: asks the lyrics of each new song whose file carries none while the file uploads, so the song is
   * published with its words (or the final "no lyrics") and is never playable without them. A lookup that fails, or
   * is still out `lookupWaitMs` after its file is stored, publishes the song without lyrics; `onLyricsUnasked` names it, and the
   * pass after the import asks it.
   */
  lookupLyrics?: (question: MusicLyricsQuery) => Promise<MusicLyrics>;
  onLyricsUnasked?: (trackId: string) => void;
  /**
   * PAR-META-15 / PAR-UP-06: the photo of an artist identified by its id in the metadata, asked once per artist with no photo
   * while its first song uploads (the desktop answers from the import review's photos first). Null: no photo anywhere;
   * a throw: the lookup failed, nothing is recorded and the pass after the import asks again. A photo is stored as
   * the pass stores one and goes out with the next publish; the last publish waits up to `lookupWaitMs` for the
   * photos still out.
   */
  artistPhoto?: (artistMusicId: string) => Promise<{ bytes: Uint8Array; credit: ParrotPhotoCredit | null } | null>;
  /** The artists whose photo is being asked, after each change (empty once none is). */
  onArtistPhotosAsked?: (artistIds: string[]) => void;
  /** agent reading (2026-11-15): an album gets its first new song of this import; the window shows it as importing. */
  onAlbumImporting?: (albumId: string) => void;
  /**
   * Each publish that went out, with the library as published (#2509): the app shows it without reading the library
   * back from the server. `db` is the importer's own and changes after this returns: copy it here, synchronously.
   */
  onPublished?: (published: { version: number; db: ParrotLibraryDb }) => void;
  /** Longest wait for a lyrics answer before its song is published, and for the photos still out at the end. */
  lookupWaitMs?: number;
  /** Pause between the starts of two lyrics lookups (the lyrics pass's own gap by default). */
  lyricsGapMs?: number;
};

/** agent reading (2026-11-15): a lookup slower than this does not hold a song back from the library. */
export const PARROT_IMPORT_LOOKUP_WAIT_MS = 15_000;

/** Resolves after `ms`, or at once on abort. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (ms <= 0 || signal?.aborted) {
    resolve();
    return promise;
  }
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
  return promise;
};

const TIMED_OUT = Symbol("timed out");
/** The promise's value, or TIMED_OUT once `ms` passed (or on abort); a rejection rejects. */
const within = async <T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | typeof TIMED_OUT> => {
  // Ends the pause once the promise settles, so no timer outlives the wait.
  const settled = new AbortController();
  try {
    return await Promise.race([promise, pause(ms, signal ? AbortSignal.any([signal, settled.signal]) : settled.signal).then((): typeof TIMED_OUT => TIMED_OUT)]);
  } finally {
    settled.abort();
  }
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Times one publish is tried when other saves keep landing first (each try already replays once). */
const PUBLISH_ATTEMPTS = 5;

/** Chunks of one file in flight at once, each lane on its own reused upload session (PAR-UP-02). */
export const PARROT_UPLOAD_LANES = 4;

/**
 * Seals and uploads one file whole as 1 MiB SFV1 chunks on its own placement; returns the chunk rows in order.
 * PARROT_UPLOAD_LANES lanes take the next chunk in turn; each lane keeps one upload session (and its websocket) for
 * all its chunks instead of opening one per chunk. `onChunk` reports each stored chunk's plain size.
 */
export const uploadParrotFile = async (input: {
  token: string;
  userId: string;
  libraryKey: Buffer;
  fileId: string;
  fileHash: string;
  /** Where the chunks' object names start; the file id unless the file is stored again (lyrics written in, PAR-LYR-01). */
  keyBase?: string;
  bytes: Uint8Array;
  clientType: string;
  upload: ParrotImportTransport["upload"];
  openUploadSession?: ParrotImportTransport["openUploadSession"];
  onChunk?: (plainBytes: number) => void;
  signal?: AbortSignal;
}): Promise<TrackFileChunkRow[]> => {
  const placementId = parrotPlacementId(input.userId, input.fileHash);
  const count = Math.ceil(input.bytes.length / TRACK_FILE_CHUNK_SIZE_BYTES);
  const chunks: TrackFileChunkRow[] = new Array(count);
  const objectOptions = { objectNamespace: "media", contentType: "application/octet-stream" };
  let next = 0;
  let failed = false;
  const lane = async () => {
    const session = input.openUploadSession?.(input.token, { placementId, clientType: input.clientType }, PARROT_APP_ID);
    try {
      while (!failed && next < count) {
        input.signal?.throwIfAborted();
        const idx = next++;
        const offset = idx * TRACK_FILE_CHUNK_SIZE_BYTES;
        const plain = input.bytes.subarray(offset, offset + TRACK_FILE_CHUNK_SIZE_BYTES);
        const sealed = new Uint8Array(sealMediaObjectWithPadding(plain, input.libraryKey));
        const key = parrotChunkKey(input.keyBase ?? input.fileId, idx);
        // STOR-USE-02: the song counts at the size of the file the user picked, one chunk's plain bytes at a time.
        const pieceOptions = { ...objectOptions, counting: { role: "source" as const, declaredBytes: plain.length } };
        const objectKey = session
          ? await session.upload(key, sealed, pieceOptions)
          : await input.upload(input.token, key, sealed, { ...pieceOptions, placementId, clientType: input.clientType }, PARROT_APP_ID);
        chunks[idx] = { idx, objectKey, plainOffset: offset, plainSize: plain.length };
        input.onChunk?.(plain.length);
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await session?.close().catch(() => undefined);
    }
  };
  // Every lane has stopped (and closed its session) before the file counts as failed: no upload outlives it.
  const lanes = await Promise.allSettled(Array.from({ length: Math.min(PARROT_UPLOAD_LANES, count) }, lane));
  const failure = lanes.find((settled) => settled.status === "rejected");
  if (failure) throw failure.reason;
  // A cancel that came while the last chunks were in flight still stops the import before this file is recorded.
  input.signal?.throwIfAborted();
  return chunks;
};

/** The ops that add one uploaded file and its song, album and artists to the library. */
export const buildParrotTrackOps = (input: {
  info: ParrotTrackInfo;
  fileHash: string;
  sizeBytes: number;
  chunks: TrackFileChunkRow[];
  now: number;
}): ParrotLibraryOp[] => {
  const { info, now } = input;
  const ids = parrotTrackIds({ ...info, fileHash: input.fileHash });
  const meta = () => ({ id: crypto.randomUUID(), createdAt: new Date(now).toISOString() });
  const ops: ParrotLibraryOp[] = [
    createParrotOp(
      "artist.upsert",
      { id: ids.artistId, musicId: info.artistMusicId ?? (ids.albumArtistId === ids.artistId ? info.albumArtistMusicId : null) ?? null, name: info.artist, sortName: info.artist },
      meta()
    ),
  ];
  if (ids.albumArtistId !== ids.artistId) {
    ops.push(
      createParrotOp("artist.upsert", { id: ids.albumArtistId, musicId: info.albumArtistMusicId ?? null, name: info.albumArtist, sortName: info.albumArtist }, meta())
    );
  }
  ops.push(
    createParrotOp(
      "album.upsert",
      {
        id: ids.albumId,
        title: info.album,
        albumArtistId: ids.albumArtistId,
        year: info.year,
        kind: "studio",
        // The matched album's id in the metadata (PAR-COPY-01); none keeps the one stored.
        musicId: info.albumMusicId ?? null,
        musicEditionId: null,
        coverObjectKey: null,
        coverThumbObjectKey: null,
        createdAt: now,
        genre: info.genre ?? null,
        // The matched album's full tracklist (PAR-LIB-05); none keeps the one stored.
        tracklist: info.tracklist ?? null,
      },
      meta()
    ),
    createParrotOp(
      "track.upsert",
      {
        id: ids.trackId,
        albumId: ids.albumId,
        disc: info.disc,
        number: info.number,
        title: info.title,
        artistId: ids.artistId,
        durationMs: info.durationMs,
        musicId: null,
        genre: info.genre ?? null,
        ...(info.loudness ?? {}),
        // Kept as is at import (PAR-UP-05); absent keeps the stored flag.
        ...(info.unidentified ? { unidentified: true } : {}),
      },
      meta()
    ),
    createParrotOp(
      "track_file.upsert",
      {
        file: {
          id: ids.fileId,
          trackId: ids.trackId,
          codec: info.format.codec,
          container: info.format.container,
          mime: info.format.mime,
          lossless: info.format.lossless,
          bitrateKbps: info.bitrateKbps,
          sampleRate: info.sampleRate,
          sizeBytes: input.sizeBytes,
          lightCopy: false,
          createdAt: now,
        },
        chunks: input.chunks,
      },
      meta()
    )
  );
  if (info.lyrics) {
    ops.push(createParrotOp("lyrics.set", { trackId: ids.trackId, plain: info.lyrics.plain, synced: info.lyrics.synced, source: "file", fetchedAt: now }, meta()));
  }
  return ops;
};

/**
 * Imports audio files into the account's Parrot library: each new file is uploaded whole as encrypted chunks
 * (PAR-FMT-01), its song added to the library, and the library snapshot published. A file already in the
 * library (same content) is skipped, so running the same import again after a stop resumes it. One file that
 * fails does not stop the others. An album without a cover takes the picture built into the first of its files
 * that has one (PAR-META-04's third source), stored encrypted in the user's storage; files already in the library
 * still give their picture to an album that has none, so importing again fills in covers missed before.
 */
export const importParrotFiles = async (files: string[], options: ParrotImportOptions): Promise<ParrotImportResult> => {
  const transport = options.transport ?? defaultParrotImportTransport;
  const log = options.log ?? (() => {});
  const readInfo = options.readInfo ?? readParrotTrackInfo;
  const rootOf = parrotRootFinder(options.roots ?? []);
  // PAR-UP-03: each song is published as soon as it is stored, so the library shows it right away.
  const publishEvery = Math.max(1, options.publishEvery ?? 1);
  const libraryKey = Buffer.from(options.libraryKeyBase64, "base64");
  if (libraryKey.length !== 32) throw new Error("the library key must be 32 bytes of base64");

  const result: ParrotImportResult = { imported: [], skipped: [], failed: [], snapshotVersion: null };
  const sizes = await Promise.all(files.map((file) => fs.stat(file).then((stat) => stat.size, () => 0)));
  const progress: ParrotImportProgress = {
    phase: "uploading",
    total: files.length,
    done: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    currentFile: null,
    bytesDone: 0,
    bytesTotal: sizes.reduce((sum, size) => sum + size, 0),
    published: 0,
  };
  const report = (patch: Partial<ParrotImportProgress>) => {
    Object.assign(progress, patch);
    options.onProgress?.({ ...progress });
  };

  const publishOptions = { transport, token: options.token, libraryKeyBase64: options.libraryKeyBase64, log };
  const state = await fetchParrotLibraryState(publishOptions);
  let unpublished: ParrotLibraryOp[] = [];
  // Albums whose cover upload failed in this run: their other songs do not retry it (the next import does).
  const coverFailed = new Set<string>();
  /** Seals one album cover or artist photo copy with the library key and stores it; resolves to its object key. */
  const storeCover = (bytes: Uint8Array) =>
    uploadParrotCover({ token: options.token, libraryKeyBase64: options.libraryKeyBase64, bytes, clientType: options.clientType, appId: PARROT_APP_ID, upload: transport.upload });

  /**
   * Gives an album already in the library the matched tracklist when it has none yet (PAR-LIB-05): an album imported
   * before tracklists were stored gets its missing songs listed once its files are imported again.
   */
  const fillAlbumTracklist = (info: ParrotTrackInfo, albumId: string) => {
    if (!info.tracklist?.length) return;
    const album = getParrotAlbumRow(state.db, albumId);
    if (!album || album.tracklist?.length) return;
    const op = createParrotOp("album.upsert", { ...album, tracklist: info.tracklist }, { id: crypto.randomUUID(), createdAt: new Date().toISOString() });
    applyParrotOps(state.db, [op]);
    unpublished.push(op);
    log(`[parrot-import] tracklist for ${albumId} from ${path.basename(info.file)}: ${info.tracklist.length} song(s)`);
  };

  /**
   * Gives `albumId` the file's picture when the album has no cover yet, or when its cover predates the small copy
   * (one full-size object, from an import before small copies existed) and the picture is wide enough to need one.
   * A failure leaves the song imported without a new cover.
   */
  const addAlbumCover = async (info: ParrotTrackInfo, albumId: string) => {
    const cover = info.cover;
    if (!cover || coverFailed.has(albumId)) return;
    const album = getParrotAlbumRow(state.db, albumId);
    if (!album || (album.coverObjectKey && album.coverThumbObjectKey)) return;
    const problem = parrotCoverProblem(cover);
    if (problem) {
      log(`[parrot-import] cover of ${path.basename(info.file)} not used for ${albumId}: ${problem}`);
      return;
    }
    try {
      const copies = makeParrotCoverCopies(cover.bytes, log);
      // A WebP or GIF wider than the large size, or an undecodable picture too big to keep as it is, is skipped (the
      // `[covers]` line says which); the album's next song may bring a usable picture.
      if (!copies) {
        log(`[parrot-import] cover of ${path.basename(info.file)} not used for ${albumId}: no copy could be made of it`);
        return;
      }
      // Already a single small (or undecodable) picture: nothing to add.
      if (album.coverObjectKey && !copies.thumb) return;
      const coverObjectKey = await storeCover(copies.large);
      const coverThumbObjectKey = copies.thumb ? await storeCover(copies.thumb) : null;
      const op = createParrotOp(
        "album.upsert",
        { ...album, coverObjectKey, coverThumbObjectKey },
        { id: crypto.randomUUID(), createdAt: new Date().toISOString() }
      );
      applyParrotOps(state.db, [op]);
      unpublished.push(op);
      log(
        `[parrot-import] album cover for ${albumId} from ${path.basename(info.file)} (${cover.bytes.length} bytes, ${cover.mime}) stored as ` +
          `${coverObjectKey} (${copies.large.length} bytes) and small copy ${coverThumbObjectKey ?? "none"} (${copies.thumb?.length ?? 0} bytes)`
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      coverFailed.add(albumId);
      log(`[parrot-import] could not store the cover of ${albumId} from ${path.basename(info.file)}: ${errorText(error)}`);
    }
  };

  /** Adds the light copy of a stored original when the app makes them and the song has none yet (PAR-FMT-02). */
  const addLightCopy = async (input: { info: ParrotTrackInfo; bytes: Uint8Array; fileId: string; trackId: string }) => {
    const make = options.makeLightCopy;
    if (!make) return;
    try {
      const op = await addParrotLightCopy({
        db: state.db,
        trackId: input.trackId,
        originalFileId: input.fileId,
        original: parrotOriginalInMemory(input.bytes),
        info: input.info,
        longSongs: options.lightCopyLongSongs ?? false,
        make,
        upload: ({ fileId, fileHash, bytes }) =>
          uploadParrotFile({
            token: options.token,
            userId: options.userId,
            libraryKey,
            fileId,
            fileHash,
            bytes,
            clientType: options.clientType,
            upload: transport.upload,
            openUploadSession: transport.openUploadSession,
            signal: options.signal,
          }),
        log,
      });
      if (op) unpublished.push(op);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      log(`[parrot-import] could not make the light copy of ${path.basename(input.info.file)}: ${errorText(error)}`);
    }
  };

  const waitMs = options.lookupWaitMs ?? PARROT_IMPORT_LOOKUP_WAIT_MS;

  // PAR-LYR-01: lookups start at most one every `lyricsGapMs`; after the lookup gives up (no ticket, too many failures
  // in a row, asked to wait) the rest of the import asks nothing and the pass after it takes over.
  let lyricsStopped = !options.lookupLyrics;
  let lyricsFailedInARow = 0;
  let lastLyricsAsk = 0;
  /** Starts the lyrics lookup of a new song without words in its file; resolves to its `lyrics.set` op, or null. */
  const askLyrics = async (info: ParrotTrackInfo, trackId: string): Promise<ParrotLibraryOp | null> => {
    const lookup = options.lookupLyrics;
    const artist = info.artist.trim();
    const title = info.title.trim();
    if (!lookup || lyricsStopped || info.lyrics || !artist || !title) return null;
    await pause(lastLyricsAsk + (options.lyricsGapMs ?? PARROT_AUTO_LYRICS_GAP_MS) - Date.now(), options.signal);
    if (options.signal?.aborted || lyricsStopped) return null;
    lastLyricsAsk = Date.now();
    const album = info.album.trim();
    const question: MusicLyricsQuery = { artist, title, ...(album ? { album } : {}), ...(info.durationMs && info.durationMs > 0 ? { durationMs: info.durationMs } : {}) };
    try {
      const answer = await lookup(question);
      lyricsFailedInARow = 0;
      const ctx = { now: Date.now(), newId: () => crypto.randomUUID() };
      const op = planParrotLyrics(trackId, answer, ctx);
      log(`[parrot-import] lyrics of ${path.basename(info.file)}: ${op ? "found" : "none anywhere"}`);
      return op ?? planParrotLyricsNotFound(trackId, ctx);
    } catch (error) {
      lyricsFailedInARow += 1;
      const next = parrotAutoLyricsOnError(error, lyricsFailedInARow);
      if (next.kind !== "skip") lyricsStopped = true;
      log(`[parrot-import] lyrics lookup of ${path.basename(info.file)} failed (${errorText(error)})${lyricsStopped ? "; the rest wait for the pass after the import" : ""}`);
      return null;
    }
  };

  // PAR-META-15: one photo lookup per artist, its op kept until the artist is in the library and a publish goes out.
  // An artist counts as asked (`onArtistPhotosAsked`) until its photo is published, or until there is none to publish.
  const photosAsked = new Map<string, Promise<void>>();
  const photosOut = new Set<string>();
  const photosReady: Array<{ artistId: string; musicId: string; picture: Pick<ArtistRow, "pictureObjectKey" | "pictureThumbObjectKey" | "pictureCredit"> | null; at: number }> = [];
  let photosPublishing: string[] = [];
  const photosSettled = (artistIds: readonly string[]) => {
    if (!artistIds.length) return;
    for (const id of artistIds) photosOut.delete(id);
    options.onArtistPhotosAsked?.([...photosOut]);
  };
  const artistRow = (id: string) =>
    state.db
      .prepare("SELECT id, music_id AS musicId, name, sort_name AS sortName, picture_object_key AS pictureObjectKey, picture_tried_at AS pictureTriedAt FROM artists WHERE id = ?")
      .get(id) as (ArtistRow & { pictureObjectKey: string | null; pictureTriedAt: number | null }) | undefined;
  const askPhoto = (artistId: string, musicId: string | null | undefined) => {
    const lookup = options.artistPhoto;
    if (!lookup || !musicId || photosAsked.has(artistId)) return;
    const known = artistRow(artistId);
    if (known?.pictureObjectKey || (known?.pictureTriedAt && known.pictureTriedAt > Date.now() - PARROT_ARTIST_PICTURE_RETRY_MS)) return;
    photosOut.add(artistId);
    options.onArtistPhotosAsked?.([...photosOut]);
    const asked = (async () => {
      try {
        const photo = await lookup(musicId);
        const copies = photo ? makeParrotCoverCopies(photo.bytes, log) : null;
        const picture =
          photo && copies
            ? { pictureObjectKey: await storeCover(copies.large), pictureThumbObjectKey: copies.thumb ? await storeCover(copies.thumb) : null, pictureCredit: photo.credit }
            : null;
        photosReady.push({ artistId, musicId, picture, at: Date.now() });
        log(`[parrot-import] artist photo for ${artistId}: ${picture ? `stored as ${picture.pictureObjectKey}` : "none anywhere"}`);
      } catch (error) {
        log(`[parrot-import] artist photo for ${artistId} not stored (${errorText(error)}); the pass after the import asks again`);
        photosSettled([artistId]);
      }
    })();
    photosAsked.set(artistId, asked);
  };
  /** Moves the photos found so far, of artists now in the library, into the next publish. */
  const takePhotos = () => {
    for (const found of [...photosReady]) {
      const row = artistRow(found.artistId);
      if (!row) continue;
      const op = createParrotOp(
        "artist.upsert",
        { id: row.id, musicId: row.musicId ?? found.musicId, name: row.name, sortName: row.sortName, ...found.picture, pictureTriedAt: found.at },
        { id: crypto.randomUUID(), createdAt: new Date(found.at).toISOString() }
      );
      applyParrotOps(state.db, [op]);
      unpublished.push(op);
      photosPublishing.push(found.artistId);
      photosReady.splice(photosReady.indexOf(found), 1);
    }
  };

  /**
   * `final`: the last publish of the import, shown as "publishing"; the ones between songs keep "uploading".
   * Another writer (a lyrics or picture save, another device) may publish meanwhile: the helper replays this batch
   * on its snapshot once and, when that meets yet another save, `state` already holds the latest library with the
   * batch applied, so it is simply published again, up to PUBLISH_ATTEMPTS times. A publish between songs that still
   * fails does not fail the song just uploaded: its ops stay in `unpublished` and go out with the next publish.
   */
  const publish = async (final: boolean) => {
    takePhotos();
    if (!unpublished.length) return;
    if (final) report({ phase: "publishing" });
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          result.snapshotVersion = await publishParrotEdits(state, () => unpublished, publishOptions);
          break;
        } catch (error) {
          if (!isParrotPublishConflict(error) || attempt >= PUBLISH_ATTEMPTS) throw error;
          log(`[parrot-import] publish attempt ${attempt} met other saves twice (${errorText(error)}); publishing again on v${state.baseVersion}`);
        }
      }
    } catch (error) {
      if (final) throw error;
      log(`[parrot-import] publish between songs failed (${errorText(error)}); its ${unpublished.length} op(s) go out with the next publish`);
      return;
    }
    unpublished = [];
    if (result.snapshotVersion !== null) options.onPublished?.({ version: result.snapshotVersion, db: state.db });
    photosSettled(photosPublishing);
    photosPublishing = [];
    report({ phase: final ? "publishing" : "uploading", published: progress.published + 1 });
  };

  const albumsImporting = new Set<string>();
  // Bytes of whole files through (stored, already there or failed) and the bytes sent so far of files still uploading.
  let filesBytes = 0;
  const sending = new Map<number, number>();
  const bytesDone = () => filesBytes + [...sending.values()].reduce((sum, sent) => sum + sent, 0);

  /**
   * What a file needs before its song can join the library: its bytes, hash and tags, and, when the library does not
   * have it yet, its original stored and its lookups started. Touches the library only to read it, so the next file's
   * runs while the song before it gets its light copy and is published (PAR-UP-02).
   */
  const prepare = async (file: string, index: number): Promise<PreparedFile> => {
    const bytes = new Uint8Array(await fs.readFile(file));
    const fileHash = sha256Hex(bytes);
    const info = await readInfo(file, rootOf(file));
    const ids = parrotTrackIds({ ...info, fileHash });
    const existing = getParrotFile(state.db, ids.fileId);
    if (existing) return { bytes, fileHash, info, ids, existing, chunks: null, lyricsAsked: null };
    const { fileId, albumId, trackId, artistId, albumArtistId } = ids;
    log(`[parrot-import] uploading ${path.basename(file)} (${bytes.length} bytes) as ${fileId}: ${info.artist} / ${info.album} / ${info.title}`);
    if (!albumsImporting.has(albumId)) {
      albumsImporting.add(albumId);
      options.onAlbumImporting?.(albumId);
    }
    // The lookups run while the file uploads (PAR-LYR-01, PAR-META-15).
    askPhoto(artistId, info.artistMusicId ?? (albumArtistId === artistId ? info.albumArtistMusicId : null));
    if (albumArtistId !== artistId) askPhoto(albumArtistId, info.albumArtistMusicId);
    const lyricsAsked = askLyrics(info, trackId);
    sending.set(index, 0);
    const chunks = await uploadParrotFile({
      token: options.token,
      userId: options.userId,
      libraryKey,
      fileId,
      fileHash,
      bytes,
      clientType: options.clientType,
      upload: transport.upload,
      openUploadSession: transport.openUploadSession,
      onChunk: (plainBytes) => {
        sending.set(index, Math.min(sizes[index], (sending.get(index) ?? 0) + plainBytes));
        report({ bytesDone: bytesDone() });
      },
      signal: options.signal,
    });
    return { bytes, info, ids, existing: null, chunks, fileHash, lyricsAsked };
  };
  // A settled outcome, so a file that fails while the one before it is still finishing is no unhandled rejection.
  const start = (index: number): Promise<PreparedOutcome> | null =>
    index < files.length
      ? prepare(files[index], index).then(
          (value): PreparedOutcome => ({ ok: true, value }),
          (error: unknown): PreparedOutcome => ({ ok: false, error })
        )
      : null;

  try {
    let sinceLastPublish = 0;
    let next = start(0);
    for (const [index, file] of files.entries()) {
      const outcome = await next!;
      options.signal?.throwIfAborted();
      // The next file is read and uploaded while this one's song is finished below.
      next = start(index + 1);
      report({ currentFile: file });
      const through = () => {
        sending.delete(index);
        filesBytes += sizes[index];
        return bytesDone();
      };
      try {
        if (!outcome.ok) throw outcome.error;
        const { bytes, fileHash, info, ids, existing, chunks } = outcome.value;
        const { fileId, albumId, trackId } = ids;
        if (existing) {
          log(`[parrot-import] already in the library: ${path.basename(file)} (${fileId})`);
          result.skipped.push(file);
          await addAlbumCover(info, albumId);
          fillAlbumTracklist(info, albumId);
          // Imported before light copies existed: importing it again adds its light copy.
          await addLightCopy({ info, bytes, fileId, trackId: existing.trackId });
          report({ done: progress.done + 1, skipped: progress.skipped + 1, bytesDone: through() });
          continue;
        }
        const ops = buildParrotTrackOps({ info, fileHash, sizeBytes: bytes.length, chunks: chunks!, now: Date.now() });
        const lyrics = await within(outcome.value.lyricsAsked!, waitMs, options.signal);
        if (lyrics !== TIMED_OUT && lyrics) ops.push(lyrics);
        else if (options.lookupLyrics && !info.lyrics) {
          if (lyrics === TIMED_OUT) log(`[parrot-import] lyrics of ${path.basename(file)} still out after ${waitMs} ms; the song goes out without them`);
          options.onLyricsUnasked?.(trackId);
        }
        applyParrotOps(state.db, ops);
        unpublished.push(...ops);
        await addAlbumCover(info, albumId);
        await addLightCopy({ info, bytes, fileId, trackId });
        result.imported.push(file);
        report({ done: progress.done + 1, imported: progress.imported + 1, bytesDone: through() });
        sinceLastPublish += 1;
        if (sinceLastPublish >= publishEvery) {
          await publish(false);
          sinceLastPublish = 0;
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        log(`[parrot-import] failed ${file}: ${errorText(error)}`);
        result.failed.push({ file, error: errorText(error) });
        report({ done: progress.done + 1, failed: progress.failed + 1, bytesDone: through() });
      }
    }
    // The photos still out get a last chance to go out with the import (PAR-META-15); the rest wait for the pass.
    if (photosOut.size > 0) await within(Promise.all(photosAsked.values()), waitMs, options.signal);
    await publish(true);
    report({ phase: "done", currentFile: null });
    return result;
  } finally {
    photosSettled([...photosOut]);
    state.db.close();
  }
};

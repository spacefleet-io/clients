import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sealMediaObjectWithPadding } from "@space/media-crypto";
import { apportionDeclaredBytes } from "@space/shared/storageCounting";
import { openStorageUploadSession, uploadStorageObjectViaTunnel } from "@space/library-db-runtime/api";
import { fetchLibrarySnapshot, publishLibrarySnapshot } from "@space/library-db-runtime/snapshotTransport";
import type { MusicLyrics, MusicLyricsQuery } from "@space/shared/api";
import {
  isParrotCopyId,
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
import { makeParrotCoverCopies, parrotCoverProblem, uploadParrotCover, type ParrotCoverImage } from "./covers";
import type { ParrotCoverCopies, ParrotCoverCrop } from "@space/parrot-core";
import { createParrotChunkSlots, type ParrotChunkSlots, type ParrotPlaybackGate } from "./uploadGate";
import { parrotChunkKey, parrotPlacementId, parrotTagsKey, parrotTrackIds, sha256Hex } from "./ids";
import { applyParrotOps, getParrotAlbumRow, getParrotFile, type ParrotLibraryDb } from "./library";
import {
  buildParrotLightCopyOp,
  hasParrotLightCopy,
  parrotCopyTagsOf,
  parrotLightCopyMadeLine,
  parrotLightCopyToMake,
  parrotOriginalOnDisk,
  type ParrotLightCopyMaker,
} from "./lightCopy";
import { fetchParrotLibraryState, PARROT_APP_ID, publishParrotEdits, type ParrotLibraryState, type ParrotSnapshotTransport } from "./publish";
import { parrotSplitPieces, splitParrotOriginal } from "./splitOriginal";

export { PARROT_APP_ID };
import { readParrotTrackInfo, type ParrotTrackInfo } from "./readTrack";
import { parrotRootFinder } from "./scan";

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
  /**
   * PAR-FMT-01: stores each new song in parts (header, sound pieces, tags object). Off (the default): each file is
   * stored whole, as before. The desktop passes the library meta's `splitOriginals`, which the API turns on only once
   * every Parrot channel carries the build that reads songs stored in parts (`PARROT_SPLIT_ORIGINALS`).
   */
  splitOriginals?: boolean;
  /** PAR-UP-14: publishes once this many songs wait (PARROT_PUBLISH_BATCH_SONGS by default)... */
  publishBatchSongs?: number;
  /** ...or this long after the first of them (PARROT_PUBLISH_BATCH_MS), or at once when nothing else can join. */
  publishBatchMs?: number;
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
  /** PAR-UP-15: this computer's uploads-while-playing gate; without it uploads always run at full. */
  uploadGate?: ParrotPlaybackGate;
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
   * PAR-META-22: the large and small copies of an album cover, cut to its square (`crop`, else the centre one). The
   * desktop passes its own, which has the window cut a picture this package cannot decode (WebP, GIF); without it
   * `makeParrotCoverCopies` makes them, and such a picture keeps its shape.
   */
  albumCoverCopies?: (cover: ParrotCoverImage, crop: ParrotCoverCrop | null) => Promise<ParrotCoverCopies | null>;
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
 * Seals and uploads one file as SFV1 chunks on its own placement; returns the chunk rows in order. The file is cut
 * into 1 MiB chunks, or into `pieces` when given (a split original, PAR-FMT-01), each declaring its share of
 * `declaredBytes` (STOR-USE-02; its own size without them). PARROT_UPLOAD_LANES lanes take the next chunk in turn;
 * each lane keeps one upload session (and its websocket) for all its chunks instead of opening one per chunk.
 * `onChunk` reports each stored chunk's declared bytes.
 */
export type ParrotFileUpload = {
  token: string;
  userId: string;
  libraryKey: Buffer;
  fileId: string;
  fileHash: string;
  bytes: Uint8Array;
  pieces?: Uint8Array[];
  declaredBytes?: number[];
  clientType: string;
  upload: ParrotImportTransport["upload"];
  openUploadSession?: ParrotImportTransport["openUploadSession"];
  onChunk?: (declaredBytes: number) => void;
  signal?: AbortSignal;
  /** PAR-UP-15: the import's chunk slots; each chunk holds one while it uploads. */
  slots?: ParrotChunkSlots;
};

export const uploadParrotFile = async (input: ParrotFileUpload): Promise<TrackFileChunkRow[]> => {
  const placementId = parrotPlacementId(input.userId, input.fileHash);
  const pieces =
    input.pieces ??
    Array.from({ length: Math.ceil(input.bytes.length / TRACK_FILE_CHUNK_SIZE_BYTES) }, (_, idx) =>
      input.bytes.subarray(idx * TRACK_FILE_CHUNK_SIZE_BYTES, (idx + 1) * TRACK_FILE_CHUNK_SIZE_BYTES)
    );
  const offsets: number[] = [];
  pieces.reduce((offset, piece) => (offsets.push(offset), offset + piece.length), 0);
  const count = pieces.length;
  const chunks: TrackFileChunkRow[] = new Array(count);
  const objectOptions = { objectNamespace: "media", contentType: "application/octet-stream" };
  let next = 0;
  let failed = false;
  const lane = async () => {
    const session = input.openUploadSession?.(input.token, { placementId, clientType: input.clientType }, PARROT_APP_ID);
    try {
      while (!failed && next < count) {
        input.signal?.throwIfAborted();
        const release = await input.slots?.take(input.signal);
        try {
          // A cancel or a failed lane while this one waited for its slot: it takes no new chunk.
          input.signal?.throwIfAborted();
          if (failed || next >= count) break;
          const idx = next++;
          const offset = offsets[idx]!;
          const plain = pieces[idx]!;
          const sealed = new Uint8Array(sealMediaObjectWithPadding(plain, input.libraryKey));
          const key = parrotChunkKey(input.fileId, idx);
          // STOR-USE-02: the song counts at the size of the file the user picked, one piece's share at a time.
          const declaredBytes = input.declaredBytes?.[idx] ?? plain.length;
          const pieceOptions = { ...objectOptions, counting: { role: "source" as const, declaredBytes } };
          const objectKey = session
            ? await session.upload(key, sealed, pieceOptions)
            : await input.upload(input.token, key, sealed, { ...pieceOptions, placementId, clientType: input.clientType }, PARROT_APP_ID);
          chunks[idx] = { idx, objectKey, plainOffset: offset, plainSize: plain.length };
          input.onChunk?.(declaredBytes);
        } finally {
          await release?.();
        }
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

/** Where a split file's header, sound and tags went (PAR-FMT-01); null on a file stored whole. */
type ParrotSplitStored = { headerBytes: number; sourceSizeBytes: number; tagsObjectKey: string | null };

/** A song's file as stored: its chunks, the bytes a player reads, and how it was cut. */
export type ParrotStoredOriginal = { chunks: TrackFileChunkRow[]; sizeBytes: number; split: ParrotSplitStored | null };

/**
 * PAR-FMT-01: stores a song's file as the user picked it, cut by `splitParrotOriginal`: its header (no picture, no
 * user tag), its sound in a 256 KiB then 1 MiB pieces, and its own tags in a sealed object of their own. The pieces
 * and the tags object together declare the size of the user's file (STOR-USE-02). With `split` off, or a file it cannot
 * cut, the file is stored whole, as it was (a file it cannot cut logs the reason).
 */
export const uploadParrotOriginal = async (
  input: Omit<ParrotFileUpload, "pieces" | "declaredBytes"> & { container: string; split: boolean; log?: (message: string) => void }
): Promise<ParrotStoredOriginal> => {
  if (!input.split) return { chunks: await uploadParrotFile(input), sizeBytes: input.bytes.length, split: null };
  const split = splitParrotOriginal(input.bytes, input.container);
  if (split.kind === "unsupported") {
    input.log?.(`[parrot-import] ${input.fileId} stored whole: ${split.reason}`);
    return { chunks: await uploadParrotFile(input), sizeBytes: input.bytes.length, split: null };
  }
  const pieces = parrotSplitPieces(split.header, split.payload);
  const tags = split.tags.groups.length > 0 ? new TextEncoder().encode(JSON.stringify(split.tags)) : null;
  const shares = apportionDeclaredBytes(input.bytes.length, [...pieces.map((piece) => piece.length), ...(tags ? [tags.length] : [])]);
  const chunks = await uploadParrotFile({ ...input, pieces, declaredBytes: shares.slice(0, pieces.length) });
  let tagsObjectKey: string | null = null;
  if (tags) {
    const declaredBytes = shares.at(-1)!;
    const release = await input.slots?.take(input.signal);
    tagsObjectKey = await input.upload(
      input.token,
      parrotTagsKey(input.fileId),
      new Uint8Array(sealMediaObjectWithPadding(tags, input.libraryKey)),
      {
        objectNamespace: "media",
        contentType: "application/octet-stream",
        counting: { role: "source", declaredBytes },
        placementId: parrotPlacementId(input.userId, input.fileHash),
        clientType: input.clientType,
      },
      PARROT_APP_ID
    ).finally(() => release?.());
    input.onChunk?.(declaredBytes);
    input.signal?.throwIfAborted();
  }
  const sizeBytes = split.header.length + split.payload.length;
  input.log?.(
    `[parrot-import] ${input.fileId} stored split: header ${split.header.length} bytes, sound ${split.payload.length} bytes in ${chunks.length - (split.header.length > 0 ? 1 : 0)} piece(s), ` +
      `tags ${tags?.length ?? 0} bytes, ${split.picturesDropped} picture(s) left out, from ${input.bytes.length} bytes`
  );
  return { chunks, sizeBytes, split: { headerBytes: split.header.length, sourceSizeBytes: input.bytes.length, tagsObjectKey } };
};

/** The ops that add one uploaded file and its song, album and artists to the library. */
export const buildParrotTrackOps = (input: {
  info: ParrotTrackInfo;
  fileHash: string;
  sizeBytes: number;
  chunks: TrackFileChunkRow[];
  /** How the file was cut when stored (PAR-FMT-01); absent or null: stored whole. */
  split?: ParrotSplitStored | null;
  now: number;
}): ParrotLibraryOp[] => {
  const { info, now } = input;
  const ids = parrotTrackIds({ ...info, fileHash: input.fileHash });
  const meta = () => ({ id: crypto.randomUUID(), createdAt: new Date(now).toISOString() });
  // PAR-META-31: an artist already in the library keeps its name, the one the user may have given it.
  const ops: ParrotLibraryOp[] = [
    createParrotOp(
      "artist.upsert",
      {
        id: ids.artistId,
        musicId: info.artistMusicId ?? (ids.albumArtistId === ids.artistId ? info.albumArtistMusicId : null) ?? null,
        name: info.artist,
        sortName: info.artist,
        keepName: true,
      },
      meta()
    ),
  ];
  if (ids.albumArtistId !== ids.artistId) {
    ops.push(
      createParrotOp(
        "artist.upsert",
        { id: ids.albumArtistId, musicId: info.albumArtistMusicId ?? null, name: info.albumArtist, sortName: info.albumArtist, keepName: true },
        meta()
      )
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
        // The matched song's id in our music copy (PAR-LYR-01), so its lyrics lookup reads our copy by it; an
        // outside source's id (PAR-META-26) is never stored.
        musicId: info.trackMusicId && isParrotCopyId(info.trackMusicId) ? info.trackMusicId : null,
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
          headerBytes: input.split?.headerBytes ?? null,
          sourceSizeBytes: input.split?.sourceSizeBytes ?? null,
          tagsObjectKey: input.split?.tagsObjectKey ?? null,
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

/** The ids a song's file gives it (`parrotTrackIds`). */
export type ParrotSongIds = { fileId: string; albumId: string; trackId: string; artistId: string; albumArtistId: string };

/** What the probe of one picked file found: its size, hash and ids, and the song already holding it when the library has the file. */
export type ParrotSongProbe = { size: number; fileHash: string; ids: ParrotSongIds; existingTrackId: string | null };

/** A light copy made and written to `path`, waiting to be uploaded (PAR-FMT-02). */
export type ParrotLightCopyMade = { path: string; fileId: string; bytes: number; fileHash: string; originalBytes: number; codec: string; ms: number };

/** PAR-UP-14: a publish goes out once this many songs wait for one... */
export const PARROT_PUBLISH_BATCH_SONGS = 8;
/** ...or this long after the first of them, or at once when nothing else of the import can join it. */
export const PARROT_PUBLISH_BATCH_MS = 2000;

/** A job of the import as the session sees it, so it knows when nothing more can join a publish. */
type ParrotSessionJob = { file: string; light: boolean; parentId: string | null };

/**
 * One import of picked files into the account's Parrot library (PAR-UP-13): the library it changes, the lookups it
 * started, its progress and result, and the steps each song's jobs run on the shared job engine (`importJobs.ts`).
 * Every change to the library goes through one writer: it waits while a publish is out (a publish that meets another
 * device's save swaps the library for the latest one and would drop ops applied meanwhile), and songs are published
 * in batches (PAR-UP-14). A song's commit resolves once its song is published.
 */
export type ParrotImportSession = ReturnType<typeof createParrotImportSession>;

export const createParrotImportSession = (files: readonly string[], options: ParrotImportOptions & { sizes?: readonly number[] }) => {
  const transport = options.transport ?? defaultParrotImportTransport;
  const log = options.log ?? (() => {});
  const readInfo = options.readInfo ?? readParrotTrackInfo;
  const rootOf = parrotRootFinder(options.roots ?? []);
  const libraryKey = Buffer.from(options.libraryKeyBase64, "base64");
  if (libraryKey.length !== 32) throw new Error("the library key must be 32 bytes of base64");
  const batchSongs = Math.max(1, options.publishBatchSongs ?? PARROT_PUBLISH_BATCH_SONGS);
  const batchMs = options.publishBatchMs ?? PARROT_PUBLISH_BATCH_MS;
  const waitMs = options.lookupWaitMs ?? PARROT_IMPORT_LOOKUP_WAIT_MS;
  // PAR-UP-15: every chunk of this import, all songs and light copies, goes through these slots.
  const slots = createParrotChunkSlots(options.uploadGate, log);

  const result: ParrotImportResult = { imported: [], skipped: [], failed: [], snapshotVersion: null };
  const sizeOf = new Map(files.map((file, index) => [file, options.sizes?.[index] ?? 0]));
  const progress: ParrotImportProgress = {
    phase: "uploading",
    total: files.length,
    done: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    currentFile: null,
    bytesDone: 0,
    bytesTotal: [...sizeOf.values()].reduce((sum, size) => sum + size, 0),
    published: 0,
  };
  const report = (patch: Partial<ParrotImportProgress>) => {
    Object.assign(progress, patch);
    options.onProgress?.({ ...progress });
  };
  // Bytes of whole files through (stored, already there or failed) and the bytes sent so far of files still uploading.
  let filesBytes = 0;
  const sending = new Map<string, number>();
  const bytesDone = () => filesBytes + [...sending.values()].reduce((sum, sent) => sum + sent, 0);

  const publishOptions = { transport, token: options.token, libraryKeyBase64: options.libraryKeyBase64, log };
  let state: ParrotLibraryState | null = null;
  const db = () => {
    if (!state) throw new Error("the import has not opened the library yet");
    return state.db;
  };

  // The jobs of this import still live, and what each one waits for.
  const jobs = new Map<string, ParrotSessionJob>();
  /** Jobs whose commit waits for its ops to be published. */
  const waitingPublish = new Set<string>();
  /** Light copies made and uploaded: their commit waits for their song to be in the library. */
  const lightReady = new Set<string>();

  // Each song in the library (or ended without it): its light copy's commit waits for it.
  const songsIn = new Map<string, PromiseWithResolvers<void>>();
  const songIn = (file: string) => {
    let gate = songsIn.get(file);
    if (!gate) {
      gate = Promise.withResolvers<void>();
      songsIn.set(file, gate);
    }
    return gate;
  };

  // The tags of each file, read once while one of its jobs is live (a resumed job reads them again).
  const infos = new Map<string, Promise<ParrotTrackInfo>>();
  const infoOf = (file: string) => {
    let info = infos.get(file);
    if (!info) {
      info = readInfo(file, rootOf(file));
      infos.set(file, info);
      info.catch(() => infos.delete(file));
    }
    return info;
  };

  // ---- the library writer and batched publish (PAR-UP-14) ----
  let pending: ParrotLibraryOp[] = [];
  let waiters: Array<{ jobId: string; resolve: () => void; reject: (error: unknown) => void }> = [];
  let publishing: Promise<void> | null = null;
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  let publishFailures = 0;

  /** Applies the ops `build` makes from the library as it is now, once no publish is out; they go out with the next publish. */
  const apply = async (build: (library: ParrotLibraryDb) => ParrotLibraryOp[]): Promise<ParrotLibraryOp[]> => {
    while (publishing) await publishing;
    const ops = build(db());
    if (!ops.length) return ops;
    applyParrotOps(db(), ops);
    pending.push(...ops);
    return ops;
  };

  /** True when some live job of the import may still add ops to the next publish soon. */
  const othersBusy = () => {
    for (const [jobId, job] of jobs) {
      if (waitingPublish.has(jobId)) continue;
      // A light copy ready to record waits for its song, which waits for this publish.
      if (job.light && lightReady.has(jobId) && job.parentId && jobs.has(job.parentId)) continue;
      return true;
    }
    return false;
  };

  const schedulePublish = () => {
    if (publishing || (!pending.length && !waiters.length)) return;
    if (waiters.length >= batchSongs || !othersBusy()) {
      void publish(false);
      return;
    }
    publishTimer ??= setTimeout(() => {
      publishTimer = null;
      void publish(false);
    }, batchMs);
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
    db()
      .prepare("SELECT id, music_id AS musicId, name, sort_name AS sortName, picture_object_key AS pictureObjectKey, picture_tried_at AS pictureTriedAt FROM artists WHERE id = ?")
      .get(id) as (ArtistRow & { pictureObjectKey: string | null; pictureTriedAt: number | null }) | undefined;
  /** Seals one album cover or artist photo copy with the library key and stores it; resolves to its object key. */
  const storeCover = (bytes: Uint8Array) =>
    uploadParrotCover({ token: options.token, libraryKeyBase64: options.libraryKeyBase64, bytes, clientType: options.clientType, appId: PARROT_APP_ID, upload: transport.upload });
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
  /** Moves the photos found so far, of artists now in the library, into the next publish (only while no publish is out). */
  const takePhotos = () => {
    for (const found of [...photosReady]) {
      const row = artistRow(found.artistId);
      if (!row) continue;
      // PAR-META-31: a photo the user gave the artist meanwhile wins over the one found for it.
      const picture = row.pictureObjectKey ? null : found.picture;
      if (row.pictureObjectKey && found.picture) log(`[parrot-import] artist photo for ${row.id} not kept: the artist has the user's photo`);
      const op = createParrotOp(
        "artist.upsert",
        { id: row.id, musicId: row.musicId ?? found.musicId, name: row.name, sortName: row.sortName, keepName: true, ...picture, pictureTriedAt: found.at },
        { id: crypto.randomUUID(), createdAt: new Date(found.at).toISOString() }
      );
      applyParrotOps(db(), [op]);
      pending.push(op);
      photosPublishing.push(found.artistId);
      photosReady.splice(photosReady.indexOf(found), 1);
    }
  };
  /**
   * PAR-META-31: a photo op replayed on a newer library (another device published meanwhile) where the artist got the
   * user's photo only records the asked time; any other op is replayed as it is.
   */
  const keepUserPhoto = (latest: ParrotLibraryDb, op: ParrotLibraryOp): ParrotLibraryOp => {
    if (op.type !== "artist.upsert" || !op.payload.pictureObjectKey) return op;
    const current = latest.prepare("SELECT picture_object_key AS pictureObjectKey FROM artists WHERE id = ?").get(op.payload.id) as
      | { pictureObjectKey: string | null }
      | undefined;
    if (!current?.pictureObjectKey || current.pictureObjectKey === op.payload.pictureObjectKey) return op;
    const { pictureObjectKey: _found, pictureThumbObjectKey: _thumb, pictureCredit: _credit, ...rest } = op.payload;
    log(`[parrot-import] artist photo for ${op.payload.id} not kept on the newer library: the artist has the user's photo`);
    return { ...op, payload: rest };
  };

  /**
   * Publishes every op applied so far, in one snapshot PUT. `final`: the last publish of the import, shown as
   * "publishing", whose failure fails the import. Another writer (a lyrics or picture save, another device) may
   * publish meanwhile: the helper replays the batch on its snapshot once and, when that meets yet another save,
   * `state` already holds the latest library with the batch applied, so it is simply published again, up to
   * PUBLISH_ATTEMPTS times. A publish between songs that still fails keeps its ops for the next one and its songs
   * waiting; after PUBLISH_ATTEMPTS such failures in a row, the songs waiting for it fail.
   */
  const publish = (final: boolean): Promise<void> => {
    if (publishing) return publishing.then(() => (final ? publish(true) : undefined));
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = null;
    const run = async () => {
      takePhotos();
      const batch = pending;
      const batchWaiters = waiters;
      if (!batch.length) {
        for (const waiter of batchWaiters) waiter.resolve();
        waiters = [];
        return;
      }
      pending = [];
      waiters = [];
      if (final) report({ phase: "publishing" });
      log(`[parrot-import] publishing ${batch.length} op(s) of ${batchWaiters.length} job(s)${final ? " (last publish of the import)" : ""}`);
      try {
        for (let attempt = 1; ; attempt += 1) {
          try {
            result.snapshotVersion = await publishParrotEdits(state!, (latest) => batch.map((op) => keepUserPhoto(latest, op)), publishOptions);
            break;
          } catch (error) {
            if (!isParrotPublishConflict(error) || attempt >= PUBLISH_ATTEMPTS) throw error;
            log(`[parrot-import] publish attempt ${attempt} met other saves twice (${errorText(error)}); publishing again on v${state!.baseVersion}`);
          }
        }
      } catch (error) {
        pending = [...batch, ...pending];
        publishFailures += 1;
        if (final || publishFailures >= PUBLISH_ATTEMPTS) {
          for (const waiter of batchWaiters) waiter.reject(error);
          if (final) throw error;
          log(`[parrot-import] publish failed ${publishFailures} times in a row (${errorText(error)}); its ${batchWaiters.length} job(s) fail, its ${batch.length} op(s) go out with the next publish`);
          return;
        }
        waiters = [...batchWaiters, ...waiters];
        log(`[parrot-import] publish failed (${errorText(error)}); its ${batch.length} op(s) go out with the next publish`);
        return;
      }
      publishFailures = 0;
      if (result.snapshotVersion !== null) options.onPublished?.({ version: result.snapshotVersion, db: db() });
      photosSettled(photosPublishing);
      photosPublishing = [];
      for (const waiter of batchWaiters) waiter.resolve();
      report({ phase: final ? "publishing" : "uploading", published: progress.published + 1 });
    };
    const out = run().finally(() => {
      publishing = null;
      // A failed publish between songs is tried again after the batch wait.
      if (pending.length || waiters.length) schedulePublish();
    });
    publishing = out.catch(() => undefined);
    return out;
  };

  /** Waits until the ops applied so far (this job's) are published. */
  const published = (jobId: string): Promise<void> => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    waiters.push({ jobId, resolve, reject });
    waitingPublish.add(jobId);
    schedulePublish();
    return promise.finally(() => waitingPublish.delete(jobId));
  };

  // ---- lookups started while a song uploads (PAR-LYR-01, PAR-META-15) ----
  // PAR-LYR-01: lookups start at most one every `lyricsGapMs`; after the lookup gives up (no ticket, too many failures
  // in a row, asked to wait) the rest of the import asks nothing and the pass after it takes over.
  let lyricsStopped = !options.lookupLyrics;
  let lyricsFailedInARow = 0;
  let lastLyricsAsk = 0;
  const lyricsAsked = new Map<string, Promise<ParrotLibraryOp | null>>();
  let lyricsTurn: Promise<void> = Promise.resolve();
  /** Starts the lyrics lookup of a new song without words in its file; resolves to its `lyrics.set` op, or null. */
  const askLyrics = async (info: ParrotTrackInfo, trackId: string): Promise<ParrotLibraryOp | null> => {
    const lookup = options.lookupLyrics;
    const artist = info.artist.trim();
    const title = info.title.trim();
    if (!lookup || lyricsStopped || info.lyrics || !artist || !title) return null;
    // Lookups wait their turn one at a time, each after the gap.
    const turn = lyricsTurn;
    const { promise: mine, resolve: done } = Promise.withResolvers<void>();
    lyricsTurn = mine;
    await turn;
    try {
      await pause(lastLyricsAsk + (options.lyricsGapMs ?? PARROT_AUTO_LYRICS_GAP_MS) - Date.now(), options.signal);
      if (options.signal?.aborted || lyricsStopped) return null;
      lastLyricsAsk = Date.now();
    } finally {
      done();
    }
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

  // ---- album covers and tracklists ----
  // Albums whose cover upload failed in this import: their other songs do not retry it (the next import does).
  const coverFailed = new Set<string>();
  // One cover at a time per album: songs of one album finish side by side and would each store the same picture.
  const coverTurns = new Map<string, Promise<void>>();

  /**
   * Gives an album already in the library the matched tracklist when it has none yet (PAR-LIB-05): an album imported
   * before tracklists were stored gets its missing songs listed once its files are imported again.
   */
  const fillAlbumTracklist = (info: ParrotTrackInfo, albumId: string) =>
    apply((library) => {
      if (!info.tracklist?.length) return [];
      const album = getParrotAlbumRow(library, albumId);
      if (!album || album.tracklist?.length) return [];
      log(`[parrot-import] tracklist for ${albumId} from ${path.basename(info.file)}: ${info.tracklist.length} song(s)`);
      return [createParrotOp("album.upsert", { ...album, tracklist: info.tracklist }, { id: crypto.randomUUID(), createdAt: new Date().toISOString() })];
    });

  /**
   * Gives `albumId` the file's picture when the album has no cover yet, or when its cover predates the small copy
   * (one full-size object, from an import before small copies existed) and the picture is wide enough to need one.
   * A failure leaves the song imported without a new cover.
   */
  const addAlbumCover = (info: ParrotTrackInfo, albumId: string): Promise<void> => {
    const before = coverTurns.get(albumId) ?? Promise.resolve();
    const turn = before.then(() => addAlbumCoverNow(info, albumId));
    const settled = turn.catch(() => undefined);
    coverTurns.set(albumId, settled);
    void settled.finally(() => {
      if (coverTurns.get(albumId) === settled) coverTurns.delete(albumId);
    });
    return turn;
  };
  const addAlbumCoverNow = async (info: ParrotTrackInfo, albumId: string) => {
    const cover = info.cover;
    if (!cover || coverFailed.has(albumId)) return;
    const album = getParrotAlbumRow(db(), albumId);
    if (!album || (album.coverObjectKey && album.coverThumbObjectKey)) return;
    const problem = parrotCoverProblem(cover);
    if (problem) {
      log(`[parrot-import] cover of ${path.basename(info.file)} not used for ${albumId}: ${problem}`);
      return;
    }
    try {
      const copies = options.albumCoverCopies
        ? await options.albumCoverCopies(cover, info.coverCrop ?? null)
        : makeParrotCoverCopies(cover.bytes, log, { square: true, crop: info.coverCrop ?? null });
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
      // The album as it is now: another song of it may have changed it while the cover uploaded.
      await apply((library) => {
        const now = getParrotAlbumRow(library, albumId);
        return now ? [createParrotOp("album.upsert", { ...now, coverObjectKey, coverThumbObjectKey }, { id: crypto.randomUUID(), createdAt: new Date().toISOString() })] : [];
      });
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

  const albumsImporting = new Set<string>();

  /** Reads a picked file again for a step that needs its bytes; it must not have changed since its probe. */
  const readSame = async (file: string, probe: ParrotSongProbe) => {
    const bytes = new Uint8Array(await fs.readFile(file));
    if (sha256Hex(bytes) !== probe.fileHash) throw new Error(`${path.basename(file)} changed on disk during the import`);
    return bytes;
  };

  const close = () => {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = null;
    photosSettled([...photosOut]);
    state?.db.close();
    state = null;
  };

  return {
    files,
    result,
    progress: () => ({ ...progress }),
    log,
    /** Reads the account's latest library; every step works on it. */
    async open() {
      state ??= await fetchParrotLibraryState(publishOptions);
    },
    /** A job of this import, live until `jobEnded`. */
    track(jobId: string, job: ParrotSessionJob) {
      jobs.set(jobId, job);
    },
    jobEnded(jobId: string) {
      const job = jobs.get(jobId);
      jobs.delete(jobId);
      lightReady.delete(jobId);
      if (job && ![...jobs.values()].some((other) => other.file === job.file)) infos.delete(job.file);
      schedulePublish();
    },

    // ---- the song's own job (PAR-UP-13): probe → identify → extract → upload → commit ----
    /** Reads, hashes and tags the file; finds out whether the library already has it. */
    async probe(file: string): Promise<ParrotSongProbe> {
      report({ currentFile: file });
      const bytes = new Uint8Array(await fs.readFile(file));
      const fileHash = sha256Hex(bytes);
      const info = await infoOf(file);
      const ids = parrotTrackIds({ ...info, fileHash });
      const existing = getParrotFile(db(), ids.fileId);
      if (!sizeOf.get(file)) {
        sizeOf.set(file, bytes.length);
        report({ bytesTotal: [...sizeOf.values()].reduce((sum, size) => sum + size, 0) });
      }
      return { size: bytes.length, fileHash, ids, existingTrackId: existing?.trackId ?? null };
    },
    /** Starts the lookups of a new song (lyrics, artist photos), which run while it uploads. */
    async identify(file: string, probe: ParrotSongProbe) {
      if (probe.existingTrackId) return;
      const info = await infoOf(file);
      const { fileId, albumId, trackId, artistId, albumArtistId } = probe.ids;
      log(`[parrot-import] uploading ${path.basename(file)} (${probe.size} bytes) as ${fileId}: ${info.artist} / ${info.album} / ${info.title}`);
      if (!albumsImporting.has(albumId)) {
        albumsImporting.add(albumId);
        options.onAlbumImporting?.(albumId);
      }
      askPhoto(artistId, info.artistMusicId ?? (albumArtistId === artistId ? info.albumArtistMusicId : null));
      if (albumArtistId !== artistId) askPhoto(albumArtistId, info.albumArtistMusicId);
      const asked = askLyrics(info, trackId);
      lyricsAsked.set(fileId, asked);
      // Never an unhandled rejection: the commit reads it, or the song failed before.
      asked.catch(() => undefined);
    },
    /** The file is still there as probed (the light copy is made from it). */
    async extract(file: string, probe: ParrotSongProbe) {
      const stat = await fs.stat(file);
      if (stat.size !== probe.size) throw new Error(`${path.basename(file)} changed on disk during the import`);
    },
    /** Stores the original (PAR-FMT-01), its chunks side by side (PAR-UP-02). */
    async upload(file: string, probe: ParrotSongProbe, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<ParrotStoredOriginal | null> {
      if (probe.existingTrackId) return null;
      const bytes = await readSame(file, probe);
      const info = await infoOf(file);
      sending.set(file, 0);
      return uploadParrotOriginal({
        token: options.token,
        userId: options.userId,
        libraryKey,
        fileId: probe.ids.fileId,
        fileHash: probe.fileHash,
        bytes,
        container: info.format.container,
        clientType: options.clientType,
        split: options.splitOriginals ?? false,
        upload: transport.upload,
        openUploadSession: transport.openUploadSession,
        onChunk: (declaredBytes) => {
          const sent = Math.min(probe.size, (sending.get(file) ?? 0) + declaredBytes);
          sending.set(file, sent);
          onProgress(probe.size ? sent / probe.size : 1);
          report({ bytesDone: bytesDone() });
        },
        signal,
        slots,
        log,
      });
    },
    /** Adds the song (or, for a file the library has, its album's missing cover and tracklist) and waits until it is published. */
    async commit(jobId: string, file: string, probe: ParrotSongProbe, stored: ParrotStoredOriginal | null, signal: AbortSignal) {
      const info = await infoOf(file);
      const { fileId, albumId, trackId } = probe.ids;
      if (probe.existingTrackId || !stored) {
        log(`[parrot-import] already in the library: ${path.basename(file)} (${fileId})`);
        await addAlbumCover(info, albumId);
        await fillAlbumTracklist(info, albumId);
        songIn(file).resolve();
        await published(jobId);
        return "skipped" as const;
      }
      const asked = lyricsAsked.get(fileId);
      lyricsAsked.delete(fileId);
      const lyrics = asked ? await within(asked, waitMs, signal) : null;
      const extra: ParrotLibraryOp[] = [];
      if (lyrics !== TIMED_OUT && lyrics) extra.push(lyrics);
      else if (options.lookupLyrics && !info.lyrics) {
        if (lyrics === TIMED_OUT) log(`[parrot-import] lyrics of ${path.basename(file)} still out after ${waitMs} ms; the song goes out without them`);
        options.onLyricsUnasked?.(trackId);
      }
      await apply(() => [...buildParrotTrackOps({ info, fileHash: probe.fileHash, ...stored, now: Date.now() }), ...extra]);
      songIn(file).resolve();
      await addAlbumCover(info, albumId);
      await published(jobId);
      return "imported" as const;
    },
    /** The song's own job ended: counted as imported, already there or failed. */
    songEnded(file: string, outcome: "imported" | "skipped" | { error: string }) {
      songIn(file).resolve();
      sending.delete(file);
      filesBytes += sizeOf.get(file) ?? 0;
      // Counted here, not at the commit: a resumed import counts the songs done before Parrot quit too (RT-LIFE-04).
      if (typeof outcome === "object") {
        log(`[parrot-import] failed ${file}: ${outcome.error}`);
        result.failed.push({ file, error: outcome.error });
      } else (outcome === "imported" ? result.imported : result.skipped).push(file);
      report({
        done: progress.done + 1,
        imported: progress.imported + (outcome === "imported" ? 1 : 0),
        skipped: progress.skipped + (outcome === "skipped" ? 1 : 0),
        failed: progress.failed + (typeof outcome === "object" ? 1 : 0),
        bytesDone: bytesDone(),
      });
    },

    /** A failed song's job runs again (its row's "Try again", UX-JOBS-02): its failure is no longer counted. */
    songRetried(file: string) {
      const at = result.failed.findIndex((failure) => failure.file === file);
      if (at < 0) return;
      result.failed.splice(at, 1);
      songsIn.delete(file);
      filesBytes -= sizeOf.get(file) ?? 0;
      log(`[parrot-import] trying ${file} again`);
      report({ done: progress.done - 1, failed: progress.failed - 1, bytesDone: bytesDone() });
    },

    // ---- the song's light copy (PAR-FMT-02), a job of its own: transcode → upload → commit ----
    /** Makes the light copy into `out`; null when the song needs none made here. */
    async transcodeLight(file: string, probe: ParrotSongProbe, out: string, signal?: AbortSignal): Promise<ParrotLightCopyMade | null> {
      const make = options.makeLightCopy;
      if (!make) return null;
      // PAR-UP-15: in `pause` the encoder waits too, so nothing competes with the song playing.
      await slots.whileHeld(signal);
      const info = await infoOf(file);
      const trackId = probe.existingTrackId ?? probe.ids.trackId;
      const fileId = parrotLightCopyToMake({ db: db(), trackId, originalFileId: probe.ids.fileId, durationMs: info.durationMs, longSongs: options.lightCopyLongSongs ?? false, log });
      if (!fileId) return null;
      const started = Date.now();
      const handle = await fs.open(file, "r");
      let bytes: Uint8Array;
      try {
        const original = parrotOriginalOnDisk(handle, probe.size);
        bytes = await make({
          size: original.size,
          read: original.read,
          container: info.format.container,
          codec: info.format.codec,
          durationMs: info.durationMs,
          tags: parrotCopyTagsOf(info),
        });
      } finally {
        await handle.close();
      }
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, bytes);
      return { path: out, fileId, bytes: bytes.length, fileHash: sha256Hex(bytes), originalBytes: probe.size, codec: info.format.codec, ms: Date.now() - started };
    },
    async uploadLight(made: ParrotLightCopyMade, signal: AbortSignal): Promise<TrackFileChunkRow[]> {
      const bytes = new Uint8Array(await fs.readFile(made.path));
      if (sha256Hex(bytes) !== made.fileHash) throw new Error(`the light copy ${made.path} changed on disk`);
      return uploadParrotFile({
        token: options.token,
        userId: options.userId,
        libraryKey,
        fileId: made.fileId,
        fileHash: made.fileHash,
        bytes,
        clientType: options.clientType,
        upload: transport.upload,
        openUploadSession: transport.openUploadSession,
        signal,
        slots,
      });
    },
    /** The light copy is made and stored: its commit waits for its song to be published first. */
    lightReady(jobId: string) {
      lightReady.add(jobId);
      schedulePublish();
    },
    async commitLight(jobId: string, file: string, probe: ParrotSongProbe, made: ParrotLightCopyMade, chunks: TrackFileChunkRow[]) {
      // A song of this import: its own commit puts it in the library first (a resumed import whose song job ended finds it there).
      if ([...jobs.entries()].some(([id, job]) => id !== jobId && job.file === file && !job.light)) await songIn(file).promise;
      const trackId = probe.existingTrackId ?? probe.ids.trackId;
      await apply((library) =>
        hasParrotLightCopy(library, trackId) || !library.prepare("SELECT 1 FROM tracks WHERE id = ?").get(trackId)
          ? []
          : [buildParrotLightCopyOp({ trackId, fileId: made.fileId, sizeBytes: made.bytes, chunks, now: Date.now() })]
      );
      log(parrotLightCopyMadeLine({ trackId, fileId: made.fileId, originalBytes: made.originalBytes, codec: made.codec, copyBytes: made.bytes, ms: made.ms }));
      await published(jobId);
      await fs.rm(made.path, { force: true });
    },

    /** Every job ended: the photos still out get a last chance, then the last publish. Closes the library. */
    async finish(signal?: AbortSignal): Promise<ParrotImportResult> {
      try {
        signal?.throwIfAborted();
        // The photos still out get a last chance to go out with the import (PAR-META-15); the rest wait for the pass.
        if (photosOut.size > 0) await within(Promise.all(photosAsked.values()), waitMs, signal);
        await publish(true);
        report({ phase: "done", currentFile: null });
        return result;
      } finally {
        close();
      }
    },
    close,
  };
};

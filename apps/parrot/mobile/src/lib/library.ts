// The Parrot library on the phone: the account's encrypted snapshot (`/library/*` under `x-space-app: parrot`), opened
// with the library key and kept as a SQLite file for the screens' queries. Playlist and heart edits are written into
// that copy and published back as the next snapshot (./saveEdits, PAR-PL-02/03/04). While something is kept on the
// phone (PAR-OFFL-01), that copy is also the offline library: with no connection the phone opens it instead.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Buffer } from "buffer";
import { Platform } from "react-native";
import RNFS from "react-native-fs";
import SQLite from "react-native-sqlite-storage";
import crypto from "react-native-quick-crypto";
import { downloadStorageObjectViaTunnel, getLibraryDb, getLibraryMeta, putLibraryDb, uploadStorageObjectViaTunnel } from "@space/shared/api";
import { TRUSTED_CHUNK_REFS_VERSION } from "@space/shared/contracts/library";
import { openRemoteLibrarySnapshot } from "@space/mobile-shell/librarySnapshot";
import { STORAGE_FORMAT_VERSION } from "@space/library-db-definition/storageFormat";
import { decryptBase64ToBytes, decryptBytesToBytes, encryptBytesToBytes } from "@space/mobile-shell/libraryEnvelope";
import { keptLibraryKeyIsStale, keptLibraryKeyVerdict } from "@space/mobile-shell/kept-library-key";
import { fflateCodec } from "@space/mobile-shell/libraryOps";
import { parrotLibraryMigrationStatements } from "@space/parrot-library-db-definition/migrations";
import { publishLibrarySnapshotWith, type LibrarySnapshotPublishDeps } from "@space/library-db-definition/snapshotPublish";
import { PARROT_OP_STREAM_VERSION, parseParrotTracklist, type ParrotListedTrack, type ParrotPhotoCredit } from "@space/parrot-library-db-definition/ops";
import { createPhoneOpsSaver, type PhoneLibraryState } from "./saveEdits";
import { phoneCoverCopies } from "./coverCopies";
import { sqliteDb } from "./dbPath";
import * as sdk from "@space/sdk";
import { API_BASE_URL } from "../config";
import { SPACE_APP_HEADER } from "@space/shared/appScope";
import { createPhoneCovers, setPhoneCoverSource } from "./covers";
import type { MusicAlbum, MusicAlbumsQuery, MusicArtistImage, MusicCoverSize, MusicImage, MusicLyrics, MusicLyricsQuery, MusicRecording, MusicRecordingsQuery } from "@space/shared/api";
import type { MetadataClient } from "@space/metadata-client";
import {
  buildParrotPlaylists,
  parrotAlbumEditValues,
  parrotTrackEditValues,
  planParrotDelete,
  saveParrotEdit,
  type ParrotEditCover,
  type ParrotEditTarget,
  type ParrotEditValues,
  type ParrotSuggestLibrary,
  type ParrotLibraryQuery,
  type ParrotManageTarget,
  fetchParrotLyrics,
  parrotAutoLyricsOnError,
  runParrotAutoLyrics,
  createParrotLyricsPending,
  queueParrotAutoLyrics,
  rebaseParrotArtistPictureOps,
  rebaseParrotAlbumCoverOps,
  runParrotAutoAlbumCovers,
  type ParrotAlbumCoversAsked,
  type ParrotAutoAlbumCoversReport,
  rebaseParrotCopyRefreshOps,
  runParrotCopyChanges,
  type ParrotCopyChangesArgs,
  type ParrotCopyChangesReport,
  type ParrotCopyCheck,
  parrotArtistPictureCredit,
  runParrotAutoArtistPictures,
  type ParrotAutoArtistPicturesReport,
  type ParrotAutoLyricsReport,
  PLAYLIST_TRACKS_SQL,
  PLAYLISTS_SQL,
  toParrotLyrics,
  TRACK_LYRICS_SQL,
  type ParrotCanSpend,
  type ParrotLyrics,
  type ParrotLyricsRow,
  type ParrotPlaylist,
  type ParrotPlaylistEdit,
  type ParrotPlaylistRow,
  type ParrotPlaylistTrackRow,
} from "@space/parrot-core";
import { phonePlaylists, PLAYLIST_SONGS_SQL, PLAYLIST_TABLE_SQL } from "./playlists";
import {
  ALBUM_COVERS_SQL,
  ALBUM_TRACKS_SQL,
  ALBUM_TRACKLIST_SQL,
  ALBUMS_SQL,
  ALL_TRACK_FILES_SQL,
  ARTIST_ALBUMS_SQL,
  ARTISTS_SQL,
  FILE_CHUNKS_SQL,
  SONGS_SQL,
  sortTracks,
  toChunkedFile,
  keepLibraryFromRows,
  toTrackFileRow,
  TRACK_FILES_SQL,
  type AlbumRow,
  type KeepLibrary,
  type ArtistRow,
  type ChunkedFile,
  type ParrotCoverKeys,
  type RawTrackFileRow,
  type SongRow,
  type TrackFileChunkRow,
  type TrackFileRow,
  type TrackRow,
  parrotLibraryUpgradeStatements,
} from "@space/parrot-core";

SQLite.enablePromise(true);

const DB_NAME = "parrot.library.sqlite";
/** Where the SQLite plugin keeps a database on this device (Android `databases/`, iPhone `Library/LocalDatabase`, Apple TV Caches). */
const deviceDb = (name: string) =>
  sqliteDb(Platform.OS, Platform.isTV, { document: RNFS.DocumentDirectoryPath, library: RNFS.LibraryDirectoryPath, caches: RNFS.CachesDirectoryPath }, name);
const dbPath = () => deviceDb(DB_NAME).path;
const openLibraryFile = () => SQLite.openDatabase({ name: DB_NAME, location: deviceDb(DB_NAME).location });

let db: SQLite.SQLiteDatabase | null = null;
/** The server version the open copy is: the snapshot opened, or the one this phone published since. */
let openedVersion = 0;

const closeDb = async () => {
  const open = db;
  db = null;
  if (open) await open.close().catch(() => undefined);
};

const log = (event: string, payload: Record<string, unknown>) => console.log(event, JSON.stringify(payload));

/** The session the open library came with: covers are downloaded and opened with it. */
let session: { token: string; libraryKey: string } | null = null;

const covers = createPhoneCovers({
  dir: `${RNFS.CachesDirectoryPath}/parrot-covers`,
  files: {
    exists: (path) => RNFS.exists(path),
    mkdir: (dir) => RNFS.mkdir(dir),
    writeBytes: (path, bytes) => RNFS.writeFile(path, Buffer.from(bytes).toString("base64"), "base64"),
    move: (from, to) => RNFS.moveFile(from, to),
    remove: (path) => RNFS.unlink(path).catch(() => undefined),
    removeDir: (dir) => RNFS.unlink(dir).catch(() => undefined),
    list: async (dir) =>
      (await RNFS.readDir(dir).catch(() => []))
        .filter((item) => item.isFile())
        .map((item) => ({ name: item.name, size: Number(item.size), usedAt: item.mtime?.getTime() ?? 0 })),
    touch: (path) => RNFS.touch(path, new Date()).then(() => undefined),
  },
  download: (objectKey) => {
    if (!session) throw new Error("LIBRARY_NOT_OPEN");
    return downloadStorageObjectViaTunnel(session.token, objectKey, { clientType: "mobile", clientVersion: "parrot-mobile", purpose: "library" });
  },
  open: (sealed) => {
    if (!session) throw new Error("LIBRARY_NOT_OPEN");
    return decryptBytesToBytes(session.libraryKey, sealed);
  },
  log,
});
setPhoneCoverSource(covers);

/** The cover keys of the open library's albums, read once per opened snapshot. */
let coverKeys: Promise<Map<string, ParrotCoverKeys>> | null = null;

/**
 * Downloads and opens the account's Parrot library. Throws `LIBRARY_MISSING` when the account has none yet and
 * `DECRYPT_FAILED` when the key does not open it.
 */
export const openLibrary = async (token: string, libraryKey: string): Promise<{ snapshotVersion: number }> => {
  const { dbBytes, snapshotVersion } = await openRemoteLibrarySnapshot(libraryKey, {
    getLibraryDb: () => getLibraryDb(token, "parrot"),
    download: async (objectKey) => {
      const bytes = await downloadStorageObjectViaTunnel(token, objectKey, {
        clientType: "mobile",
        clientVersion: "parrot-mobile",
        // Library data stays readable when unpaid and while the silo is saturated (STOR-BW-09).
        purpose: "library",
      });
      log("parrot.library.downloaded", { objectKey, bytes: bytes.byteLength, offset: bytes.byteOffset });
      return bytes;
    },
    decrypt: (key, envelope) =>
      decryptBytesToBytes(key, envelope).catch((err: unknown) => {
        log("parrot.library.decrypt_failed", {
          bytes: envelope.byteLength,
          offset: envelope.byteOffset,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }),
    inflate: fflateCodec,
    supportedStorageFormatVersion: STORAGE_FORMAT_VERSION,
    log,
  });
  await closeDb();
  coverKeys = null;
  const path = dbPath();
  await RNFS.mkdir(path.slice(0, path.lastIndexOf("/")));
  await RNFS.writeFile(path, Buffer.from(dbBytes).toString("base64"), "base64");
  const opened = await openLibraryFile();
  // A snapshot published by an older build is brought to schema 10 in the phone's own copy (e.g. the small cover
  // column, PAR-META-04); a file at 11 stays there (API-VER-01). The next playlist save publishes it at that schema.
  const [version] = await opened.executeSql("PRAGMA user_version");
  const fileVersion = Number(version.rows.item(0)?.user_version ?? 0);
  const statements = parrotLibraryUpgradeStatements(fileVersion);
  if (statements.length) {
    await opened.sqlBatch(statements);
    log("parrot.library.migrated", { from: fileVersion, statements: statements.length });
  }
  db = opened;
  openedVersion = snapshotVersion;
  session = { token, libraryKey };
  await recordLibraryCopy();
  return { snapshotVersion };
};

/** Remembers which version the kept offline copy is, while something is kept (the marker opens it offline). */
const COPY_KEY = "parrot.library.offlineCopy";
/** Device-local memory of when each album's cover was last asked for (PAR-META-20): `{albumId: at}`. */
const ALBUM_COVERS_ASKED_KEY = "parrot.albumCovers.asked";
/** Device-local memory of the last music-copy check (PAR-COPY-01): `{checkedAt, version}`. */
const COPY_CHANGES_CHECK_KEY = "parrot.copyChanges.check";
let copyKept = false;
const recordLibraryCopy = async () => {
  if (copyKept && db) await AsyncStorage.setItem(COPY_KEY, String(openedVersion));
};

/**
 * PAR-OFFL-01: something is kept on the phone (or nothing any more). While something is, the library copy stays usable
 * offline; with nothing kept, the phone opens the server's library or nothing, as before.
 */
export const setLibraryCopyKept = async (kept: boolean) => {
  copyKept = kept;
  if (kept) await recordLibraryCopy();
  else await AsyncStorage.removeItem(COPY_KEY);
  log("parrot.library.copy", { kept, version: openedVersion });
};

/**
 * The server's library could not be downloaded (no connection): opens the copy the phone kept for its kept songs.
 * Null when nothing is kept, so the caller shows the error as before.
 */
export const openLibraryCopy = async (token: string, libraryKey: string): Promise<{ snapshotVersion: number } | null> => {
  const marker = await AsyncStorage.getItem(COPY_KEY).catch(() => null);
  if (marker === null || !(await RNFS.exists(dbPath()))) return null;
  await closeDb();
  coverKeys = null;
  db = await openLibraryFile();
  openedVersion = Number(marker) || 0;
  session = { token, libraryKey };
  copyKept = true;
  log("parrot.library.opened_copy", { version: openedVersion });
  return { snapshotVersion: openedVersion };
};

/** The signed-in session's token while a library is open; the ticket issuance (lib/lookup.ts) reads it. */
export const libraryToken = (): string | null => session?.token ?? null;

/** Sign out: the library file, its offline marker and the kept covers go with the session. */
export const removeLibrary = async () => {
  session = null;
  coverKeys = null;
  copyKept = false;
  await closeDb();
  await RNFS.unlink(dbPath()).catch(() => undefined);
  await AsyncStorage.removeItem(COPY_KEY).catch(() => undefined);
  await AsyncStorage.removeItem(ALBUM_COVERS_ASKED_KEY).catch(() => undefined);
  await AsyncStorage.removeItem(COPY_CHANGES_CHECK_KEY).catch(() => undefined);
  await covers.clear();
};

const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
  if (!db) throw new Error("LIBRARY_NOT_OPEN");
  const [result] = await db.executeSql(sql, params);
  const rows: T[] = [];
  for (let i = 0; i < result.rows.length; i += 1) rows.push(result.rows.item(i) as T);
  return rows;
};

/** A row with its album's two cover keys (PAR-META-04); both null for the drawn tile. Pictures are asked for by tiles. */
export type WithCoverKeys<T> = T & ParrotCoverKeys;

export type AlbumWithCover = WithCoverKeys<AlbumRow>;

const albumCoverKeys = () => {
  coverKeys ??= query<ParrotCoverKeys & { id: string }>(ALBUM_COVERS_SQL).then(
    (rows) => new Map(rows.map((row) => [row.id, { coverObjectKey: row.coverObjectKey, coverThumbObjectKey: row.coverThumbObjectKey }]))
  );
  return coverKeys.catch((error: unknown) => {
    coverKeys = null;
    throw error;
  });
};

const NO_COVER: ParrotCoverKeys = { coverObjectKey: null, coverThumbObjectKey: null };

/** `rows` with their album's cover keys: the list is ready without waiting for a single picture. */
const withCoverKeys = async <T>(rows: T[], albumIdOf: (row: T) => string): Promise<Array<WithCoverKeys<T>>> => {
  const keys = await albumCoverKeys();
  return rows.map((row) => ({ ...row, ...(keys.get(albumIdOf(row)) ?? NO_COVER) }));
};

export const listAlbums = async (): Promise<AlbumWithCover[]> => withCoverKeys(await query<AlbumRow>(ALBUMS_SQL), (album) => album.id);

/** One album as the Albums view lists it (its page re-reads it after an edit); null once it is gone. */
export const albumHeader = async (albumId: string): Promise<AlbumWithCover | null> => (await listAlbums()).find((album) => album.id === albumId) ?? null;

export const listAlbumTracks = async (albumId: string): Promise<TrackRow[]> =>
  sortTracks(await query<TrackRow>(ALBUM_TRACKS_SQL, [albumId]));

/** The album's full tracklist from the metadata, owned and missing songs (PAR-LIB-05); null when unknown. */
export const listAlbumTracklist = async (albumId: string): Promise<ParrotListedTrack[] | null> =>
  parseParrotTracklist((await query<{ tracklist: string | null }>(ALBUM_TRACKLIST_SQL, [albumId]))[0]?.tracklist);

export const listArtists = (): Promise<ArtistRow[]> => query<ArtistRow>(ARTISTS_SQL);

/** An artist's photo (PAR-META-15): both copies' keys and the credit line's parts; null when it has none. */
export const readArtistPicture = async (
  artistId: string
): Promise<{ pictureObjectKey: string; pictureThumbObjectKey: string | null; credit: ParrotPhotoCredit | null } | null> => {
  const row = (
    await query<Pick<ArtistRow, "pictureObjectKey" | "pictureThumbObjectKey" | "pictureAuthor" | "pictureLicence" | "pictureLicenceUrl">>(
      `SELECT picture_object_key AS pictureObjectKey, picture_thumb_object_key AS pictureThumbObjectKey,
              picture_author AS pictureAuthor, picture_licence AS pictureLicence, picture_licence_url AS pictureLicenceUrl
         FROM artists WHERE id = ?`,
      [artistId]
    )
  )[0];
  if (!row?.pictureObjectKey) return null;
  return { pictureObjectKey: row.pictureObjectKey, pictureThumbObjectKey: row.pictureThumbObjectKey, credit: parrotArtistPictureCredit(row) };
};

export const listArtistAlbums = async (artistId: string): Promise<AlbumWithCover[]> =>
  withCoverKeys(await query<AlbumRow>(ARTIST_ALBUMS_SQL, [artistId]), (album) => album.id);

/** Every song with its album's cover keys (PAR-META-04). */
export const listSongs = async (): Promise<Array<WithCoverKeys<SongRow>>> => withCoverKeys(await query<SongRow>(SONGS_SQL), (song) => song.albumId);

/** The library's playlists, "Liked songs" first (empty when the library predates playlists). */
export const listPlaylists = async (): Promise<ParrotPlaylist[]> => {
  if ((await query<{ name: string }>(PLAYLIST_TABLE_SQL)).length === 0) return phonePlaylists([], []);
  return phonePlaylists(await query<ParrotPlaylistRow>(PLAYLISTS_SQL), await query<ParrotPlaylistTrackRow>(PLAYLIST_TRACKS_SQL));
};

/** The playlists as stored (no stand-in "Liked songs"): what an edit is built on. */
const storedPlaylists = async (): Promise<ParrotPlaylist[]> => {
  if ((await query<{ name: string }>(PLAYLIST_TABLE_SQL)).length === 0) return [];
  return buildParrotPlaylists(await query<ParrotPlaylistRow>(PLAYLISTS_SQL), await query<ParrotPlaylistTrackRow>(PLAYLIST_TRACKS_SQL));
};

const openSession = () => {
  if (!session) throw new Error("LIBRARY_NOT_OPEN");
  return session;
};

const openState = async (): Promise<PhoneLibraryState> => ({ baseVersion: openedVersion, playlists: await storedPlaylists() });

const reopen = async () => {
  const { token, libraryKey } = openSession();
  await openLibrary(token, libraryKey);
};

/** Screens that read the open library again when it changes before the server has the change (PAR-PL-03). */
const changeListeners = new Set<() => void>();
/** Runs `listener` whenever a change is written into the open library or undone; returns the unsubscribe. */
export const onLibraryChanged = (listener: () => void) => {
  changeListeners.add(listener);
  return () => void changeListeners.delete(listener);
};

/** The open library's file as it was before the save under way changed it. */
const backupPath = () => `${dbPath()}.before-save`;

/** Copies the open library aside; the returned function closes it, puts the copy back and opens that instead. */
const keepOpenCopy = async (): Promise<() => Promise<void>> => {
  if (!db) throw new Error("LIBRARY_NOT_OPEN");
  await db.executeSql("PRAGMA wal_checkpoint(TRUNCATE)");
  await RNFS.unlink(backupPath()).catch(() => undefined);
  await RNFS.copyFile(dbPath(), backupPath());
  return async () => {
    await closeDb();
    coverKeys = null;
    for (const leftover of [dbPath(), `${dbPath()}-wal`, `${dbPath()}-shm`]) await RNFS.unlink(leftover).catch(() => undefined);
    await RNFS.copyFile(backupPath(), dbPath());
    db = await openLibraryFile();
    log("parrot.library.change_undone", { version: openedVersion });
  };
};

/** Publishing a snapshot from this phone (`@space/library-db-definition/snapshotPublish`) under `current()`'s session. */
const phoneSnapshotDeps = (current: () => { token: string; libraryKey: string }): LibrarySnapshotPublishDeps => ({
  seal: (plaintext) => encryptBytesToBytes(current().libraryKey, plaintext),
  codec: fflateCodec,
  sha256Hex: async (bytes) => crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex") as string,
  randomId: () => crypto.randomUUID(),
  uploadChunk: async (objectKey, bytes) => {
    await uploadStorageObjectViaTunnel(current().token, objectKey, bytes, {
      clientType: "mobile",
      clientVersion: "parrot-mobile",
      objectNamespace: "library",
      logicalRef: objectKey,
      uploadId: crypto.randomUUID(),
    });
  },
  putSnapshot: (put) =>
    putLibraryDb(
      current().token,
      put.baseVersion,
      put.manifestBase64,
      put.snapshotId,
      put.chunkSize,
      put.keyProbeBase64,
      false,
      null,
      null,
      "parrot",
      put.chunkRefs,
      { client: "parrot-mobile", refsVersion: TRUSTED_CHUNK_REFS_VERSION },
      { storageFormatVersion: STORAGE_FORMAT_VERSION, opStreamVersion: PARROT_OP_STREAM_VERSION }
    ),
  log,
});

const CLAIM_DB_NAME = "parrot.claim.sqlite";
const claimFilePath = () => deviceDb(CLAIM_DB_NAME).path;

/**
 * A new key made on this phone becomes the account's key (UX-KEY-01): an empty Parrot library is published with it
 * over version 0, which also writes the account's key probe, as the desktop apps do when they make the key. Until
 * then no other device can check a key against it, and this phone's own start check would find no probe and forget
 * the key. Rejects as the PUT does (409: another device made the account's library first).
 */
export const claimAccountKey = async (token: string, libraryKey: string): Promise<{ version: number }> => {
  const removeClaimFile = async () => {
    for (const leftover of [claimFilePath(), `${claimFilePath()}-wal`, `${claimFilePath()}-shm`, `${claimFilePath()}-journal`]) {
      await RNFS.unlink(leftover).catch(() => undefined);
    }
  };
  await removeClaimFile();
  log("parrot.library.claim.start", {});
  try {
    const empty = await SQLite.openDatabase({ name: CLAIM_DB_NAME, location: deviceDb(CLAIM_DB_NAME).location });
    try {
      await empty.sqlBatch(parrotLibraryMigrationStatements(0).map((sql): [string, unknown[]] => [sql, []]));
      await empty.executeSql("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => undefined);
    } finally {
      await empty.close().catch(() => undefined);
    }
    const bytes = new Uint8Array(Buffer.from(await RNFS.readFile(claimFilePath(), "base64"), "base64"));
    const { version } = await publishLibrarySnapshotWith(bytes, 0, phoneSnapshotDeps(() => ({ token, libraryKey })));
    log("parrot.library.claim.done", { version });
    return { version };
  } finally {
    await removeClaimFile();
  }
};

/**
 * A snapshot carries a new key probe made with the open key, so a phone whose key the account no longer has (erased or
 * remade elsewhere) must never publish one: it would make its old key the account's again for every device
 * (UX-KEY-01). Each save checks the probe right before its PUT; a failed meta request rejects, as the PUT would.
 */
const keyCheckedSnapshotDeps = (deps: LibrarySnapshotPublishDeps): LibrarySnapshotPublishDeps => ({
  ...deps,
  putSnapshot: async (put) => {
    const { token, libraryKey } = openSession();
    const verdict = await keptLibraryKeyVerdict(libraryKey, await getLibraryMeta(token, "parrot"), decryptBase64ToBytes);
    if (keptLibraryKeyIsStale(verdict)) {
      log("parrot.library.snapshot.key_mismatch", { verdict });
      throw new Error("KEY_MISMATCH");
    }
    return deps.putSnapshot(put);
  },
});

/** Every change the phone saves goes through this one queue, each built on the library the previous one left. */
const saver = createPhoneOpsSaver({
  current: openState,
  loadLatest: async () => {
    await reopen();
    return openState();
  },
  run: async (statements) => {
    if (!db) throw new Error("LIBRARY_NOT_OPEN");
    await db.sqlBatch(statements.map(({ sql, params }): [string, unknown[]] => [sql, [...params]]));
  },
  readBytes: async () => {
    if (!db) throw new Error("LIBRARY_NOT_OPEN");
    // Android opens SQLite in WAL mode: fold the log into the file before reading it.
    await db.executeSql("PRAGMA wal_checkpoint(TRUNCATE)");
    return new Uint8Array(Buffer.from(await RNFS.readFile(dbPath(), "base64"), "base64"));
  },
  published: (version) => {
    openedVersion = version;
    void recordLibraryCopy();
  },
  reload: reopen,
  keep: keepOpenCopy,
  changed: () => {
    for (const listener of changeListeners) listener();
  },
  snapshot: keyCheckedSnapshotDeps(phoneSnapshotDeps(openSession)),
  now: Date.now,
  newId: () => crypto.randomUUID(),
  log: (message) => console.log(message),
});

/**
 * Saves playlist and heart edits (PAR-PL-02/03/04) as the account's next library snapshot; resolves to its version.
 * Rejects when the save failed, with the server's library open again.
 */
export const saveLibraryEdits = saver.savePlaylistEdits;

/** The open library as the shared planners read it (@space/parrot-core). */
const libraryQuery: ParrotLibraryQuery = <T>(sql: string, params: readonly unknown[] = []) => query<T>(sql, [...params]);

const planDelete = (target: ParrotManageTarget) => planParrotDelete(libraryQuery, target, { now: Date.now(), newId: () => crypto.randomUUID() });

/** Removes stored objects from the account's Parrot storage (`x-space-app: parrot`). */
const deleteObjects = (keys: string[]) =>
  sdk.unwrap(
    sdk.deleteStorageObjects({
      client: sdk.createSpaceClient({ baseUrl: API_BASE_URL, token: openSession().token }),
      headers: { [SPACE_APP_HEADER]: "parrot" },
      body: { keys },
    })
  );

/** What a delete would remove, for the confirm dialog (PAR-LIB-03): nothing is changed. */
export const previewDelete = async (target: ParrotManageTarget): Promise<{ trackCount: number; albumCount: number }> => {
  const plan = await planDelete(target);
  return { trackCount: plan.trackCount, albumCount: plan.albumCount };
};

/**
 * PAR-LIB-03: deletes a song, an album or an artist, as the desktop does: the stored files first (if storage refuses,
 * nothing is removed), then the rows, published as the next snapshot. Resolves to the library version after it.
 */
export const deleteFromLibrary = (target: ParrotManageTarget): Promise<number> =>
  saver.serial(async () => {
    const plan = await planDelete(target);
    log("parrot.library.delete", { kind: target.kind, tracks: plan.trackCount, albums: plan.albumCount, objects: plan.objectKeys.length, ops: plan.ops.length });
    if (plan.ops.length === 0) return openedVersion;
    if (plan.objectKeys.length > 0) await deleteObjects(plan.objectKeys);
    try {
      return await saver.publish(`delete ${target.kind} ${target.id}`, plan.ops, async () => (await planDelete(target)).ops);
    } finally {
      coverKeys = null;
    }
  });

/**
 * The library as the edit dialog's autocomplete ranks it (PAR-META-18): every artist, album and song with the names it
 * is matched on. Read once when the dialog opens (and again after the library changed), never per keystroke.
 */
export const readSuggestLibrary = async (): Promise<ParrotSuggestLibrary> => {
  const [artists, albums, tracks] = await Promise.all([
    query<ParrotSuggestLibrary["artists"][number]>("SELECT id, name FROM artists"),
    query<ParrotSuggestLibrary["albums"][number]>(
      `SELECT al.id AS id, al.title AS title, COALESCE(ar.name, '') AS artist, al.year AS year, al.kind AS kind, al.music_id AS musicId
         FROM albums al LEFT JOIN artists ar ON ar.id = al.album_artist_id`
    ),
    query<ParrotSuggestLibrary["tracks"][number]>(
      `SELECT t.id AS id, t.title AS title, COALESCE(ar.name, '') AS artist, t.album_id AS albumId, al.title AS album,
              t.number AS number, t.disc AS disc, COALESCE(t.year, al.year) AS year
         FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id`
    ),
  ]);
  log("parrot.library.suggest_read", { artists: artists.length, albums: albums.length, tracks: tracks.length });
  return { artists, albums, tracks };
};

/** The cover of an album picked in the edit dialog's autocomplete, by its lookup id, for review; nothing is saved. */
export const fetchSuggestionCover = async (coverId: string, client: Pick<MetadataClient, "musicCover">): Promise<ParrotEditCover | null> => {
  const { cover } = await client.musicCover(coverId, 500);
  return cover ? { kind: "file", bytes: new Uint8Array(Buffer.from(cover.base64, "base64")), mime: cover.mime } : null;
};

/** The details the edit form opens with (PAR-META-16): a song's or an album's current values; null when it is gone. */
export const getEditValues = async (target: ParrotManageTarget): Promise<ParrotEditValues> => {
  if (target.kind === "track") {
    const edit = await parrotTrackEditValues(libraryQuery, target.id);
    return edit && { kind: "track", edit };
  }
  if (target.kind !== "album") return null;
  const values = await parrotAlbumEditValues(libraryQuery, target.id);
  if (!values) return null;
  const { coverObjectKey: _cover, ...edit } = values;
  return { kind: "album", edit };
};

/**
 * PAR-META-16/17: saves edited details of a song or an album, and an album's new cover (sealed with the library key
 * in both sizes), through the shared `saveParrotEdit`. Resolves to the library version after it; rejects when nothing
 * was saved.
 */
export const editDetails = (target: ParrotEditTarget, cover: ParrotEditCover | null): Promise<number> =>
  saver.serial(async () => {
    const { token, libraryKey } = openSession();
    let version = openedVersion;
    try {
      const result = await saveParrotEdit<null, { ok: true }>({
        target,
        cover,
        db: null,
        query: () => libraryQuery,
        makeCoverCopies: phoneCoverCopies,
        storeCover: async (bytes) =>
          uploadStorageObjectViaTunnel(token, `assets/${crypto.randomUUID()}`, await encryptBytesToBytes(libraryKey, bytes), {
            objectNamespace: "library",
            contentType: "application/octet-stream",
            clientType: "mobile",
            clientVersion: "parrot-mobile",
            counting: { role: "artwork" },
          }),
        publish: async (ops, build) => {
          version = await saver.publish(`edit ${target.kind} ${target.id}`, ops, () => build(null));
          return { ok: true };
        },
        deleteObjects,
        newId: () => crypto.randomUUID(),
        log: (message) => console.log(message),
        fail: (message) => console.warn(message),
      });
      if (result !== "unchanged" && !result.ok) throw new Error(result.error);
      return version;
    } finally {
      coverKeys = null;
    }
  });

/** The song's lyrics as the Lyrics sheet draws them (PAR-LYR-01); null when it has none or the library is closed. */
export const readTrackLyrics = async (trackId: string): Promise<ParrotLyrics | null> => {
  if (!db) return null;
  return toParrotLyrics((await query<ParrotLyricsRow>(TRACK_LYRICS_SQL, [trackId]))[0]);
};

/**
 * PAR-LYR-05: asks our lyrics library for the words of a song whose file has none (only its names, length and
 * id in the metadata go out, through an anonymous ticket) and keeps an answer in the library like any edit. Resolves to
 * what the sheet shows now; a failed lookup or save rejects.
 */
export const fetchTrackLyrics = async (
  trackId: string,
  lookup: (question: MusicLyricsQuery) => Promise<MusicLyrics>
): Promise<{ outcome: "found" | "none"; lyrics: ParrotLyrics | null }> => {
  const read = <Row,>(sql: string, params?: readonly (string | number | null)[]) => query<Row>(sql, [...(params ?? [])]);
  const found = await fetchParrotLyrics({ query: read, trackId, lookup, now: Date.now, newId: () => crypto.randomUUID() });
  log("lyrics.fetch", { trackId, kind: found.kind });
  // "No lyrics" is kept too, so every device shows it as final (PAR-LYR-04); a later fetch asks again.
  if (found.kind === "found" || found.kind === "none") {
    const op = found.op;
    await saver.save(`lyrics for song ${trackId}`, () => [op]);
  }
  const lyrics = await readTrackLyrics(trackId);
  return { outcome: lyrics?.synced || lyrics?.plain ? "found" : "none", lyrics };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The songs the phone's automatic pass still has to settle (PAR-LYR-06): the Lyrics sheet says "Looking for lyrics…"
 * for them and reads its song again when this set changes.
 */
export const lyricsPending = createParrotLyricsPending();

/** The library opened while a pass runs: its songs never looked up wait for the next pass, pending from now on. */
export const queueAutoLyrics = (): Promise<void> => queueParrotAutoLyrics(libraryQuery, lyricsPending);

/**
 * PAR-LYR-01: the automatic lookup on the phone, the same pass the desktop runs (`runParrotAutoLyrics`): every song
 * never looked up is asked for its words one at a time, and each batch of answers (the words, or the final "No
 * lyrics") is saved like any edit, through the same queue. Songs deleted meanwhile are left out of a batch, also when
 * it is planned again on a library another device published. `saved` gets each new library version. Nothing is saved
 * once `signal` is aborted (sign-out). The songs still to settle are held in `lyricsPending`.
 */
export const autoFetchLyrics = (args: {
  lookup: (question: MusicLyricsQuery) => Promise<MusicLyrics>;
  signal: AbortSignal;
  canSpend: ParrotCanSpend;
  saved: (version: number) => void;
}): Promise<ParrotAutoLyricsReport> =>
  runParrotAutoLyrics({
    query: () => libraryQuery,
    lookup: args.lookup,
    publish: async (ops) => {
      if (args.signal.aborted || !db) return false;
      const existing = async () => {
        const songs = new Set((await query<{ id: string }>("SELECT id FROM tracks")).map((row) => row.id));
        return ops.filter((op) => op.type === "lyrics.set" && songs.has(op.payload.trackId));
      };
      if ((await existing()).length === 0) return true;
      try {
        const version = await saver.save(`lyrics for ${ops.length} song(s), looked up on their own`, existing);
        args.saved(version);
        return true;
      } catch (error) {
        log("lyrics.auto_save_failed", { message: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },
    onError: (error, failedInARow) => {
      log("lyrics.auto_lookup_failed", { failedInARow, message: error instanceof Error ? error.message : String(error) });
      return parrotAutoLyricsOnError(error, failedInARow);
    },
    now: Date.now,
    newId: () => crypto.randomUUID(),
    sleep,
    signal: args.signal,
    pending: lyricsPending,
    canSpend: args.canSpend,
  });

/** Seals one picture copy (cover or artist photo) with the library key and stores it; resolves to its object key. */
const storeSealedCopy = async (bytes: Uint8Array): Promise<string> => {
  const { token, libraryKey } = openSession();
  return uploadStorageObjectViaTunnel(token, `assets/${crypto.randomUUID()}`, await encryptBytesToBytes(libraryKey, bytes), {
    objectNamespace: "library",
    contentType: "application/octet-stream",
    clientType: "mobile",
    clientVersion: "parrot-mobile",
    counting: { role: "artwork" },
  });
};

/**
 * PAR-META-15: the artist-photo pass on the phone, the same one the desktop runs (`runParrotAutoArtistPictures`):
 * every artist with an id in the metadata and no photo is asked for one, a found photo is sealed with the library key in
 * both sizes like an album cover, and each batch is saved like any edit, through the same queue (planned again on a
 * library another device published: artists gone are left out, a rename made there is kept). `saved` gets each new
 * library version; `onWaiting` the artists still to ask (their photos shimmer, PAR-META-20). Nothing is saved once
 * `signal` is aborted (sign-out).
 */
export const autoFetchArtistPictures = (args: {
  lookup: (artistId: string) => Promise<{ image: MusicArtistImage | null }>;
  albums: (question: MusicAlbumsQuery) => Promise<{ results: MusicAlbum[] }>;
  recordings: (question: MusicRecordingsQuery) => Promise<{ results: MusicRecording[] }>;
  signal: AbortSignal;
  canSpend: ParrotCanSpend;
  saved: (version: number) => void;
  onWaiting: (artistIds: readonly string[]) => void;
}): Promise<ParrotAutoArtistPicturesReport> =>
  runParrotAutoArtistPictures({
    query: () => libraryQuery,
    lookup: args.lookup,
    albums: args.albums,
    recordings: args.recordings,
    fromBase64: (base64) => new Uint8Array(Buffer.from(base64, "base64")),
    makeCopies: phoneCoverCopies,
    store: storeSealedCopy,
    publish: async (ops) => {
      if (args.signal.aborted || !db) return false;
      const existing = () => rebaseParrotArtistPictureOps(libraryQuery, ops);
      if ((await existing()).length === 0) return true;
      try {
        args.saved(await saver.save(`photos for ${ops.length} artist(s), looked up on their own`, existing));
        return true;
      } catch (error) {
        log("artist_pictures.auto_save_failed", { message: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },
    onError: (error, failedInARow) => {
      log("artist_pictures.auto_lookup_failed", { failedInARow, message: error instanceof Error ? error.message : String(error) });
      return parrotAutoLyricsOnError(error, failedInARow);
    },
    onWaiting: args.onWaiting,
    now: Date.now,
    newId: () => crypto.randomUUID(),
    sleep,
    signal: args.signal,
    canSpend: args.canSpend,
  });

/** The phone's memory of the cover lookups, read once before a pass; each answer is kept at once. */
const loadAlbumCoversAsked = async (): Promise<ParrotAlbumCoversAsked> => {
  const askedAt = new Map<string, number>();
  try {
    const kept = await AsyncStorage.getItem(ALBUM_COVERS_ASKED_KEY);
    for (const [albumId, at] of Object.entries(kept ? (JSON.parse(kept) as Record<string, unknown>) : {})) if (typeof at === "number") askedAt.set(albumId, at);
  } catch (error) {
    log("album_covers.asked_read_failed", { message: error instanceof Error ? error.message : String(error) });
  }
  return {
    at: (albumId) => askedAt.get(albumId) ?? null,
    mark: (albumId, at) => {
      askedAt.set(albumId, at);
      AsyncStorage.setItem(ALBUM_COVERS_ASKED_KEY, JSON.stringify(Object.fromEntries(askedAt))).catch((error: unknown) =>
        log("album_covers.asked_write_failed", { albumId, message: error instanceof Error ? error.message : String(error) })
      );
    },
  };
};

/**
 * PAR-META-20: the album-cover pass on the phone, the same one the desktop runs (`runParrotAutoAlbumCovers`): every
 * album with a known id in the metadata and no cover is asked for one, a found cover is sealed with the library key in both
 * sizes, and each batch is saved like any edit, through the same queue (planned again on a library another device
 * published: albums gone or given a cover meanwhile are left out). Which albums were asked lately is remembered on this
 * device only. `onWaiting` gets the albums still to ask (their covers shimmer); `saved` gets each new library version.
 * Nothing is saved once `signal` is aborted (sign-out).
 */
export const autoFetchAlbumCovers = async (args: {
  lookup: (albumId: string, size: MusicCoverSize) => Promise<{ cover: MusicImage | null }>;
  signal: AbortSignal;
  canSpend: ParrotCanSpend;
  saved: (version: number) => void;
  onWaiting: (albumIds: readonly string[]) => void;
}): Promise<ParrotAutoAlbumCoversReport> =>
  runParrotAutoAlbumCovers({
    query: () => libraryQuery,
    lookup: args.lookup,
    fromBase64: (base64) => new Uint8Array(Buffer.from(base64, "base64")),
    makeCopies: phoneCoverCopies,
    store: storeSealedCopy,
    publish: async (ops) => {
      if (args.signal.aborted || !db) return false;
      const existing = () => rebaseParrotAlbumCoverOps(libraryQuery, ops);
      if ((await existing()).length === 0) return true;
      try {
        const version = await saver.save(`covers for ${ops.length} album(s), looked up on their own`, existing);
        coverKeys = null;
        args.saved(version);
        return true;
      } catch (error) {
        log("album_covers.auto_save_failed", { message: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },
    asked: await loadAlbumCoversAsked(),
    onError: (error, failedInARow) => {
      log("album_covers.auto_lookup_failed", { failedInARow, message: error instanceof Error ? error.message : String(error) });
      return parrotAutoLyricsOnError(error, failedInARow);
    },
    onWaiting: args.onWaiting,
    now: Date.now,
    newId: () => crypto.randomUUID(),
    sleep,
    signal: args.signal,
    canSpend: args.canSpend,
  });

/** The phone's memory of the last music-copy check, read once before a pass. */
const loadCopyChangesCheck = async (): Promise<ParrotCopyCheck> => {
  try {
    const kept = await AsyncStorage.getItem(COPY_CHANGES_CHECK_KEY);
    const stored = (kept ? JSON.parse(kept) : {}) as Partial<ParrotCopyCheck>;
    return { checkedAt: typeof stored.checkedAt === "number" ? stored.checkedAt : null, version: typeof stored.version === "string" ? stored.version : null };
  } catch (error) {
    log("copy_changes.check_read_failed", { message: error instanceof Error ? error.message : String(error) });
    return { checkedAt: null, version: null };
  }
};

/**
 * PAR-COPY-01: the music-copy refresh on the phone, the same pass the desktop runs (`runParrotCopyChanges`): at most
 * once a day, ONE shared list of the albums each new copy changed is asked, and only the held, unedited albums on it
 * are looked up and saved like any edit, through the same queue (planned again on a library another device published).
 * The last check is remembered on this device only. Nothing is saved once `signal` is aborted (sign-out).
 */
export const autoRefreshCopyChanges = async (args: {
  changes: ParrotCopyChangesArgs["changes"];
  albums: ParrotCopyChangesArgs["albums"];
  signal: AbortSignal;
  canSpend: ParrotCanSpend;
  saved: (version: number) => void;
}): Promise<ParrotCopyChangesReport> => {
  let remembered = await loadCopyChangesCheck();
  return runParrotCopyChanges({
    query: () => libraryQuery,
    changes: args.changes,
    albums: args.albums,
    publish: async (ops) => {
      if (args.signal.aborted || !db) return false;
      const existing = () => rebaseParrotCopyRefreshOps(libraryQuery, ops);
      if ((await existing()).length === 0) return true;
      try {
        args.saved(await saver.save(`details of ${ops.filter((op) => op.type === "album.upsert").length} album(s) refreshed from a new copy`, existing));
        return true;
      } catch (error) {
        log("copy_changes.save_failed", { message: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },
    memory: {
      read: () => remembered,
      write: (next) => {
        remembered = next;
        AsyncStorage.setItem(COPY_CHANGES_CHECK_KEY, JSON.stringify(next)).catch((error: unknown) =>
          log("copy_changes.check_write_failed", { message: error instanceof Error ? error.message : String(error) })
        );
      },
    },
    onError: (error, failedInARow) => {
      log("copy_changes.lookup_failed", { failedInARow, message: error instanceof Error ? error.message : String(error) });
      return parrotAutoLyricsOnError(error, failedInARow);
    },
    now: Date.now,
    newId: () => crypto.randomUUID(),
    sleep,
    signal: args.signal,
    canSpend: args.canSpend,
  });
};

/** One playlist's songs in its order, with their album's cover keys. */
export const listPlaylistSongs = async (playlistId: string): Promise<Array<WithCoverKeys<SongRow>>> =>
  withCoverKeys(await query<SongRow>(PLAYLIST_SONGS_SQL, [playlistId]), (song) => song.albumId);

/** The kept file of the cover stored under `objectKey`, downloaded and opened first when needed; null when none. */
export const coverUri = (objectKey: string | null | undefined) => covers.uriFor(objectKey);

/** The kept file of the cover stored under `objectKey` when it is already there; null otherwise (nothing is fetched). */
export const keptCoverUri = (objectKey: string | null | undefined) => covers.kept(objectKey);

/** Every stored file of `trackId`: its originals and its light copy (PAR-FMT-02); none when it has no stored file. */
export const trackFiles = async (trackId: string): Promise<TrackFileRow[]> =>
  (await query<RawTrackFileRow>(TRACK_FILES_SQL, [trackId])).map(toTrackFileRow);

/** `file` laid out for the media proxy: its chunk objects. */
export const chunkedFile = async (file: TrackFileRow): Promise<ChunkedFile> =>
  toChunkedFile(file, await query<TrackFileChunkRow>(FILE_CHUNKS_SQL, [file.id]));

/** What keeping reads of the open library, once per load (PAR-OFFL-01): songs' albums, playlists and stored files. */
export const readKeepLibrary = async (): Promise<KeepLibrary> => {
  const [tracks, playlists, files] = await Promise.all([
    query<{ id: string; albumId: string }>("SELECT id, album_id AS albumId FROM tracks"),
    listPlaylists(),
    query<RawTrackFileRow>(ALL_TRACK_FILES_SQL),
  ]);
  return keepLibraryFromRows({ tracks, playlists, files: files.map(toTrackFileRow) });
};

/** One stored file's chunk objects and its song's title and artist, for the download queue and its notification. */
export const fileForDownload = async (file: { id: string; trackId: string }) => {
  const [song] = await query<{ title: string; artistName: string }>(
    "SELECT t.title AS title, COALESCE(ar.name, '') AS artistName FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id WHERE t.id = ?",
    [file.trackId]
  );
  return { title: song?.title ?? "", artistName: song?.artistName ?? "", chunks: await query<TrackFileChunkRow>(FILE_CHUNKS_SQL, [file.id]) };
};

// "Save offline" (PAR-OFFL-01/02): the shared keeping loop (`createParrotKeeping` in `@space/parrot-core`, the
// desktop runs the same one) with the kept list in AsyncStorage and the songs in the phone's native download engine
// (`@space/mobile-media-proxy/downloads`, one download per kept song file, stored encrypted like Badger's, OFFL-FILE-03).
// The engine waits for Wi-Fi on its own: Parrot has no "Downloads over Wi-Fi only" switch yet, so it stays on, Badger's
// default (agent reading, approved by Main (2026-11-09)). Songs a library load finds missing (added later to a kept
// album or playlist) are handed over only while the phone is on Wi-Fi.
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createParrotKeeping,
  keptTrackIds,
  type KeepCopyChoice,
  type KeepLibrary,
  type KeptKind,
  type KeptStatus,
  type ParrotKeeping,
  type TrackFileRow,
} from "@space/parrot-core";
import { resolveGatewayCandidates } from "@space/mobile-media-proxy";
import {
  downloadNotificationLabels,
  downloadsNativeAvailable,
  EMPTY_DOWNLOADS_STATE,
  nativeConfigure,
  nativeEnqueue,
  nativeGetState,
  nativeGetStatus,
  nativeRemove,
  nativeResume,
  parseDownloadsState,
  subscribeNativeState,
  type DownloadItem,
  type DownloadsState,
} from "@space/mobile-media-proxy/downloads";
import { translate } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { fileForDownload, readKeepLibrary, setLibraryCopyKept } from "./library";
import { parrotOfflineTrackIds, type OfflineManageRow } from "@space/shared/offlineManage";

const logger = scopeLogger("kept");
const log = (line: string) => logger.info(line);

const KEPT_KEY = "parrot.kept";
const APP_ID = "parrot";
/** See the header: the native engine waits for Wi-Fi before any download. */
const WIFI_ONLY = true;

export const EMPTY_KEPT_STATUS: KeptStatus = Object.freeze({ entries: [], songs: [], downloading: false }) as KeptStatus;

let keeping: Promise<ParrotKeeping> | null = null;
let instance: ParrotKeeping | null = null;
let library: KeepLibrary | null = null;
let token: string | null = null;
let unsubscribeNative: (() => void) | null = null;
let native: DownloadsState = EMPTY_DOWNLOADS_STATE;
let current: KeptStatus = EMPTY_KEPT_STATUS;
const listeners = new Set<() => void>();

const songItems = (): DownloadItem[] => native.items.filter((item) => item.kind === "song");

const publish = (status: KeptStatus) => {
  current = status;
  for (const listener of listeners) listener();
};

/** Hands one song file to the native download queue, titled with the song for its notification. */
const enqueueSong = async (file: TrackFileRow) => {
  if (!token) throw new Error("NOT_SIGNED_IN");
  const { title, artistName, chunks } = await fileForDownload(file);
  if (chunks.length === 0) throw new Error("FILE_CHUNKS_MISSING");
  const gatewayCandidates = await resolveGatewayCandidates(token, null);
  await nativeEnqueue({
    id: file.id,
    mediaId: file.trackId,
    title: title || file.trackId,
    subtitle: artistName || null,
    kind: "song",
    seasonNumber: null,
    episodeNumber: null,
    quality: file.lossless ? "lossless" : `${file.bitrateKbps ?? 0}k`,
    formatId: file.id,
    codec: file.mime,
    estimatedBytes: file.sizeBytes,
    objects: [...new Set(chunks.map((chunk) => chunk.objectKey))].map((key): [string, number] => [key, 0]),
    gatewayCandidates,
  });
};

const createKeeping = () =>
  createParrotKeeping({
    storage: {
      read: () => AsyncStorage.getItem(KEPT_KEY),
      write: (text) => AsyncStorage.setItem(KEPT_KEY, text),
      remove: () => AsyncStorage.removeItem(KEPT_KEY),
    },
    files: {
      // A failed download is not on the phone: the next run hands it to the engine again.
      fileIds: () => songItems().filter((item) => item.status !== "failed").map((item) => item.id),
      completeIds: () => songItems().filter((item) => item.status === "completed").map((item) => item.id),
      mayDownload: async (byHand) => {
        if (byHand) return true;
        const { networkType } = await nativeGetStatus();
        return networkType === "wifi" || networkType === "ethernet";
      },
      keep: async (file, cancelled) => {
        if (cancelled()) return false;
        await enqueueSong(file);
        log(`[kept] song ${file.trackId} handed to the download queue (${file.id}, ${file.sizeBytes} bytes)`);
        return true;
      },
      remove: (ids) => nativeRemove(ids).then(() => undefined),
      clear: async () => {
        const ids = songItems().map((item) => item.id);
        if (ids.length) await nativeRemove(ids);
      },
    },
    library: () => library,
    onChange: publish,
    onKeptAny: (any) => void setLibraryCopyKept(any),
    log,
  });

const ready = (): Promise<ParrotKeeping> => {
  keeping ??= createKeeping().then(async (created) => {
    await setLibraryCopyKept(created.status().entries.length > 0);
    instance = created;
    publish(created.status());
    return created;
  });
  return keeping;
};

/**
 * Signed in (or the token or the language changed): hands the engine the token and the notification text, loads its
 * queue and resumes what was unfinished. Safe to call again.
 */
export const startKeeping = async (authToken: string): Promise<void> => {
  token = authToken;
  if (downloadsNativeAvailable()) {
    unsubscribeNative ??= subscribeNativeState((raw) => {
      native = parseDownloadsState(raw);
      void keeping?.then((created) => created.notify());
    });
    await nativeConfigure(authToken, APP_ID, WIFI_ONLY, downloadNotificationLabels(translate));
    native = await nativeGetState();
    if (native.items.some((item) => item.status !== "completed")) await nativeResume();
  }
  await ready();
};

/**
 * A library was opened (or saved): keeping reads it again and makes the phone match the kept list. Failed downloads no
 * kept item holds any more are dropped from the engine too.
 */
export const keptLibraryLoaded = async (): Promise<void> => {
  const created = await ready();
  library = await readKeepLibrary();
  await created.reconcile();
  const held = new Set(created.status().songs.map((song) => song.fileId));
  const stale = songItems().filter((item) => item.status === "failed" && !held.has(item.id)).map((item) => item.id);
  if (stale.length) await nativeRemove(stale);
  publish(created.status());
};

export const keepItem = async (kind: KeptKind, id: string, choice: string | null) => publish(await (await ready()).keep(kind, id, choice));

export const unkeepItem = async (kind: KeptKind, id: string) => publish(await (await ready()).unkeep(kind, id));

/** Settings › Manage offline content › Remove all (OFFL-MANAGE-01): every kept item is unkept, so its songs leave the phone. */
export const unkeepAll = async (): Promise<void> => {
  const created = await ready();
  for (const entry of created.status().entries) publish(await created.unkeep(entry.kind, entry.id));
};

/** One kept album, playlist or song with the songs it holds on the phone and the file kept for each. */
export type KeptItemSongs = { kind: KeptKind; id: string; songs: Array<{ trackId: string; fileId: string }> };

/**
 * Each kept item with its songs on the phone (OFFL-MANAGE-01), songs left out by hand excluded: the screen groups them
 * into artists › albums › songs and playlists › songs. A song two kept items share is listed under both.
 */
export const keptSongs = (): KeptItemSongs[] => {
  const fileOf = new Map(current.songs.map((song) => [song.trackId, song.fileId]));
  return current.entries.map((entry) => ({
    kind: entry.kind,
    id: entry.id,
    songs: library
      ? [...new Set(keptTrackIds(library, entry))].flatMap((trackId) => {
          const fileId = fileOf.get(trackId);
          return fileId ? [{ trackId, fileId }] : [];
        })
      : [],
  }));
};

/**
 * Manage offline content's bin on a song, an album, an artist or a playlist row (OFFL-MANAGE-01). A song's bin leaves
 * that song out of the library's kept albums and songs, or of one kept playlist; an album's, an artist's or a playlist's
 * bin also stops keeping the albums or the playlist outright, so songs that cannot play (never on the phone, so not
 * under the row) do not keep the item saved. A file another kept item still holds stays on the phone.
 */
export const removeKeptRow = async (row: OfflineManageRow) => {
  const trackIds = parrotOfflineTrackIds(row);
  const from = row.playlistId ? { playlist: row.playlistId } : ("library" as const);
  const whole: Array<{ kind: "album" | "playlist"; id: string }> =
    row.kind === "playlist" || row.kind === "album"
      ? [{ kind: row.kind, id: row.id }]
      : row.kind === "artist"
        ? row.children.filter((child) => child.kind === "album").map((album) => ({ kind: "album" as const, id: album.id }))
        : [];
  log(`[kept] bin ${row.key}: ${trackIds.length} song(s), ${whole.length} whole item(s) from ${row.playlistId ? `playlist ${row.playlistId}` : "the library"}`);
  publish(await (await ready()).leaveOut(trackIds, from, whole));
};

/** The copies to ask about (PAR-OFFL-02); two or more is a real choice. */
export const keepChoices = async (kind: KeptKind, id: string): Promise<KeepCopyChoice[]> => (await ready()).choices(kind, id);

/** The complete kept file of a song, when it is kept here; null otherwise (or before keeping started). */
export const keptFileIdFor = (trackId: string): string | null => instance?.keptFileId(trackId) ?? null;

export const getKeptStatus = (): KeptStatus => current;

export const subscribeKept = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Sign-out: the kept list and every kept song leave the phone. */
export const clearKeeping = async (): Promise<void> => {
  const created = await ready();
  await created.clear();
  library = null;
  token = null;
  publish(EMPTY_KEPT_STATUS);
};

/**
 * Offline downloads on the phone (`@space/mobile-media-proxy/downloads`): the shared types and the thin typed wrapper over
 * `NativeModules.DownloadsBridge` (android/.../mediaproxy/downloads/DownloadsModule.kt). One engine for every app: Badger
 * keeps titles (OFFL-FILE-03), Parrot keeps songs (PAR-OFFL-01). No policy lives here: what to download is each app's
 * (Badger `apps/badger/mobile/src/lib/downloads`, Parrot `@space/parrot-core` offline.ts); native only executes,
 * persists and resumes.
 *
 * Badger model: one download per library `media_files.id` (a movie or one episode), exactly like the desktop
 * `media_local_downloads.file_id` (UNIQUE) row in `packages/library-db-definition`. Desktop muxes a single mkv/mp4
 * through ffmpeg; mobile cannot, so it stores the SAME encrypted storage objects the player streams (init + chunks of
 * the chosen format, all audio tracks, all subtitle objects) and serves them through the local playback proxy. Quality
 * is a stored rendition label (`1080p`, `420p`, ...) picked in the download prompt (OFFL-QUAL-01,
 * `@space/shared/offlineQualityChoice`).
 *
 * Parrot model: one download per kept song, id = its `track_files.id`, objects = that file's SFV1 chunks; the proxy
 * serves them from disk first, and alone with `clientKind: "offline"`.
 */
import { useSyncExternalStore } from "react";
import { AppState, DeviceEventEmitter, NativeModules } from "react-native";

/** Native queue states (see `DownloadStatus` in DownloadQueueStore.kt). */
export type DownloadStatus = "queued" | "downloading" | "waiting_network" | "completed" | "failed";

/** Native error codes (see `DownloadErrorCode` in DownloadQueueStore.kt). */
export type DownloadErrorCode = "auth" | "network" | "insufficient_space" | "storage";

export type DownloadKind = "movie" | "episode" | "song";

/** Light item snapshot pushed by the native engine (no object list). */
export type DownloadItem = {
  /** Library `media_files.id`. */
  id: string;
  mediaId: string;
  title: string;
  subtitle: string | null;
  kind: DownloadKind;
  seasonNumber: number | null;
  episodeNumber: number | null;
  quality: string;
  formatId: string;
  codec: string;
  status: DownloadStatus;
  errorCode: DownloadErrorCode | null;
  errorMessage: string | null;
  estimatedBytes: number;
  totalObjects: number;
  doneBytes: number;
  doneObjects: number;
  /** Actual bytes on disk; only meaningful once completed. */
  storedBytes: number;
  createdAt: number;
  completedAt: number;
};

/**
 * The silo's traffic as the engine acts on it (STOR-BW-01, STOR-BW-09): `slowed` = high traffic, transfers run at the
 * reduced rate; `held` = saturated, transfers wait for the silo; `normal` = no restriction.
 */
export type DownloadsTraffic = "normal" | "slowed" | "held";

export type DownloadsState = {
  items: DownloadItem[];
  traffic: DownloadsTraffic;
  /** Native network gate: false while waiting for Wi-Fi (or for any network). */
  networkAllowed: boolean;
  wifiOnly: boolean;
};

export const EMPTY_DOWNLOADS_STATE: DownloadsState = Object.freeze({
  items: [] as DownloadItem[],
  traffic: "normal",
  networkAllowed: true,
  wifiOnly: true,
}) as DownloadsState;

/** What JS hands to `DownloadsBridge.enqueue` (one media file). */
export type DownloadItemSpec = {
  id: string;
  mediaId: string;
  title: string;
  subtitle: string | null;
  kind: DownloadKind;
  seasonNumber: number | null;
  episodeNumber: number | null;
  quality: string;
  formatId: string;
  codec: string;
  estimatedBytes: number;
  /** `[objectKey, sizeBytes]`, de-duplicated; sizeBytes 0 when unknown. */
  objects: Array<[string, number]>;
};

export type NetworkType = "wifi" | "ethernet" | "cellular" | "other" | "none";

export type NativeStatus = {
  networkType: NetworkType;
  freeBytes: number;
};

/** One complete download with the space it takes on disk (Settings › "Manage offline content", OFFL-MANAGE-01). */
export type OfflineInventoryItem = {
  /** The download id: Badger `media_files.id`, Parrot `track_files.id`. */
  itemId: string;
  /** Bytes on disk of every object it holds (an object shared with another item counts in both). */
  bytes: number;
  objectCount: number;
  /** When it finished downloading (epoch ms); null when unknown. */
  savedAt: number | null;
};

/** Complete downloads and the space they take; an object shared by several items counts once in `totalBytes`. */
export type OfflineInventory = { items: OfflineInventoryItem[]; totalBytes: number };

export const EMPTY_OFFLINE_INVENTORY: OfflineInventory = Object.freeze({ items: [] as OfflineInventoryItem[], totalBytes: 0 }) as OfflineInventory;

type NativeDownloads = {
  configure(authToken: string, appId: string, wifiOnly: boolean, labelsJson: string): Promise<boolean>;
  enqueue(itemJson: string): Promise<boolean>;
  retry(id: string, gatewayCandidatesJson: string | null): Promise<boolean>;
  remove(idsJson: string): Promise<boolean>;
  removeAll(): Promise<boolean>;
  listItems(): Promise<string>;
  resume(): Promise<boolean>;
  getState(): Promise<string>;
  getStatus(): Promise<string>;
};

/**
 * The download notification text the native engines show (Android progress notification and channel, iOS
 * completion/failure notifications), in the app's language (UX-I18N-02). Native code cannot read the app's translation
 * files, so `configure` hands it these strings; it keeps the last ones for runs without JS. `activeItems` keeps the
 * literal `{count}` token, which native code replaces with the number of active downloads; `percent` keeps the literal
 * `{percent}` token for the progress.
 */
export type DownloadNotificationLabels = {
  title: string;
  channelDescription: string;
  activeItems: string;
  waitingWifi: string;
  waitingNetwork: string;
  percent: string;
  completed: string;
  failed: string;
  insufficientSpace: string;
  auth: string;
  network: string;
};

const EVENT_NAME = "SpaceDownloadsChanged";

const native = (): NativeDownloads => {
  const mod = NativeModules.DownloadsBridge as NativeDownloads | undefined;
  if (!mod) throw new Error("DOWNLOADS_NATIVE_UNAVAILABLE");
  return mod;
};

export const downloadsNativeAvailable = (): boolean => Boolean(NativeModules.DownloadsBridge);

export const parseDownloadsState = (raw: string): DownloadsState => {
  const parsed = JSON.parse(raw) as Partial<DownloadsState>;
  return {
    items: parsed.items ?? [],
    traffic: parsed.traffic === "slowed" || parsed.traffic === "held" ? parsed.traffic : "normal",
    networkAllowed: parsed.networkAllowed ?? true,
    wifiOnly: parsed.wifiOnly ?? true,
  };
};

export const parseOfflineInventory = (raw: string): OfflineInventory => {
  const parsed = JSON.parse(raw) as Partial<OfflineInventory>;
  const items = (parsed.items ?? []).map((item) => ({
    itemId: String(item.itemId),
    bytes: Number(item.bytes) || 0,
    objectCount: Number(item.objectCount) || 0,
    savedAt: typeof item.savedAt === "number" && item.savedAt > 0 ? item.savedAt : null,
  }));
  return { items, totalBytes: Number(parsed.totalBytes) || 0 };
};

export const nativeConfigure = (authToken: string, appId: string, wifiOnly: boolean, labels: DownloadNotificationLabels) =>
  native().configure(authToken, appId, wifiOnly, JSON.stringify(labels));

export const nativeEnqueue = (spec: DownloadItemSpec & { gatewayCandidates: string[] }) => native().enqueue(JSON.stringify(spec));

export const nativeRetry = (id: string, gatewayCandidates: string[] | null) =>
  native().retry(id, gatewayCandidates ? JSON.stringify(gatewayCandidates) : null);

export const nativeRemove = (ids: string[]) => native().remove(JSON.stringify(ids));

/** Cancels and deletes every download, finished or not. */
export const nativeRemoveAll = () => native().removeAll();

/** Complete downloads and their size on disk; empty where the engine is absent (TV, tests). */
export const nativeListItems = async (): Promise<OfflineInventory> => {
  if (!downloadsNativeAvailable()) return EMPTY_OFFLINE_INVENTORY;
  return parseOfflineInventory(await native().listItems());
};

export const nativeResume = () => native().resume();

export const nativeGetState = async (): Promise<DownloadsState> => {
  if (!downloadsNativeAvailable()) return EMPTY_DOWNLOADS_STATE;
  return parseDownloadsState(await native().getState());
};

export const nativeGetStatus = async (): Promise<NativeStatus> => JSON.parse(await native().getStatus()) as NativeStatus;

/** Subscribe to raw state pushes (JSON string; parsed lazily by the caller). */
export const subscribeNativeState = (handler: (rawState: string) => void): (() => void) => {
  const sub = DeviceEventEmitter.addListener(EVENT_NAME, handler);
  return () => sub.remove();
};

/**
 * The download notification text in the app's language, from the phone apps' shared `downloads.*` strings
 * (`@space/mobile-shell/i18n`); `translate` is that i18n's. Badger and Parrot hand it to `nativeConfigure`.
 */
export const downloadNotificationLabels = (translate: (key: string, options?: Record<string, unknown>) => string): DownloadNotificationLabels => ({
  title: translate("downloads.title"),
  channelDescription: translate("downloads.notification.channelDescription"),
  activeItems: translate("downloads.notification.activeItems", { number: "{count}" }),
  waitingWifi: translate("downloads.status.waitingWifi"),
  waitingNetwork: translate("downloads.status.waitingNetwork"),
  percent: translate("downloads.percent", { percent: "{percent}" }),
  completed: translate("downloads.notification.completed"),
  failed: translate("downloads.errors.failed"),
  insufficientSpace: translate("downloads.errors.insufficientSpace"),
  auth: translate("downloads.errors.auth"),
  network: translate("downloads.errors.network"),
});

/**
 * Whether the phone has a network at all, read from the download engine's network check (no other native module):
 * false in airplane mode or with Wi-Fi and mobile data off. Polled every 3 s, and at once when the app comes back to the
 * front, only while a screen watches it. Without the native engine (tests, a build without it) it stays true.
 * Used to grey out what cannot play offline (PAR-OFFL-04, and Badger's OFFL-PLAY-03 through its `networkListener`).
 */
let deviceOnline = true;
const onlineListeners = new Set<() => void>();
let stopOnlineWatch: (() => void) | null = null;

const checkOnline = async () => {
  if (!downloadsNativeAvailable()) return;
  const next = await nativeGetStatus()
    .then((status) => status.networkType !== "none")
    .catch(() => deviceOnline);
  if (next === deviceOnline) return;
  deviceOnline = next;
  for (const listener of onlineListeners) listener();
};

/** Watch `getDeviceOnline()`: the listener runs each time it flips. Returns the unsubscribe. */
export const subscribeDeviceOnline = (listener: () => void): (() => void) => {
  onlineListeners.add(listener);
  if (!stopOnlineWatch) {
    void checkOnline();
    const timer = setInterval(() => void checkOnline(), 3000);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void checkOnline();
    });
    stopOnlineWatch = () => {
      clearInterval(timer);
      appState.remove();
    };
  }
  return () => {
    onlineListeners.delete(listener);
    if (onlineListeners.size === 0 && stopOnlineWatch) {
      stopOnlineWatch();
      stopOnlineWatch = null;
    }
  };
};

export const getDeviceOnline = (): boolean => deviceOnline;

export const useDeviceOnline = (): boolean => useSyncExternalStore(subscribeDeviceOnline, getDeviceOnline);

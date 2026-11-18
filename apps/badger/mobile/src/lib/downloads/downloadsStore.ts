/**
 * JS mirror of the native download queue.
 *
 * The native engine is the source of truth (persisted queue, survives app
 * kill / reboot) and pushes its full state as a `SpaceDownloadsChanged` event
 * (≤2 Hz while active). The store keeps the RAW json and parses it lazily on
 * first read, so while nobody is subscribed (e.g. during playback) a running
 * download costs the JS thread nothing.
 */
import { useMemo, useSyncExternalStore } from "react";
import { scopeLogger } from "@space/mobile-shell/logger";
import { completedMediaIds, needsResume } from "./decisions";
import {
  downloadsNativeAvailable,
  EMPTY_DOWNLOADS_STATE,
  nativeConfigure,
  nativeGetState,
  nativeResume,
  parseDownloadsState,
  subscribeNativeState,
  type DownloadItem,
  type DownloadNotificationLabels,
  type DownloadsState,
} from "@space/mobile-media-proxy/downloads";

const log = scopeLogger("downloads");

const APP_ID = "badger";

let raw: string | null = null;
let parsed: DownloadsState = EMPTY_DOWNLOADS_STATE;
let parsedFrom: string | null = null;
const listeners = new Set<() => void>();
let nativeUnsubscribe: (() => void) | null = null;

const getSnapshot = (): DownloadsState => {
  if (raw !== null && raw !== parsedFrom) {
    try {
      parsed = parseDownloadsState(raw);
    } catch (err) {
      log.warn("state.parse_failed", { error: String(err) });
    }
    parsedFrom = raw;
  }
  return parsed;
};

const setRaw = (next: string) => {
  raw = next;
  listeners.forEach((l) => l());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Current downloads state (non-reactive). */
export const getDownloadsState = getSnapshot;

/** Completed download for a file, or undefined. */
export const getCompletedDownload = (fileId: string): DownloadItem | undefined =>
  getSnapshot().items.find((i) => i.id === fileId && i.status === "completed");

/**
 * Start the bridge: hand the native engine the current auth token, Wi-Fi
 * policy and notification text, subscribe to pushes, load the persisted queue
 * and resume anything unfinished (app was killed mid-download, device
 * rebooted, token expired…). Safe to call again whenever the token, the
 * Wi-Fi-only setting or the app language changes.
 */
export const startDownloads = async (input: {
  authToken: string;
  wifiOnly: boolean;
  labels: DownloadNotificationLabels;
}): Promise<void> => {
  if (!downloadsNativeAvailable()) return;
  if (!nativeUnsubscribe) nativeUnsubscribe = subscribeNativeState(setRaw);
  await nativeConfigure(input.authToken, APP_ID, input.wifiOnly, input.labels);
  const state = await nativeGetState();
  setRaw(JSON.stringify(state));
  if (needsResume(state.items)) {
    log.info("resume", { items: state.items.filter((i) => i.status !== "completed").length });
    await nativeResume();
  }
};

export const useDownloads = (): DownloadsState =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

let downloadedFor: DownloadsState | null = null;
let downloadedMediaIds: ReadonlySet<string> = new Set();

const getDownloadedMediaIds = (): ReadonlySet<string> => {
  const state = getSnapshot();
  if (state !== downloadedFor) {
    downloadedFor = state;
    downloadedMediaIds = completedMediaIds(state.items, downloadedMediaIds);
  }
  return downloadedMediaIds;
};

/**
 * True when at least one file of the title is stored on the device. Returns a
 * primitive, so library cards only re-render when their own flag flips (not on
 * every progress push).
 */
export const useIsMediaDownloaded = (mediaId: string): boolean =>
  useSyncExternalStore(subscribe, () => getDownloadedMediaIds().has(mediaId));

/** Stable set of media ids with a completed download (same instance across progress pushes). */
export const useDownloadedMediaIds = (): ReadonlySet<string> =>
  useSyncExternalStore(subscribe, getDownloadedMediaIds, getDownloadedMediaIds);

/** Map of fileId → item, rebuilt only when the state changes. */
export const useDownloadsById = (): { byId: ReadonlyMap<string, DownloadItem>; state: DownloadsState } => {
  const state = useDownloads();
  const byId = useMemo(() => new Map(state.items.map((i) => [i.id, i] as const)), [state]);
  return { byId, state };
};

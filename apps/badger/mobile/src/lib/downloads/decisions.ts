/**
 * Pure decision logic for offline downloads (start / Wi-Fi gate / resume /
 * pill state). Native code executes the queue; every policy decision is made
 * here so it is unit tested (`tests/downloads-decisions.test.ts`).
 */
import { getCurrentLanguage, translate } from "@space/mobile-shell/i18n";
import { formatLocalizedStorage } from "@space/shared/format";
import type { DownloadItem, NetworkType } from "@space/mobile-media-proxy/downloads";

/** Never fill the phone: always leave this much free after the download. */
export const SPACE_RESERVE_BYTES = 100 * 1024 * 1024;
/** Encrypted objects carry envelope overhead and sizes can be estimated. */
export const SPACE_SAFETY_FACTOR = 1.05;

export const requiredBytesFor = (estimatedBytes: number): number =>
  Math.ceil(Math.max(0, estimatedBytes) * SPACE_SAFETY_FACTOR) + SPACE_RESERVE_BYTES;

/** Is a transfer allowed on this network under the Wi-Fi-only setting? */
export const isNetworkAllowed = (wifiOnly: boolean, network: NetworkType): boolean => {
  if (network === "none") return false;
  if (!wifiOnly) return true;
  return network === "wifi" || network === "ethernet";
};

export type StartDecision =
  | {
      action: "enqueue";
      /** True when the queue will sit in "waiting for Wi-Fi" until Wi-Fi is up. */
      waitForWifi: boolean;
    }
  | {
      action: "refuse";
      reason: "insufficient_space";
      requiredBytes: number;
      freeBytes: number;
    }
  | { action: "refuse"; reason: "no_network" };

/** Human size in the current UI language: "800 Mo", "1,5 Go" in French (STOR-UNIT-02). A zero size reads "0 MB", not "0 B". */
export const formatBytes = (bytes: number): string =>
  formatLocalizedStorage(bytes, getCurrentLanguage(), { minUnit: bytes > 0 ? "B" : "MB" });

/**
 * Decide whether a download of `estimatedBytes` may be enqueued now.
 *  - Not enough free space → refuse with `insufficient_space` (before anything is
 *    fetched; native re-checks as defense in depth, like desktop `submit`).
 *  - No connectivity at all → refuse: the gateway cannot be resolved.
 *  - Wi-Fi only on a non-Wi-Fi network → enqueue but wait for Wi-Fi.
 */
export const decideStart = (input: {
  estimatedBytes: number;
  /** Remaining bytes of downloads already queued/active (see `pendingDownloadBytes`). */
  pendingBytes?: number;
  freeBytes: number;
  wifiOnly: boolean;
  networkType: NetworkType;
}): StartDecision => {
  const requiredBytes = requiredBytesFor(input.estimatedBytes + (input.pendingBytes ?? 0));
  if (input.freeBytes < requiredBytes) {
    return {
      action: "refuse",
      reason: "insufficient_space",
      requiredBytes,
      freeBytes: input.freeBytes,
    };
  }
  if (input.networkType === "none") {
    return { action: "refuse", reason: "no_network" };
  }
  return { action: "enqueue", waitForWifi: !isNetworkAllowed(input.wifiOnly, input.networkType) };
};

const ACTIVE: ReadonlyArray<DownloadItem["status"]> = ["queued", "downloading", "waiting_network"];

export const isActiveStatus = (status: DownloadItem["status"]): boolean => ACTIVE.includes(status);

/**
 * Bytes still to fetch for downloads already queued or running: they will take that space too,
 * so a new request must be checked against free space minus this.
 */
export const pendingDownloadBytes = (
  items: ReadonlyArray<Pick<DownloadItem, "status" | "estimatedBytes" | "doneBytes">>,
): number =>
  items.reduce(
    (sum, i) => (isActiveStatus(i.status) ? sum + Math.max(0, i.estimatedBytes - i.doneBytes) : sum),
    0,
  );

/**
 * Resume policy at app start: unfinished work (queued / downloading /
 * waiting) plus failures that are expected to heal on their own — a stale
 * auth token (JS just re-configured a fresh one) or a network error. Out of
 * space and storage errors stay failed until the user retries.
 */
export const needsResume = (items: ReadonlyArray<Pick<DownloadItem, "status" | "errorCode">>): boolean =>
  items.some(
    (i) =>
      isActiveStatus(i.status) ||
      (i.status === "failed" && (i.errorCode === "auth" || i.errorCode === "network")),
  );

/** 0..100 for one item. Completed = 100; active items never reach 100 early. */
export const itemPercent = (item: Pick<DownloadItem, "status" | "estimatedBytes" | "doneBytes" | "totalObjects" | "doneObjects">): number => {
  if (item.status === "completed") return 100;
  const frac =
    item.estimatedBytes > 0
      ? item.doneBytes / item.estimatedBytes
      : item.totalObjects > 0
        ? item.doneObjects / item.totalObjects
        : 0;
  return Math.max(0, Math.min(99, Math.floor(frac * 100)));
};

export type PillState =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "waiting"; reason: "wifi" | "network" }
  | { kind: "downloading"; percent: number }
  | { kind: "partial"; completed: number; total: number }
  | { kind: "downloaded" }
  | { kind: "error"; error: Pick<DownloadItem, "errorCode" | "errorMessage">; retryable: boolean };

/**
 * Collapse the download items of a scope (one episode, a season, a whole show
 * or a movie) into the single state the download pill shows.
 * `fileIds` are the playable files of the scope; files without a download
 * entry count as not downloaded.
 */
export const derivePillState = (
  fileIds: ReadonlyArray<string>,
  itemsById: ReadonlyMap<string, DownloadItem>,
  net: { networkAllowed: boolean; wifiOnly: boolean },
): PillState => {
  if (fileIds.length === 0) return { kind: "idle" };

  let completed = 0;
  let downloading = 0;
  let queued = 0;
  let waiting = 0;
  let failed: DownloadItem | null = null;
  let percentSum = 0;

  for (const id of fileIds) {
    const item = itemsById.get(id);
    if (!item) continue;
    percentSum += itemPercent(item);
    switch (item.status) {
      case "completed":
        completed += 1;
        break;
      case "downloading":
        downloading += 1;
        break;
      case "queued":
        queued += 1;
        break;
      case "waiting_network":
        waiting += 1;
        break;
      case "failed":
        failed ??= item;
        break;
    }
  }

  const active = downloading + queued + waiting;
  if (completed === fileIds.length) return { kind: "downloaded" };
  if (active > 0) {
    if (!net.networkAllowed || (downloading === 0 && waiting > 0)) {
      return { kind: "waiting", reason: net.wifiOnly ? "wifi" : "network" };
    }
    if (downloading === 0) return { kind: "queued" };
    return { kind: "downloading", percent: Math.floor(percentSum / fileIds.length) };
  }
  if (failed) {
    return {
      kind: "error",
      error: { errorCode: failed.errorCode, errorMessage: failed.errorMessage },
      retryable: failed.errorCode !== "insufficient_space",
    };
  }
  if (completed > 0) return { kind: "partial", completed, total: fileIds.length };
  return { kind: "idle" };
};

/** User-facing failure text in the current UI language (call at render time, never store it). */
export const describeError = (item: Pick<DownloadItem, "errorCode" | "errorMessage">): string => {
  switch (item.errorCode) {
    case "insufficient_space":
      return translate("downloads.errors.insufficientSpace");
    case "auth":
      return translate("downloads.errors.auth");
    case "network":
      return translate("downloads.errors.network");
    default:
      return item.errorMessage
        ? translate("downloads.errors.failedWithReason", { reason: item.errorMessage })
        : translate("downloads.errors.failed");
  }
};

/**
 * Media ids with at least one COMPLETED download. Returns `previous` itself when the set did not
 * change, so a progress push (same completed titles) does not re-render the library grid.
 */
export const completedMediaIds = (
  items: ReadonlyArray<Pick<DownloadItem, "mediaId" | "status">>,
  previous: ReadonlySet<string> | null,
): ReadonlySet<string> => {
  const next = new Set<string>();
  for (const i of items) if (i.status === "completed") next.add(i.mediaId);
  if (previous && previous.size === next.size) {
    let same = true;
    for (const id of next) {
      if (!previous.has(id)) {
        same = false;
        break;
      }
    }
    if (same) return previous;
  }
  return next;
};

/** Library "downloaded only" filter: titles that have a real completed download on this device. */
export const filterDownloadedMedia = <T extends { id: string }>(
  media: ReadonlyArray<T>,
  downloadedMediaIds: ReadonlySet<string>,
): T[] => media.filter((m) => downloadedMediaIds.has(m.id));

import {
  STORAGE_TRAFFIC_REFRESH_MIN_INTERVAL_MS,
  type StorageTraffic,
  type StorageTrafficSnapshot,
} from "@space/shared/storageTunnel";

/**
 * Offline downloads while the object's silo is saturated (STOR-BW-09).
 *
 * The gateway gives an export flow zero bytes at saturation and the tunnel read simply waits; nothing errors and the
 * download resumes by itself when the silo lifts. The gate only makes that visible: it reports the held state to the job
 * (UI notice) and, between objects, waits for the silo's own report instead of opening more sessions against it. The
 * state is per silo (the one serving the object), never the merged "any silo high" view of STOR-BW-01. It never starts,
 * prefetches or queues anything by itself (OFFL-AUTO-01): it only holds back a job that already exists.
 */

/** Job `stageLabel` shown while held; the desktop notice keys on the shared `stageCode`. */
export const HELD_SATURATED_STAGE_LABEL = "Waiting: server saturated";

/** Job `stageLabel` shown while slowed by high traffic (STOR-BW-01); the desktop notice keys on the shared `stageCode`. */
export const SLOWED_HIGH_TRAFFIC_STAGE_LABEL = "Downloading: slowed, high traffic";

/** The average rate of an offline download while the merged state is high: 4 Mbit/s. The spec leaves the rate open. */
export const HIGH_TRAFFIC_DOWNLOAD_BYTES_PER_SEC = 500_000;

/** The tunnel client's traffic view, as the offline step sees it. */
export interface OfflineTrafficSource {
  /** The merged "any silo high" snapshot (STOR-BW-01); no network call. */
  current(): StorageTrafficSnapshot;
  /** The report of the silo serving `objectKey` (`GET /storage/traffic`, polled at most once a minute per gateway); null when unknown. */
  refresh(token: string, objectKey: string): Promise<StorageTraffic | null>;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal.aborted) {
    resolve();
    return promise;
  }
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
  return promise;
};

/**
 * `observe(report)` takes every report the download learns (the per-download `onTraffic` hint: session open, every ack)
 * and calls `onHold` / `onRelease` on each change of the silo's `saturated` flag. `before(objectKey)` is awaited ahead
 * of every object: it resolves at once unless the last report says saturated, then re-checks the silo every minute
 * (no faster polling) until it lifts, and returns early when the signal aborts so the caller's own cancellation check
 * ends the job. A silo whose report is unknown is not held: the gateway holds the bytes itself anyway.
 */
export const createSaturationGate = (input: {
  traffic: OfflineTrafficSource | undefined;
  token: string;
  signal: AbortSignal;
  onHold: () => void;
  onRelease: () => void;
  pollIntervalMs?: number;
}) => {
  const pollIntervalMs = input.pollIntervalMs ?? STORAGE_TRAFFIC_REFRESH_MIN_INTERVAL_MS;
  let held = false;

  const observe = (report: StorageTraffic | null): void => {
    const saturated = report?.saturated === true;
    if (saturated === held) return;
    held = saturated;
    if (saturated) input.onHold();
    else input.onRelease();
  };

  const before = async (objectKey: string): Promise<void> => {
    while (held && input.traffic && !input.signal.aborted) {
      await sleep(pollIntervalMs, input.signal);
      if (input.signal.aborted) return;
      observe(await input.traffic.refresh(input.token, objectKey));
    }
  };

  return { observe, before };
};

/**
 * Offline downloads while the MERGED traffic state is `high` (STOR-BW-01): slowed, never stopped. `before()` is called
 * as an object's fetch starts and `after(bytes)` once it has arrived. While the state reads `high`, `after` waits until
 * the object has taken `bytes / bytesPerSec` since its own `before()`, so every object, and so the average, stays at or
 * under `bytesPerSec`; time spent held by saturation or idle between objects earns no credit for a later burst. It never
 * waits otherwise and never throws. `onSlow` / `onNormal` fire on each change of the state, and `after` returns early
 * when the signal aborts so the caller's own cancellation check ends the job. Playback is not involved. Like the
 * saturation gate it only paces a job that already exists (OFFL-AUTO-01).
 */
export const createSlowdownGate = (input: {
  traffic: Pick<OfflineTrafficSource, "current"> | undefined;
  signal: AbortSignal;
  onSlow: () => void;
  onNormal: () => void;
  bytesPerSec?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}) => {
  const bytesPerSec = input.bytesPerSec ?? HIGH_TRAFFIC_DOWNLOAD_BYTES_PER_SEC;
  const now = input.now ?? Date.now;
  const wait = input.sleep ?? sleep;
  let slowed = false;
  let objectStartedAt = now();

  const update = (): void => {
    const high = input.traffic?.current().state === "high";
    if (high === slowed) return;
    slowed = high;
    if (high) {
      input.onSlow();
    } else {
      input.onNormal();
    }
  };

  const before = (): void => {
    objectStartedAt = now();
  };

  const after = async (bytes: number): Promise<void> => {
    update();
    if (!slowed) return;
    const waitMs = Math.ceil((bytes / bytesPerSec) * 1000) - (now() - objectStartedAt);
    if (waitMs > 0) await wait(waitMs, input.signal);
    if (!input.signal.aborted) update();
  };

  return { before, after };
};

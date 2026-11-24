/**
 * MPV-PREV-07: the skip-detection catch-up (MPV-PREV-03) as the Jobs tab shows it. Polled from the runtime every 5 s
 * while anything shows it (the Jobs icon's counter, the Jobs panel, the MPV-PREV-08 notice): one poll for all of
 * them. Null until the first answer and whenever the runtime is not reachable.
 */
import { useSyncExternalStore } from "react";
import type { BadgerPreviewsCatchUp } from "@space/runtime-contracts";

export type SkipCatchUpStatus = BadgerPreviewsCatchUp;

export const SKIP_CATCH_UP_POLL_MS = 5_000;
/** Dispatched on `window` to open the Jobs panel (the MPV-PREV-08 notice's "Open Jobs"); `TopNavJobsSidebar` listens. */
export const OPEN_JOBS_EVENT = "sf:open-jobs";
/** A finished catch-up stays in the Jobs tab this long, then leaves it. */
export const SKIP_CATCH_UP_SHOWN_AFTER_DONE_MS = 24 * 60 * 60 * 1000;

let shared: SkipCatchUpStatus | null = null;
const listeners = new Set<() => void>();
let timer: number | null = null;
/** Bumped when the last listener leaves, so an answer that lands after it is dropped. */
let generation = 0;

const poll = () => {
  const getStatus = window.sf?.skipCatchUp?.getStatus;
  if (!getStatus) return;
  const asked = generation;
  void getStatus()
    .catch(() => null)
    .then((next) => {
      if (asked !== generation) return;
      shared = next;
      for (const listener of listeners) listener();
    });
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    poll();
    timer = window.setInterval(poll, SKIP_CATCH_UP_POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.clearInterval(timer ?? undefined);
    timer = null;
    generation += 1;
    shared = null;
  };
};

export const useSkipCatchUpStatus = (): SkipCatchUpStatus | null =>
  useSyncExternalStore(subscribe, () => shared, () => null);

/** "Try again" (MPV-PREV-07): one video (`formatId`) or all (null); the shown status is asked again at once. */
export const retrySkipCatchUp = async (formatId: string | null): Promise<boolean> => {
  const retry = window.sf?.skipCatchUp?.retry;
  if (!retry) return false;
  const ok = await retry(formatId).catch(() => false);
  if (listeners.size > 0) poll();
  return ok;
};

/**
 * "Try again for all left-out episodes" on a title (PLAY-SKIP-09): asks again for each of its videos, never the whole
 * library; the shown status is asked again once at the end.
 */
export const retrySkipCatchUpVideos = async (formatIds: readonly string[]): Promise<boolean> => {
  const retry = window.sf?.skipCatchUp?.retry;
  if (!retry) return false;
  const results = await Promise.all(formatIds.map((formatId) => retry(formatId).catch(() => false)));
  if (listeners.size > 0) poll();
  return results.every(Boolean);
};

/** A skip job's Cancel or Remove from history (MPV-PREV-07); the shown status is asked again at once. */
export const setSkipCatchUpVideo = async (formatId: string, action: "cancel" | "dismiss"): Promise<boolean> => {
  const setVideo = window.sf?.skipCatchUp?.setVideo;
  if (!setVideo) return false;
  const ok = await setVideo(formatId, action).catch(() => false);
  if (listeners.size > 0) poll();
  return ok;
};

export type SkipCatchUpVideo = SkipCatchUpStatus["videos"][number];

/** The Jobs icon counts the catch-up as one running job while it works, not while it waits or is done. */
export const skipCatchUpActiveCount = (status: SkipCatchUpStatus | null): number =>
  status?.state === "running" ? 1 : 0;

/** Shown while videos remain, and for a day after the list ran dry. */
export const isSkipCatchUpShown = (status: SkipCatchUpStatus, nowMs: number): boolean =>
  status.total > 0 &&
  (status.state !== "done" ||
    (status.finishedAt !== null && nowMs - Date.parse(status.finishedAt) < SKIP_CATCH_UP_SHOWN_AFTER_DONE_MS));

/** "S02E03" for an episode, "" for a film. */
export const episodeCode = (season: number | null, episode: number | null): string =>
  season === null || episode === null
    ? ""
    : `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
